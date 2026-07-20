# Bodhi + Sutando — Voice-Driven Personal Agent Demo

A voice assistant that uses **Gemini native audio** for conversation and delegates
real work to your **[Sutando](https://github.com/sonichi/sutando)** agent running
on your MacBook — email, calendar, meetings, phone calls, files, screen, coding.

Unlike the Hermes demo (which points an OpenAI-compatible provider at a VPS
endpoint), Sutando's core is a Claude Code CLI session behind NAT with no API
server — so this demo inverts the connection: it hosts Sutando's
**remote-gateway relay contract** (4 HTTP endpoints), and the Mac's shipping
bridge client **dials out** to it. No inbound port, tunnel, or code change on
the Mac. Design doc: `dev_docs/design-sutando-persistent-subagent.md`.

## Features

- **Voice interface**: speak requests naturally via Chrome
- **Sutando delegation** (`ask_sutando`): a persistent subagent per voice
  session — follow-up requests carry conversation context
- **Location-flexible**: run this demo on the MacBook itself, a GCP VM, or a
  LAN box; only the Mac's `REMOTE_TASK_URL` changes
- **Presence-aware**: heartbeats tell the agent whether your Mac is online —
  offline delegations queue and the agent says so instead of timing out
- **Interactive delegation**: Sutando's clarifying questions (`[needs-input]`)
  are relayed by voice; your answer resumes the work
- **Bounded briefs**: results are summarized for voice; full raw output goes
  only to a per-session sidecar directory
- **No ghosts**: "goodbye" closes the session, cancels undelivered tasks, and
  orphan-logs (never speaks) late results
- **Restart-durable (M2)**: a fsync'd task ledger survives crashes — work the
  Mac already accepted is recovered after a restart (its result is accepted and
  archived, never lost), dropped requests surface one "want me to redo it?"
  notice, and post-goodbye work stays silent forever
- **Real cancellation (M2)**: abandoning delivered work (watchdog, abort,
  goodbye) sends Sutando's `CANCEL_INSTRUCTION` task at urgent priority; a
  raced-and-lost cancel just means the original result lands in the orphan log
- **Long-session continuity (M3)**: the conversation digest compresses
  deterministically past a char budget — a 50-delegation session keeps a
  bounded context block
- **Presence transitions (M3)**: "your Mac came back online — running your
  queued task now," exactly once per offline→online transition

## Architecture

```
        USER                       THIS DEMO (anywhere close to the user)
  ┌──────────────┐  WebSocket  ┌──────────────────────────────────────────┐
  │ Browser UI   │◄───────────►│  VoiceSession (actor mode)               │
  │ (:8080)      │ audio+JSON  │   ├─ ask_sutando │ search │ time │ bye   │
  └──────────────┘             │   ├─ SutandoSubagentInstance (persistent)│
  ┌──────────────┐   audio +   │   └─ SutandoRelayServer  /v1/*  ◄──┐     │
  │ Gemini Live  │◄───────────►│      (bearer-auth task queue)      │     │
  └──────────────┘   tools     └────────────────────────────────────┼─────┘
                                             outbound long-poll only│
        YOUR MACBOOK (behind NAT — no inbound port)                 │
  ┌─────────────────────────────────────────────────────────────────┼───┐
  │  remote-gateway-bridge.py ── GET /v1/tasks ── ack ── results ───┘   │
  │        │write                      ▲                                │
  │   tasks/task-*.txt ──► Claude Code core ──► results/task-*.txt      │
  └─────────────────────────────────────────────────────────────────────┘
```

## Deployment topologies

| | Demo runs on | Mac's `REMOTE_TASK_URL` | Transport requirement |
|---|---|---|---|
| A | the MacBook itself | `http://127.0.0.1:7930` | none (loopback) |
| B | a GCP/cloud VM | `https://vm.example` | real HTTPS in front of the VM |
| C | another LAN machine | `http://<box-tailnet-name>:7930` | tailnet/WireGuard overlay (recommended) or reverse-proxy TLS; bare LAN HTTP is explicit opt-in only |

The relay binds `127.0.0.1` by default; for B/C set `SUTANDO_RELAY_HOST=0.0.0.0`
**and** `SUTANDO_RELAY_ALLOW_NONLOOPBACK=true` (the topology flag), and front it
per the table. The voice WebSocket has the same discipline: non-loopback `HOST`
requires `VOICE_FRONT_AUTH_CONFIRMED=true` after you've actually fronted it —
the demo fails closed otherwise.

## Setup

### 1. Generate a relay token

```bash
openssl rand -hex 32
```

### 2. Configure the Mac (Sutando side — config only, no code changes)

In your Sutando checkout, create the gateway channel `.env`
(e.g. `channels/bodhi/.env`, or wherever your install keeps channel env files):

```bash
REMOTE_TASK_URL=http://127.0.0.1:7930      # this demo's relay URL (topology-dependent)
REMOTE_TASK_TOKEN=<the token from step 1>
REMOTE_TASK_PROVIDER=bodhi
```

Then start (or restart) Sutando — `bash src/startup.sh` launches the bridge
whenever that `.env` exists. The bridge long-polls the relay and stamps every
inbound task `access_tier: owner` (its default; the task body cannot override it).

### 3. Run the demo

```bash
export GEMINI_API_KEY="your-gemini-api-key"
export SUTANDO_RELAY_TOKEN="<the token from step 1>"

# Terminal 1: voice agent + relay
pnpm tsx examples/sutando/sutando-demo.ts

# Terminal 2: web client (reused from the OpenClaw example)
pnpm tsx examples/openclaw/web-client.ts

# Open http://localhost:8080 in Chrome and click Connect
```

## What to try

| Prompt | What happens |
|---|---|
| "What's the weather in San Francisco?" | Gemini native Google Search — no delegation |
| "What time is it?" | Inline tool, instant |
| "Ask Sutando to check my email for the AWS invoice" | Delegation — voice says "on it," keeps talking; summary spoken when it lands |
| "Have Sutando join my 2pm meeting" | Delegation into Sutando's meeting machinery |
| *(Sutando asks a question)* | The question is spoken; your answer becomes the follow-up delegation |
| "Goodbye" | Graceful close — no ghost tasks |

## Tool routing

| Tool | Type | When |
|---|---|---|
| `ask_sutando` | background, `persistent_session` | email, calendar, meetings, phone, Mac files/screen, coding, research — any multi-step task |
| Google Search | Gemini native | quick factual lookups |
| `get_current_time` | inline | date/time |
| `end_session` | inline | goodbye (actually closes the session) |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | (required) | Google AI Studio API key |
| `SUTANDO_RELAY_TOKEN` | (required) | Bearer the Mac's bridge presents (`REMOTE_TASK_TOKEN`) |
| `SUTANDO_RELAY_PORT` | `7930` | Relay listen port |
| `SUTANDO_RELAY_HOST` | `127.0.0.1` | Relay bind; non-loopback needs `SUTANDO_RELAY_ALLOW_NONLOOPBACK=true` |
| `PORT` | `9900` | Voice agent WebSocket port |
| `HOST` | `127.0.0.1` | Voice bind; non-loopback needs `VOICE_FRONT_AUTH_CONFIRMED=true` |
| `TRANSCRIPT_DIR` | `./transcripts` | Per-session transcript + raw result sidecar |
| `SUTANDO_LEDGER_DIR` | `./sutando-ledger` | M2 durable task ledger (IDs/states/one-line descriptions only — never result content; pruned after consumption + TTL) |

## Smoke test (no voice, no Gemini key needed)

Verifies the real Sutando bridge client against the relay end-to-end
(heartbeat → delivery → ack → result), using a temp workspace so your live
Sutando install is untouched:

```bash
SUTANDO_REPO=/path/to/sutando pnpm tsx examples/sutando/smoke-live-bridge.ts
```

## Manual acceptance checklist (needs a live voice run)

The headless parts of the design doc's M1 acceptance run are covered by
`examples/test/sutando-*.test.ts` and the smoke test above. These need a human
with a mic and a live Sutando:

- [ ] (a) Voice keeps talking the moment a task is submitted (pending message, no stall)
- [ ] (b) An email-search delegation round-trips and is *summarized* aloud; full raw only in the sidecar
- [ ] (c) A `[needs-input]` question is spoken; answering resumes the work with context
- [ ] (d) With the Mac offline: immediate notice, task drains on reconnect; an expired task surfaces the stale-failure brief
- [ ] (e) "Goodbye" → session closes, `dispose()` runs (undelivered tasks cancelled in the relay log), and a late result never gets spoken

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `SUTANDO_RELAY_TOKEN environment variable is required` | no token set | generate one and export it (and mirror it on the Mac) |
| demo exits: `refuses non-loopback bind` | `SUTANDO_RELAY_HOST` set without the topology flag | choose your topology; set `SUTANDO_RELAY_ALLOW_NONLOOPBACK=true` once fronted per §6 |
| demo exits: `binds the (unauthenticated) voice WebSocket beyond loopback` | `HOST` non-loopback without confirmation | front the voice WS with auth, then set `VOICE_FRONT_AUTH_CONFIRMED=true` |
| "Mac presence: no heartbeat yet" forever | bridge not running or wrong URL/token | check the Mac's channel `.env`; `curl -sS <relay>/v1/tasks?wait=0 -H "Authorization: Bearer $TOKEN"` should return `{"tasks":[]}` |
| bridge exits `gateway auth rejected (HTTP 401)` | token mismatch | copy the exact `SUTANDO_RELAY_TOKEN` value into `REMOTE_TASK_TOKEN` |
| delegation times out | Mac's core busy or task watchdog too tight | check the Mac's Sutando; results land in the raw sidecar even if late (orphan-logged) |

## Security notes

- The relay bearer authorizes everything the bridge does (poll, ack, results,
  heartbeat) — treat a leak as **bridge impersonation** (an attacker could read
  queued task bodies and forge results). Per-deployment token; rotate to revoke;
  TLS on every non-loopback topology.
- The voice WebSocket is unauthenticated in this framework — whoever reaches it
  can issue owner-tier delegations. Hence the loopback default + fail-closed flag.
- Raw Sutando output can contain email bodies and file contents; it is written
  only to the per-session sidecar (`TRANSCRIPT_DIR/<session>-raw/`), never to logs.
