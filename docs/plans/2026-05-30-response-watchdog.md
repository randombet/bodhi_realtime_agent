# Response Watchdog Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert a silent Gemini Live model stall (socket open, no output after the user's turn ends) into an automatic reconnect by adding a response watchdog in `VoiceSession`.

**Architecture:** A configurable timer in `VoiceSession` arms when the user's turn ends (`completeClientAudioVad`), disarms on any model-activity callback, and on timeout invokes a shared `triggerReconnect()` extracted from the existing close-driven recovery. After a watchdog-driven reconnect, a best-effort generation nudge re-elicits a response: a new optional `LLMTransport.elicitResponse?()` (implemented on Gemini as a content-less `turnComplete`), with `triggerGeneration()` as the fallback.

**Tech Stack:** TypeScript, Vitest (fake timers), Biome. `@google/genai` Live SDK.

**Design doc:** `docs/plans/2026-05-30-response-watchdog-design.md`

**Conventions:** First line of every `src/`/`test/` file is ``. Run a single test file with `pnpm test -- --run path/to/file.test.ts`. Each task ends with a commit.

---

## Task 1: Add the watchdog constant and config field

**Files:**
- Modify: `src/core/constants.ts` (after `DEFAULT_RECONNECT_TIMEOUT_MS`, line 13)
- Modify: `src/core/voice-session.ts` (`VoiceSessionConfig`, near `listenTimeoutMs:217`)

**Step 1: Add the constant**

In `src/core/constants.ts`, after line 13:

```ts
/** Default model-silence watchdog after the user's turn ends (ms). A silent
 *  stall (socket open, no model output) past this forces a reconnect.
 *  `<= 0` disables the watchdog. */
export const DEFAULT_RESPONSE_WATCHDOG_MS = 8_000;
```

**Step 2: Add the config field**

In `src/core/voice-session.ts`, in `VoiceSessionConfig`, after `listenTimeoutMs?: number;` (line 217):

```ts
	/** Model-silence watchdog (ms) after the user's turn ends. If the model emits
	 *  nothing for this long, force a reconnect. Default 8000; `<= 0` disables. */
	responseWatchdogMs?: number;
```

**Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no usages yet).

**Step 4: Commit**

```bash
git add src/core/constants.ts src/core/voice-session.ts
git commit -m "feat(voice-session): add responseWatchdogMs config + default constant"
```

---

## Task 2: Extract `triggerReconnect()` from `handleTransportClose` (pure refactor)

This is a no-behavior-change refactor so the watchdog can reuse the proven path. Existing tests must stay green.

**Files:**
- Modify: `src/core/voice-session.ts` (`handleTransportClose`, lines 3288-3330)

**Step 1: Add the shared method**

Add a new private method (place directly above `handleTransportClose`):

```ts
	/** Force a reconnect using the proven resumption-handle + buffering path.
	 *  Shared by the transport-close handler and the response watchdog.
	 *  @param reason short tag for logs
	 *  @param elicit when true, after a successful reconnect, nudge the model to
	 *    respond (used by the watchdog — a stalled turn has no pending generation). */
	private triggerReconnect(reason: string, elicit = false): void {
		if (this.sessionManager.state !== 'ACTIVE') return;
		const handle = this.sessionManager.resumptionHandle;
		if (handle && this.reconnectAttempts < VoiceSession.MAX_RECONNECT_ATTEMPTS) {
			const attempt = this.reconnectAttempts++;
			const delay = VoiceSession.RECONNECT_BACKOFF_MS[attempt] ?? 4000;
			this.log(
				`Reconnect attempt ${attempt + 1}/${VoiceSession.MAX_RECONNECT_ATTEMPTS} in ${delay}ms (reason=${reason})`,
			);
			this.sessionManager.transitionTo('RECONNECTING');
			this.clientTransport.startBuffering();
			setTimeout(() => {
				this.transport
					.reconnect({
						resumptionHandle: handle,
						conversationHistory: this.conversationContext.toReplayContent(),
					})
					.then(() => {
						const buffered = this.clientTransport.stopBuffering();
						for (const chunk of buffered) {
							this.transport.sendAudio(chunk.toString('base64'));
						}
						this.sessionManager.transitionTo('ACTIVE');
						this.log('Reconnect complete; session ACTIVE');
						if (elicit) this.elicitModelResponse(reason);
					})
					.catch((err) => {
						this.clientTransport.stopBuffering();
						this.reportError('reconnect', err);
						this.sessionManager.transitionTo('CLOSED');
					});
			}, delay);
		} else {
			if (this.reconnectAttempts >= VoiceSession.MAX_RECONNECT_ATTEMPTS) {
				this.log(
					`Reconnect limit reached (${VoiceSession.MAX_RECONNECT_ATTEMPTS} attempts), giving up`,
				);
			}
			this.sessionManager.transitionTo('CLOSED');
		}
	}
```

