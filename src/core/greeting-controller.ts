import type { MainAgent } from '../types/agent.js';
import type { MemoryFact } from '../types/memory.js';
import type { LLMTransport } from '../types/transport.js';
import { InterruptGraceWindow } from './interrupt-grace-window.js';

/** Caller-supplied greeting tuning (read at construction). */
export interface GreetingControllerConfig {
	/** Caller override for the greeting interrupt grace window (ms), already
	 *  clamped (pass 1). `undefined` means "inherit the transport default at
	 *  finalize time". */
	overrideGraceMs: number | undefined;
}

/**
 * Collaborators the {@link GreetingController} reaches back into on the session.
 * Thunks/getters carry values mutable at runtime or constructed later
 * (`getActiveAgent`, `getMemoryFacts`); direct callbacks carry actions
 * (`getSessionSuffix`, `resetNotificationAudio`, `log`). The `transport`
 * reference is stable after construction.
 */
export interface GreetingControllerDeps {
	/** LLM transport — capabilities (grace finalization), `sendContent`
	 *  (greeting/memory injection), `clearInputAudio` (echo-residue discard on
	 *  arming), and `cancelResponse` presence (grace-enable validation). */
	transport: LLMTransport;
	/** The currently active agent (carries `name` + optional `greeting`). */
	getActiveAgent(): MainAgent;
	/** Cached memory facts to prepend to the greeting (may be empty). */
	getMemoryFacts(): MemoryFact[];
	/** Session-directive suffix prepended to the greeting body. */
	getSessionSuffix(): string;
	/** Reset the notification audio gate before sending the greeting. */
	resetNotificationAudio(): void;
	log(message: string): void;
}

/**
 * Owns the greeting send + the greeting interrupt-grace state as one cohesive
 * unit. The grace window suppresses (a) user-driven interrupts and (b) outbound
 * mic frames for a short period after the first assistant audio chunk, giving
 * browser AEC time to converge before echo-driven `speech_started` events are
 * treated as a real barge-in.
 *
 * `VoiceSession` holds this as a field and delegates:
 *  - `sendGreeting()` (three call sites: setup-complete, client-connected,
 *    transfer),
 *  - `finalizeGreetingInterruptGrace()` (pass-2, from `handleSetupComplete`),
 *  - `maybeArmGraceOnFirstAudio()` (first-audio arming, from `handleAudioOutput`
 *    + injected into the TTS pipeline),
 *  - `shouldDropOutbound()` (the AudioRouter mic-drop gate),
 *  - `requestInterrupt(source)` (the grace gate behind every interrupt site),
 *  - `resetForClientConnected()` (per-client grace reset).
 *
 * See dev_docs/framework/design-greeting-interrupt-grace.md §4–§6, §8.
 */
export class GreetingController {
	/** Pass-2-final greeting interrupt grace window (ms). `0` disables the
	 *  window. Finalized in `finalizeGreetingInterruptGrace()` against the
	 *  transport's post-connect capabilities; `0` until then. */
	private greetingInterruptGraceMs = 0;
	/** Per-session interrupt grace window. Holds a windowMs=0 placeholder (its
	 *  `isActive()` always returns `false`) until pass-2 validation finalizes
	 *  `greetingInterruptGraceMs`. Re-armed by `maybeArmGraceOnFirstAudio()` on
	 *  the first assistant audio chunk; reset on `resetForClientConnected()`. */
	private _grace: InterruptGraceWindow = new InterruptGraceWindow(0);
	/** One-shot gate for the `[Latency] Interrupt grace window armed (Nms)` log
	 *  line — only fires on the arming audio chunk, not on subsequent idempotent
	 *  `onAudioStart()` calls. Cleared in `resetForClientConnected()` alongside
	 *  `_grace.reset()`. */
	private _graceArmingLogged = false;
	/** True between session-ready (`finalizeGreetingInterruptGrace`/greeting
	 *  send) and the first assistant-audio chunk (where `_grace` takes over).
	 *  Extends the mic-drop window backwards so user speech sent in the gap
	 *  doesn't accumulate / auto-commit before the greeting response completes.
	 *  Only set when the resolved `greetingInterruptGraceMs > 0`. */
	private _greetingInFlight = false;

