# Design: Response Watchdog for Silent Model Stalls

**Date:** 2026-05-30
**Status:** Approved — ready for implementation plan
**Area:** `src/core/voice-session.ts` (provider-agnostic), `src/core/constants.ts`

## Problem

Gemini Live can stop emitting after a user finishes a heavy turn (long answer +
large injected KB) **without closing the WebSocket**. The framework only recovers
from an explicit transport `close`/`error` (`VoiceSession.handleTransportClose`,
`voice-session.ts:3288`). A silent stall — socket open, model emitting nothing —
never triggers that path, so the session waits forever.

Observed incident timeline:

- `01:19:08` turn_4 complete (agent asks a follow-up).
- `01:19:44` `"User voice input completed (client audio VAD …; speechDuration=35494ms)"`.
- Then **nothing** — no `Provider recognized user input completed`, no tool calls,
  no assistant transcript — until disconnect at `01:20:31`. ~47s of dead air.

A prior session (`01:06`) hit Gemini close code `1011`, the socket closed, and the
existing reconnect path recovered it. This time the model degraded *silently*
instead of closing, so nothing fired.

## Goal

Convert a permanent silent hang into a brief, automatic reconnect — reusing the
proven recovery machinery — when the model goes silent after the user's turn ends.

Success criteria:

1. After the user's turn ends, if the model emits **nothing** for `responseWatchdogMs`
   (default 8000), the watchdog fires the existing reconnect path.
2. Any model activity before the timeout cancels the watchdog (no false reconnect).
3. A second user turn before the model responds re-arms the watchdog (no spurious fire).
4. The watchdog never fires while not `ACTIVE`, or while already `RECONNECTING`.
5. Unit-tested with a mock transport and fake timers.

Non-goals: reconstructing the user's exact words when no transcript was captured
(see "Re-prompt" below); changing VAD tuning; touching the OpenAI close-driven path.

## Key constraint discovered during design

In a silent stall, **Gemini never transcribed the user input** (no
`onInputTranscription` fired — confirmed by the absent transcript in the incident
log). User messages only enter `ConversationContext` when a transcript finalizes
(`voice-session.ts:627`). Therefore, **unless an external STT is running, the
framework does not have the text of the stalled turn** — literal "re-send the last
user message" is not reliable. This shaped the re-prompt decision below.

## Design

> Note: line numbers below are pre-implementation estimates and have since drifted
> (the file grew during the work). They are approximate locators, not exact;
> grep the named methods/handlers for the current lines.

### 1. Where it lives

`VoiceSession` — provider-agnostic. It owns both the "user finished" signal and the
reconnect machinery, so no transport changes are needed. Covers all transports
(Gemini and OpenAI Realtime).

### 2. Arm

In `completeClientAudioVad` (`voice-session.ts:1935`), on the `'completed'` branch
(the line that logs `"User voice input completed"`, `:1964`): start the watchdog
timer for `responseWatchdogMs`. This is the framework's reliable "user turn ended"
signal and is the exact point that preceded the incident's dead air.

### 3. Disarm

Cancel the timer on the first sign of model life. Chain into the callbacks already
wired in `voice-session.ts:855–890` (preserving existing handlers):

- `onModelTurnStart`
- `onAudioOutput`
- `onToolCall`
- `onTurnComplete`
- `onInterrupted`
- `onOutputTranscription`

A single private `clearResponseWatchdog()` called from each.

### 4. Re-arm

A second `completeClientAudioVad === 'completed'` while the timer is pending simply
restarts it (clear + start). No spurious fire when the user speaks again.

### 5. Fire → recover

On timeout:

- Guard: only proceed if `sessionManager.state === 'ACTIVE'` (skip if already
  `RECONNECTING`/`CLOSED`).
- Log a distinct line, e.g. `"[Watchdog] Model silent ${ms}ms after user turn — forcing reconnect"`.
- Call a new shared `triggerReconnect(reason)` method.

### 6. Shared reconnect method

Extract the body of `handleTransportClose` (`voice-session.ts:3288`) into
`private triggerReconnect(reason: string)`:

- Reuses resumption handle, `reconnectAttempts`/`MAX_RECONNECT_ATTEMPTS` cap,
  `RECONNECT_BACKOFF_MS`, client-audio buffering (`startBuffering`/`stopBuffering`),
  and the `RECONNECTING → ACTIVE` transitions.
- `handleTransportClose` becomes a thin caller: `this.triggerReconnect('transport-close')`.
- The watchdog calls `this.triggerReconnect('response-watchdog')`.