Add a temporary stub for `elicitModelResponse` (filled in Task 4) so this compiles:

```ts
	/** Best-effort post-reconnect generation nudge. Filled in Task 4. */
	private elicitModelResponse(_reason: string): void {}
```

**Step 2: Rewrite `handleTransportClose` to delegate**

Replace the body inside `if (this.sessionManager.state === 'ACTIVE')` … else block (lines 3291-3329) so the whole method becomes:

```ts
	private handleTransportClose(code?: number, reason?: string): void {
		const detail = code != null ? ` code=${code}${reason ? ` reason="${reason}"` : ''}` : '';
		this.log(`Transport closed (state=${this.sessionManager.state}${detail})`);
		this.triggerReconnect('transport-close');
	}
```

Note: the original early-returns when state !== ACTIVE; `triggerReconnect` does the same guard, so behavior is preserved.

**Step 3: Run the full suite to prove no regression**

Run: `pnpm test`
Expected: PASS — same set as before (the reconnect/close tests still pass).

**Step 4: Commit**

```bash
git add src/core/voice-session.ts
git commit -m "refactor(voice-session): extract triggerReconnect() shared by close handler"
```

---

## Task 3: The watchdog — arm, disarm, re-arm, fire (TDD)

**Files:**
- Create: `test/core/voice-session-response-watchdog.test.ts`
- Modify: `src/core/voice-session.ts`

### Step 1: Write the failing test file

Create `test/core/voice-session-response-watchdog.test.ts`. Model the harness on `test/core/voice-session-native-playback.test.ts` (mock transport, fake timers).

```ts


import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	TransportCapabilities,
} from '../../src/types/transport.js';

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return { name: 'main', instructions: 'You are a concise assistant.', tools: [] };
}

function createMockTransport(): LLMTransport {
	return {
		capabilities: {
			messageTruncation: true,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: true,
			sessionResumption: true,
			contextCompression: false,
			groundingMetadata: false,
			textResponseModality: true,
		} satisfies TransportCapabilities,
		audioFormat: {
			inputSampleRate: 16000,
			outputSampleRate: 24000,
			channels: 1,
			bitDepth: 16,
			encoding: 'pcm',
		} satisfies AudioFormatSpec,
		isConnected: true,
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		reconnect: vi.fn().mockResolvedValue(undefined),
		sendAudio: vi.fn(),
		commitAudio: vi.fn(),
		clearAudio: vi.fn(),
		updateSession: vi.fn(async () => {}),
		transferSession: vi.fn().mockResolvedValue(undefined),
		sendContent: vi.fn(),
		sendFile: vi.fn(),
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
	};
}

/** A 30 ms client mic frame (16 kHz PCM16) at the given amplitude. */
function micFrame(amplitude: number): Buffer {
	const f = Buffer.alloc(480 * 2);
	for (let i = 0; i < f.length; i += 2) f.writeInt16LE(amplitude, i);
	return f;
}

function setup(responseWatchdogMs = 8000) {
	const transport = createMockTransport();
	const session = new VoiceSession({
		sessionId: 'sess_watchdog',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [createAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport,
		orchestrationMode: 'actor',
		clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		clientAudioVad: { bargeInConfirmMs: 0 },
		responseWatchdogMs,
	});
	return { transport, session };
}

/** Drive client audio VAD to a completed user turn (arms the watchdog). */
function completeUserTurn(session: VoiceSession) {
	session.feedAudioFromClient(micFrame(2400)); // speech start
	vi.advanceTimersByTime(150); // > AUDIO_VAD_MIN_SPEECH_MS (120)
	session.feedAudioFromClient(micFrame(2400)); // still speaking; duration ~150ms
	vi.advanceTimersByTime(500); // >= AUDIO_VAD_SILENCE_MS (500)
	session.feedAudioFromClient(micFrame(0)); // silence → completeClientAudioVad('silence')
}

async function activate(session: VoiceSession, transport: LLMTransport) {
	await session.start();
	transport.onSessionReady?.('mock_session'); // → ACTIVE
	transport.onResumptionUpdate?.('handle-1', true); // give reconnect a handle
}

describe('response watchdog', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('forces a reconnect when the model is silent after the user turn ends', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await activate(session, s.transport);

			completeUserTurn(session);
			expect(s.transport.reconnect).not.toHaveBeenCalled();

			vi.advanceTimersByTime(8000); // watchdog fires
			vi.advanceTimersByTime(1000); // first backoff delay → reconnect()
			expect(s.transport.reconnect).toHaveBeenCalledTimes(1);
		} finally {
			await session?.close();
		}
	});

	it('does not reconnect when the model responds before the timeout', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await activate(session, s.transport);

			completeUserTurn(session);
			s.transport.onModelTurnStart?.(); // sign of life → disarm

			vi.advanceTimersByTime(20000);
			expect(s.transport.reconnect).not.toHaveBeenCalled();
		} finally {
			await session?.close();
		}
	});

	it('fires only once when the user speaks twice before any model output', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await activate(session, s.transport);

			completeUserTurn(session); // arm
			vi.advanceTimersByTime(3000); // not yet fired
			completeUserTurn(session); // re-arm (restart timer)
			vi.advanceTimersByTime(8000); // fires once
			vi.advanceTimersByTime(1000);
			expect(s.transport.reconnect).toHaveBeenCalledTimes(1);
		} finally {
			await session?.close();
		}
	});

	it('is disabled when responseWatchdogMs <= 0', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup(0);
			session = s.session;
			await activate(session, s.transport);

			completeUserTurn(session);
			vi.advanceTimersByTime(20000);
			expect(s.transport.reconnect).not.toHaveBeenCalled();
		} finally {
			await session?.close();
		}
	});
});
```

