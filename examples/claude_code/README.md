# Claude Code — Voice-Driven Coding Assistant

A voice assistant backed by [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) (Anthropic's AI coding agent). Speak coding requests naturally and Claude reads, edits, creates files, runs commands, and searches your codebase.

This demo uses the **relay subagent pattern** — an interactive subagent bridges the Gemini voice model to Claude Code's stateful SDK, managing session lifecycles and question relay.

## Prerequisites

- Node.js 22+
- A Google API key (Gemini Live API)
- An Anthropic API key (Claude Agent SDK)
- macOS (for Apple Mail email integration)

## Setup

```bash
# From the repository root:
pnpm install

# Install the Claude Agent SDK (optional dependency):
pnpm add @anthropic-ai/claude-agent-sdk
```

## Running

```bash
export GEMINI_API_KEY="your-gemini-key"
export ANTHROPIC_API_KEY="your-anthropic-key"
export PROJECT_DIR="/path/to/your/project"  # optional, defaults to cwd

# Start the voice agent:
pnpm tsx examples/claude_code/claude-demo.ts

# In another terminal, start the web client:
pnpm tsx examples/openclaw/web-client.ts
# Then open http://localhost:8080 in Chrome
```

## How It Works

1. You speak a coding request → Gemini calls the `ask_claude` background tool
2. The relay subagent receives the task and calls `claude_code_start`
3. Claude Code runs autonomously: reads files, edits code, runs commands
4. If Claude asks a follow-up question, the relay calls `ask_user` → you hear the question and answer by voice
5. When Claude finishes, the relay summarizes the result → Gemini speaks it to you

## Things to Try

| Say this | What happens |
|----------|-------------|
| "Fix the bug in auth.py" | Claude reads files, edits code, runs tests |
| "Add input validation to the login form" | Claude creates or modifies files |
| "Run the tests and fix any failures" | Claude runs bash commands and iterates |
| "Summarize the README and email it to user@example.com" | Claude reads files and sends via Apple Mail |
| "What's the weather in San Francisco?" | Google Search (Gemini native) |
| "Draw me a picture of a sunset" | Image generation subagent |
| "Goodbye" | Graceful session end |

## Architecture

| File | Purpose |
|------|---------|
| `claude-demo.ts` | Entry point — wires agents, tools, and the voice session |
| `claude-code-tools.ts` | `ask_claude` tool definition + relay SubagentConfig factory |
| `claude-code-client.ts` | `ClaudeCodeSession` — wraps the Claude Agent SDK `query()` with pause/resume for interactive questions |
| `apple-mail-sender.ts` | Email sending via macOS Mail.app (AppleScript) |

## Troubleshooting

**Claude makes zero tool calls:** Verify `ANTHROPIC_API_KEY` is set. Check server logs for `[ClaudeCode] SDK init message:` to confirm the SDK initialized correctly.

**Email not sending:** Requires macOS with Mail.app configured. First use triggers a system permission dialog. Check for `[MCP:send_email] Tool invoked!` in logs.
