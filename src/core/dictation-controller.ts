import type {
	ContentTurn,
	LLMTransport,
	STTProvider,
	TransportToolResult,
} from '../types/transport.js';
import type { InternalTranscriptionMode } from './audio-router.js';
import type { EventBus } from './event-bus.js';

/** Caller-supplied dictation config (read at construction). */
export interface DictationControllerConfig {
	/** The transcription-mode Whisper provider. MUST be a distinct instance from
	 *  the session's `sttProvider`. `undefined` disables transcription mode. */
	whisperProvider: STTProvider | undefined;
	/** The session's streaming STT provider — used only for the distinct-instance
	 *  validation against `whisperProvider`. */
	sttProvider: STTProvider | undefined;
	/** Initial transcription mode. `'transcription'` seeds `internalMode` so the
	 *  session reports transcription publicly from construction; the actual
	 *  whisper bring-up + transport quiesce happens in `prepareForStart()`. */
	transcriptionMode: 'agent' | 'transcription' | undefined;
}

/**
 * Collaborators the {@link DictationController} reaches back into on the session.
 * Thunks/getters carry values constructed after the controller or mutable at
 * runtime (`audioRouter`); direct callbacks carry actions (`reportError`, `log`).
 * The `transport` / `eventBus` references are stable after construction.
 */
export interface DictationControllerDeps {
	/** LLM transport — quiesce/unquiesce/clearAudio for cross-provider mode flips,
	 *  and the `sendToolResult` / `sendContent` instances the controller wraps. */
	transport: LLMTransport;
	/** Audio router — `drainTransitionBufferToWhisper()` flushes the buffered
	 *  transition frames on entry to transcription mode. Reached through a getter
	 *  because the router may be constructed independently of the controller. */
	getAudioRouter(): { drainTransitionBufferToWhisper(): void };
	eventBus: EventBus;
	/** The session id (carried in `session.transcription_mode_changed` publishes). */
	getSessionId(): string;
	reportError(context: string, error: Error): void;
	log(message: string): void;
}

/**
 * Owns the transcription/dictation subsystem as one cohesive unit: the
 * `internalMode` state machine, the dictation buffer, the Whisper provider
 * lifecycle, and the §3.5 "no response.create while not in agent mode"
 * invariant (enforced by the `sendToolResult` / `sendContent` interception
 * wrappers it installs on the transport, plus the pending-work queues drained
 * on re-entry to agent mode).
 *
 * `internalMode` lives here and is exposed via {@link mode} / {@link isAgentMode}.
 * Every reader (AudioRouter `getMode`, TtsPipeline / TransportReconnector
 * `isAgentMode`, the audio-output drop guard, `guardedTriggerGeneration`,
 * `getTranscriptionMode`) reads through this single owner.
 *
 * `VoiceSession` holds this as a field and delegates `enterTranscriptionMode` /
 * `exitTranscriptionMode` (driven by its serialized `setTranscriptionMode`),
 * the dictation-buffer accessors, `prewarmTranscriptionMode`, and
 * `prepareForStart()` (called from `start()`).
 *
 * See design-openai-realtime-transport-v2.md §3.
 */
export class DictationController {
	private internalMode: InternalTranscriptionMode = 'agent';
	private readonly whisperProvider?: STTProvider;
	private dictationBuffer: string[] = [];

	/** Tool results that arrived while not in 'agent' mode. Flushed in order on
	 *  re-entry. Prevents response.create from leaking during transcription mode. */
	private pendingToolResultsAwaitingAgentMode: Array<
		Parameters<LLMTransport['sendToolResult']>[0]
	> = [];
	/** Queue of `transport.sendContent(turns, true)` calls that arrived while
	 *  not in agent mode. Each `turnComplete:true` would trigger response.create
	 *  on OpenAI, which violates the §3.5 dictation-only invariant. Drained
	 *  on entry to 'agent'. */
	private pendingContentTurnsAwaitingAgentMode: Array<{
		turns: ContentTurn[];
		turnComplete?: boolean;
	}> = [];
	/** Reference to the transport's original sendToolResult, captured at
	 *  construction. flushPendingToolResults calls through this to bypass
	 *  the guard wrapper installed on the transport. */
	private _rawSendToolResult: (result: TransportToolResult) => void = () => undefined;
	/** Same as `_rawSendToolResult` but for `sendContent`. Used to drain
	 *  `pendingContentTurnsAwaitingAgentMode` on entry to agent mode without
	 *  re-entering the guard wrapper. */
	private _rawSendContent: (turns: ContentTurn[], turnComplete?: boolean) => void = () => undefined;

