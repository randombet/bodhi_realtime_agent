import {
	GoogleGenAI,
	type LiveServerMessage,
	type RealtimeInputConfig,
	type Session,
} from '@google/genai';
import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_RECONNECT_TIMEOUT_MS } from '../core/constants.js';
import type { ToolDefinition } from '../types/tool.js';
import type {
	AudioFormatSpec,
	ContentTurn,
	LLMTransport,
	LLMTransportConfig,
	LLMTransportError,
	RealtimeLLMUsageEvent,
	ReconnectState,
	ReplayItem,
	RetainedUserTurn,
	SessionUpdate,
	TransportCapabilities,
	TransportToolCall,
	TransportToolResult,
} from '../types/transport.js';
import { normalizeGeminiUsageMetadata } from './realtime-usage-normalize.js';
import { zodToJsonSchema } from './zod-to-schema.js';

/** Module-level latch so the legacy `resumptionHandle` deprecation warning
 *  fires at most once per process. */
let legacyResumptionHandleWarned = false;
function warnLegacyResumptionHandleOnce(): void {
	if (legacyResumptionHandleWarned) return;
	legacyResumptionHandleWarned = true;
	console.warn(
		'[gemini-live-transport] GeminiTransportConfig.resumptionHandle is deprecated; ' +
			'use sessionResumption: { handle } instead. Will be removed in a future release.',
	);
}

function toFunctionResponsePayload(value: unknown): Record<string, unknown> {
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (value === undefined) {
		return { result: null };
	}
	return { result: value };
}

export type GeminiRealtimeInputConfig = RealtimeInputConfig | Record<string, unknown>;

/**
 * Framework default applied by VoiceSession when no realtimeInputConfig is
 * provided. Tuned to feel less eager than Gemini's stock VAD
 * (silenceDurationMs=100); matches the values used in the
 * interviewer/direct-rtc demos so most apps can omit the field entirely.
 *
 * Only applied on the built-in Gemini construction path in VoiceSession.
 * Injected transports own their own config.
 */
export const DEFAULT_GEMINI_REALTIME_INPUT_CONFIG: GeminiRealtimeInputConfig = {
	automaticActivityDetection: {
		endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
		silenceDurationMs: 500,
	},
};

/** Current default Gemini Live model for bidiGenerateContent sessions. */
export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';

/**
 * Deep-merges a user-supplied realtimeInputConfig over
 * DEFAULT_GEMINI_REALTIME_INPUT_CONFIG. Merge depth is exactly one level into
 * automaticActivityDetection — user fields win, missing fields fall back to
 * the default. If user is undefined, returns the default unchanged.
 */
export function resolveGeminiRealtimeInputConfig(
	user: GeminiRealtimeInputConfig | undefined,
): GeminiRealtimeInputConfig {
	if (!user) return DEFAULT_GEMINI_REALTIME_INPUT_CONFIG;
	const defaultAad = (DEFAULT_GEMINI_REALTIME_INPUT_CONFIG as Record<string, unknown>)
		.automaticActivityDetection as Record<string, unknown> | undefined;
	const userAad = (user as Record<string, unknown>).automaticActivityDetection as
		| Record<string, unknown>
		| undefined;
	return {
		...DEFAULT_GEMINI_REALTIME_INPUT_CONFIG,
		...user,
		automaticActivityDetection: { ...(defaultAad ?? {}), ...(userAad ?? {}) },
	} as GeminiRealtimeInputConfig;
}

/** Configuration for connecting to the Gemini Live API. */
export interface GeminiTransportConfig {
	/** Google API key for authentication. */
	apiKey: string;
	/** Gemini model name (default: "gemini-3.1-flash-live-preview"). */
	model?: string;
	/** System instruction sent to the model at connection time. */
	systemInstruction?: string;
	/** Tool definitions to register with the model (converted to Gemini function declarations). */
	tools?: ToolDefinition[];
	/** Server-side session resumption configuration.
	 *  - `false` → opt out entirely (server will not issue resumption handles).
	 *    Required for ZDR / privacy-sensitive callers who must not allow
	 *    server-side conversation snapshots.
	 *  - `{ handle?: string }` → opt in. Pass a prior handle to resume that
	 *    session, or omit `handle` (i.e. `{}`) for a fresh resumable session.
	 *  - omitted → defaults to `{}` (resume-enabled fresh session, current behavior).
	 *
	 *  Resolution at connect time: `false` overrides everything else, including
	 *  any handle in `ReconnectState`. Otherwise the transport's mutable
	 *  `effectiveResumptionHandle` is used, seeded from this field's
	 *  `handle` or the legacy `resumptionHandle` alias and updated by every
	 *  `resumable: true` server `sessionResumptionUpdate`. */
	sessionResumption?: false | { handle?: string };
	/** @deprecated Use `sessionResumption: { handle }` instead. Kept as a
	 *  compatibility alias; emits a one-shot WARN log per process when used.
	 *  If both are set, `sessionResumption.handle` wins. */
	resumptionHandle?: string;
	/** Voice configuration for Gemini's speech synthesis. */
	speechConfig?: { voiceName?: string };
	/** Context window compression settings (trigger and target token counts). */
	compressionConfig?: { triggerTokens: number; targetTokens: number };
	/** Enable Gemini's built-in Google Search grounding. */
	googleSearch?: boolean;
	/** Enable server-side transcription of user audio input (default: true). */
	inputAudioTranscription?: boolean;
	/** Gemini Live realtime input behavior, including server-side VAD tuning. */
	realtimeInputConfig?: GeminiRealtimeInputConfig;
	/** Timeout in ms for connect() to receive setupComplete (default: 30000). */
	connectTimeoutMs?: number;
	/** Timeout in ms for the overall reconnect operation (default: 45000). */
	reconnectTimeoutMs?: number;
}

