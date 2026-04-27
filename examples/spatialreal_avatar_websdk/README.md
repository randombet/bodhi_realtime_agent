# SpatialReal Avatar Web SDK Demo

This example mirrors the `openclaw` shape:

- `demo.ts`: starts Bodhi realtime voice session (WebSocket) + token backend + avatar driving bridge
- `web-client.ts`: browser client that connects to Bodhi voice WebSocket and renders SpatialReal host-mode avatar
- `bridge/avatar_bridge.py`: python bridge (same role as `app/lib/spatialreal/bridge/`); the **venv lives only under `app/`** — one-time: `app/lib/spatialreal/bridge/setup-venv.sh`

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
- optional: `SPATIALREAL_PYTHON` (defaults to `app/lib/spatialreal/bridge/.venv/.../python3` after you run the app bridge setup)

## Python (single venv under `app/`; avoids PEP 668)

One-time, from the repo root:

```bash
cd app/lib/spatialreal/bridge
./setup-venv.sh
```

`demo.ts` spawns the bridge with that venv by default. Override with `SPATIALREAL_PYTHON` if needed.

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