	constructor(
		private readonly deps: GreetingControllerDeps,
		config: GreetingControllerConfig,
	) {
		this._overrideGraceMs = config.overrideGraceMs;
	}

	/** Pass-1 caller override (clamped), captured at construction. `undefined`
	 *  means "inherit transport default at finalize time". */
	private readonly _overrideGraceMs: number | undefined;

	/** True if outbound mic frames should be dropped right now — either the
	 *  pre-first-audio greeting window or the armed grace window. Read by the
	 *  AudioRouter mic-drop gate. */
	shouldDropOutbound(): boolean {
		return this._greetingInFlight || this._grace.isActive();
	}

	/** Pass 2 of greeting-grace resolution (§5). Reads the transport's
	 *  now-finalized capabilities (`greetingInterruptGraceMs`,
	 *  `frameworkOwnsInterrupt`) and the presence of `cancelResponse`; combines
	 *  with the caller override stored in pass 1; validates; publishes the
	 *  effective value and constructs the runtime grace window. */
	finalizeGreetingInterruptGrace(): void {
		const transportDefault =
			clampTransportGraceMs(this.deps.transport.capabilities.greetingInterruptGraceMs) ?? 0;
		const requestedGraceMs = this._overrideGraceMs ?? transportDefault;
		if (requestedGraceMs <= 0) {
			this.greetingInterruptGraceMs = 0;
			return;
		}
		const frameworkOwns = this.deps.transport.capabilities.frameworkOwnsInterrupt === true;
		const hasCancelResponse = typeof this.deps.transport.cancelResponse === 'function';
		if (!frameworkOwns || !hasCancelResponse) {
			const reason = !frameworkOwns
				? 'frameworkOwnsInterrupt is not true (provider auto-cancel still wins)'
				: 'cancelResponse is not implemented on the transport';
			this.deps.log(
				`[WARN] greetingInterruptGraceMs=${requestedGraceMs}ms requested but ${reason}. Disabling grace for this session.`,
			);
			this.greetingInterruptGraceMs = 0;
			return;
		}
		this.greetingInterruptGraceMs = requestedGraceMs;
		this.deps.log(
			`[Latency] greetingInterruptGraceMs resolved to ${this.greetingInterruptGraceMs}ms`,
		);
		// Construct the runtime grace window with the finalized length.
		// Arming happens later, on the first assistant audio chunk.
		this._grace = new InterruptGraceWindow(this.greetingInterruptGraceMs);
		this._graceArmingLogged = false;
		// `_greetingInFlight` is set by `sendGreeting()` at the actual send
		// time, not here. Setting it at session-ready would be wiped by
		// `resetForClientConnected` (which runs between session-ready and
		// sendGreeting in the common "client connects later" path) — and
		// before `startMic` runs there are no mic frames to gate anyway.
		// See dev_docs/framework/design-greeting-interrupt-grace.md §6, §8.
	}

	/** Idempotent arming hook called from every assistant-audio chunk site
	 *  (native `handleAudioOutput`, external TTS `tts.onAudio`). Arms the
	 *  window on the first chunk via the class's own idempotency; emits the
	 *  one-shot armed-log; and asks the transport to clear any pre-arming echo
	 *  residue from its input buffer (no-op on transports without
	 *  `clearInputAudio`). */
	maybeArmGraceOnFirstAudio(): void {
		if (this.greetingInterruptGraceMs <= 0) return;
		const wasActive = this._grace.isActive();
		this._grace.onAudioStart();
		if (!wasActive && this._grace.isActive() && !this._graceArmingLogged) {
			this._graceArmingLogged = true;
			// Hand off pre-audio mic-drop to the grace window. (The two flags
			// are deliberately overlapped during the same call: the gate in
			// routeAudioToAgent ORs them, and the order of assignment doesn't
			// matter — mic frames sent in this tick are still dropped.)
			this._greetingInFlight = false;
			this.deps.log(`[Latency] Interrupt grace window armed (${this.greetingInterruptGraceMs}ms)`);
			// Belt-and-suspenders: discard any provider input-buffer residue.
			// With `_greetingInFlight` set in `sendGreeting()`, the gate has
			// been active for the entire greeting-send → first-audio window,
			// so the buffer should already be empty. The only frames that
			// could still be in the buffer are pre-`sendGreeting` (i.e.
			// WS-connect → session-ready, plus the brief microtask gap into
			// sendGreeting via `_memoryReadyPromise.then`) — typically empty
			// because `startMic` hasn't started capturing yet. Safe to
			// discard either way.
			this.deps.transport.clearInputAudio?.();
		}
	}

