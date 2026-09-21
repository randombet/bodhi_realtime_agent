import { resamplePcm } from '../audio/resample.js';
import type { IClientChannel } from '../types/session-client.js';
import type { LLMTransport } from '../types/transport.js';
import type { TTSAudioConfig, TTSProvider } from '../types/tts.js';
import type { HooksManager } from './hooks.js';
import type { PlaybackCompletionArbiter } from './playback-completion-arbiter.js';
import { ExternalTtsPlaybackGate } from './playback-gate.js';
import type { Turn } from './turn.js';

/**
 * Collaborators the {@link TtsPipeline} reaches back into on the session.
 * Thunks are used wherever a value is not yet resolved at pipeline-construction
 * time (the completion arbiter is built *after* the gate; the playback-state
 * protocol flag is resolved later in the constructor) or is mutable at runtime
 * (`isAgentMode`, `getCurrentTurn`).
 */
export interface TtsPipelineDeps {
	transport: LLMTransport;
	/** Thunk — the client channel is constructed after the pipeline. */
	getClientTransport(): IClientChannel;
	hooks: HooksManager;
	sessionId: string;
	/** Resolved TTS fallback-timer margin (ms). */
	fallbackMarginMs: number;
	/** Slowest client playback rate — divides the fallback estimate. */
	minPlaybackRate: number;
	ensureCurrentTurn(): void;
	getCurrentTurn(): Turn | null;
	handleTranscriptOutput(text: string): void;
	/** True only while the session is in agent (not dictation/transcription) mode. */
	isAgentMode(): boolean;
	/** True when the client participates in the ordered playback-state protocol. */
	isPlaybackStateProtocolActive(): boolean;
	getCompletionArbiter(): PlaybackCompletionArbiter;
	maybeArmGraceOnFirstAudio(): void;
	signalAudioStarted(): void;
	requestInterrupt(source: string): boolean;
	finalizeTurn(turn: Turn | null, opts: { interrupted: boolean }): void;
	close(reason: string): void;
	log(message: string): void;
}

/**
 * Owns the external-TTS path as one cohesive unit: the {@link TTSProvider} and
 * its {@link ExternalTtsPlaybackGate}, plus {@link wire} — the transport↔provider
 * callback wiring that was previously `VoiceSession.wireTtsProvider`.
 *
 * `VoiceSession` keeps a single `ttsPipeline?` field instead of the former
 * `ttsProvider`/`ttsGate` pair, reaching the provider for start/stop/cancel and
 * the gate for its lifecycle ops (the completion arbiter and `liveGate()` still
 * consult `gate` directly — a session is TTS *or* native, never both).
 *
 * See dev_docs/framework/investigation-voice-session-modularity.md (Step 5b).
 */
export class TtsPipeline {
	readonly provider: TTSProvider;
	readonly gate: ExternalTtsPlaybackGate;

	constructor(
		provider: TTSProvider,
		private readonly deps: TtsPipelineDeps,
	) {
		this.provider = provider;
		this.gate = new ExternalTtsPlaybackGate({
			onComplete: (turn, opts) => deps.finalizeTurn(turn, opts),
			getCurrentTurn: () => deps.getCurrentTurn(),
			log: (msg) => deps.log(msg),
		});
	}

