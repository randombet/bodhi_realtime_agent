# Architecture Overview

This page maps how all core concepts relate to each other. Use it as a mental model for understanding how data and control flow through the framework.

## The Big Picture

Every component lives inside `VoiceSession`. Two WebSocket connections bridge the client and LLM provider, with the framework orchestrating everything in between. The `LLMTransport` interface abstracts provider differences — Gemini Live and OpenAI Realtime are both supported.

```mermaid
graph TB
    subgraph VoiceSession["VoiceSession (orchestrator)"]
        direction TB
        AR[AgentRouter]
        EC[EventBus]
        HM[HooksManager]
        CC[ConversationContext]
        SM[SessionManager]

        subgraph Agents["Agents"]
            A1["Agent: main"]
            A2["Agent: expert"]
        end

        subgraph Tools["Tools"]
            T1["Inline Tool"]
            T2["Background Tool"]
        end

        subgraph Memory["Memory"]
            MD[MemoryDistiller]
            MS[MemoryStore]
        end
    end

    CT[ClientTransport<br/>WebSocket Server]
    LT[LLMTransport<br/>Gemini / OpenAI]
    Client["Client App"]
    LLM["LLM Provider"]

    Client <-->|"binary: audio<br/>text: JSON"| CT
    CT <--> VoiceSession
    VoiceSession <--> LT
    LT <-->|"audio + tool calls<br/>+ transcripts"| LLM

    style VoiceSession fill:#f0f7ff,stroke:#3b82f6
    style Agents fill:#ecfdf5,stroke:#10b981
    style Tools fill:#fef3c7,stroke:#f59e0b
    style Memory fill:#fdf2f8,stroke:#ec4899
    style Client fill:#e0e7ff,stroke:#6366f1
    style LLM fill:#e0e7ff,stroke:#6366f1
```

## Component Ownership

`VoiceSession` creates and manages every other component. Here's the ownership tree:

```mermaid
graph LR
    VS[VoiceSession] --> AR[AgentRouter]
    VS --> CT[ClientTransport]
    VS --> GT[LLMTransport]
    VS --> EB[EventBus]
    VS --> HM[HooksManager]
    VS --> CC[ConversationContext]
    VS --> SM[SessionManager]
    VS --> TM[TranscriptManager]
    VS --> STT["STTProvider<br/>(optional)"]
    VS --> MD[MemoryDistiller]
    VS --> MS[MemoryStore]

    AR --> A["agents[]"]
    AR --> SR[SubagentRunner]
    CC --> CI["conversationItems[]"]
    TM --> CC
    MD --> MS

    style VS fill:#3b82f6,color:#fff,stroke:#1d4ed8
    style STT fill:#f472b6,stroke:#ec4899
    style TM fill:#a78bfa,stroke:#7c3aed
```

## How Agents, Tools, and the LLM Interact

Each agent provides its system instructions and tool set to the LLM. When the model calls a tool, the execution mode determines the path:

```mermaid
flowchart TD
    A["Active Agent"] -->|"instructions + tools"| G["LLM Provider"]
    G -->|"generates voice"| Audio["Audio Response"]
    G -->|"calls function"| TC{"Tool Call"}

    TC -->|"execution: inline"| IT["Inline Tool<br/>(LLM waits)"]
    TC -->|"execution: background"| BT["Background Tool<br/>(Subagent runs)"]

    IT -->|"return result"| G
    BT -->|"pendingMessage"| G
    BT -->|"async execution"| SR["SubagentRunner<br/>(Vercel AI SDK)"]
    SR -->|"result when done"| G

    style A fill:#10b981,color:#fff
    style G fill:#6366f1,color:#fff
    style IT fill:#f59e0b,color:#000
    style BT fill:#ec4899,color:#fff
    style SR fill:#ec4899,color:#fff
```

## Data Flow: A Single Voice Turn

This is what happens when a user speaks and gets a response. Note how audio is forked to both the LLM and the STT provider simultaneously:

```mermaid
sequenceDiagram
    participant C as Client App
    participant CT as ClientTransport
    participant STT as STTProvider
    participant TM as TranscriptManager
    participant GT as LLMTransport
    participant G as LLM Provider
    participant T as Tool

    C->>CT: Binary frame (PCM audio)
    CT->>GT: Forward audio to LLM
    CT->>STT: feedAudio(base64)
    GT->>G: sendAudio(base64)

    Note over STT: (Chrome STT shows<br/>real-time interim<br/>on client)

    Note over G: Process speech<br/>+ generate response

    G->>GT: onModelTurnStart()
    GT->>STT: commit(turnId)

    alt Tool call needed
        G->>GT: onToolCall(name, args)
        GT->>T: execute(args, ctx)
        T->>GT: return result
        GT->>G: sendToolResponse(result)
    end

    STT->>TM: onTranscript(text, turnId)
    TM->>CT: {type: transcript, role: user}
    Note over C: Server text replaces<br/>Chrome STT interim

    G->>GT: onAudioOutput(base64)
    GT->>CT: Forward audio
    CT->>C: Binary frame (PCM audio)

    G->>GT: onTurnComplete()
    TM->>CT: Final transcripts (user + assistant)
    Note over CT,GT: Turn complete,<br/>events published
```

