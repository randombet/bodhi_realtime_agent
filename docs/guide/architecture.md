# Architecture Overview

This page maps how all core concepts relate to each other. Use it as a mental model for understanding how data and control flow through the framework.

## The Big Picture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          VoiceSession                               │
│                    (top-level orchestrator)                          │
│                                                                     │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────────────────┐ │
│  │   Agents    │    │    Tools     │    │      Memory            │ │
│  │  ┌───────┐  │    │  ┌────────┐  │    │  ┌──────────────────┐  │ │
│  │  │ main  │  │    │  │ inline │  │    │  │ MemoryDistiller  │  │ │
│  │  │ agent │──┼────┼──│  tool  │  │    │  │   (extracts)     │  │ │
│  │  └───────┘  │    │  └────────┘  │    │  └────────┬─────────┘  │ │
│  │  ┌───────┐  │    │  ┌────────┐  │    │           │            │ │
│  │  │expert │  │    │  │  bg    │──┼────┼──►Subagent │            │ │
│  │  │ agent │  │    │  │  tool  │  │    │           ▼            │ │
│  │  └───────┘  │    │  └────────┘  │    │  ┌──────────────────┐  │ │
│  └─────────────┘    └──────────────┘    │  │  MemoryStore     │  │ │
│                                          │  │  (persists)      │  │ │
│  ┌────────────────────────────────────┐  │  └──────────────────┘  │ │
│  │          EventBus + Hooks          │  └────────────────────────┘ │
│  │  (observability & coordination)    │                             │
│  └────────────────────────────────────┘                             │
│                                                                     │
│  ┌──────────────────┐    ┌───────────────────┐                     │
│  │ ClientTransport   │    │ GeminiLiveTransport│                    │
│  │ (WebSocket server)│    │ (WebSocket client) │                    │
│  └────────┬─────────┘    └─────────┬─────────┘                     │
└───────────┼─────────────────────────┼───────────────────────────────┘
            │                         │
            ▼                         ▼
      ┌──────────┐              ┌──────────┐
      │  Client  │              │  Gemini  │
      │   App    │              │ Live API │
      └──────────┘              └──────────┘
```

## Component Relationships

### VoiceSession owns everything

`VoiceSession` is the entry point. It creates, wires, and manages every other component:

```
VoiceSession
  ├── agents[]              — Agent definitions
  ├── AgentRouter           — Handles transfers and subagent handoffs
  ├── ClientTransport       — Client WebSocket server
  ├── GeminiLiveTransport   — Gemini WebSocket client
  ├── EventBus              — Internal event system
  ├── HooksManager          — Lifecycle callbacks
  ├── ConversationContext    — Conversation state
  ├── SessionManager        — Connection state machine
  ├── MemoryDistiller       — Fact extraction (optional)
  └── MemoryStore           — Fact persistence (optional)
```

### How agents, tools, and Gemini interact

```
                    ┌─────────────────────┐
                    │      Gemini         │
                    │   (voice + brain)   │
                    └──────┬──────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        system         audio        tool calls
      instruction    streaming     (function calls)
              │            │            │
              ▼            ▼            ▼
        ┌─────────┐  ┌─────────┐  ┌─────────┐
        │  Agent  │  │Transport│  │  Tools  │
        │(persona)│  │ (audio) │  │(actions)│
        └─────────┘  └─────────┘  └────┬────┘
                                       │
                          ┌────────────┴────────────┐
                          ▼                         ▼
                    ┌───────────┐            ┌────────────┐
                    │  inline   │            │ background  │
                    │ (Gemini   │            │ (subagent   │
                    │  waits)   │            │  runs async)│
                    └───────────┘            └────────────┘
```

**Flow:**
1. The active **Agent** provides its `instructions` and `tools` to Gemini
2. **Gemini** generates voice responses and may call tools
3. **Inline tools** execute and return results to Gemini immediately
4. **Background tools** send a `pendingMessage` to Gemini and run via a subagent

### Data flow for a single voice turn

```
User speaks
  │
  ▼
Client App ──(binary frame)──► ClientTransport ──(PCM audio)──► GeminiLiveTransport ──► Gemini
                                                                                          │
                                                                              Gemini processes
                                                                              (may call tools)
                                                                                          │
Gemini responds                                                                           │
  │                                                                                       │
  ▼                                                                                       ▼
Client App ◄──(binary frame)── ClientTransport ◄──(PCM audio)── GeminiLiveTransport ◄── Gemini
  │
  ▼
User hears response
```

### Agent transfer flow

```
Agent A active
  │
  ▼
Gemini calls transferToAgent("agent_b")
  │
  ▼
AgentRouter receives transfer request
  │
  ├── 1. Agent A.onExit(ctx)        ← lifecycle hook
  ├── 2. ClientTransport.startBuffering()  ← audio buffered
  ├── 3. GeminiLiveTransport.disconnect()
  ├── 4. GeminiLiveTransport.connect()     ← new session with Agent B config
  ├── 5. Replay buffered audio
  └── 6. Agent B.onEnter(ctx)        ← lifecycle hook
         │
         ▼
Agent B active (seamless to user)
```

### Memory extraction pipeline

```
Conversation turns accumulate
  │
  ├── Every 5th turn ─────────┐
  ├── Agent transfer ──────────┤
  ├── Tool result ─────────────┤
  └── Session close ───────────┤
                               ▼
                    ┌──────────────────┐
                    │ MemoryDistiller  │
                    │  (LLM call to    │
                    │   extract facts) │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │   MemoryStore    │
                    │  (persistence)   │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        preference      entity        decision
        "dark mode"   "Acme Corp"   "Pro plan"
                             │
                             ▼
              Next session: Agent.onEnter()
              reads facts → injectSystemMessage()