	constructor(
		private readonly deps: DictationControllerDeps,
		config: DictationControllerConfig,
	) {
		// Intercept transport.sendToolResult so BOTH legacy and actor-mode
		// dispatch paths go through the transcription-mode guard. The actor
		// adapter calls `transport.sendToolResult(...)` directly (no
		// VoiceSession reference), so the cleanest single-point fix is to
		// wrap the method on the transport instance itself.
		const originalSendToolResult = this.deps.transport.sendToolResult.bind(this.deps.transport);
		this.deps.transport.sendToolResult = (result: TransportToolResult) => {
			// `scheduling: 'silent'` doesn't trigger response.create (the OpenAI
			// transport just inserts the conversation item), so it doesn't
			// violate the §3.5 invariant. Pass it through immediately even
			// during transcription mode. Useful for tools whose result is
			// informational only — e.g. set_transcription_mode itself.
			if (result.scheduling === 'silent') {
				originalSendToolResult(result);
				return;
			}
			if (this.internalMode !== 'agent') {
				this.pendingToolResultsAwaitingAgentMode.push(result);
				return;
			}
			originalSendToolResult(result);
		};
		// Keep a reference so flushPendingToolResults can bypass the guard and
		// call the underlying method directly (draining INTO agent mode).
		this._rawSendToolResult = originalSendToolResult;

		// Same pattern for sendContent — gate `turnComplete: true` (which fires
		// response.create on OpenAI) when not in agent mode. `turnComplete: false`
		// is a passive append (no response trigger) and passes through.
		// Catches: directive reinforcement, greetings, memory injection, text
		// input, legacy notifications, and the actor-mode notification path
		// (transport-actor.ts) — all route through `this.transport.sendContent`.
		const originalSendContent = this.deps.transport.sendContent.bind(this.deps.transport);
		this.deps.transport.sendContent = (turns: ContentTurn[], turnComplete?: boolean) => {
			if (turnComplete === true && this.internalMode !== 'agent') {
				this.pendingContentTurnsAwaitingAgentMode.push({ turns, turnComplete });
				return;
			}
			originalSendContent(turns, turnComplete);
		};
		this._rawSendContent = originalSendContent;

		// Wire the transcription-mode Whisper provider (§Phase 3). Independent
		// from sttProvider — must be a distinct instance.
		if (config.whisperProvider) {
			if (config.whisperProvider === config.sttProvider) {
				throw new Error(
					'VoiceSession: whisperProvider must be a distinct instance from sttProvider. ' +
						'Sharing one instance entangles their lifecycles and causes double-start/premature-stop.',
				);
			}
			this.whisperProvider = config.whisperProvider;
			// Configure with the format VoiceSession actually FEEDS — Whisper
			// gets PCM16 @ 24 kHz mono after routeAudioToWhisper resamples.
			// Not the transport's wire format (which may be 16 kHz Gemini or
			// 8 kHz pcmu OpenAI telephony).
			this.whisperProvider.configure({
				sampleRate: 24000,
				bitDepth: 16,
				channels: 1,
				encoding: 'pcm',
			});
			// Whisper transcripts feed the dictation buffer ONLY — never the
			// TranscriptManager / ConversationContext path (that would
			// auto-inject and violate the "never auto-inject" guarantee).
			this.whisperProvider.onTranscript = (text) => {
				if (text) this.dictationBuffer.push(text);
			};
			// Partials are not surfaced here today; subscribers wanting live
			// dictation preview can wire onPartialTranscript directly.
		}
		// Honour an initial transcriptionMode='transcription' by setting the
		// internal mode now. The actual whisper.start() happens lazily on
		// session start so it lines up with sttProvider's existing pattern.
		if (config.transcriptionMode === 'transcription') {
			this.internalMode = 'transcription';
		}
	}