/** Callbacks fired by GeminiLiveTransport when server messages arrive. */
export interface GeminiTransportCallbacks {
	/** Gemini session setup is complete and ready for audio. */
	onSetupComplete?(sessionId: string): void;
	/** Base64-encoded PCM audio output from the model. */
	onAudioOutput?(data: string): void;
	/** Model is requesting one or more tool invocations. */
	onToolCall?(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): void;
	/** Model is cancelling previously requested tool calls. */
	onToolCallCancellation?(ids: string[]): void;
	/** Model has finished its response turn. */
	onTurnComplete?(serverTurnId?: number): void;
	/** Model's response was interrupted by user speech. */
	onInterrupted?(serverTurnId?: number): void;
	/** Model started a new response turn (first audio or tool call). */
	onModelTurnStart?(): void;
	/** First audio chunk of the model's response (TTS-first-audio anchor). */
	onFirstAudioChunk?(): void;
	/** Transcription of user's spoken input. */
	onInputTranscription?(text: string): void;
	/** Transcription of model's spoken output. */
	onOutputTranscription?(text: string): void;
	/** Server is shutting down — reconnect before timeLeft expires. */
	onGoAway?(timeLeft: string): void;
	/** New session resumption handle available. */
	onResumptionUpdate?(handle: string, resumable: boolean): void;
	/** Grounding metadata from Google Search results. */
	onGroundingMetadata?(metadata: Record<string, unknown>): void;
	/** Transport-level error. */
	onError?(error: Error): void;
	/** WebSocket connection closed. */
	onClose?(code?: number, reason?: string): void;
}

/**
 * WebSocket transport layer for the Gemini Live API.
 *
 * Wraps the `@google/genai` SDK's live.connect() to manage the bidirectional
 * audio stream. Handles connection setup, message routing, tool declaration
 * conversion (Zod → JSON Schema), and session resumption.
 *
 * Implements `LLMTransport` for provider-agnostic usage. The constructor
 * callback pattern is preserved for backward compatibility alongside the
 * LLMTransport callback properties.
 */
export class GeminiLiveTransport implements LLMTransport {
	private session: Session | null = null;
	private ai: GoogleGenAI;
	private callbacks: GeminiTransportCallbacks;
	private config: GeminiTransportConfig;
	/** Resolves when setupComplete fires — used to make connect() await Gemini readiness. */
	private setupResolver: (() => void) | null = null;
	/** Tracks whether onModelTurnStart has already fired for the current turn. */
	private _modelTurnStarted = false;
	/** Tracks whether onFirstAudioChunk has already fired for the current response. */
	private _firstAudioFired = false;
	/** Whether the transport should emit text output (used by external TTS pipelines). */
	private _textMode = false;
	/**
	 * True when text-mode is satisfied by output audio transcription instead of
	 * model text parts (native-audio model compatibility path).
	 */
	private _textFromOutputTranscription = false;
	/** Latest Gemini `usageMetadata` for the active model turn (cleared on `turnComplete`). */
	private _cachedGeminiUsage: unknown | null = null;
	// --- Server-turn state machine (external-TTS turn completion).
	//     See dev_docs/framework/design-external-tts-turn-completion.md. ---
	/** Gemini server-turn lifecycle: idle → generating → (ended_early) → closed. */
	private _serverTurnState: 'idle' | 'generating' | 'ended_early' | 'closed' = 'idle';
	/** Monotonic id of the current Gemini server turn (for finalization dedup). */
	private _serverTurnId = 0;
	/** Server turn whose remaining outbound audio is suppressed after a framework
	 *  `cancelResponse()` (Gemini can't cancel generation, so it keeps streaming
	 *  the already-generated response). `null` = not suppressing; self-clears when
	 *  the active server turn advances. See bufferedUncancellableAudio /
	 *  design-noncancellable-transport-barge-in.md. */
	private _suppressedServerTurnId: number | null = null;
	/** Whether the model emitted response text/transcription in the current turn. */
	private _textEmittedThisTurn = false;
	/** Whether a tool call appeared in the current turn (disables early completion). */
	private _toolCallSeenThisTurn = false;
	/** True while the framework turn has ended (early completion or interrupt) but
	 *  the Gemini server turn has not yet closed — the divergence window. */
	private _serverTurnWindingDown = false;
	/** Generation-triggering outbound sends buffered during the divergence window. */
	private _windingDownSendBuffer: Array<() => void> = [];
	/** Safety-net timer for a server turn whose `turnComplete` never arrives. */
	private _windingDownTimer?: ReturnType<typeof setTimeout>;
	/** Mutable resumption handle. Seeded at construct time from cfg, then
	 *  replaced by every `resumable: true` server update; cleared on
	 *  `resumable: false` so reconnect forces a fresh session + replay. */
	private effectiveResumptionHandle: string | null = null;
	/** Wall-clock ms of the most recent `resumable: false` server update.
	 *  Telemetry / debugging only — surfaced via getLastNonResumableAt(). */
	private lastNonResumableAt: number | null = null;

	/** Telemetry helper: the wall-clock ms of the most recent `resumable: false`
	 *  sessionResumptionUpdate observed, or null if none has fired. */
	getLastNonResumableAt(): number | null {
		return this.lastNonResumableAt;
	}

	// --- LLMTransport static properties ---

