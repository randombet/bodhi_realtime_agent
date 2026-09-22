# Quick Start

## Prerequisites

- Node.js 22+
- `pnpm` (recommended; repo uses pnpm lockfile)
- API key for your provider:
  - Gemini: `GEMINI_API_KEY`
  - OpenAI Realtime: `OPENAI_API_KEY`

## Install

```bash
pnpm install
```

## Start an example agent

```bash
export GEMINI_API_KEY="your-key"
pnpm tsx examples/hello_world/agent.ts
```

Or on OpenAI Realtime (its image/video subagents also use `GEMINI_API_KEY`):

```bash
export OPENAI_API_KEY="your-key"
pnpm tsx examples/hello_world/openai-realtime-tools.ts
```

The agent listens on `ws://localhost:9900`.

## Talk to it

```bash
pnpm web-client
```

Then open `http://localhost:8080` and click **Connect**. See [Running the Examples](./running-examples.md) for more demos.

## Docs site

```bash
pnpm docs:dev
```

Then open `http://localhost:5173/bodhi_realtime_agent/`.
