<!-- SPDX-License-Identifier: MIT -->

# Remote persistent worker (minimal bridge)

Bodhi’s voice agent can call **your** HTTPS server on each background tool invocation. The server receives:

- `POST {baseUrl}/task`
- Header: `Authorization: Bearer <token>` (must match what you saved in Agent Studio)
- Body: `{ "sessionId": "bodhi_<voiceSessionId>_<toolName>", "task": "<user task string>" }`

Respond with JSON:

```json
{ "status": "completed", "text": "Short summary for the voice assistant." }
```

or

```json
{ "status": "error", "text": "What went wrong." }
```

Use the same `sessionId` across requests to keep context on your side (map it to Claude Code resume id, a thread file, etc.).

## Run the example (Node, no npm deps)

```bash
node examples/remote-persistent-worker/server.mjs
```

Defaults: URL `http://127.0.0.1:8788`, bearer token `dev-token` (override with `BODHI_WORKER_TOKEN`).

## What this server now does

- Calls local Claude CLI (`claude`) for each `/task` request.
- First call for a Bodhi `sessionId`: starts a Claude run.
- Later calls with the same Bodhi `sessionId`: sends `--resume <claudeSessionId>` (when detected from prior output).
- Logs request/response IO with timestamps so you can verify:
  - incoming JSON body (`sessionId`, task preview)
  - whether run mode is `start` or `resume`
  - Claude session id capture
  - status returned back to Bodhi.

Environment knobs:

- `BODHI_WORKER_TOKEN` (default `dev-token`)
- `CLAUDE_CMD` (default `claude`)
- `CLAUDE_TIMEOUT_MS` (default `180000`)
- `CLAUDE_PROJECT_DIR` (default current working directory)
- `CLAUDE_PERMISSION_MODE` (default `bypassPermissions`)
- `CLAUDE_DANGEROUS_SKIP_PERMISSIONS` (`1` default, set `0` to disable)

Recommended local run for fully non-interactive permissions:

```bash
CLAUDE_PROJECT_DIR=/absolute/path/to/your/repo \
CLAUDE_PERMISSION_MODE=bypassPermissions \
CLAUDE_DANGEROUS_SKIP_PERMISSIONS=1 \
node examples/remote-persistent-worker/server.mjs
```

## Agent Studio (exact checklist)

1. **Start the bridge** (command above). Leave it running.
2. Open **Agent Studio** in the web app (same machine is easiest so the Bodhi **voice server** can call `127.0.0.1`).
3. Under **Remote persistent worker (HTTPS)**, click **Use local demo defaults** (fills tool name `remote_demo_task`, URL, token, enables the tool, and appends system-prompt instructions). Or type the same values by hand.
4. Click **Save** (sign in if your setup requires cloud save).
5. Open **Voice test**, connect, and say something like: *“Use remote_demo_task and write docs/remote-test.md with two bullets.”*
6. Watch terminal logs from `server.mjs`:
   - first call should show `mode: "start"`
   - second related call should show `mode: "resume"` and the same `bodhiSessionId`.

**If nothing happens:** confirm the tool is checked under **Agent tools**, the agent was saved after filling the three fields, and the voice backend can reach the URL (hosted cloud cannot reach your laptop `localhost` unless you tunnel a public HTTPS URL and paste that as base URL).

For a public URL, expose this port with ngrok, Cloudflare Tunnel, or Tailscale Funnel and paste the HTTPS base URL (and update the token to match your server).