	readonly capabilities: TransportCapabilities = {
		messageTruncation: false,
		turnDetection: true,
		userTranscription: true,
		inPlaceSessionUpdate: false,
		sessionResumption: true,
		contextCompression: true,
		groundingMetadata: true,
		textResponseModality: true,
		// Gemini has no client-issued response.cancel — quiesce() works at the
		// framework layer (suppress onAudioOutput until unquiesce()). The
		// transport keeps the WS open and lets server-VAD handle pre-emption
		// when the user starts dictating into Whisper.
		quiescible: true,
		// `turnComplete` is delayed by the SDK until model audio playback should
		// be done — so the native playback-end gate must NOT engage for Gemini.
		playbackGatedTurnComplete: true,
		// Gemini streams the whole response faster than realtime and has no
		// cancel-generation command; `cancelResponse()` suppresses the current
		// turn's remaining outbound audio instead. The framework drives barge-in
		// via client VAD. See design-noncancellable-transport-barge-in.md.
		bufferedUncancellableAudio: true,
	};

	// --- Quiesce / unquiesce (cross-provider transcription-mode contract) ---
	private _quiesced = false;

	async quiesce(): Promise<void> {
		this._quiesced = true;
	}

	async unquiesce(): Promise<void> {
		this._quiesced = false;
	}

	readonly audioFormat: AudioFormatSpec = {
		inputSampleRate: 16000,
		outputSampleRate: 24000,
		channels: 1,
		bitDepth: 16,
		encoding: 'pcm',
	};

	// --- LLMTransport callback properties ---

	onAudioOutput?: (base64Data: string) => void;
	onToolCall?: (calls: TransportToolCall[]) => void;
	onToolCallCancel?: (ids: string[]) => void;
	onTurnComplete?: (serverTurnId?: number) => void;
	onInterrupted?: (serverTurnId?: number) => void;
	onInputTranscription?: (text: string) => void;
	onOutputTranscription?: (text: string) => void;
	onSessionReady?: (sessionId: string) => void;
	onError?: (error: LLMTransportError) => void;
	onClose?: (code?: number, reason?: string) => void;
	onModelTurnStart?: () => void;
	onFirstAudioChunk?: () => void;
	onGoAway?: (timeLeft: string) => void;
	onResumptionUpdate?: (handle: string, resumable: boolean) => void;
	onGroundingMetadata?: (metadata: Record<string, unknown>) => void;
	onTextOutput?: (text: string) => void;
	onTextDone?: () => void;
	onSpeechStarted?: () => void;
	onRealtimeLLMUsage?: (usage: RealtimeLLMUsageEvent) => void;

	constructor(config: GeminiTransportConfig, callbacks: GeminiTransportCallbacks) {
		this.ai = new GoogleGenAI({ apiKey: config.apiKey });
		this.config = config;
		this.callbacks = callbacks;

		// Seed effectiveResumptionHandle from config (sessionResumption wins over
		// the legacy resumptionHandle alias). After construct, server-issued
		// resumable handles always win (see handleSessionResumptionUpdate).
		if (
			typeof config.sessionResumption === 'object' &&
			config.sessionResumption !== null &&
			config.sessionResumption.handle
		) {
			this.effectiveResumptionHandle = config.sessionResumption.handle;
		} else if (config.resumptionHandle) {
			this.effectiveResumptionHandle = config.resumptionHandle;
			warnLegacyResumptionHandleOnce();
		}
	}