```

### EventBus wiring diagram

```
                          ┌──────────────┐
                          │   EventBus   │
                          └──────┬───────┘
                                 │
        ┌────────────────┬───────┼───────┬────────────────┐
        │                │       │       │                │
        ▼                ▼       ▼       ▼                ▼
  ┌──────────┐   ┌────────┐  ┌─────┐  ┌──────┐   ┌───────────┐
  │  Agent   │   │  Tool  │  │Turn │  │ GUI  │   │  Session  │
  │  events  │   │ events │  │evts │  │events│   │  events   │
  ├──────────┤   ├────────┤  ├─────┤  ├──────┤   ├───────────┤
  │ .enter   │   │ .call  │  │.start│ │.update│  │ .start    │
  │ .exit    │   │ .result│  │.end  │ │.notif │  │ .close    │
  │ .transfer│   │ .cancel│  │.intr │ └──────┘  │ .stateChg │
  │ .handoff │   └────────┘  └─────┘            │ .goaway   │
  └──────────┘                                   └───────────┘
        │                                              │
        ▼                                              ▼
  ┌──────────┐                                 ┌───────────┐
  │  Hooks   │ ← onAgentTransfer               │   Hooks   │ ← onSessionStart
  │          │ ← onToolCall                    │           │ ← onSessionEnd
  │          │ ← onToolResult                  │           │ ← onError
  └──────────┘                                 └───────────┘
```

### Transport layer detail

```
┌─────────────────────────────────────────────────┐
│                ClientTransport                   │
│                                                  │
│  WebSocket Server (port 9900)                    │
│                                                  │
│  Binary frames (audio):                          │
│    IN:  onAudioFromClient → GeminiLiveTransport  │
│    OUT: sendAudioToClient ← GeminiLiveTransport  │
│                                                  │
│  Text frames (JSON):                             │
│    IN:  onJsonFromClient → EventBus              │
│    OUT: sendJsonToClient ← EventBus / Tools      │
│                                                  │
│  Buffering:                                      │
│    startBuffering() → AudioBuffer (during xfer)  │
│    stopBuffering()  → drain & replay             │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│             GeminiLiveTransport                   │
│                                                  │
│  WebSocket Client → Gemini Live API              │
│                                                  │
│  Outbound:                                       │
│    sendAudio(base64)    — user voice             │
│    sendToolResponse()   — tool results           │
│    sendClientContent()  — context replay         │
│                                                  │
│  Inbound callbacks:                              │
│    onAudioOutput        — model voice            │
│    onToolCall           — function requests       │
│    onTurnComplete       — end of model turn      │
│    onGoAway             — reconnect signal       │
│    onInputTranscription — user speech text       │
│    onOutputTranscription— model speech text      │
└─────────────────────────────────────────────────┘
```

## How Concepts Connect

### Agent → Tools → Subagents

Each agent carries its own tool set. When Gemini calls a tool, the execution mode determines the path:

```
Agent.tools = [toolA, toolB, toolC]
                 │        │        │
                 ▼        ▼        ▼
            inline    inline   background
                 │        │        │
                 ▼        ▼        ▼
          execute()  execute()  SubagentRunner
          return ──► Gemini    ├── generateText()
                               ├── tool calls
                               └── return ──► Gemini
```

### Agents → Memory → Agents

Memory creates continuity across sessions. Agents write memory (indirectly, via conversation) and read it (directly, via lifecycle hooks):

```
Session 1:  User says "I prefer dark mode"
              │
              ▼
            MemoryDistiller extracts: { preference: "dark mode" }
              │
              ▼
            MemoryStore.addFacts()

Session 2:  Agent.onEnter()
              │
              ▼
            ctx.getMemoryFacts() → [{ content: "dark mode", category: "preference" }]
              │
              ▼
            ctx.injectSystemMessage("User prefers dark mode")
              │
              ▼
            Gemini knows the preference without being told again
```

### EventBus → Hooks → Observability

The EventBus is the internal nervous system. Hooks provide a curated API on top:

```
Framework internal event  ──► EventBus.publish()
                                    │
                     ┌──────────────┼──────────────┐
                     ▼              ▼              ▼
              EventBus         HooksManager    ClientTransport
              subscribers      (curated)       (GUI events)
              (any event)           │
                                    ▼
                              onToolCall()
                              onError()
                              onSessionStart()
                              ...
```

### Session State → Transport Behavior

The session state machine drives transport behavior:

```
State          │ ClientTransport        │ GeminiLiveTransport
───────────────┼────────────────────────┼────────────────────
CREATED        │ Not started            │ Not connected
CONNECTING     │ Listening              │ Connecting
ACTIVE         │ Forwarding audio       │ Streaming
TRANSFERRING   │ Buffering audio        │ Disconnecting/reconnecting
RECONNECTING   │ Buffering audio        │ Reconnecting with handle
CLOSED         │ Stopped                │ Disconnected
```

## Reading Order

If you're new to the framework, read the docs in this order:

1. **[VoiceSession](/guide/voice-session)** — The entry point. Understand how everything is wired.
2. **[Agents](/guide/agents)** — Define personalities and route conversations.
3. **[Tools](/guide/tools)** — Give agents the ability to take actions.
4. **[Memory](/guide/memory)** — Remember users across sessions.
5. **[Events & Hooks](/guide/events)** — Observe and react to everything happening.
6. **[Transport](/guide/transport)** — Understand the audio and message plumbing.
7. **[Subagent Patterns](/advanced/subagents)** — Background execution for complex tasks.
