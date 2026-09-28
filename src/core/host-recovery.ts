import type { LLMTransport } from '../types/transport.js';

/**
 * Host upstream recovery: the synthetic-output hold and the dial-generation
 * fence. Internal: neither class nor the origin union is exported from the
 * package index.
 */

/** What produced a synthetic (not user-initiated) send. A log label only. */
export type SyntheticHoldOrigin =
	| 'greeting'
	| 'greeting-memory'
	| 'directive-reinforcement'
	| 'client-reconnect-context'
	| 'gemini-reconnect-context'
	| 'divergence-correction'
	| 'assistant-initiated'
	| 'host-inject'
	| 'watchdog-replay'
	| 'watchdog-nudge';

/** Fresh user evidence that releases the fresh-speech hold. Raw microphone
 *  PCM (client-VAD energy) is not evidence and never releases it. */
export type SyntheticHoldReleaseSource =
	| 'input-transcription'
	| 'external-stt-final'
	| 'provider-interrupted'
	| 'typed-input';

/** Collaborators the {@link SyntheticOutputHold} reaches back into. */
export interface SyntheticOutputHoldDeps {
	/** Hold (`true`) or release (`false`) background-notification delivery. */
	setNotificationsHeld(held: boolean): void;
	/** Deliver one queued notification if the model is idle. Called when a
	 *  dial window releases the notification hold, since a released queue
	 *  otherwise waits for the next turn completion before delivering. */
	drainNotifications(): void;
	log(message: string): void;
}

/**
 * The gate every framework-generated ("synthetic") send passes through:
 * greeting, directive reinforcement, guarded generation triggers and
 * hold-respecting injections. Two independent holds close it:
 *
 * - the fresh-speech hold ({@link engage}): after a host recovery that asks
 *   for it, nothing synthetic is sent until the user is heard again
 *   ({@link release});
 * - the dial window ({@link engageDialWindow}): a transient hold from the
 *   moment a recovery strands the old connection until the replacement
 *   activates ({@link releaseDialWindow}).
 *
 * Either one also holds background-notification delivery; the notifications
 * are released only once neither remains.
 */
export class SyntheticOutputHold {
	private freshSpeechHold = false;
	private dialWindow = false;
	private readonly releaseListeners = new Set<() => void>();

	constructor(private readonly deps: SyntheticOutputHoldDeps) {}

	/** Whether the fresh-speech hold is engaged. The dial window is not
	 *  reported here: it is part of an in-flight recovery, not a hold the
	 *  host can observe. */
	isActive(): boolean {
		return this.freshSpeechHold;
	}

	/** Hold synthetic output and notifications until fresh user evidence. */
	engage(): void {
		this.deps.setNotificationsHeld(true);
		this.freshSpeechHold = true;
	}

	/**
	 * Fresh user evidence arrived. Releases the fresh-speech hold, and the
	 * notification hold unless a dial window still holds it, then notifies the
	 * {@link onRelease} listeners. Returns `true` when a hold was released,
	 * `false` when none was engaged (a no-op).
	 */
	release(source: SyntheticHoldReleaseSource): boolean {
		if (!this.freshSpeechHold) return false;
		this.freshSpeechHold = false;
		if (!this.dialWindow) this.deps.setNotificationsHeld(false);
		this.deps.log(`Synthetic output hold released by fresh user evidence (${source})`);
		for (const listener of [...this.releaseListeners]) listener();
		return true;
	}

	/** Open the dial window: synthetic output and notifications are held
	 *  until {@link releaseDialWindow}. */
	engageDialWindow(): void {
		this.deps.setNotificationsHeld(true);
		this.dialWindow = true;
	}

	/** Close the dial window. When no fresh-speech hold remains, release the
	 *  notification hold and run one notification drain. */
	releaseDialWindow(): void {
		if (!this.dialWindow) return;
		this.dialWindow = false;
		if (this.freshSpeechHold) return;
		this.deps.setNotificationsHeld(false);
		this.deps.drainNotifications();
	}

	/** `true` when a synthetic send may proceed; `false` (logged with its
	 *  origin) while either hold is engaged. */
	gate(origin: SyntheticHoldOrigin): boolean {
		if (!this.freshSpeechHold && !this.dialWindow) return true;
		this.deps.log(`Synthetic output held — suppressed ${origin}`);
		return false;
	}

