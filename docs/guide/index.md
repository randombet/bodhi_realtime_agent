# Introduction

Bodhi Realtime Agent Framework is a TypeScript framework for building **real-time voice agent applications** using the [Google Gemini Live API](https://ai.google.dev/gemini-api/docs/live). It handles the hard parts of voice AI — bidirectional audio streaming, turn detection, agent transfers, tool execution, and session management — so you can focus on what your agent actually does.

## What You Can Build

- **Voice assistants with tools** — An agent that answers questions, checks the weather, does math, and searches the web, all through natural conversation.
- **Multi-agent systems** — A general assistant that transfers to a booking specialist, a math expert, or a language tutor mid-conversation.
- **Multimodal applications** — Users can speak, type, upload images, and receive generated images — all on a single WebSocket connection.
- **Proactive notification agents** — Service subagents that monitor calendars, inboxes, or IoT devices and notify the user when something needs attention.

## Architecture Overview

```
Client App  <──WebSocket──>  ClientTransport  <──audio──>  GeminiLiveTransport  <──WebSocket──>  Gemini Live API
                                    │                              │
                                    └───────── VoiceSession ───────┘
                                    │    (audio fast-path relay)    │
                                    │                              │
                              AgentRouter    ToolExecutor    ConversationContext
```

Audio flows on a **fast-path** directly between the client and Gemini transports, bypassing the EventBus for minimal latency. Everything else (tool calls, agent transfers, GUI events) goes through the control plane.

## Key Concepts

| Concept | What it does |
|---------|-------------|
| [VoiceSession](/guide/voice-session) | Top-level orchestrator that wires all components together |
| [Agents](/guide/agents) | Personas with distinct instructions, tools, and lifecycle hooks |
| [Tools](/guide/tools) | Functions the AI model can call during conversation (inline or background) |
| [Memory](/guide/memory) | Automatic extraction of durable user facts across sessions |
| [Events & Hooks](/guide/events) | Type-safe EventBus and lifecycle callbacks for observability |
| [Transport](/guide/transport) | WebSocket connections to Gemini and client applications |

## Prerequisites

- **Node.js 22+** — The framework uses modern JavaScript features
- **pnpm** — Package manager ([install guide](https://pnpm.io/installation))
- **Google API key** — With Gemini Live API access ([get one here](https://aistudio.google.com/))

## Next Steps

- [Quick Start](/guide/quickstart) — Build a working voice agent in 5 minutes
- [Running Examples](/guide/running-examples) — Try the built-in demo with tools, transfers, and image generation