	/**
	 * Wire the transport text callbacks and the provider audio/done/error/word
	 * callbacks. Disables native audio output + output transcription (TTS mode
	 * synthesizes from text). Behaviorally identical to the former
	 * `wireTtsProvider`; only the `this.*` references became `deps.*`.
	 */
	wire(): void {
		const { deps } = this;
		const tts = this.provider;
		const gate = this.gate;
		const transport = deps.transport;

		// Configure TTS with preferred output format
		const preferredFormat: TTSAudioConfig = {
			sampleRate: transport.audioFormat.outputSampleRate,
			bitDepth: 16,
			channels: 1,
			encoding: 'pcm',
		};
		gate.setFormat(tts.configure(preferredFormat));

		// Wire LLM text output → TTS provider + transcript
		transport.onTextOutput = (text) => {
			deps.ensureCurrentTurn();
			deps.handleTranscriptOutput(text);
			// Phase 3 dictation guard: when not in agent mode, drop model text
			// before it reaches the TTS provider. Belt-and-braces backup for
			// transports whose quiesce() can't stop already-in-flight responses.
			if (!deps.isAgentMode()) return;
			// Skip empty/whitespace-only chunks for TTS to avoid invalid transcript
			// errors from providers that require meaningful initial text.
			if (!text || text.trim().length === 0) {
				return;
			}

			if (!gate.hasTurnText) {
				gate.beginRequest();
				deps.getCompletionArbiter().clearDefer();
			}
			gate.addTextLength(text.length);
			tts.synthesize(text, gate.currentRequestId);
		};

		// When the LLM text stream ends — flush is end-of-input for this requestId;
		// the provider must then finalize and emit onDone (see TTSProvider.synthesize).
		transport.onTextDone = () => {
			if (gate.hasTurnText) {
				tts.synthesize('', gate.currentRequestId, { flush: true });
			}
		};

		// Wire TTS audio output → client (fast-path, with stale filtering + resampling)
		tts.onAudio = (base64Pcm, durationMs, requestId) => {
			if (requestId !== gate.currentRequestId) return; // stale
			// Phase 3 dictation guard: silence the TTS path when not in agent
			// mode. Queued synthesis can complete after a transcription-mode
			// flip; without this guard the client would hear stale agent
			// speech during dictation.
			if (!deps.isAgentMode()) return;
			// Greeting interrupt grace: arm on the first assistant audio
			// chunk (idempotent — subsequent chunks no-op inside the class).
			deps.maybeArmGraceOnFirstAudio();
			let buffer: Buffer = Buffer.from(base64Pcm, 'base64');
			const fmt = gate.format;
			if (fmt && fmt.sampleRate !== transport.audioFormat.outputSampleRate) {
				buffer = resamplePcm(
					buffer,
					fmt.sampleRate,
					transport.audioFormat.outputSampleRate,
					fmt.bitDepth,
				);
			}
			deps.getClientTransport().sendAudioToClient(buffer);
			deps.signalAudioStarted();
			gate.noteAudio(durationMs);
		};

		// Wire TTS done → turn gating + hook
		tts.onDone = (requestId) => {
			if (requestId !== gate.currentRequestId) return; // stale
			gate.clearTimers();
			// Fire TTS synthesis hook with timing metrics
			if (deps.hooks.onTTSSynthesis && gate.firstTextAtMs > 0) {
				const now = Date.now();
				deps.hooks.onTTSSynthesis({
					sessionId: deps.sessionId,
					provider: tts.constructor.name,
					textLength: gate.textLength,
					durationMs: now - gate.firstTextAtMs,
					audioMs: 0, // Would require tracking total audio duration
					ttfbMs: gate.firstAudioAtMs > 0 ? gate.firstAudioAtMs - gate.firstTextAtMs : 0,
					requestId,
				});
			}
			// Synthesis is done, but the client is still draining the buffered
			// audio — it plays in realtime while synthesis ran far faster. A
			// no-audio turn completes now; an audio-bearing turn always arms the
			// fallback timer (never completes synchronously, even when synthesis
			// ran slower than realtime), so a barge-in during the tail works and
			// a healthy client has room to answer with a playback signal.
			if (gate.firstAudioAtMs === 0) {
				deps.getCompletionArbiter().completePlayback();
				return;
			}
			// When the protocol is active the client may slow playback (it
			// schedules at audioBuf.duration / playbackRate); divide by the
			// slowest rate so the fallback cannot pre-empt a healthy client.
			const rateDivisor = deps.isPlaybackStateProtocolActive() ? deps.minPlaybackRate : 1;
			const estimatedEndMs = gate.firstAudioAtMs + gate.totalAudioDurationMs / rateDivisor;
			gate.setEstimatedEnd(estimatedEndMs);
			const remainingMs = Math.max(estimatedEndMs - Date.now(), 0) + deps.fallbackMarginMs;
			gate.armTimer(remainingMs, () => deps.getCompletionArbiter().finishOrDeferForVad('fallback'));
			// Tell the client "no more audio for this turn" — it answers with
			// `playback.ended` once its buffer drains. Ordered after the audio.
			if (deps.isPlaybackStateProtocolActive()) {
				deps.getClientTransport().sendJsonAfterAudio?.({
					type: 'audio.done',
					playbackId: gate.currentRequestId,
				});
			}
		};

		// Wire TTS errors
		tts.onError = (error, fatal) => {
			deps.log(`TTS error (fatal=${fatal}): ${error.message}`);
			if (deps.hooks.onError) {
				deps.hooks.onError({
					component: 'tts',
					error,
					severity: fatal ? 'fatal' : 'warn',
				});
			}
			if (fatal) {
				deps.close('tts_fatal_error');
			}
		};

		// Wire word boundaries to client
		tts.onWordBoundary = (word, offsetMs, requestId) => {
			if (requestId !== gate.currentRequestId) return;
			deps.getClientTransport().sendJsonToClient({
				type: 'word_boundary',
				word,
				offsetMs,
				requestId,
			});
		};

		// Wire speech-started for TTS barge-in. Two cases (each grace-guarded):
		//   tts-tail: `_ttsSpeaking && _ttsLlmTextDone` — LLM text done; only
		//     TTS audio still playing locally. No LLM response in flight, so
		//     cancelResponse is a no-op on the wire (framework-owned mode).
		//   tts-generation: `_ttsSpeaking && !_ttsLlmTextDone` — LLM is still
		//     streaming text into the TTS provider. In framework-owned mode
		//     we need to cancel the LLM response so it stops emitting more
		//     text; in provider-owned mode the server's auto-cancel + the
		//     transport's own truncate already handle this via onInterrupted.
		// See dev_docs/framework/design-greeting-interrupt-grace.md §4.
		const prevSpeechStarted = transport.onSpeechStarted;
		transport.onSpeechStarted = () => {
			// Chain-preserve any earlier handler (e.g. the session's raw-fact
			// publisher for speech.user_started) — same pattern as the native gate.
			try {
				prevSpeechStarted?.();
			} catch (e) {
				deps.log(`pre-attached onSpeechStarted threw: ${(e as Error).message}`);
			}
			const frameworkOwns = transport.capabilities.frameworkOwnsInterrupt === true;
			const turn = deps.getCurrentTurn();
			if (gate.isSpeaking && gate.isLlmTextDone) {
				if (!deps.requestInterrupt('tts-onSpeechStarted-tail')) return;
				if (frameworkOwns) transport.cancelResponse?.({});
				deps.finalizeTurn(turn, { interrupted: true });
				return;
			}
			if (frameworkOwns && gate.isSpeaking && !gate.isLlmTextDone && turn && !turn.isFinalized) {
				if (!deps.requestInterrupt('tts-onSpeechStarted-generation')) return;
				transport.cancelResponse?.({});
				deps.finalizeTurn(turn, { interrupted: true });
			}
		};

		// Disable native audio output and output transcription in TTS mode
		transport.onAudioOutput = undefined;
		transport.onOutputTranscription = undefined;
	}
}