	/** Subscribe to fresh-speech hold releases; returns the unsubscribe. */
	onRelease(cb: () => void): () => void {
		this.releaseListeners.add(cb);
		return () => {
			this.releaseListeners.delete(cb);
		};
	}
}

/**
 * Drops work that belongs to a provider connection a host recovery has
 * abandoned: tool results for calls the old connection issued, and external
 * STT captures committed on it.
 *
 * Tool calls and STT commits are stamped with the transport's dial
 * generation (`currentDialGen`). {@link markBoundary} records the generation
 * of the connection a host recovery is about to abandon; a stamp at or below
 * it is stale. Automatic reconnects never mark a boundary, so across them
 * tool results and STT captures are delivered as before. Until a boundary is
 * marked nothing is stale, and on a transport without `currentDialGen`
 * nothing is stamped.
 *
 * The constructor wraps `transport.sendToolResult` once, so every result
 * sent through the transport afterwards passes the fence, including results
 * a later wrapper queues and sends through the sender it captured.
 */
export class DialGenerationFence {
	/** Dial generation each tool call was issued on, until its result is sent. */
	private readonly toolCallGens = new Map<string, number>();
	/** Dial generation each turn's STT capture was committed on. A batch
	 *  provider transcribes asynchronously, so a transcript can arrive long
	 *  after its commit: its capture, not its arrival, places it. */
	private readonly sttCommitGens = new Map<number, number>();
	/** Latest turn whose STT capture was stamped. */
	private latestSttTurn: number | null = null;
	/** Dial generation of the connection abandoned at the last boundary. */
	private boundaryGen: number | null = null;
	/** Latest turn whose STT capture was stamped before the last boundary. */
	private boundaryTurn: number | null = null;

	constructor(
		private readonly transport: LLMTransport,
		private readonly log: (message: string) => void,
	) {
		const send = transport.sendToolResult.bind(transport);
		transport.sendToolResult = (result) => {
			if (this.shouldDropToolResult(result.id)) return;
			send(result);
		};
	}

	/** Record the dial generation these tool calls were issued on. */
	stampToolCalls(ids: string[]): void {
		const gen = this.transport.currentDialGen;
		if (gen === undefined) return;
		for (const id of ids) this.toolCallGens.set(id, gen);
	}

	/** Whether this result answers a call issued before the last boundary
	 *  (logged when so). Settles the call's stamp either way. */
	shouldDropToolResult(id: string): boolean {
		const issuedGen = this.toolCallGens.get(id);
		this.toolCallGens.delete(id);
		if (issuedGen === undefined || this.boundaryGen === null || issuedGen > this.boundaryGen) {
			return false;
		}
		this.log(
			`Dropped tool result ${id}: its call was issued on dial ${issuedGen}, abandoned by a host recovery`,
		);
		return true;
	}

	/** Record the dial generation a turn's STT capture was committed on. The
	 *  turn window consults only the current and the preceding turn, so older
	 *  stamps are pruned; a reserved transcript outside that window is placed
	 *  by its turn instead ({@link isSttCaptureStale}). */
	stampSttCommit(turnId: number): void {
		const gen = this.transport.currentDialGen;
		if (gen === undefined) return;
		this.sttCommitGens.set(turnId, gen);
		if (this.latestSttTurn === null || turnId > this.latestSttTurn) this.latestSttTurn = turnId;
		for (const t of this.sttCommitGens.keys()) {
			if (t < turnId - 2) this.sttCommitGens.delete(t);
		}
	}

	/** Whether this turn's STT capture was committed before the last boundary.
	 *  An id-less transcript (a streaming provider's own commit) has no stamp
	 *  and is never stale. A turn whose stamp was pruned is stale when it is
	 *  no later than the last turn stamped before the boundary, since turns
	 *  commit in order. */
	isSttCaptureStale(turnId: number | undefined): boolean {
		if (turnId === undefined || this.boundaryGen === null) return false;
		const capturedGen = this.sttCommitGens.get(turnId);
		if (capturedGen === undefined) {
			return this.boundaryTurn !== null && turnId <= this.boundaryTurn;
		}
		return capturedGen <= this.boundaryGen;
	}

	/** Mark a host-recovery boundary: record the current dial generation,
	 *  before the recovery aborts the connection and advances it, and the
	 *  latest turn whose capture was stamped on it or earlier. */
	markBoundary(): void {
		const gen = this.transport.currentDialGen;
		if (gen === undefined) return;
		this.boundaryGen = gen;
		this.boundaryTurn = this.latestSttTurn;
	}
}