	/** Current internal transcription mode (single source of truth). */
	get mode(): InternalTranscriptionMode {
		return this.internalMode;
	}

	/** True only in agent mode — gates audio output, watchdog arming, the
	 *  post-reconnect nudge, and the triggerGeneration guard. */
	isAgentMode(): boolean {
		return this.internalMode === 'agent';
	}

	/** The configured transcription-mode Whisper provider (or `undefined`).
	 *  Read by the AudioRouter's `getWhisperProvider` thunk to feed dictation
	 *  audio, and `setTranscriptionMode` checks it for presence. */
	get whisper(): STTProvider | undefined {
		return this.whisperProvider;
	}

	/** `start()`-time initial-mode bring-up: when constructed with an initial
	 *  transcriptionMode='transcription', bring Whisper up and quiesce the agent
	 *  transport before start() resolves — otherwise the session reports
	 *  `transcription` publicly while Whisper is down and the agent transport is
	 *  live, leaking agent audio/generation. Called from `VoiceSession.start()`.
	 *  Audio dropped during these awaits is bounded by clientTransport buffering. */
	async prepareForStart(): Promise<void> {
		if (this.internalMode === 'transcription' && this.whisperProvider) {
			await this.whisperProvider.start();
			if (this.deps.transport.capabilities.quiescible && this.deps.transport.quiesce) {
				try {
					await this.deps.transport.quiesce();
				} catch (err) {
					this.deps.reportError(
						'transport-quiesce',
						err instanceof Error ? err : new Error(String(err)),
					);
				}
			}
		}
	}

	/** Snapshot of dictated text since the last clear, joined with spaces. */
	getDictationBuffer(): string {
		return this.dictationBuffer.join(' ').trim();
	}

	/** Discard buffered dictation without injecting it. */
	clearDictationBuffer(): void {
		this.dictationBuffer = [];
	}

	/** Take and clear the dictation buffer (joined text). Returns the empty
	 *  string when not in agent mode or the buffer is empty — leaving the buffer
	 *  intact in the not-agent-mode case so the dictation isn't silently lost. */
	takeDictationBufferForInjection(): string {
		if (this.internalMode !== 'agent') return '';
		const text = this.getDictationBuffer();
		if (!text) return '';
		this.dictationBuffer = [];
		return text;
	}

	/** Stop the dictation-mode Whisper provider so prewarmed or active sockets
	 *  don't survive session close. Idempotent; called from `VoiceSession.close`. */
	async stopWhisper(): Promise<void> {
		await this.whisperProvider?.stop().catch(() => undefined);
	}

	/** Pre-start the whisper session without flipping audio routing. Useful
	 *  for masking the ~150–500 ms whisper-start latency on the first flip. */
	async prewarmTranscriptionMode(): Promise<void> {
		if (!this.whisperProvider) return;
		await this.whisperProvider.start();
	}

	/** Agent → transcription transition. */
	async enterTranscriptionMode(): Promise<void> {
		this.internalMode = 'starting_transcription';
		// Quiesce the transport so any in-flight response stops emitting.
		// Optional method — fall back to the framework-layer guard.
		if (this.deps.transport.capabilities.quiescible && this.deps.transport.quiesce) {
			try {
				await this.deps.transport.quiesce();
			} catch (err) {
				this.deps.reportError(
					'transport-quiesce',
					err instanceof Error ? err : new Error(String(err)),
				);
			}
		}
		// Clear unprocessed input audio server-side (mandatory — see design §3.4).
		// Some transports auto-trigger responses via VAD's create_response:true;
		// without clearAudio() that response can fire after the mode flip.
		try {
			this.deps.transport.clearAudio();
		} catch {
			// Best-effort: clearAudio is a no-op when disconnected.
		}
		// Bring up whisper. Idempotent — no-op if prewarm already ran.
		// setTranscriptionMode('transcription') above already verified that
		// whisperProvider is set, so this is safe.
		const whisper = this.whisperProvider;
		if (!whisper) {
			this.internalMode = 'agent';
			throw new Error('enterTranscriptionMode: whisperProvider missing');
		}
		try {
			await whisper.start();
		} catch (err) {
			// Rollback on failure.
			this.internalMode = 'agent';
			if (this.deps.transport.capabilities.quiescible && this.deps.transport.unquiesce) {
				try {
					await this.deps.transport.unquiesce();
				} catch {
					// Best-effort rollback.
				}
			}
			throw err;
		}
		// Flush buffered transition frames in FIFO order through the router's
		// whisper routing (which handles resampling).
		this.deps.getAudioRouter().drainTransitionBufferToWhisper();
		this.internalMode = 'transcription';
		this.deps.eventBus.publish('session.transcription_mode_changed', {
			mode: 'transcription',
			sessionId: this.deps.getSessionId(),
		});
	}