## Agent Transfer Flow

When the model calls `transferToAgent`, the framework handles the transition. For Gemini, this requires a reconnect; for OpenAI, it uses in-place `session.update`:

```mermaid
sequenceDiagram
    participant G as LLM
    participant AR as AgentRouter
    participant CT as ClientTransport
    participant GT as LLMTransport
    participant A as Agent A
    participant B as Agent B

    G->>AR: transferToAgent("agent_b")
    AR->>A: onExit(ctx)
    AR->>CT: startBuffering()
    Note over CT: Audio buffered,<br/>not lost

    AR->>GT: disconnect()
    AR->>GT: connect(agent_b config)
    GT-->>AR: setupComplete

    AR->>CT: stopBuffering()
    CT->>GT: replay buffered audio
    AR->>B: onEnter(ctx)

    Note over G,B: Agent B now active,<br/>seamless to user
```

## Memory Extraction Pipeline

The memory system runs alongside conversation, extracting durable facts about the user:

```mermaid
flowchart LR
    subgraph Triggers
        T1["Every 5th turn"]
        T2["Agent transfer"]
        T3["Tool result"]
        T4["Session close"]
    end

    T1 & T2 & T3 & T4 --> MD["MemoryDistiller<br/>(LLM call)"]
    MD --> MS["MemoryStore<br/>(persistence)"]

    MS --> F1["preference<br/>'dark mode'"]
    MS --> F2["entity<br/>'Acme Corp'"]
    MS --> F3["decision<br/>'Pro plan'"]
    MS --> F4["requirement<br/>'HIPAA'"]

    F1 & F2 & F3 & F4 --> NS["Next Session:<br/>Agent.onEnter()"]
    NS --> INJ["injectSystemMessage()<br/>'User prefers dark mode...'"]

    style MD fill:#ec4899,color:#fff
    style MS fill:#f9a8d4,color:#000
    style NS fill:#10b981,color:#fff
```

## Transcription Pipeline

User speech is transcribed through a dual-layer system: **Chrome STT** provides instant visual feedback on the client, while a **server-side STTProvider** produces the authoritative transcript stored in conversation history.

```mermaid
flowchart TB
    subgraph Client["Client (Browser)"]
        MIC["🎤 Microphone"]
        CSTT["Chrome STT<br/>(SpeechRecognition API)"]
        UI["Transcript Display"]
    end

    subgraph Server["Server (VoiceSession)"]
        CT2["ClientTransport"]

        subgraph STTPath["STT Path (one active per session)"]
            direction LR
            BUILT["Built-in<br/>(transport native)"]
            EXT["External STTProvider<br/>(GeminiBatch / ElevenLabs)"]
        end

        TM2["TranscriptManager"]
    end

    MIC -->|"PCM audio"| CT2
    MIC -->|"audio stream"| CSTT
    CSTT -->|"real-time<br/>interim text"| UI

    CT2 --> STTPath
    STTPath -->|"onTranscript /<br/>onPartialTranscript"| TM2
    TM2 -->|"transcript JSON<br/>(partial + final)"| UI

    UI -.->|"Server final<br/>replaces Chrome<br/>STT interim"| UI

    style Client fill:#e0e7ff,stroke:#6366f1
    style Server fill:#f0f7ff,stroke:#3b82f6
    style STTPath fill:#fef3c7,stroke:#f59e0b
    style CSTT fill:#f472b6,stroke:#ec4899
```

**Key behaviors:**
- Chrome STT shows what the user is saying in real-time (interim text, opacity 60%)
- When the server sends its authoritative transcript, it replaces the Chrome STT text in-place
- Orphaned Chrome STT interims (e.g., from assistant echo) are automatically removed on turn boundaries
- Exactly one server-side STT path is active: either transport built-in or an external `STTProvider`

## EventBus Wiring

All framework components communicate through the EventBus. Hooks provide a curated subset:

```mermaid
graph TB
    subgraph Publishers
        AR2[AgentRouter]
        TE[ToolExecutor]
        SM2[SessionManager]
        SA[SubagentRunner]
    end

    EB[EventBus]

    AR2 -->|"agent.enter<br/>agent.exit<br/>agent.transfer"| EB
    TE -->|"tool.call<br/>tool.result<br/>tool.cancel"| EB
    SM2 -->|"session.start<br/>session.close<br/>turn.start/end"| EB
    SA -->|"subagent.ui.send<br/>subagent.notification"| EB

    EB --> HK["Hooks<br/>(9 callbacks)"]
    EB --> CT2["ClientTransport<br/>(GUI events)"]
    EB --> US["Your Subscribers"]

    HK --> H1["onSessionStart"]
    HK --> H2["onToolCall"]
    HK --> H3["onError"]
    HK --> H4["...6 more"]

    style EB fill:#3b82f6,color:#fff
    style HK fill:#f59e0b,color:#000
```

