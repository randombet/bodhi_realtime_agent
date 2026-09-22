<!-- SPDX-License-Identifier: MIT -->

# Remote persistent worker setup (user guide)

This guide shows how to connect Agent Studio to your own coding agent server (Claude Code, Codex, Cursor agent, OpenCoder, etc.) over HTTPS using `remote_persistent_worker`.

## What you get

- Main voice agent stays in Bodhi.
- Heavy coding runs on your machine/server.
- Bodhi sends `{ sessionId, task }` on each tool call.
- Same `sessionId` is reused across turns in one voice session, so your worker can resume context.

## Fast local setup (same machine as Bodhi server)

1. Open Agent Studio and go to **Remote persistent worker (HTTPS)**.
2. Click **Fill local demo defaults**.
3. Click **Save**.
4. Open **Voice test** and connect.
5. Ask for a coding task that should be delegated.

The preset fills:

- Tool name: `remote_demo_task`
- URL: `http://127.0.0.1:8788`
- Token: `dev-token`
- Tool description + pending message + system-prompt helper text

## Start the example bridge server

Use the example bridge in this repository:

- Code: [`examples/remote-persistent-worker/server.mjs`](../../examples/remote-persistent-worker/server.mjs)
- Quick notes: [`examples/remote-persistent-worker/README.md`](../../examples/remote-persistent-worker/README.md)

Recommended run command:

```bash
CLAUDE_PROJECT_DIR=/absolute/path/to/your/repo \
CLAUDE_PERMISSION_MODE=bypassPermissions \
CLAUDE_DANGEROUS_SKIP_PERMISSIONS=1 \
node examples/remote-persistent-worker/server.mjs
```

Expected startup logs include:

- `Remote persistent worker demo at .../task`
- `Claude project dir: ...`
- `Claude permission mode: bypassPermissions`
- `Dangerous skip permissions: on`

## Expose your worker over HTTPS (when Bodhi server is remote)

If your Bodhi voice backend runs in cloud/staging, `127.0.0.1` on your laptop is not reachable. Expose your local worker and paste the public HTTPS URL into Agent Studio.

### Option A: ngrok

```bash
ngrok http 8788
```

Use the `https://...ngrok...` URL as **Remote worker base URL**.

### Option B: Cloudflare Tunnel

```bash
cloudflared tunnel --url http://127.0.0.1:8788
```

Use the issued `https://...trycloudflare.com` URL.

### Option C: Tailscale Funnel

Expose your worker through Tailscale and use the generated HTTPS funnel URL.

## Required Agent Studio fields

Under **Remote persistent worker (HTTPS)**:

- `Remote worker tool name` (snake_case)
- `Remote worker base URL`
- `Bearer token`
- `Tool description`
- Optional `Pending message`

Then ensure the tool is enabled under **Agent tools** and click **Save**.

## Request/response contract

Request to your worker:

```json
{
  "sessionId": "bodhi_<voiceSessionId>_<toolName>",
  "task": "..."
}
```

Response from your worker:

```json
{
  "status": "completed",
  "text": "Short, truthful summary for voice."
}
```

or

```json
{
  "status": "error",
  "text": "What failed."
}
```

## Verify persistence and IO

In worker logs, check:

- same `bodhiSessionId` for related turns
- first call `mode: start`, later call `mode: resume`
- `claudeSessionId` captured and reused

In Bodhi logs, check:

- tool call appears for your remote worker tool
- background task started/completed events

## Trust/safety note

Do not claim file changes unless your worker output explicitly confirms them (or returns evidence fields you define). The default bridge returns text; it does not add automatic proof fields.