	/** Returns `true` if the caller should proceed with the interrupt; `false`
	 *  (and logs) if the grace is currently suppressing it. Wraps
	 *  `_grace.isActive()` with the session's log channel. */
	requestInterrupt(source: string): boolean {
		if (this._grace.isActive()) {
			this.deps.log(
				`[Latency] interrupt suppressed (grace, ${this._grace.remainingMs()}ms remaining; src=${source})`,
			);
			return false;
		}
		return true;
	}

	/** Send the active agent's greeting prompt to the LLM to trigger a spoken
	 *  greeting. No-op (and clears `_greetingInFlight`) if the agent has no
	 *  greeting configured. */
	sendGreeting(): void {
		const agent = this.deps.getActiveAgent();
		if (!agent.greeting) {
			this._greetingInFlight = false;
			return;
		}
		this.deps.log(`Sending greeting for agent "${agent.name}"`);
		// The effective pre-audio gate must start at the actual greeting send,
		// not only at setup-complete: in the common ordering where the LLM is
		// ready before the browser connects, resetForClientConnected resets the
		// per-client grace state immediately before scheduling this greeting.
		if (this.greetingInterruptGraceMs > 0 && !this._graceArmingLogged) {
			this._greetingInFlight = true;
		}
		// Pre-greeting audio-gate reset (clears the actor debounce too, via the sink).
		this.deps.resetNotificationAudio();

		// Collapse memory facts + session directives + greeting into ONE
		// sendContent call. Previously this fired two sendContent calls (memory
		// first with turnComplete: true, then the greeting), which created two
		// separate response.create on framework-owned interruption (and also
		// risked racing two active responses on OpenAI Realtime — see
		// `conversation_already_has_active_response`). Combining keeps the
		// grace-window invariant "first audio = greeting" intact.
		// See dev_docs/framework/design-greeting-interrupt-grace.md §6.
		const cachedFacts = this.deps.getMemoryFacts();
		const memoryPrefix =
			cachedFacts.length > 0
				? `[MEMORY — what you already know about this user from previous sessions]\n${cachedFacts
						.map((f) => `- ${f.content}`)
						.join('\n')}\n\n`
				: '';
		if (cachedFacts.length > 0) {
			this.deps.log(`Injected ${cachedFacts.length} memory facts`);
		}

		// Prepend session directives so the greeting response respects user preferences (e.g. pacing)
		const directiveSuffix = this.deps.getSessionSuffix();
		const greetingBody = directiveSuffix
			? `${directiveSuffix}\n\n${agent.greeting}`
			: agent.greeting;
		const greetingText = `${memoryPrefix}${greetingBody}`;
		this.deps.transport.sendContent([{ role: 'user', text: greetingText }], true);
	}

	/** Client-(re)connect reset: a fresh browser tab / RTC audio context
	 *  typically means a cold AEC. Reset the window so the next first audio
	 *  chunk re-arms cleanly. Leaving any prior session's grace active would
	 *  suppress new-client mic frames before its own first audio chunk armed —
	 *  leaking the prior session's grace into a different audio context. */
	resetForClientConnected(): void {
		this._grace.reset();
		this._graceArmingLogged = false;
		// Don't leak greeting-in-flight state into the new client session.
		// The next sendGreeting (if any) will re-set it.
		this._greetingInFlight = false;
	}
}

const GRACE_MAX_MS = 5000;

/** Clamp a transport-capability `greetingInterruptGraceMs` default to a sane
 *  numeric range. Returns `undefined` when omitted; `0` for `NaN`, negative,
 *  or non-finite inputs; the clamped value otherwise. Mirrors VoiceSession's
 *  `clampGraceMs` for the transport-default path. */
function clampTransportGraceMs(raw: number | undefined): number | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 0;
	if (raw > GRACE_MAX_MS) return GRACE_MAX_MS;
	return raw;
}
