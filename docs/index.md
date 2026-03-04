---
layout: home

hero:
  name: Bodhi Realtime Agent Framework
  text: Build Real-Time Voice Agents
  tagline: TypeScript framework for voice AI applications — supports Google Gemini Live and OpenAI Realtime APIs
  actions:
    - theme: brand
      text: Get Started
      link: /guide/
    - theme: alt
      text: API Reference
      link: /api/
    - theme: alt
      text: GitHub
      link: https://github.com/randombet/bodhi_realtime_agent

features:
  - title: Real-Time Voice
    details: Bidirectional audio streaming via a provider-agnostic LLMTransport interface. Supports Google Gemini Live and OpenAI Realtime APIs with server-side turn detection, pluggable STT providers, and sub-500ms latency.
  - title: Multi-Agent
    details: Define multiple agents with distinct personas and tool sets. Transfer between them mid-conversation with automatic context preservation.
  - title: Function Tools
    details: Inline (blocking) and background (non-blocking) tool execution. Zod schema validation, timeout, cancellation, and abort signals.
  - title: Memory
    details: Automatic extraction and persistence of durable user facts across sessions. LLM-powered distillation with configurable triggers.
  - title: Observability
    details: Type-safe EventBus and lifecycle hooks for logging, metrics, and debugging. Zero overhead when unattached.
  - title: Multimodal
    details: Voice, text input, file upload, and image generation on a single WebSocket connection. Mixed-mode interaction out of the box.
---
