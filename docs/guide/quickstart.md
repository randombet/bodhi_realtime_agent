# Quick Start

## Prerequisites

- Node.js 22+
- `pnpm` (recommended; repo uses pnpm lockfile)
- API key for your provider:
  - Gemini: `GEMINI_API_KEY`
  - OpenAI Realtime: `OPENAI_API_KEY` with `LLM_PROVIDER=openai`

## Install

```bash
pnpm install
```

## Start server

```bash
pnpm start
```

Server default: `ws://localhost:9900`.

## Optional web client

```bash
pnpm web-client:dev
```

Then open `http://localhost:8080`.

## Docs site

```bash
pnpm docs:dev
```

Then open `http://localhost:5173/bodhi_realtime_agent/`.
