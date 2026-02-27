# Refactoring Audit

Automated analysis of `src/` — 40 files, ~4,100 lines. Issues ranked by severity.

## Critical: voice-session.ts is a God Object (991 lines)

`VoiceSession` is the single biggest risk. It handles 7+ distinct responsibilities in one class:

| Concern | Lines | Description |
|---------|-------|-------------|
| Transcript buffering | 103-106, 752-832 | Input/output dedup, overlap detection, flush logic |
| Directive management | 107-110, 658-682 | Session vs agent scoped directives, merging, clearing |
| Background notifications | 118-121, 684-709 | Queue, conditional send, flush-on-turn-end |
| Memory cache | 100-101, 280-298, 974-984 | Load, refresh, inject into greeting |
| Tool call routing | 410-604 | Inline vs background branching, transfer interception |
| Transport wiring | 193-242 | 8+ inline closure callbacks for Gemini + Client |
| Agent transfer orchestration | 346-375 | Delegates to AgentRouter; rebuilds ToolExecutor + clears directives |

**Extractable classes:** `TranscriptManager`, `DirectiveManager`, `BackgroundNotificationQueue`, `MemoryCacheManager`. Each would be <100 lines and independently testable.

**Code duplication within voice-session.ts:**
- Directive writer closure defined 3 times (lines 161-164, 251-255, 359-363)
- ToolExecutor construction duplicated in constructor and `transfer()` (lines 245-260, 353-366)
- User transcript recording pattern repeated 3 times (lines 419-426, 778-786, 913-921)
- Tool error response sending duplicated for inline/background paths (lines 489-499, 571-596)

---

## High Severity

### 1. AgentRouter has no error recovery in transfer (agent-router.ts)

Lines 77-144: 67-line `transfer()` method with 12 sequential steps and **no try-catch**. If `geminiTransport.reconnect()` fails at step 6, the state machine is stuck in TRANSFERRING with no rollback. Client audio is being buffered and will never be replayed.

### 2. Unsafe initialization: `undefined as unknown as MainAgent` (agent-router.ts:52)

Bypasses type safety for `_activeAgent`. No guard on the `activeAgent` getter (line 69). Any access before `setInitialAgent()` is called will silently return undefined.

### 3. SubagentConfig.timeout is never enforced (subagent-runner.ts)

`SubagentConfig` defines a `timeout` field (types/agent.ts:65), but `runSubagent()` never uses it. The `generateText` call at line 61 can run indefinitely. Only `abortSignal` provides external cancellation.

### 4. Timestamp not persisted to storage — design limitation (json-memory-store.ts:50, types/memory.ts:12)

`JsonMemoryStore` always returns `timestamp: 0` when reading facts from disk. This is **documented behavior** (`types/memory.ts:12`: "0 if parsed from storage"), not an accidental bug. However, it means timestamps set during extraction are lost on the next read, which limits timestamp-based deduplication or age-based pruning. Consider persisting timestamps in the JSON format if these features are needed.

### 5. zod-to-schema.ts relies on Zod private internals (zod-to-schema.ts)

Entire file accesses `_def` property (Zod internal). Typed as `any` throughout (lines 12, 21, 34). Unknown Zod types silently degrade to `{ type: 'STRING' }` (line 84). Invalid schemas silently return `{ type: 'OBJECT', properties: {} }` (line 14). Breakage risk on Zod version bumps.

### 6. Silent error swallowing across transport layer

| File | Line | What's swallowed |
|------|------|-----------------|
| client-transport.ts | 63-65 | Malformed client JSON — empty catch |
| gemini-live-transport.ts | 163-167 | Session close errors — empty catch |
| json-memory-store.ts | 89-91 | All file read errors — returns empty |
| voice-session.ts | 327-332 | Final memory extraction failure |
| voice-session.ts | 280-297 | Memory cache refresh + directive restore |

### 7. Dual hook/event publication (tool-executor.ts, session-manager.ts)

Every tool call and result fires both a `hooks.onToolCall` callback AND an `eventBus.publish('tool.call')` with overlapping data. Same for session start/end, agent transfer. Consumers don't know which to use. Creates maintenance burden when adding new lifecycle events.

### 8. GeminiLiveTransport is approaching God Object (295 lines)

Mixes: WebSocket lifecycle, message routing (9 types in `handleMessage`), config building, tool declaration conversion, connection state. The `connect()` method is 66 lines of config assembly. `handleMessage()` is 67 lines of nested conditionals. Tool conversion (lines 288-295) is a domain concern leaked into transport.

### 9. Unhandled reconnect rejections (voice-session.ts:851, 952)

Two places call `this.geminiTransport.reconnect(handle).then(...)` with **no `.catch()`**. If `reconnect()` rejects, the promise rejection is unhandled and the session state is left stuck in `RECONNECTING`:

- **Line 851** (`handleGoAway`): transitions to RECONNECTING, starts buffering, then `.then()` only — buffered audio is never replayed on failure.
- **Line 952** (`handleTransportClose`): transitions to RECONNECTING, then `.then()` only — no fallback to CLOSED on failure.

### 10. Tool timeout bypasses AbortController (tool-executor.ts:65, 177-178)

