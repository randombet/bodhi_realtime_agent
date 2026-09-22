"""
Avatar Driving Bridge — Python child process for Node.js.

Communicates with Node over stdin/stdout using newline-delimited JSON.
"""

import asyncio
import base64
import json
import sys
from datetime import datetime, timedelta, timezone

from avatarkit import new_avatar_session

REGION_ENDPOINTS = {
    "us-west": {
        "console": "https://console.us-west.spatialwalk.cloud/v1/console",
        "ingress": "wss://api.us-west.spatialwalk.cloud/v2/driveningress",
    },
    "ap-northeast": {
        "console": "https://console.ap-northeast.spatialwalk.cloud/v1/console",
        "ingress": "wss://api.ap-northeast.spatialwalk.cloud/v2/driveningress",
    },
}

session = None


def send_msg(msg: dict):
    line = json.dumps(msg, separators=(",", ":"))
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def log(msg: str):
    sys.stderr.write(f"[avatar-bridge] {msg}\n")
    sys.stderr.flush()


async def handle_init(config: dict):
    global session
    region = config.get("region", "us-west")
    endpoints = REGION_ENDPOINTS.get(region)
    if not endpoints:
        send_msg({"type": "error", "message": f"Unknown region: {region}"})
        return

    sample_rate = config.get("sampleRate", 24000)

    def on_frame(frame_data: bytes, is_last: bool):
        send_msg(
            {
                "type": "frame",
                "data": base64.b64encode(frame_data).decode("ascii"),
                "last": is_last,
            }
        )

    def on_error(err: Exception):
        log(f"SDK error: {err}")
        send_msg({"type": "error", "message": str(err)})

    def on_close():
        send_msg({"type": "closed"})

    session = new_avatar_session(
        api_key=config["apiKey"],
        app_id=config["appId"],
        avatar_id=config["avatarId"],
        console_endpoint_url=endpoints["console"],
        ingress_endpoint_url=endpoints["ingress"],
        expire_at=datetime.now(timezone.utc) + timedelta(hours=1),
        sample_rate=sample_rate,
        use_query_auth=True,
        transport_frames=on_frame,
        on_error=on_error,
        on_close=on_close,
    )

    await session.init()
    connection_id = await session.start()
    send_msg({"type": "ready", "connectionId": connection_id})


async def handle_audio(data_b64: str, end: bool):
    if not session:
        return
    audio_bytes = base64.b64decode(data_b64)
    await session.send_audio(audio_bytes, end=end)


async def handle_interrupt():
    if not session:
        return
    try:
        await session.interrupt()
    except Exception as e:
        log(f"Interrupt error: {e}")


async def handle_close():
    global session
    if session:
        await session.close()
        session = None
    send_msg({"type": "closed"})


async def main():
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            break
        try:
            msg = json.loads(line.decode("utf-8").strip())
        except json.JSONDecodeError:
            continue

        msg_type = msg.get("type")
        try:
            if msg_type == "init":
                await handle_init(msg)
            elif msg_type == "audio":
                await handle_audio(msg["data"], msg.get("end", False))
            elif msg_type == "interrupt":
                await handle_interrupt()
            elif msg_type == "close":
                await handle_close()
                break
        except Exception as e:
            send_msg({"type": "error", "message": str(e)})


if __name__ == "__main__":
    asyncio.run(main())
