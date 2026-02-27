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
    VS --> MD[MemoryDistiller]
    VS --> MS[MemoryStore]

    AR --> A["agents[]"]
    AR --> SR[SubagentRunner]
    CC --> CI["conversationItems[]"]
    MD --> MS

    style VS fill:#3b82f6,color:#fff,stroke:#1d4ed8
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

This is what happens when a user speaks and gets a response:

```mermaid
sequenceDiagram
    participant C as Client App
    participant CT as ClientTransport
    participant GT as LLMTransport
    participant G as LLM Provider
    participant T as Tool

    C->>CT: Binary frame (PCM audio)
    CT->>GT: Forward audio
    GT->>G: sendAudio(base64)
    Note over G: Process speech<br/>+ generate response

    alt Tool call needed
        G->>GT: onToolCall(name, args)
        GT->>T: execute(args, ctx)
        T->>GT: return result
        GT->>G: sendToolResponse(result)
    end

    G->>GT: onAudioOutput(base64)
    GT->>CT: Forward audio
    CT->>C: Binary frame (PCM audio)

    G->>GT: onTurnComplete()
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

The `LLMTransport` interface abstracts provider differences. Two implementations are available:

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

    subgraph Provider Side
        G["Gemini Live API"]
        O["OpenAI Realtime API"]
    end

    C <-->|"Binary: PCM audio<br/>Text: JSON messages"| WS
    WS <--> AB
    WS <--> LT
    ZS -->|"tool declarations"| GLT
    ZS -->|"tool declarations"| ORT
    GLT <-->|"16kHz in / 24kHz out"| G
    ORT <-->|"24kHz in / 24kHz out"| O

    style CT fill:#f0f7ff,stroke:#3b82f6
    style LT fill:#fef3c7,stroke:#f59e0b
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
