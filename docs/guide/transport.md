# Transport

Transport abstracts provider-specific realtime APIs behind a common interface.

## Providers

- Gemini Live transport
- OpenAI Realtime transport

## Responsibilities

- live session connect/disconnect
- turn and interruption handling
- tool call/result protocol mapping
- provider-specific session update and recovery logic

## STT/TTS

- Built-in transcription is supported via transport/provider capabilities.
- External STT/TTS providers can be attached at session level.