## Transport Layer

The `LLMTransport` interface abstracts provider differences. An optional `STTProvider` handles user speech transcription independently from the LLM:

```mermaid
graph LR
    subgraph Client Side
        C["Client App"]
    end

    subgraph CT["ClientTransport"]
        WS["WebSocket Server<br/>port 9900"]
        AB["AudioBuffer<br/>(during transfers)"]
    end

    subgraph LT["LLMTransport Interface"]
        GLT["GeminiLiveTransport"]
        ORT["OpenAIRealtimeTransport"]
        ZS["Zod → JSON Schema<br/>converter"]
    end

    subgraph STT["STTProvider (optional)"]
        GBSTT["GeminiBatchSTT"]
        ELSTT["ElevenLabsSTT"]
    end

    subgraph Provider Side
        G["Gemini Live API"]
        O["OpenAI Realtime API"]
    end

    C <-->|"Binary: PCM audio<br/>Text: JSON messages"| WS
    WS <--> AB
    WS <--> LT
    WS -.->|"audio fork"| STT
    ZS -->|"tool declarations"| GLT
    ZS -->|"tool declarations"| ORT
    GLT <-->|"16kHz in / 24kHz out"| G
    ORT <-->|"24kHz in / 24kHz out"| O

    style CT fill:#f0f7ff,stroke:#3b82f6
    style LT fill:#fef3c7,stroke:#f59e0b
    style STT fill:#fdf2f8,stroke:#ec4899
```

## Session State Machine

The `SessionManager` tracks the connection lifecycle:

```mermaid
stateDiagram-v2
    [*] --> CREATED
    CREATED --> CONNECTING: start()
    CONNECTING --> ACTIVE: setupComplete
    ACTIVE --> TRANSFERRING: agent transfer
    ACTIVE --> RECONNECTING: GoAway / disconnect
    TRANSFERRING --> ACTIVE: new session ready
    RECONNECTING --> ACTIVE: reconnected
    ACTIVE --> CLOSED: close()
    TRANSFERRING --> CLOSED: fatal error
    RECONNECTING --> CLOSED: reconnect failed
    CLOSED --> [*]
```

| State | ClientTransport | LLMTransport |
|-------|-----------------|--------------|
| CREATED | Not started | Not connected |
| CONNECTING | Listening | Connecting |
| ACTIVE | Forwarding audio | Streaming |
| TRANSFERRING | Buffering audio (Gemini) / Brief pause (OpenAI) | Reconnecting / session.update |
| RECONNECTING | Buffering audio | Reconnecting |
| CLOSED | Stopped | Disconnected |

## How Concepts Connect

### Agents → Tools → Subagents

```mermaid
graph LR
    AG["Agent"] -->|"owns"| T1["Tool A<br/>(inline)"]
    AG -->|"owns"| T2["Tool B<br/>(inline)"]
    AG -->|"owns"| T3["Tool C<br/>(background)"]

    T1 -->|"execute()"| R1["Result → LLM"]
    T2 -->|"execute()"| R2["Result → LLM"]
    T3 -->|"handoff"| SR["SubagentRunner"]
    SR -->|"generateText()"| LLM["Vercel AI SDK"]
    LLM -->|"result"| R3["Result → LLM"]

    style AG fill:#10b981,color:#fff
    style T1 fill:#f59e0b
    style T2 fill:#f59e0b
    style T3 fill:#ec4899,color:#fff
    style SR fill:#ec4899,color:#fff
```

### Agents → Memory → Agents (cross-session)

```mermaid
graph TB
    subgraph Session1["Session 1"]
        U1["User: 'I prefer dark mode'"]
        MD1["MemoryDistiller"]
        U1 --> MD1
    end

    MD1 -->|"replaceAll()"| MS2["MemoryStore<br/>(persisted)"]

    subgraph Session2["Session 2"]
        OE["Agent.onEnter()"]
        GM["getMemoryFacts()"]
        INJ2["injectSystemMessage()"]
        GEM["LLM knows preference<br/>without being told"]
        OE --> GM --> INJ2 --> GEM
    end

    MS2 -->|"getAll()"| GM

    style Session1 fill:#fef3c7,stroke:#f59e0b
    style Session2 fill:#ecfdf5,stroke:#10b981
    style MS2 fill:#fdf2f8,stroke:#ec4899
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