	/** Establish a WebSocket connection to the Gemini Live API.
	 *  Resolves only after Gemini sends `setupComplete`, so callers can safely
	 *  send content immediately after awaiting this method.
	 *
	 *  Also satisfies `LLMTransport.connect(config)` — if config is provided,
	 *  it is applied before connecting.
	 */
	async connect(transportConfig?: LLMTransportConfig): Promise<void> {
		if (transportConfig) {
			this.applyTransportConfig(transportConfig);
		}

		const setupComplete = new Promise<void>((resolve) => {
			this.setupResolver = resolve;
		});

		const model = this.config.model ?? DEFAULT_GEMINI_LIVE_MODEL;
		// Native-audio Live models reject the TEXT response modality. Beyond the
		// explicit "native-audio" names, all Gemini 3.x Live models are
		// native-audio (the suffix was dropped once it became the only mode).
		const isNativeAudioModel = /native-audio/i.test(model) || /^gemini-3[.-]/i.test(model);
		const nativeAudioTextFallback = this._textMode && isNativeAudioModel;
		this._textFromOutputTranscription = nativeAudioTextFallback;

		const connectConfig: Record<string, unknown> = {
			// In external TTS mode, request both AUDIO and TEXT:
			// - TEXT is consumed by the app's TTS provider
			// - AUDIO is ignored by the app, but keeps native-audio models happy
			//
			// Native-audio models reject TEXT modality; for those, use AUDIO +
			// outputAudioTranscription and route transcription text to TTS.
			responseModalities: nativeAudioTextFallback
				? ['AUDIO']
				: this._textMode
					? ['AUDIO', 'TEXT']
					: ['AUDIO'],
			...((this._textMode && nativeAudioTextFallback) || !this._textMode
				? { outputAudioTranscription: {} }
				: {}),
		};

		if (this.config.inputAudioTranscription !== false) {
			connectConfig.inputAudioTranscription = {};
		}

		if (this.config.realtimeInputConfig) {
			connectConfig.realtimeInputConfig = this.config.realtimeInputConfig;
		}

		if (this.config.systemInstruction) {
			connectConfig.systemInstruction = this.config.systemInstruction;
		}

		const toolEntries: Record<string, unknown>[] = [];
		if (this.config.googleSearch) {
			toolEntries.push({ googleSearch: {} });
		}
		if (this.config.tools?.length) {
			toolEntries.push({ functionDeclarations: this.config.tools.map(toolToDeclaration) });
		}
		if (toolEntries.length > 0) {
			connectConfig.tools = toolEntries;
		}

		// Session resumption resolution order (per design-context-caching.md §3):
		//   1. cfg.sessionResumption === false → omit (privacy/ZDR opt-out wins).
		//   2. effectiveResumptionHandle !== null → use it (server-issued or seeded).
		//   3. otherwise → {} (fresh resumable session, current default).
		if (this.config.sessionResumption === false) {
			// omit sessionResumption entirely
		} else if (this.effectiveResumptionHandle !== null) {
			connectConfig.sessionResumption = { handle: this.effectiveResumptionHandle };
		} else {
			connectConfig.sessionResumption = {};
		}

		if (this.config.speechConfig?.voiceName && !this._textMode) {
			connectConfig.speechConfig = {
				voiceConfig: { prebuiltVoiceConfig: { voiceName: this.config.speechConfig.voiceName } },
			};
		}

		if (this.config.compressionConfig) {
			connectConfig.contextWindowCompression = {
				triggerTokens: this.config.compressionConfig.triggerTokens,
				slidingWindow: { targetTokens: this.config.compressionConfig.targetTokens },
			};
		}

		this.session = await this.ai.live.connect({
			model,
			config: connectConfig,
			callbacks: {
				onopen: () => {},
				onmessage: (msg: LiveServerMessage) => this.handleMessage(msg),
				onerror: (e: { message?: string }) => {
					const error = new Error(e.message ?? 'WebSocket error');
					this.callbacks.onError?.(error);
					if (this.onError) this.onError({ error, recoverable: true });
				},
				onclose: (e: { code?: number; reason?: string }) => {
					const code = e?.code;
					const reason = e?.reason;
					this.callbacks.onClose?.(code, reason);
					if (this.onClose) this.onClose(code, reason);
				},
			},
		});

		const timeoutMs = this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`Gemini connect timed out after ${timeoutMs}ms`)),
				timeoutMs,
			);
		});
		await Promise.race([setupComplete, timeout]).finally(() => clearTimeout(timer));
	}

	/** Disconnect and reconnect, optionally with a new resumption handle or ReconnectState.
	 *  Accepts either a string handle (legacy API) or ReconnectState (LLMTransport API).
	 */
	async reconnect(stateOrHandle?: ReconnectState | string): Promise<void> {
		const timeoutMs = this.config.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS;
		const timer = setTimeout(() => {
			// Force-kill the stale session so disconnect() unblocks
			this.session = null;
		}, timeoutMs);

		try {
			await this.disconnect();

			// Honor the privacy/ZDR opt-out FIRST: if the caller configured
			// sessionResumption: false, no incoming handle (constructor, state,
			// or server) is used. Reconnect proceeds as a fresh session and
			// replays conversation history when present.
			let resumptionHandle: string | null;
			if (this.config.sessionResumption === false) {
				resumptionHandle = null;
			} else {
				const incoming =
					typeof stateOrHandle === 'string'
						? stateOrHandle
						: (stateOrHandle?.resumptionHandle ?? null);
				resumptionHandle = incoming ?? this.effectiveResumptionHandle;
				if (resumptionHandle) {
					this.effectiveResumptionHandle = resumptionHandle;
				}
			}

			await this.connect();

			// A resumed Gemini Live session already has server-side context. Replaying
			// history after resume duplicates state and can send Live-invalid tool parts.
			if (
				!resumptionHandle &&
				typeof stateOrHandle === 'object' &&
				stateOrHandle?.conversationHistory?.length
			) {
				this.replayHistory(stateOrHandle.conversationHistory);
			}
		} finally {
			clearTimeout(timer);
		}
	}

	async disconnect(): Promise<void> {
		this._modelTurnStarted = false;
		this._firstAudioFired = false;
		this._cachedGeminiUsage = null;
		this.resetServerTurnState();
		if (this.session) {
			try {
				await this.session.close();
			} catch {
				// Ignore close errors
			}
			this.session = null;
		}
	}

	/** Send base64-encoded PCM audio to Gemini as realtime input. */
	sendAudio(base64Data: string): void {
		if (!this.session) return;
		this.session.sendRealtimeInput({
			audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' },
		});
	}

	/** Send tool execution results back to Gemini (legacy API). */
	sendToolResponse(
		responses: Array<{ id?: string; name?: string; response?: Record<string, unknown> }>,
		scheduling?: 'SILENT' | 'WHEN_IDLE' | 'INTERRUPT',
	): void {
		if (!this.session) return;
		if (this.bufferIfWindingDown(() => this.sendToolResponse(responses, scheduling))) return;
		this.session.sendToolResponse({ functionResponses: responses });
	}

	/**
	 * Send text-based conversation turns to Gemini.
	 *
	 * @deprecated Prefer `sendContent()` for framework text turns. Live generation
	 * text should use realtime input; keep this only for legacy callers and context
	 * replay/prefill flows that need client-content ordering semantics.
	 */
	sendClientContent(
		turns: Array<{ role: string; parts: Array<{ text: string }> }>,
		turnComplete = true,
	): void {
		if (!this.session) return;
		if (this.bufferIfWindingDown(() => this.sendClientContent(turns, turnComplete))) return;
		this.session.sendClientContent({ turns, turnComplete });
	}

	/** Update the tool declarations (applied on next reconnect). */
	updateTools(tools: ToolDefinition[]): void {
		this.config.tools = tools;
	}

	/** Update the system instruction (applied on next reconnect). */
	updateSystemInstruction(instruction: string): void {
		this.config.systemInstruction = instruction;
	}

	/** Update Google Search grounding flag (applied on next reconnect). */
	updateGoogleSearch(enabled: boolean): void {
		this.config.googleSearch = enabled;
	}

	get isConnected(): boolean {
		return this.session !== null;
	}

	// --- LLMTransport methods ---

	private shouldUseRealtimeTextForContent(): boolean {
		const model = this.config.model ?? '';
		return (
			/^gemini-3(?:\.\d+)?-.*live/i.test(model) ||
			/^gemini-2\.5-.*(?:live|native-audio)/i.test(model)
		);
	}

	/** Send provider-neutral content turns to Gemini. Converts ContentTurn to Gemini format. */
	sendContent(turns: ContentTurn[], turnComplete = true): void {
		if (!this.session) return;
		if (this.bufferIfWindingDown(() => this.sendContent(turns, turnComplete))) return;
		if (turnComplete && this.shouldUseRealtimeTextForContent()) {
			const text = turns
				.map((t) => t.text.trim())
				.filter(Boolean)
				.join('\n\n');
			if (text.length > 0) {
				this.session.sendRealtimeInput({ text });
			}
			return;
		}
		const geminiTurns = turns.map((t) => ({
			role: t.role === 'assistant' ? 'model' : t.role,
			parts: [{ text: t.text }],
		}));
		this.session.sendClientContent({ turns: geminiTurns, turnComplete });
	}

	/** Send a file/image to Gemini as inline data. */
	sendFile(base64Data: string, mimeType: string): void {
		if (!this.session) return;
		if (this.bufferIfWindingDown(() => this.sendFile(base64Data, mimeType))) return;
		this.session.sendClientContent({
			turns: [{ role: 'user', parts: [{ inlineData: { data: base64Data, mimeType } }] as never[] }],
			turnComplete: false,
		});
	}

	/** Send a tool result back to Gemini (LLMTransport API). */
	sendToolResult(result: TransportToolResult): void {
		if (!this.session) return;
		if (this.bufferIfWindingDown(() => this.sendToolResult(result))) return;
		this.session.sendToolResponse({
			functionResponses: [
				{
					id: result.id,
					name: result.name,
					response: toFunctionResponsePayload(result.result),
				},
			],
		});
	}

	/** No-op for Gemini — generation is automatic after tool results and content injection. */
	triggerGeneration(_instructions?: string): void {
		// Gemini auto-generates after sendToolResponse and sendClientContent
	}

	/** Re-elicit a response from the resumed/existing server context with no new
	 *  content — a bare `turnComplete`. Used by the framework's response watchdog
	 *  after a reconnect. No-op if the session is not connected. */
	elicitResponse(): void {
		if (!this.session) return;
		// Omit `turns` entirely — the SDK parses any non-null/non-undefined value
		// and rejects an empty array ("contents are required"), so `turns: []`
		// throws instead of sending a bare turnComplete.
		this.session.sendClientContent({ turnComplete: true });
	}

	/** Replay a retained user utterance as a complete user turn — inline audio
	 *  content with an explicit `turnComplete`, deliberately NOT the realtime
	 *  channel (no server-VAD dependence; a brief utterance after a barge-in is
	 *  exactly what the server VAD dropped). Phase 0 validated this shape in both
	 *  clean and post-barge-in states (raw PCM, no input transcription emitted —
	 *  see design-retained-user-content-recovery.md). */
	replayUserTurn(turn: RetainedUserTurn): boolean {
		if (!this.session) return false;
		// Same winding-down discipline as sendContent/sendFile: a replay must not
		// race a session draining toward close.
		if (this.bufferIfWindingDown(() => this.replayUserTurn(turn))) return true;
		this.session.sendClientContent({
			turns: [
				{
					role: 'user',
					parts: [
						{
							inlineData: {
								data: turn.pcm.toString('base64'),
								mimeType: `audio/pcm;rate=${turn.sampleRateHz}`,
							},
						},
					] as never[],
				},
			],
			turnComplete: true,
		});
		return true;
	}

	/** No-op for V1 — server VAD only. */
	commitAudio(): void {}

	/** No-op for V1 — server VAD only. */
	clearAudio(): void {}

	/** Gemini has no cancel-generation wire command — its interrupts are
	 *  provider-driven via `serverContent.interrupted` and it keeps streaming the
	 *  rest of the already-generated response. So `cancelResponse()` satisfies the
	 *  widened contract ("stop the current response reaching the user") by
	 *  suppressing the current server turn's *remaining* outbound audio until the
	 *  next server turn (the response to the barge-in) begins. Drives the
	 *  `bufferedUncancellableAudio` capability.
	 *  See dev_docs/framework/design-noncancellable-transport-barge-in.md. */
	async cancelResponse(): Promise<void> {
		this._suppressedServerTurnId = this.getActiveServerTurnId() ?? null;
	}

	/** Whether the current server turn's remaining outbound audio is suppressed
	 *  (post `cancelResponse`). Self-clears once the active server turn advances. */
	private isOutboundAudioSuppressed(): boolean {
		if (this._suppressedServerTurnId === null) return false;
		if ((this.getActiveServerTurnId() ?? null) === this._suppressedServerTurnId) return true;
		this._suppressedServerTurnId = null;
		return false;
	}

	// Note: `clearInputAudio?` is intentionally not implemented for Gemini —
	// `sendRealtimeInput({audio})` streams directly with no persistent
	// server-managed buffer (commitAudio/clearAudio are also no-ops here).
	// VoiceSession calls `transport.clearInputAudio?.()` via optional chain;
	// the absence is the no-op.

	/** Update session configuration (applied on next reconnect for Gemini —
	 *  no in-place mutation, capabilities.inPlaceSessionUpdate is false).
	 *  Async signature for LLMTransport interface parity; body is synchronous. */
	async updateSession(config: SessionUpdate): Promise<void> {
		if (config.instructions !== undefined) {
			this.config.systemInstruction = config.instructions;
		}
		if (config.tools !== undefined) {
			this.config.tools = config.tools;
		}
		if (config.responseModality !== undefined) {
			this._textMode = config.responseModality === 'text';
		}
		if (config.transcription?.input !== undefined) {
			// Maps to Gemini's inputAudioTranscription connectConfig field.
			// Applied on next connect / reconnect (Gemini has no in-place update).
			this.config.inputAudioTranscription = config.transcription.input;
		}
		if (config.providerOptions !== undefined) {
			if (typeof config.providerOptions.googleSearch === 'boolean') {
				this.config.googleSearch = config.providerOptions.googleSearch;
			}
			if (config.providerOptions.compressionConfig) {
				this.config.compressionConfig = config.providerOptions.compressionConfig as {
					triggerTokens: number;
					targetTokens: number;
				};
			}
		}
	}

	/** Transfer session: update config → reconnect → replay conversation history. */
	async transferSession(config: SessionUpdate, state?: ReconnectState): Promise<void> {
		await this.updateSession(config);
		// Same resolution order as reconnect: privacy/ZDR opt-out wins, then
		// the incoming state handle, then our mutable effective handle.
		let resumptionHandle: string | null;
		if (this.config.sessionResumption === false) {
			resumptionHandle = null;
		} else {
			resumptionHandle = state?.resumptionHandle ?? this.effectiveResumptionHandle;
			if (resumptionHandle) {
				this.effectiveResumptionHandle = resumptionHandle;
			}
		}
		const resumingSession = !!resumptionHandle;
		await this.disconnect();
		await this.connect();

		// If Gemini resumes the previous Live session, server-side context is already
		// present. Only replay for a fresh session that has no resumption handle.
		if (!resumingSession && state?.conversationHistory?.length) {
			this.replayHistory(state.conversationHistory);
		}
	}

	// --- Private helpers ---

	/** Apply LLMTransportConfig fields to the internal GeminiTransportConfig. */
	/** Merge LLMTransportConfig into the internal config. Only provided fields are applied;
	 *  undefined fields preserve existing constructor values.
	 */
	private applyTransportConfig(config: LLMTransportConfig): void {
		if (config.auth.type === 'api_key') {
			this.ai = new GoogleGenAI({ apiKey: config.auth.apiKey });
		}
		if (config.model !== undefined) {
			this.config.model = config.model;
		}
		if (config.instructions !== undefined) {
			this.config.systemInstruction = config.instructions;
		}
		if (config.tools !== undefined) {
			this.config.tools = config.tools;
		}
		if (config.voice !== undefined) {
			this.config.speechConfig = { voiceName: config.voice };
		}
		if (config.transcription !== undefined) {
			this.config.inputAudioTranscription = config.transcription.input ?? true;
		}
		if (config.realtimeInputConfig !== undefined) {
			this.config.realtimeInputConfig = config.realtimeInputConfig;
		}
		if (config.providerOptions) {
			if (typeof config.providerOptions.googleSearch === 'boolean') {
				this.config.googleSearch = config.providerOptions.googleSearch;
			}
			if (config.providerOptions.compressionConfig) {
				this.config.compressionConfig = config.providerOptions.compressionConfig as {
					triggerTokens: number;
					targetTokens: number;
				};
			}
		}
		if (config.responseModality !== undefined) {
			this._textMode = config.responseModality === 'text';
		}
	}

	/** Convert ReplayItem[] to Gemini Content format and send as client content. */
	private replayHistory(items: ReplayItem[]): void {
		if (!this.session || items.length === 0) return;
		const turns: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

		for (const item of items) {
			switch (item.type) {
				case 'text':
					turns.push({
						role: item.role === 'assistant' ? 'model' : item.role,
						parts: [{ text: item.text }],
					});
					break;
				case 'tool_call':
					turns.push({
						role: 'user',
						parts: [
							{
								text: `[Previous tool call: ${item.name}(${JSON.stringify(item.args)})]`,
							},
						],
					});
					break;
				case 'tool_result':
					turns.push({
						role: 'user',
						parts: [
							{
								text: `[Previous tool result for ${item.name}: ${JSON.stringify(item.result)}]`,
							},
						],
					});
					break;
				case 'file':
					turns.push({
						role: 'user',
						parts: [{ inlineData: { data: item.base64Data, mimeType: item.mimeType } }],
					});
					break;
				case 'transfer':
					turns.push({
						role: 'user',
						parts: [{ text: `[Agent transfer: ${item.fromAgent} → ${item.toAgent}]` }],
					});
					break;
			}
		}

		this.session.sendClientContent({ turns, turnComplete: false });
	}

	// --- Server-turn state machine (external-TTS turn completion) ---

	/**
	 * The id of the server turn currently being generated, or `undefined` when
	 * no server turn is active. Active-only by contract: between turns
	 * (`idle` / `closed`) `_serverTurnId` still holds the previous turn's value,
	 * so it must not be exposed — a stale id would mis-bind a freshly-born `Turn`.
	 */
	getActiveServerTurnId(): number | undefined {
		return this._serverTurnState === 'generating' || this._serverTurnState === 'ended_early'
			? this._serverTurnId
			: undefined;
	}

	/** Begin a new Gemini server turn (fresh id) if one is not already open. */
	private beginServerTurn(): void {
		if (this._serverTurnState === 'generating' || this._serverTurnState === 'ended_early') {
			return;
		}
		this._serverTurnState = 'generating';
		this._serverTurnId++;
		this._textEmittedThisTurn = false;
		this._toolCallSeenThisTurn = false;
		this._serverTurnWindingDown = false;
		// New server turn — stop suppressing post-cancelResponse trailing audio.
		this._suppressedServerTurnId = null;
	}

	/** Close the current server turn and flush any buffered outbound sends. */
	private closeServerTurn(): void {
		this._serverTurnState = 'closed';
		this._serverTurnWindingDown = false;
		this._modelTurnStarted = false;
		this._firstAudioFired = false;
		if (this._windingDownTimer) {
			clearTimeout(this._windingDownTimer);
			this._windingDownTimer = undefined;
		}
		this.flushWindingDownBuffer();
	}

	/** Reset all server-turn state (disconnect / reconnect). */
	private resetServerTurnState(): void {
		this._serverTurnState = 'idle';
		this._serverTurnWindingDown = false;
		this._suppressedServerTurnId = null;
		this._textEmittedThisTurn = false;
		this._toolCallSeenThisTurn = false;
		this._windingDownSendBuffer = [];
		if (this._windingDownTimer) {
			clearTimeout(this._windingDownTimer);
			this._windingDownTimer = undefined;
		}
	}

	/** Buffer a generation-triggering send during the divergence window.
	 *  Returns true if buffered (caller must not also send). */
	private bufferIfWindingDown(send: () => void): boolean {
		if (this._serverTurnWindingDown) {
			this._windingDownSendBuffer.push(send);
			return true;
		}
		return false;
	}

	private flushWindingDownBuffer(): void {
		if (this._windingDownSendBuffer.length === 0) return;
		const buffered = this._windingDownSendBuffer;
		this._windingDownSendBuffer = [];
		for (const send of buffered) {
			try {
				send();
			} catch {
				// best-effort flush
			}
		}
	}

	/** Safety net: force-close a server turn whose `turnComplete` never arrives,
	 *  so buffered sends are not leaked. */
	private startWindingDownTimer(): void {
		if (this._windingDownTimer) clearTimeout(this._windingDownTimer);
		this._windingDownTimer = setTimeout(() => {
			this._windingDownTimer = undefined;
			if (this._serverTurnState !== 'ended_early') return;
			const err = new Error('GeminiLiveTransport: server turn wedged — turnComplete never arrived');
			this.callbacks.onError?.(err);
			if (this.onError) this.onError({ error: err, recoverable: true });
			this.closeServerTurn();
		}, DEFAULT_RECONNECT_TIMEOUT_MS);
	}

	/** Tag a usage event with the current server-turn id / winding-down phase. */
	private tagUsage(usage: RealtimeLLMUsageEvent): RealtimeLLMUsageEvent {
		usage.serverTurnId = this._serverTurnId;
		if (this._serverTurnWindingDown) usage.serverTurnWindingDown = true;
		return usage;
	}

	// biome-ignore lint/suspicious/noExplicitAny: LiveServerMessage is a complex union type
	private handleMessage(msg: any): void {
		if (msg.setupComplete) {
			// Resolve the connect() promise so callers know Gemini is ready
			if (this.setupResolver) {
				this.setupResolver();
				this.setupResolver = null;
			}
			const sessionId = msg.setupComplete.sessionId ?? '';
			this.callbacks.onSetupComplete?.(sessionId);
			if (this.onSessionReady) this.onSessionReady(sessionId);
			return;
		}

		// Usage may appear on its own server message or alongside other fields.
		if (msg.usageMetadata) {
			this._cachedGeminiUsage = msg.usageMetadata;
			const update = normalizeGeminiUsageMetadata(msg.usageMetadata, 'update');
			if (update && this.onRealtimeLLMUsage) this.onRealtimeLLMUsage(this.tagUsage(update));
		}

		if (msg.serverContent) {
			const content = msg.serverContent;

			// Model output — fire onModelTurnStart on first modelTurn.parts per turn
			if (content.modelTurn?.parts) {
				this.beginServerTurn();
				if (!this._modelTurnStarted) {
					this._modelTurnStarted = true;
					this.callbacks.onModelTurnStart?.();
					if (this.onModelTurnStart) this.onModelTurnStart();
				}
				for (const part of content.modelTurn.parts) {
					if (part.inlineData?.data) {
						// In text-mode pipelines (external TTS), Gemini audio is intentionally ignored.
						// In _quiesced mode (cross-provider transcription mode), Gemini audio is
						// suppressed at this seam — VoiceSession owns the routing decision.
						if (!this._textMode && !this._quiesced && !this.isOutboundAudioSuppressed()) {
							if (!this._firstAudioFired) {
								this._firstAudioFired = true;
								this.callbacks.onFirstAudioChunk?.();
								if (this.onFirstAudioChunk) this.onFirstAudioChunk();
							}
							this.callbacks.onAudioOutput?.(part.inlineData.data);
							if (this.onAudioOutput) this.onAudioOutput(part.inlineData.data);
						}
					}
					if (part.text !== undefined && part.text !== null && !this._textFromOutputTranscription) {
						// Text output (text mode — for TTS). In native-audio text fallback,
						// prefer outputTranscription and suppress model text parts.
						if (this.onTextOutput) {
							this._textEmittedThisTurn = true;
							this.onTextOutput(part.text);
						}
					}
				}
			}

			// Grounding metadata (Google Search results)
			if (content.groundingMetadata) {
				this.callbacks.onGroundingMetadata?.(content.groundingMetadata);
				if (this.onGroundingMetadata) this.onGroundingMetadata(content.groundingMetadata);
			}

			// Transcriptions
			if (content.inputTranscription?.text) {
				// Best-effort speech-start signal for external TTS barge-in.
				// Gemini Live does not currently expose a dedicated speech_started event.
				if (this.onSpeechStarted) this.onSpeechStarted();
				this.callbacks.onInputTranscription?.(content.inputTranscription.text);
				if (this.onInputTranscription) this.onInputTranscription(content.inputTranscription.text);
			}
			if (content.outputTranscription?.text) {
				this.beginServerTurn();
				this.callbacks.onOutputTranscription?.(content.outputTranscription.text);
				if (this.onOutputTranscription)
					this.onOutputTranscription(content.outputTranscription.text);
				if (this._textMode && this._textFromOutputTranscription && this.onTextOutput) {
					this._textEmittedThisTurn = true;
					this.onTextOutput(content.outputTranscription.text);
				}
			}

			// Turn signals
			if (content.interrupted) {
				if (this._serverTurnState === 'idle' || this._serverTurnState === 'closed') {
					this.beginServerTurn();
				}
				// The framework turn ends on interrupt; the Gemini server turn stays
				// open until its turnComplete — the divergence window. Only relevant
				// in text mode (external TTS): without it the framework turn ends on
				// turnComplete as usual, so there is no divergence window to buffer.
				if (this._textMode) this._serverTurnWindingDown = true;
				// Mirror interruption as speech-start signal for consumers that need
				// barge-in semantics while model audio/text may still be flushing.
				if (this.onSpeechStarted) this.onSpeechStarted();
				this.callbacks.onInterrupted?.(this._serverTurnId);
				if (this.onInterrupted) this.onInterrupted(this._serverTurnId);
			}

			// generationComplete — early turn end in text mode. It arrives well
			// before the playback-gated turnComplete and (verified) after all
			// transcription text. See design-external-tts-turn-completion.md.
			if (
				content.generationComplete &&
				this._textMode &&
				this._textEmittedThisTurn &&
				!this._toolCallSeenThisTurn &&
				this._serverTurnState === 'generating' &&
				!this._serverTurnWindingDown
			) {
				this._serverTurnState = 'ended_early';
				this._serverTurnWindingDown = true;
				this.startWindingDownTimer();
				// onTextDone before onTurnComplete (ordering contract).
				if (this.onTextDone) this.onTextDone();
				this.callbacks.onTurnComplete?.(this._serverTurnId);
				if (this.onTurnComplete) this.onTurnComplete(this._serverTurnId);
			}

			if (content.turnComplete) {
				if (this._serverTurnState === 'idle' || this._serverTurnState === 'closed') {
					// Bare turnComplete, no model content — no-model-output safety net.
					this.beginServerTurn();
				}
				const completedServerTurnId = this._serverTurnId;
				const firedEarly = this._serverTurnState === 'ended_early';
				// Final usage is only known at turnComplete.
				if (this._cachedGeminiUsage) {
					const fin = normalizeGeminiUsageMetadata(this._cachedGeminiUsage, 'final');
					if (fin && this.onRealtimeLLMUsage) this.onRealtimeLLMUsage(this.tagUsage(fin));
					this._cachedGeminiUsage = null;
				}
				if (!firedEarly) {
					// GENERATING/IDLE → CLOSED: turn-end callbacks were not fired early.
					if (this._textMode && this.onTextDone) this.onTextDone();
					this.callbacks.onTurnComplete?.(completedServerTurnId);
					if (this.onTurnComplete) this.onTurnComplete(completedServerTurnId);
				}
				this.closeServerTurn();
			}
			return;
		}

		if (msg.toolCall?.functionCalls?.length) {
			this.beginServerTurn();
			this._toolCallSeenThisTurn = true;
			// Fire onModelTurnStart on first toolCall if no audio preceded it
			if (!this._modelTurnStarted) {
				this._modelTurnStarted = true;
				this.callbacks.onModelTurnStart?.();
				if (this.onModelTurnStart) this.onModelTurnStart();
			}
			this.callbacks.onToolCall?.(msg.toolCall.functionCalls);
			if (this.onToolCall) this.onToolCall(msg.toolCall.functionCalls);
			return;
		}

		if (msg.toolCallCancellation?.ids?.length) {
			this.callbacks.onToolCallCancellation?.(msg.toolCallCancellation.ids);
			if (this.onToolCallCancel) this.onToolCallCancel(msg.toolCallCancellation.ids);
			return;
		}

		if (msg.goAway) {
			this.callbacks.onGoAway?.(msg.goAway.timeLeft ?? '');
			if (this.onGoAway) this.onGoAway(msg.goAway.timeLeft ?? '');
			return;
		}

		if (msg.sessionResumptionUpdate?.newHandle) {
			const handle = msg.sessionResumptionUpdate.newHandle;
			const resumable = msg.sessionResumptionUpdate.resumable ?? false;
			// Policy: keep effectiveResumptionHandle in sync with the latest
			// resumable handle. On non-resumable updates, clear it so the next
			// reconnect forces a fresh session + replay (per Google's docs,
			// resuming from an old handle after non-resumable can lose data).
			if (resumable) {
				this.effectiveResumptionHandle = handle;
			} else {
				this.effectiveResumptionHandle = null;
				this.lastNonResumableAt = Date.now();
			}
			// Maintain the legacy alias too so any caller still reading
			// transport.config.resumptionHandle observes the latest server handle.
			this.config.resumptionHandle = handle;
			this.callbacks.onResumptionUpdate?.(handle, resumable);
			if (this.onResumptionUpdate) {
				this.onResumptionUpdate(handle, resumable);
			}
		}
	}
}

/** Convert a ToolDefinition to a Gemini function declaration (name + description + JSON Schema). */
function toolToDeclaration(tool: ToolDefinition): Record<string, unknown> {
	return {
		name: tool.name,
		description: tool.description,
		parameters: zodToJsonSchema(tool.parameters),
	};
}