### Step 2: Run it — verify it fails

Run: `pnpm test -- --run test/core/voice-session-response-watchdog.test.ts`
Expected: FAIL — the first/third tests expect `reconnect` to have been called, but no watchdog exists yet.

### Step 3: Implement the watchdog

In `src/core/voice-session.ts`:

**(a)** Add fields near the other private timers (e.g. by line 533):

```ts
	/** Pending response-watchdog timer (model-silence-after-user-turn). */
	private _responseWatchdogTimer?: ReturnType<typeof setTimeout>;
	/** Resolved watchdog timeout (ms); `<= 0` disables. Set in the constructor. */
	private readonly responseWatchdogMs: number;
```

**(b)** In the constructor (with the other config resolution, e.g. near `:646`), import and resolve the default:

```ts
		this.responseWatchdogMs = config.responseWatchdogMs ?? DEFAULT_RESPONSE_WATCHDOG_MS;
```

Add `DEFAULT_RESPONSE_WATCHDOG_MS` to the existing import from `./constants.js`.

**(c)** Add arm/clear helpers (place near `clearNativePlaybackTimer`, ~`:2412`):

```ts
	/** Arm (or re-arm) the response watchdog after the user's turn ends. */
	private armResponseWatchdog(): void {
		if (this.responseWatchdogMs <= 0) return;
		this.clearResponseWatchdog();
		this._responseWatchdogTimer = setTimeout(() => {
			this._responseWatchdogTimer = undefined;
			if (this.sessionManager.state !== 'ACTIVE') return;
			this.log(
				`[Watchdog] Model silent ${this.responseWatchdogMs}ms after user turn — forcing reconnect`,
			);
			this.triggerReconnect('response-watchdog', true);
		}, this.responseWatchdogMs);
	}

	/** Cancel the response watchdog (model showed activity, or teardown). */
	private clearResponseWatchdog(): void {
		if (this._responseWatchdogTimer) {
			clearTimeout(this._responseWatchdogTimer);
			this._responseWatchdogTimer = undefined;
		}
	}
```

**(d) Arm** on a completed user turn. In `completeClientAudioVad` (`:1935`), on the `'completed'` path — right before `return 'completed';` (after the log at `:1964`):

