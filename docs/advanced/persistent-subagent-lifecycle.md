# Persistent Subagent Lifecycle

This page documents the current actor-runtime lifecycle for `persistent_session` subagents (for example, `ask_openclaw` in `app/openclaw-demo.ts`).

## Where It Is Configured

- `ask_openclaw` is wired to a persistent config via `createPersistentOpenClawSubagentConfig(...)`.
- That config sets:
  - `lifetime: 'persistent_session'`
  - `persistentFactory: (...) => new PersistentOpenClawSubagent(...)`

## End-to-End Sequence

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant LLM as Main Agent (Gemini)
    participant Router as ToolRouterActor
    participant Sup as SubagentSupervisorActor
    participant Exec as VoiceSession.backgroundExecutor
    participant PM as PersistentSubagentManager
    participant OCSub as PersistentOpenClawSubagent
    participant OCGW as OpenClaw Gateway

    User->>LLM: "Research X and email me"
    LLM->>Router: tool call ask_openclaw(task)
    Router-->>LLM: immediate tool_result (still_in_progress)
    Router->>Sup: subagent.spawn_requested(configName=ask_openclaw, lifetime=persistent_session)

    Sup->>Exec: executionHandler(request)
    Exec->>PM: acquirePersistent("ask_openclaw")
    alt First call in VoiceSession
        PM->>OCSub: create via persistentFactory
    else Existing instance
        PM-->>Exec: reuse existing instance
    end

    Exec->>PM: invoke(key, args, signal)
    PM->>OCSub: invoke(...)
    OCSub->>OCGW: chat.send(sessionKey, message)
    OCGW-->>OCSub: delta/final events
    OCSub-->>PM: final text
    PM-->>Exec: final text

    Exec->>Exec: add tool_result to conversation
    Exec->>Exec: queue completion/failure notification for user voice update
    Exec-->>Sup: return final text
    Sup-->>LLM: transport.send_tool_result(...when_idle)
    LLM-->>User: completion update
```

## Persistent Instance State

```mermaid
stateDiagram-v2
    [*] --> NotCreated
    NotCreated --> Ready : first acquirePersistent(key)

    Ready --> Running : invoke(...)
    Running --> Ready : final result
    Running --> Ready : error/aborted

    Ready --> Disposed : VoiceSession.close() -> disposeAllPersistent()
    Running --> Disposed : close while running (abort + dispose)
    Disposed --> [*]
```

## Ownership Boundaries

- `ToolRouterActor`: decides inline vs background; emits `subagent.spawn_requested`.
- `SubagentSupervisorActor`: owns workflow state (`running`, `waiting_input`, `completed`, `failed`, `cancelled`).
- `VoiceSession.backgroundExecutor`: picks persistent vs fallback handoff execution path.
- `PersistentSubagentManager`: owns persistent instance registry and reuse by key.
- `PersistentOpenClawSubagent`: owns provider call loop (`chatSend` + streamed `nextChatEvent`).

## Key Behavior Notes

- One persistent instance per `(VoiceSession, subagent key)`; current key is `configName` (for `ask_openclaw`, key is `ask_openclaw`).
- Persistent instances are disposed when `VoiceSession.close()` runs.
- For tools with `pendingMessage`, completion/failure updates are queued as system notifications so the main LLM can reliably speak progress back.

## Routing Precedence (OpenClaw Demo)

In `app/openclaw-demo.ts`, explicit mentions of OpenClaw route to `ask_openclaw`, but media generation has higher precedence:

- Image/visual generation requests must route to `generate_image`.
- Video/motion generation requests must route to `generate_video`.
- OpenClaw is not used for image/video generation in this demo configuration.

This prevents explicit phrases like "use OpenClaw" from accidentally bypassing media tools for image/video tasks.

## Code Map

- `app/openclaw-demo.ts`
- `app/lib/openclaw-tools.ts`
- `app/lib/persistent-openclaw-subagent.ts`
- `src/core/voice-session.ts`
- `src/agent/persistent-subagent-manager.ts`
- `src/runtime/actors/tool-router-actor.ts`
- `src/runtime/actors/subagent-supervisor-actor.ts`
- `src/transport/gemini-live-transport.ts`
