# Claude Coding Subagent (Claude Code CLI)

This page captures what this framework can support today by integrating Claude Code CLI as a background subagent runtime, plus limitations and a comparison with PR #4.

## What is supported

- **MainAgent → Claude coding subagent handoff** using `SubagentConfig.runtime = 'claude_code'`.
- **Interactive user clarification loop** through existing `SubagentSession` plumbing:
  - Claude subagent can return `{"status":"needs_input", ...}`.
  - Framework relays question to the user via voice.
  - User reply is sent back to Claude as next turn context.
- **Configurable Claude execution options**:
  - command path (`command`), `cwd`, `model`, `permissionMode`, `allowedTools`, `maxTurns`, `extraArgs`.
- **Lifecycle and cancellation integration**:
  - Shares framework timeout/abort wiring and terminal session transitions.
  - Emits `onSubagentStep` hook events per Claude CLI turn.

## What is not fully supported (yet)

- **Persistent Claude CLI process / streaming session**.
  - Current runtime executes Claude CLI per turn (request/response style), not a long-lived interactive TTY.
- **Token-level streaming relay** from Claude to user.
  - Turn-level results only.
- **Native framework mapping of Claude-specific telemetry** (token/cost/latency breakdown).
  - `onSubagentStep.tokensUsed` is currently `0` placeholder for this runtime.
- **Hard guarantee of schema compliance**.
  - Runtime instructs Claude to return strict JSON; malformed JSON returns an error.
- **First-class support for every CLI feature**.
  - Framework currently maps only commonly useful coding-runtime flags listed above.

## Comparison with PR #4

PR #4 implemented a Claude runtime through a Python bridge (`claude-agent-sdk-python`) and persisted SDK `session_id` across turns.

### Pros of this CLI-based implementation

- **Fewer runtime dependencies** for Node-first users (no Python bridge script required by default).
- **Simpler operational model** for teams already standardizing on Claude Code CLI.
- **Direct parity with CLI permissions/tool flags** exposed to users via `SubagentConfig.claude`.

### Cons vs PR #4

- **No SDK-level session resume primitive** (PR #4 used `resume/session_id`).
- **No direct access to Python SDK-specific capabilities** (hooks, richer typed messages, SDK MCP wiring).
- **Less deterministic structured-output handling** than an SDK API with explicit typed result channels.

### Pros of PR #4 (Python bridge)

- Better support for **stateful continuation** with explicit SDK session resume.
- Easier path to **SDK-level advanced controls** (interrupt APIs, richer metadata).
- Potentially cleaner integration for **strict structured output** depending on SDK guarantees.

### Cons of PR #4

- Added **Python runtime dependency** and bridge maintenance burden.
- More moving parts (TypeScript ↔ Python process contract).
- Operational complexity for environments that only expect Node tooling.