```ts
		this.armResponseWatchdog();
		return 'completed';
```

**(e) Disarm** on model activity. Add `this.clearResponseWatchdog();` at the start of each of these handlers (do NOT remove existing logic):

- `onModelTurnStart` chained handler (`:1005`) — add at the top of the arrow body.
- `handleAudioOutput` (`:2009`) — add after the `internalMode !== 'agent'` early-return guard.
- `onToolCall` handler (`:856`) — add at the top.
- `handleTurnComplete` — add at the top (find it: `private handleTurnComplete`).
- `handleInterrupted` — add at the top (find it: `private handleInterrupted`).
- `onOutputTranscription` handler (`:880`) — add at the top of the arrow body.

> Rationale: any of these is the model showing life; the first one cancels the timer. Multiple calls are safe (idempotent clear).

**(f) Clear on teardown.** In `close()` (`:1575`), alongside `this.ttsClearTimers();` (~`:1609`):

```ts
		this.clearResponseWatchdog();
```

### Step 4: Run the watchdog tests — verify pass

Run: `pnpm test -- --run test/core/voice-session-response-watchdog.test.ts`
Expected: PASS (all 4).

### Step 5: Run the full suite — no regressions

Run: `pnpm test`
Expected: PASS.

### Step 6: Commit

```bash
git add src/core/voice-session.ts test/core/voice-session-response-watchdog.test.ts
git commit -m "feat(voice-session): response watchdog forces reconnect on silent model stall"
```

---

## Task 4: Generation nudge — `elicitResponse?()` on Gemini + post-reconnect call (TDD)

**Files:**
- Modify: `src/types/transport.ts` (`LLMTransport` interface, near `triggerGeneration:528`)
- Modify: `src/transport/gemini-live-transport.ts` (near `triggerGeneration:601`)
- Modify: `src/core/voice-session.ts` (`elicitModelResponse` stub from Task 2)
- Modify: `test/transport/gemini-live-transport.test.ts`

### Step 1: Add the optional interface method

In `src/types/transport.ts`, after the `triggerGeneration(...)` declaration (`:531`):

```ts
	/** Best-effort re-elicit of a model response from existing/restored context,
	 *  without injecting new content. Used after a watchdog-driven reconnect to
	 *  recover a turn the model silently dropped. Optional — transports that
	 *  auto-generate (or cannot elicit without content) may omit it; callers fall
	 *  back to `triggerGeneration()`. Gemini implements it as a content-less
	 *  `turnComplete`. */
	elicitResponse?(): void;
```

### Step 2: Write the failing Gemini transport test

In `test/transport/gemini-live-transport.test.ts`, add a test (mirroring the existing `connect()` + `mockSession.sendClientContent` pattern):

```ts
	it('elicitResponse sends a content-less turnComplete', async () => {
		await transport.connect();
		mockSession.sendClientContent.mockClear();
		transport.elicitResponse?.();
		expect(mockSession.sendClientContent).toHaveBeenCalledWith({
			turns: [],
			turnComplete: true,
		});
	});
```

Run: `pnpm test -- --run test/transport/gemini-live-transport.test.ts`
Expected: FAIL — `elicitResponse` is undefined.

### Step 3: Implement on Gemini

In `src/transport/gemini-live-transport.ts`, after `triggerGeneration` (`:603`):

```ts
	/** Re-elicit a response from the resumed/existing server context with no new
	 *  content — a bare `turnComplete`. Used by the framework's response watchdog
	 *  after a reconnect. No-op if the session is not connected. */
	elicitResponse(): void {
		if (!this.session) return;
		this.session.sendClientContent({ turns: [], turnComplete: true });
	}
```

Run: `pnpm test -- --run test/transport/gemini-live-transport.test.ts`
Expected: PASS.

### Step 4: Fill in `elicitModelResponse` in VoiceSession

Replace the Task 2 stub:

```ts
	/** Best-effort post-reconnect generation nudge: prefer the transport's
	 *  content-less elicit (Gemini), else fall back to triggerGeneration (OpenAI).
	 *  Agent mode only — never nudge while in transcription/dictation mode. */
	private elicitModelResponse(reason: string): void {
		if (this.internalMode !== 'agent') return;
		this.log(`[Watchdog] Re-eliciting model response after reconnect (reason=${reason})`);
		if (this.transport.elicitResponse) {
			this.transport.elicitResponse();
		} else {
			this.transport.triggerGeneration();
		}
	}
```

