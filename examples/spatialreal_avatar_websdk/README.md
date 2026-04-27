# SpatialReal Avatar Web SDK Demo

This example is self-contained under `examples/` and mirrors the `openclaw` shape:

- `demo.ts`: starts Bodhi realtime voice session (WebSocket) + token backend + avatar driving bridge
- `web-client.ts`: browser client that connects to Bodhi voice WS and renders SpatialReal host-mode avatar
- `bridge/avatar_bridge.py`: python bridge that sends Bodhi audio output to SpatialReal driving ingress and returns keyframes

## Architecture

Two services and one bridge run in `demo.ts`:

1. **Voice backend** (`ws://localhost:9900` by default): Bodhi `VoiceSession`
2. **Token backend** (`http://localhost:9901` by default): mints SpatialReal session tokens
3. **Avatar driving bridge**: streams Bodhi output audio to SpatialReal and emits keyframes for avatar talking sync
4. Browser web client sends/receives voice to Bodhi over WebSocket and applies keyframes in host mode

This path uses host mode (python bridge) because that is the only way to drive avatar lip sync from Bodhi output audio.

## Environment

Put these in `.env` (or export them before running):

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `SPATIALREAL_API_KEY`
- `SPATIALREAL_APP_ID`
- `SPATIALREAL_AVATAR_ID`
- `SPATIALREAL_REGION` (`us-west` or `ap-northeast`) for token backend
- `SPATIALREAL_ENV` (`intl` or `cn`) for the browser SDK
- optional: `HOST`, `PORT`, `SPATIALREAL_TOKEN_PORT`, `CLIENT_HOST`, `CLIENT_PORT`
- optional: `SPATIALREAL_TOKEN_SERVER_URL` if your client should hit a non-default backend URL
- optional: `SPATIALREAL_PYTHON` to point at a specific Python (defaults to `examples/spatialreal_avatar_websdk/bridge/.venv/bin/python3` if you used the venv below)

## Python dependency (use a venv; avoids PEP 668 “externally managed environment”)

On macOS Homebrew Python, **do not** `pip install` into the system interpreter. One-time (Unix/macOS):

```bash
cd examples/spatialreal_avatar_websdk/bridge
./setup-venv.sh
```

On Windows, create the same venv manually: `python -m venv .venv` then `.\.venv\Scripts\python -m pip install -r requirements.txt`.

`demo.ts` will spawn the bridge with that venv by default. Override with `SPATIALREAL_PYTHON` if the venv lives elsewhere.

## Run

Terminal 1:

```bash
pnpm tsx examples/spatialreal_avatar_websdk/demo.ts
```

Terminal 2:

```bash
pnpm tsx examples/spatialreal_avatar_websdk/web-client.ts
```

Then open `http://localhost:8080`.