The timeout handler at line 177-178 calls `ctx.abortSignal.dispatchEvent(new Event('abort'))` instead of calling `controller.abort()` (controller created at line 65). This fires the `abort` event but does **not** set `signal.aborted = true`, so consumers checking `signal.aborted` (the standard pattern) won't detect the timeout. The AbortController is in scope but unused by the timeout path.

---

## Medium Severity

### Constructor parameter proliferation

| Class | Params | Callbacks |
|-------|--------|-----------|
| AgentRouter | 9 | 2 optional |
| ToolExecutor | 6 | 2 optional |
| MemoryDistiller | 5 | 0 |
| BehaviorManager | 4 | 3 callbacks |

All require extensive mocking in tests. Suggests need for options objects.

### Missing timeouts

- `ClientTransport.start()` — no timeout on WebSocket server listen
- `GeminiLiveTransport.connect()` — no timeout on `setupComplete` message
- `GeminiLiveTransport.reconnect()` — no timeout or retry logic
- `runSubagent()` — no timeout enforcement despite config field

### Error handling inconsistencies

- `tool-executor.ts:110` — converts errors to strings, losing stack traces
- `memory-distiller.ts:153` — wraps in Error, reports to hooks
- `json-memory-store.ts:89` — swallows entirely
- `event-bus.ts:36` — logs to `console.error` (no hooks integration)
- No shared error reporting utility across components

### ClientTransport gaps

- **Race condition** (lines 48-73): `this.client = ws` set before event handlers are attached
- **No client connection promise**: Callers must poll `isClientConnected` or use callback
- **Incomplete cleanup** (line 80): `stop()` doesn't clear `audioBuffer` or reset `_buffering`
- **Unused interface** (line 17): `onImageUpload` callback defined but never invoked

### Type safety issues

| Location | Issue |
|----------|-------|
| gemini-live-transport.ts:218 | `msg: any` for all Gemini messages |
| subagent-runner.ts:65 | `config.tools as Parameters<typeof generateText>[0]['tools']` |
| voice-session.ts:884 | Unsafe assertion on file upload payload |
| voice-session.ts:896 | `as never[]` defeats type checking entirely |
| json-memory-store.ts:81 | `as Partial<MemoryFile>` without validation |

### Hardcoded schema duplication (memory-distiller.ts:10-17, types/memory.ts:4)

Zod schema defines `['preference', 'entity', 'decision', 'requirement']` — must be manually kept in sync with the `MemoryCategory` type union. No single source of truth.

### ConversationContext.toReplayContent() couples to Gemini wire format (lines 116-132)

Serialization to Gemini's `Content[]` structure belongs in the transport layer, not the domain model.

### Config mutation in GeminiLiveTransport (lines 154-159)

`reconnect()` mutates `this.config.resumptionHandle`. If config objects are shared, instances interfere with each other.

### Dynamic import in hot path (memory-distiller.ts:119)

`const { generateObject } = await import('ai')` runs inside every extraction call. Should be a top-level import.

---

## Low Severity

- **Magic numbers**: `30_000` timeout duplicated in tool-executor.ts:102 and memory-distiller.ts:63. Turn frequency `5` also duplicated.
- **Preset factory duplication**: `speechSpeed()` and `verbosity()` in presets.ts have identical structure (lines 6-30 vs 33-57). Could use a generic factory.
- **HooksManager getters**: 9 identical `get onX() { return this.hooks.onX; }` methods (hooks.ts:17-43). Could use a Proxy.
- **Error subclass boilerplate**: 6 error classes with identical constructor patterns (errors.ts:28-75). Could use a factory.
- **WebSocket.OPEN magic number**: `readyState === 1` hardcoded 3 times in client-transport.ts (lines 94, 101, 117).
- **No event timestamps**: EventPayloadMap (events.ts) defines 15+ events, none include a `timestamp` field.
- **AudioBuffer edge case**: Single chunks exceeding `maxBytes` bypass capacity limit (audio-buffer.ts:28-33).
- **`_scheduling` unused parameter**: gemini-live-transport.ts:183 accepts but ignores scheduling parameter.
- **Prompt template fragility**: `.replace('{placeholder}', value)` pattern in memory-distiller.ts:105-113. Typos in placeholder names fail silently.

---

## Summary

| Severity | Count | Top areas |
|----------|-------|-----------|
| Critical | 1 | voice-session.ts God Object |
| High | 10 | Error recovery, unhandled rejections, abort correctness, type safety, silent failures |
| Medium | ~20 | Timeouts, constructors, duplication, coupling |
| Low | ~15 | Constants, boilerplate, naming |

### Recommended priority order

1. **Fix unhandled reconnect rejections** — prevents stuck RECONNECTING state and unhandled promise rejections
2. **Fix tool timeout AbortController bypass** — ensures signal.aborted is set correctly
3. **Extract classes from VoiceSession** — biggest impact on maintainability and testability
4. **Add try-catch to AgentRouter.transfer()** — prevents stuck state machine
5. **Add timeouts to transport connect/reconnect** — prevents hanging promises
6. **Unify error handling** — shared utility, consistent catch patterns
7. **Reduce constructor params** — options objects for >4 params