### Step 5: Add a VoiceSession test that the nudge fires after a watchdog reconnect

In `test/core/voice-session-response-watchdog.test.ts`, extend the mock transport with `elicitResponse: vi.fn()` and add:

```ts
	it('re-elicits a response after a watchdog-driven reconnect', async () => {
		let session: VoiceSession | undefined;
		try {
			const s = setup();
			session = s.session;
			await activate(session, s.transport);

			completeUserTurn(session);
			vi.advanceTimersByTime(8000); // fire
			vi.advanceTimersByTime(1000); // backoff → reconnect resolves
			await vi.runAllTimersAsync(); // let the reconnect().then() microtasks flush
			expect(s.transport.elicitResponse).toHaveBeenCalledTimes(1);
		} finally {
			await session?.close();
		}
	});
```

> Note: the nudge runs inside the `reconnect().then(...)` callback, so the test must flush the resolved promise — `await vi.runAllTimersAsync()` advances pending timers and drains microtasks. If timing proves flaky, replace the manual `advanceTimersByTime` calls in this single test with `await vi.runAllTimersAsync()` after `completeUserTurn`.

Run: `pnpm test -- --run test/core/voice-session-response-watchdog.test.ts`
Expected: PASS (all 5).

### Step 6: Full suite + lint + typecheck

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: PASS.

### Step 7: Commit

```bash
git add src/types/transport.ts src/transport/gemini-live-transport.ts src/core/voice-session.ts \
  test/transport/gemini-live-transport.test.ts test/core/voice-session-response-watchdog.test.ts
git commit -m "feat(transport): elicitResponse() nudge after watchdog reconnect (Gemini content-less turnComplete)"
```

---

## Verification checklist (before opening a PR)

- [ ] `pnpm test && pnpm lint && pnpm typecheck` all green.
- [ ] Watchdog fires only after the user's turn ends and only on real silence.
- [ ] Any model-activity callback cancels the timer (no false reconnect).
- [ ] `responseWatchdogMs <= 0` disables it.
- [ ] No timer leak after `close()`.
- [ ] **Live (manual, not unit-covered):** reproduce a long-turn Gemini stall; confirm reconnect + nudge restores a responsive session. The re-elicit-on-resume behavior is **unverified Gemini behavior** — if the nudge does nothing, recovery still degrades to reconnect-only (the proven 01:06 outcome), which is the primary win. Document the observed result on the PR.

## Risks / open questions

- **Gemini resume re-elicit:** whether `sendClientContent({turns: [], turnComplete: true})` on a resumed session reliably regenerates the dropped turn is unverified; floor is reconnect-only.
- **8s default vs slow first token:** a genuinely slow first token after a heavy turn could trip the watchdog. Mitigated by the conservative 8s and by disarming on the *first* output (`onModelTurnStart`/`onAudioOutput` fire early). Tune via `responseWatchdogMs` if false positives appear.
- **Arm signal depends on client audio VAD:** confirmed active in the incident (it logged the VAD completion). If a deployment runs without client VAD, the watchdog won't arm — acceptable, as that path also lacks the observed failure's signal. A server-VAD arm signal is a possible future enhancement.
- **Shared `reconnectAttempts` cap across repeated stalls (from final review):** `reconnectAttempts` resets only on a completed turn (`handleTurnComplete`). A successful watchdog reconnect whose nudge yields a real turn resets the counter. But in the unverified case where the resumed session never regenerates, no turn completes, the counter keeps climbing, and after `MAX_RECONNECT_ATTEMPTS` the watchdog (and the close path, which shares the counter) stops recovering. This is arguably correct — a model silent across several reconnects is genuinely broken — but the watchdog makes repeated counted reconnects more likely than before. Worth watching in the live validation; a watchdog-specific reset/backoff is a possible future refinement.
- **Watchdog is agent-mode only (hardened post-review):** `armResponseWatchdog` early-returns unless `internalMode === 'agent'`, and `handleGoAway` disarms — so dictation/transcription turns (model intentionally silent) and GoAway-driven reconnects can't trigger a spurious watchdog reconnect.