	/** Transcription → agent transition. Asymmetric — audio routing is
	 *  restored synchronously; the public promise awaits whisper.stop().
	 *
	 *  Ordering matters: unquiesce() drains the OpenAI transport's
	 *  _pendingWhenIdle queue which fires `response.create`. The §3.5
	 *  invariant says no response.create while not in agent mode, so
	 *  unquiesce() must run AFTER `internalMode = 'agent'`, not before.
	 *  The brief `_quiesced` window costs a few ms of audio suppression
	 *  during stop_transcription, traded for strict invariant compliance. */
	async exitTranscriptionMode(): Promise<void> {
		// Restore audio ROUTING immediately so the user is never silent. The
		// routing switch's stopping_transcription case (§3.3) feeds mic frames
		// to the transport from the very next frame; suppression at the
		// audio-output seam is still on for the brief window below.
		this.internalMode = 'stopping_transcription';
		// Tear down whisper FIRST so any in-flight whisper transcripts that
		// arrived just before "end dictation" finish landing in the buffer.
		// Idempotent.
		try {
			await this.whisperProvider?.stop();
		} catch (err) {
			this.deps.reportError('whisper-stop', err instanceof Error ? err : new Error(String(err)));
		}
		// Flip to agent BEFORE unquiesce — unquiesce() in OpenAI drains
		// _pendingWhenIdle, which sends response.create. That has to happen
		// when internalMode === 'agent' to honour §3.5.
		this.internalMode = 'agent';
		// Now unquiesce — drains any when_idle tool results that accumulated.
		if (this.deps.transport.capabilities.quiescible && this.deps.transport.unquiesce) {
			try {
				await this.deps.transport.unquiesce();
			} catch (err) {
				this.deps.reportError(
					'transport-unquiesce',
					err instanceof Error ? err : new Error(String(err)),
				);
			}
		}
		// Drain framework-side queues: tool results AND content turns that
		// arrived while not in agent mode.
		this.flushPendingToolResults();
		this.flushPendingContentTurns();
		this.deps.eventBus.publish('session.transcription_mode_changed', {
			mode: 'agent',
			sessionId: this.deps.getSessionId(),
		});
	}

	/** Flush tool results that arrived during transcription mode. Calls the
	 *  unguarded sender so we don't re-enter the queue. */
	private flushPendingToolResults(): void {
		if (this.pendingToolResultsAwaitingAgentMode.length === 0) return;
		const queued = this.pendingToolResultsAwaitingAgentMode;
		this.pendingToolResultsAwaitingAgentMode = [];
		for (const result of queued) {
			this._rawSendToolResult(result);
		}
	}

	/** Flush content turns (sendContent calls) that arrived with
	 *  turnComplete=true during transcription mode. Same idempotency story
	 *  as flushPendingToolResults — drain through the raw sender. */
	private flushPendingContentTurns(): void {
		if (this.pendingContentTurnsAwaitingAgentMode.length === 0) return;
		const queued = this.pendingContentTurnsAwaitingAgentMode;
		this.pendingContentTurnsAwaitingAgentMode = [];
		for (const { turns, turnComplete } of queued) {
			this._rawSendContent(turns, turnComplete);
		}
	}
}
