# Claude Coding Subagent (Anthropic SDK) — Capability Assessment

This document captures what the framework can support today by integrating `claude-agent-sdk-python`, and what is currently out-of-scope.

## What is supported

- **Interactive multi-turn coding handoff from MainAgent → Claude subagent.**
  - A background tool can hand off work to a Claude runtime subagent (`runtime: 'claude_code'`).
  - The subagent can ask follow-up questions (`status: needs_input`) and receive spoken user input through the existing interactive subagent session.

- **Stateful continuation across turns.**
  - The implementation persists Claude `session_id` between turns and resumes conversation when user clarification is required.

- **Tool permission controls.**
  - You can configure `permissionMode` and `allowedTools` via `SubagentConfig.claude`.

- **Working directory and model controls.**
  - You can configure `cwd`, `model`, `maxTurns`, and Python binary path.

- **No custom Claude CLI install required (by default).**
  - Integration uses Python SDK and relies on bundled CLI behavior in `claude-agent-sdk-python`.

## What is not fully supported (yet)

- **Live token-by-token relay from Claude to voice user.**
  - Current bridge returns a turn-level result, not incremental stream updates.

- **Native Claude-side tool hook/mcp wiring from TypeScript directly.**
  - Python SDK supports hooks and SDK MCP servers, but this framework bridge currently only maps core coding-turn options.

- **Interrupt/resume controls surfaced through framework APIs.**
  - The Python SDK client supports interrupt operations; this initial integration uses request/response turn execution.

- **Usage/cost telemetry mapping into framework step metrics.**
  - Framework `onSubagentStep` currently records step count, but not Claude token/cost metadata.

- **Strict guarantee on “needs_input” detection without JSON contract compliance.**
  - Bridge requests structured JSON output (`completed|needs_input`). If model output violates schema, fallback behavior is best-effort.

## Recommended next improvements

1. Add stream event relay (partial output/progress) into `SubagentMessage`.
2. Add explicit `interruptSubagent` support for Claude runtime.
3. Expose richer `claude` config (hooks, MCP servers, sandbox, budget caps).
4. Pipe Claude usage/cost into framework telemetry.
5. Add conformance tests that simulate malformed structured output.