This guarantees the watchdog recovery is *identical* to the proven 01:06 path.

### 7. Re-prompt: best-effort generation nudge (with reconnect-only floor)

After reconnect completes **with a resumption handle** (server still holds the
user's audio), send a **content-less `turnComplete`** to elicit a response from the
restored context — no transcript needed, no duplication of context.

- Wire form (decided): the generic `LLMTransport.triggerGeneration()` is the
  neutral "respond now" primitive (OpenAI → `response.create`), but it is a
  documented **no-op on Gemini** (`gemini-live-transport.ts:601`), and
  `sendContent([], true)` short-circuits to nothing on Gemini (empty realtime
  text, `:558-567`). To make the nudge real on the provider that actually stalls,
  add a dedicated content-less elicit to `GeminiLiveTransport`
  (`session.sendClientContent({ turns: [], turnComplete: true })`), exposed via a
  new **optional** `LLMTransport.elicitResponse?()` implemented **on Gemini only**.
  On a watchdog-driven reconnect, VoiceSession calls
  `transport.elicitResponse?.()` if present, else falls back to
  `transport.triggerGeneration()` (covers OpenAI with no transport edit). Normal
  turn flow is untouched — `triggerGeneration` keeps its existing semantics, so
  there is no double-generation risk.
- This depends on Gemini regenerating from a resumed session — **unverified Gemini
  behavior**. It is therefore best-effort and layered *on top of* reconnect.
- **Floor:** if the nudge elicits nothing, the user simply repeats — exactly the
  01:06 outcome. The watchdog has still converted a permanent hang into a working
  session, which is the primary win.
- Honesty note: the watchdog mechanics are fully unit-testable; the live re-elicit
  behavior can only be confirmed against a real Gemini session and will be flagged
  as such, not asserted as proven.

### 8. Configuration

Add `responseWatchdogMs?: number` to `VoiceSessionConfig` (near `listenTimeoutMs`,
`:217`).

- Default `DEFAULT_RESPONSE_WATCHDOG_MS = 8000` in `src/core/constants.ts`.
- `0` or `undefined`-resolving-to-disabled semantics: a value `<= 0` disables the
  watchdog entirely (escape hatch).
- The interview/screening/example apps are diverged *app-level* copies; this is a
  single framework-level change in `src/`, so all three inherit it without per-copy
  porting.

## Data flow

```
user speaks ──► client audio VAD ──► completeClientAudioVad('completed')
                                          │
                                          └─► start/restart watchdog timer (8s)

model emits (audio | text | toolCall | turnStart | turnComplete | interrupted)
                                          │
                                          └─► clearResponseWatchdog()

timer elapses (state ACTIVE) ──► triggerReconnect('response-watchdog')
                                   │  (resume handle, buffering, backoff, cap)
                                   └─► on reconnect complete ─► best-effort
                                        content-less turnComplete nudge
```

## Error handling / edge cases

- **Already reconnecting:** state guard prevents a watchdog fire from racing a
  close-driven reconnect.
- **Reconnect cap reached:** `triggerReconnect` keeps the existing behavior —
  transition to `CLOSED` after `MAX_RECONNECT_ATTEMPTS`.
- **No resumption handle:** existing path transitions to `CLOSED`; the nudge is
  skipped (nothing to resume into). Unchanged from today's close-driven behavior.
- **User still speaking in segments:** re-arm on each completed segment.
- **Watchdog disabled (`<= 0`):** arm is a no-op; zero behavior change.
- **Session teardown:** clear the timer in the session stop/dispose path to avoid a
  stray fire after close.

## Testing

Mock-transport unit tests with fake timers (`vitest`):

1. user-turn-completed → advance `responseWatchdogMs` with no model callback →
   asserts reconnect triggered.
2. user-turn-completed → model callback (each disarm signal) before timeout →
   asserts **no** reconnect; timer cleared.
3. two user-turn-completed events back-to-back → only one pending timer; fires once.
4. watchdog disabled (`<= 0`) → never fires.
5. not `ACTIVE` when timer elapses → no reconnect.

Live validation (manual, flagged as not-unit-covered): reproduce a long-turn stall
against Gemini and confirm reconnect + nudge restores a responsive session.

## Decisions (from brainstorming)

- Recovery: reconnect (resume-preferred) **+ best-effort generation nudge**, with
  reconnect-only as the guaranteed floor.
- Timeout: **configurable, default 8000ms**.
- Scope: **all transports** (generic `VoiceSession` implementation).
