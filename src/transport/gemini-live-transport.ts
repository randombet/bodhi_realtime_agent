import {
	type FunctionResponseScheduling,
	GoogleGenAI,
	type LiveConnectConfig,
	type LiveServerMessage,
	type RealtimeInputConfig,
	type Session,
	type UsageMetadata,
} from '@google/genai';
import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_RECONNECT_TIMEOUT_MS } from '../core/constants.js';
import { ValidationError } from '../core/errors.js';
import type { FunctionBehavior, ToolDefinition } from '../types/tool.js';
import type {
	AudioFormatSpec,
	ConnectFailure,
	ConnectionLifecycleEvent,
	ContentTurn,
	GenerationEndReason,
	LLMTransport,
	LLMTransportConfig,
	LLMTransportError,
	RealtimeLLMUsageEvent,
	ReconnectState,
	ReplayItem,
	RetainedUserTurn,
	SessionUpdate,
	TransportCapabilities,
	TransportDiagnostics,
	TransportToolCall,
	TransportToolResult,
	TransportUsageMetadata,
	UpstreamCounters,
	UpstreamSlotCounters,
} from '../types/transport.js';
import { ConnectionLifecycleLedger } from './connection-lifecycle-ledger.js';
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

/** Framework scheduling hint to Gemini's `FunctionResponseScheduling`. `immediate` sends none,
 *  leaving Gemini's own default for a non-blocking response. */
const GEMINI_SCHEDULING: Record<
	NonNullable<TransportToolResult['scheduling']>,
	FunctionResponseScheduling | undefined
> = {
	immediate: undefined,
	when_idle: 'WHEN_IDLE' as FunctionResponseScheduling,
	interrupt: 'INTERRUPT' as FunctionResponseScheduling,
	silent: 'SILENT' as FunctionResponseScheduling,
};

/**
 * Recursively sanitize a tool result so it conforms to `google.protobuf.Struct`,
 * which only holds null, boolean, number, string, array and object. An object
 * with a callable `toJSON` is replaced by what it returns, as `JSON.stringify`
 * does (a `Date` becomes its ISO string). Object fields that are `undefined` are
 * dropped (array slots become `null`), non-finite numbers, bigints and other
 * non-JSON values become strings, and a non-object result is wrapped as
 * `{ result }`.
 */
function sanitizeForStruct(value: unknown): Record<string, unknown> {
	const sanitized = sanitizeValue(value, '');
	if (typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)) {
		return sanitized as Record<string, unknown>;
	}
	return { result: sanitized };
}

/** Apply an object's callable `toJSON` once, with its property key, as `JSON.stringify` does. */
function applyToJSON(value: unknown, key: string): unknown {
	if (typeof value === 'object' && value !== null) {
		const toJSON = (value as { toJSON?: unknown }).toJSON;
		if (typeof toJSON === 'function') return toJSON.call(value, key);
	}
	return value;
}

function sanitizeValue(value: unknown, key: string): unknown {
	return sanitizeResolved(applyToJSON(value, key));
}

/** Sanitize a value whose own `toJSON` (if any) has already been applied. */
function sanitizeResolved(value: unknown): unknown {
	if (value === undefined || value === null) return null;
	if (typeof value === 'boolean' || typeof value === 'string') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) return String(value);
		return value;
	}
	if (Array.isArray(value)) return value.map((v, i) => sanitizeValue(v, String(i)));
	if (typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const resolved = applyToJSON(v, k);
			if (resolved !== undefined) out[k] = sanitizeResolved(resolved);
		}
		return out;
	}
	return String(value);
}

export type GeminiRealtimeInputConfig = RealtimeInputConfig | Record<string, unknown>;

/** Session-wide media token cost for image/video input (`LOW` = 64 tokens per frame). */
export type GeminiMediaResolution =
	| 'MEDIA_RESOLUTION_LOW'
	| 'MEDIA_RESOLUTION_MEDIUM'
	| 'MEDIA_RESOLUTION_HIGH';

/** Gemini automatic activity detection (server VAD) settings, sent as
 *  `realtimeInputConfig.automaticActivityDetection` exactly as given. */
export interface GeminiVadConfig {
	disabled?: boolean;
	startOfSpeechSensitivity?: string;
	endOfSpeechSensitivity?: string;
	prefixPaddingMs?: number;
	silenceDurationMs?: number;
}

/** Context-window compression thresholds, in tokens. Each one left unset is
 *  omitted from the setup message, so the server's default applies (trigger at
 *  80% of the model limit, target half of it); `{}` enables compression with
 *  both defaults. */
export type GeminiCompressionConfig = { triggerTokens?: number; targetTokens?: number };

/**
 * Framework default applied by VoiceSession when neither realtimeInputConfig
 * nor vadConfig is provided (`realtimeInputConfig: false` opts out of it).
 * Tuned to feel less eager than Gemini's stock VAD
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
 * the default. If user is undefined, returns the default unchanged; if user is
 * `false` (the opt-out), returns undefined so no realtimeInputConfig is sent.
 */
export function resolveGeminiRealtimeInputConfig(
	user: GeminiRealtimeInputConfig | false | undefined,
): GeminiRealtimeInputConfig | undefined {
	if (user === false) return undefined;
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

/** The final setup of one connection: exactly what the transport passes to
 *  `live.connect`. Built once per connect and deep-frozen, so a credential
 *  locked to it (a Gemini ephemeral token with `liveConnectConstraints`)
 *  locks what is actually sent. */
export interface GeminiLiveSetup {
	readonly model: string;
	readonly config: Readonly<LiveConnectConfig>;
}

/** What a {@link GeminiCredentialProvider} returns: the credential for one connection. */
export interface GeminiCredential {
	/** An API key or an ephemeral token (`auth_tokens/…`), used for this one connection. */
	apiKey: string;
	/** Gemini API version for this connection (the SDK's ephemeral-token support
	 *  expects `v1alpha`). Omitted, the SDK's default applies. */
	apiVersion?: string;
	/** Epoch ms when the transport closes this connection and reconnects with a
	 *  new credential, whether or not the server sent GoAway. Must be finite and
	 *  at least `connectTimeoutMs` away when the provider returns. */
	expiresAtMs: number;
	/** Opaque to the transport: carried on this connection's lifecycle events. */
	meta?: unknown;
}

/**
 * Fetches the credential for one connection. Called inside every `connect()`
 * (start, reconnect, transfer, recovery redial) with that connection's final
 * setup, which is the object `live.connect` receives a copy of. `signal`
 * aborts when the attempt is cancelled: its half of the connect deadline ran
 * out, `abortIncumbent()` retired it, a newer `connect()` superseded it, or
 * `disconnect()` ran while it fetched. A credential that arrives after
 * cancellation is dropped unused.
 */
export type GeminiCredentialProvider = (
	setup: GeminiLiveSetup,
	signal: AbortSignal,
) => Promise<GeminiCredential>;

/** Configuration for connecting to the Gemini Live API with one static API key. */
export interface GeminiTransportConfig extends GeminiTransportOptions {
	/** Google API key for authentication. */
	apiKey: string;
	credentialProvider?: never;
}

/** Configuration for connecting to the Gemini Live API with a credential
 *  fetched for each connection. */
export interface GeminiProviderTransportConfig extends GeminiTransportOptions {
	/** Per-connection credentials. The transport builds no client of its own
	 *  and never uses a static key: each connect gets a client built from the
	 *  provider's credential, with the Developer API selected explicitly
	 *  (`vertexai: false`, `enterprise: false`), so the SDK's routing environment
	 *  variables do not apply. `connect(config).auth` is ignored. */
	credentialProvider: GeminiCredentialProvider;
	apiKey?: never;
}

/** The Gemini transport's options apart from its credential. */
export interface GeminiTransportOptions {
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
	/** Context-window compression. Thresholds are sent as strings (the API types
	 *  them as int64); an unset one is omitted so the server default applies,
	 *  and `{}` enables compression with both defaults. */
	compressionConfig?: GeminiCompressionConfig;
	/** Session-wide media token cost for image/video input. Applies to every
	 *  realtime-input image this transport sends; realtime input has no
	 *  per-send override. Omitted → server default. */
	mediaResolution?: GeminiMediaResolution;
	/** Default `behavior` written on every function declaration that does not set its own.
	 *  Unset sends no `behavior`, so the model's default applies. */
	functionBehavior?: FunctionBehavior;
	/** Enable Gemini's built-in Google Search grounding. */
	googleSearch?: boolean;
	/** Enable server-side transcription of user audio input (default: true). */
	inputAudioTranscription?: boolean;
	/** Gemini Live realtime input behavior, including server-side VAD tuning,
	 *  sent as given. `false` sends no `realtimeInputConfig` at all, so the
	 *  server's own defaults apply. Mutually exclusive with `vadConfig`. */
	realtimeInputConfig?: GeminiRealtimeInputConfig | false;
	/** Shorthand for `realtimeInputConfig: { automaticActivityDetection: vadConfig }`,
	 *  sent verbatim with nothing merged in. Supplying it together with
	 *  `realtimeInputConfig` (including `false`) throws a `ValidationError`. */
	vadConfig?: GeminiVadConfig;
	/** Timeout in ms for connect() to receive setupComplete (default: 30000).
	 *  With a `credentialProvider` it is one deadline over the credential fetch,
	 *  the dial and setupComplete; the fetch may use at most half of it. */
	connectTimeoutMs?: number;
	/** Force-kill delay in ms for `reconnect()` (default: 45000): when it expires
	 *  and no newer dial has started, the session field is cleared. It does not
	 *  bound the incumbent's close or the redial. */
	reconnectTimeoutMs?: number;
}

/** Token accounting as reported by the Live server.
 *
 * Aliases the SDK's own schema so every field the server sends stays reachable
 * — a hand-written subset would silently hide cache and tool-use counts.
 * `promptTokenCount` is the standing prompt size, the field to watch for context
 * growth; `totalTokenCount` adds response tokens and so does not describe it. */
export type LiveUsageMetadata = UsageMetadata;

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
	/** A new generation opened (first model output or tool call of an answer). */
	onModelTurnStart?(generationId?: string): void;
	/** A generation opened. Paired with exactly one `onGenerationEnd`. */
	onGenerationStart?(generationId: string): void;
	/** That generation closed, and why. Fires exactly once per start. */
	onGenerationEnd?(generationId: string, reason: GenerationEndReason): void;
	/** The provider said `generationComplete` (any response modality). Distinct
	 *  from `turnComplete`. */
	onGenerationComplete?(): void;
	/** First audio chunk of the model's response (TTS-first-audio anchor). */
	onFirstAudioChunk?(): void;
	/** Transcription of user's spoken input. */
	onInputTranscription?(text: string): void;
	/** Transcription of model's spoken output. */
	onOutputTranscription?(text: string): void;
	/** Server is shutting down — reconnect before timeLeft expires. */
	onGoAway?(timeLeft: string): void;
	/** The current connection's credential expired (`credentialProvider` only);
	 *  see `LLMTransport.onCredentialExpiry`. */
	onCredentialExpiry?(): void;
	/** New session resumption handle available. */
	onResumptionUpdate?(handle: string, resumable: boolean): void;
	/** Connection-lifecycle facts (attempt / setup / close). */
	onConnectionLifecycle?(event: ConnectionLifecycleEvent): void;
	/** Server-reported token accounting. Fires on EVERY message carrying it,
	 *  including ones that also carry serverContent, a tool call, or goAway. */
	onUsageMetadata?(usage: LiveUsageMetadata): void;
	/** Grounding metadata from Google Search results. */
	onGroundingMetadata?(metadata: Record<string, unknown>): void;
	/** Transport-level error. */
	onError?(error: Error): void;
	/** WebSocket connection closed. */
	onClose?(code?: number, reason?: string): void;
}

function freshSlot(): UpstreamSlotCounters {
	return {
		attempted: 0,
		queued: 0,
		skippedNoSession: 0,
		threw: 0,
		attemptedRawBytes: 0,
		queuedRawBytes: 0,
		attemptedWireBytesEstimate: 0,
		queuedWireBytesEstimate: 0,
		lastAttemptedAt: null,
		lastQueuedAt: null,
		lastSkippedAt: null,
		lastThrewAt: null,
	};
}

function freshUpstreamCounters(): UpstreamCounters {
	return {
		audio: freshSlot(),
		video: { ...freshSlot(), unsupportedMime: 0 },
		text: { ...freshSlot(), skippedEmpty: 0 },
	};
}

/** Raw and wire-estimate byte sizes of a `clientContent` batch payload: UTF-8
 *  text parts count the same on both; inline data counts decoded bytes raw and
 *  base64 characters on the wire. */
function clientContentBytes(turns: ReadonlyArray<{ parts: ReadonlyArray<unknown> }>): {
	raw: number;
	wire: number;
} {
	let raw = 0;
	let wire = 0;
	// Tolerant of malformed input: instrumentation must never throw where the SDK
	// send would have been reached.
	for (const turn of Array.isArray(turns) ? turns : []) {
		const parts = Array.isArray(turn?.parts) ? turn.parts : [];
		for (const part of parts as ReadonlyArray<{
			text?: string;
			inlineData?: { data?: string };
		} | null>) {
			if (!part) continue;
			if (typeof part.text === 'string') {
				const bytes = Buffer.byteLength(part.text, 'utf8');
				raw += bytes;
				wire += bytes;
			}
			const data = part.inlineData?.data;
			if (typeof data === 'string') {
				raw += Buffer.byteLength(data, 'base64');
				wire += data.length;
			}
		}
	}
	return { raw, wire };
}

/** Close reason of a connection closed at its credential's expiry. */
const CREDENTIAL_EXPIRED = 'credential expired';

/** Where a credential-provider connect attempt is: fetching its credential,
 *  dialing, or opened and waiting for setupComplete. */
interface CredentialAttempt {
	stage: ConnectFailure['source'];
	/** The last WebSocket error message, for a refused upgrade's HTTP status. */
	lastError?: string;
	/** Set by the failure that ended the attempt, when it knew more than a timeout. */
	failure?: ConnectFailure;
	/** The credential's expiry, once the provider returned. */
	expiresAtMs?: number;
}

/** `disconnect()`'s hold on a credential-provider connect until its
 *  setupComplete. */
interface PendingSetup {
	/** Fence the connect off, report its failure, and fail its setup wait. */
	retire(): void;
	/** The dial generation `retire()` left, when it was the one to advance it. */
	retiredGen?: number;
}

/** HTTP status of a refused WebSocket upgrade, from the `ws` error message. */
function upgradeStatus(message: string | undefined): number | undefined {
	const match = /Unexpected server response: (\d{3})/.exec(message ?? '');
	return match ? Number(match[1]) : undefined;
}

/** A socket close before setupComplete, as a `ConnectFailure`. */
function closeFailure(
	attempt: CredentialAttempt,
	message: string,
	code: number | undefined,
	reason: string | undefined,
): ConnectFailure {
	const source = attempt.stage === 'session' ? 'session' : 'dial';
	const status = source === 'dial' ? upgradeStatus(attempt.lastError) : undefined;
	return {
		source,
		message,
		...(code !== undefined ? { code } : {}),
		...(reason ? { reason } : {}),
		...(status !== undefined ? { status } : {}),
	};
}

/** A failure that came with nothing but a message (the deadline, a supersede). */
function stageFailure(attempt: CredentialAttempt, message: string): ConnectFailure {
	return { source: attempt.stage, message };
}

/** Why a provider's credential is refused, or `null` when it is usable. */
function refuseCredential(credential: GeminiCredential, connectTimeoutMs: number): string | null {
	if (typeof credential?.apiKey !== 'string' || credential.apiKey === '') {
		return 'credentialProvider returned no apiKey';
	}
	if (!Number.isFinite(credential.expiresAtMs)) {
		return 'credentialProvider returned a non-finite expiresAtMs';
	}
	const remainingMs = credential.expiresAtMs - Date.now();
	if (remainingMs < connectTimeoutMs) {
		return `credential expires in ${remainingMs}ms, less than the ${connectTimeoutMs}ms connect deadline`;
	}
	return null;
}

/** `promise`, rejected with the signal's reason once it aborts, whether or not
 *  `promise` honors the signal. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			},
		);
	});
}

/** Freeze `value` and everything it holds. */
function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
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
	/** Bound on `abortIncumbent()`'s close of the stranded session. */
	private static readonly ABORT_INCUMBENT_CLOSE_TIMEOUT_MS = 5_000;
	/** Longest single `setTimeout` (Node fires a longer one at once). */
	private static readonly MAX_TIMER_MS = 2_147_483_647;

	private session: Session | null = null;
	/** The static-key client; `null` with a `credentialProvider`, where each
	 *  connect builds its own. */
	private ai: GoogleGenAI | null;
	private callbacks: GeminiTransportCallbacks;
	private config: GeminiTransportConfig | GeminiProviderTransportConfig;
	private readonly credentialProvider: GeminiCredentialProvider | undefined;
	/** Cancels the credential fetch of the dial in flight, if any. */
	private credentialFetch: AbortController | null = null;
	/** Retires the latest credential-provider connect until its setupComplete
	 *  arrives, so `disconnect()` retires it at any stage: fetching, dialing, or
	 *  opened and waiting for setup. */
	private pendingSetup: PendingSetup | null = null;
	/** The expiry timer of the current dial's credential. */
	private credentialExpiry: { gen: number; timer: ReturnType<typeof setTimeout> } | null = null;
	/** Resolves when setupComplete fires — used to make connect() await Gemini readiness. */
	private setupResolver: (() => void) | null = null;
	/** Increments per dial and when the current dial fails or is aborted; socket
	 *  callbacks capture their dial's value so a superseded dial's events never
	 *  reach the live handlers. */
	private dialGen = 0;
	/** Post-setup generation counter, distinct from the dial counter (which also
	 *  advances on failed and aborted dials). Minted by the lifecycle ledger on
	 *  each `setupComplete` and adopted from its setup-ok event; 0 until then. */
	private transportGeneration = 0;
	/** The close `disconnect()` is awaiting on the session it detached, kept until
	 *  that close settles so `abortIncumbent()` can still bound it. Only the call
	 *  that recorded it clears it. */
	private pendingDisconnectClose: Promise<void> | null = null;
	/** Behavior of the declarations sent on the last dial; staged tool updates apply only on reconnect. */
	private liveBehaviors: {
		byTool: Map<string, FunctionBehavior | undefined>;
		fallback?: FunctionBehavior;
	} = {
		byTool: new Map(),
	};
	/** Upstream send counters for the current generation; reset on `setupComplete`. */
	private upstream: UpstreamCounters = freshUpstreamCounters();
	/** Attempt/generation identity, fed this transport's `dialGen` (the fence in
	 *  `connect()` keeps superseded dials' socket events away from it). */
	private readonly lifecycle = new ConnectionLifecycleLedger((event) => {
		// Adopt the minted generation before any observer runs, so a setup-ok
		// observer reading `currentTransportGeneration`/`getDiagnostics()` sees it.
		if (event.kind === 'setup-ok') this.transportGeneration = event.transportGeneration;
		this.notifyObserver('onConnectionLifecycle', () =>
			this.callbacks.onConnectionLifecycle?.(event),
		);
		this.notifyObserver('onConnectionLifecycle', () => this.onConnectionLifecycle?.(event));
	});
	/**
	 * Where the current generation is. A generation is one answer, the unit a
	 * consumer builds per-answer state on; it is NOT a Gemini server turn.
	 *
	 *   idle            --modelTurn|toolCall-->  active
	 *   active          --turnComplete------->   draining   (identity survives)
	 *   active|draining --generationComplete-->  terminal
	 *   active|draining --interrupted-------->   terminal
	 *   draining        --modelTurn---------->   active     (NEW generation; ends `superseded`)
	 *   terminal        --modelTurn|toolCall-->  active     (NEW generation)
	 *   any             --disconnect/abort---->  idle       (ends `disconnected` if open)
	 *
	 * A tool call after `turnComplete` is the draining generation's own tail,
	 * not a new answer. `modelTurn` parts that trail a terminal generation
	 * inside the server turn it ended in (post-`generationComplete` playback
	 * stream, post-interrupt tail) do not open one either. Only provider events
	 * move this — nothing times or gaps a boundary.
	 */
	private _genState: 'idle' | 'active' | 'draining' | 'terminal' = 'idle';
	/** Identity counter of generations; its own, not the session's turn id. */
	private _genSeq = 0;
	private _genId = 'gen_0';
	/** Server turn open when the last generation ended (`undefined` if none was):
	 *  later `modelTurn` parts in that same server turn are its trailing parts. */
	private _genEndServerTurnId: number | undefined;
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
	// --- Server-turn state machine (external-TTS turn completion). ---
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
	onModelTurnStart?: (generationId?: string) => void;
	onGenerationStart?: (generationId: string) => void;
	onGenerationEnd?: (generationId: string, reason: GenerationEndReason) => void;
	onGenerationComplete?: () => void;
	onFirstAudioChunk?: () => void;
	onGoAway?: (timeLeft: string) => void;
	onResumptionUpdate?: (handle: string, resumable: boolean) => void;
	onGroundingMetadata?: (metadata: Record<string, unknown>) => void;
	onTextOutput?: (text: string) => void;
	onTextDone?: () => void;
	onSpeechStarted?: () => void;
	onRealtimeLLMUsage?: (usage: RealtimeLLMUsageEvent) => void;
	// The two diagnostics hooks are initialized (not just typed) so they exist on
	// every instance: VoiceSession warns at construction when a transport
	// declares neither.
	/** Raw Live usage, property form (VoiceSession wires this one). Typed to the
	 *  neutral shape so it satisfies LLMTransport; the object passed is the full
	 *  provider payload, castable to `LiveUsageMetadata`. */
	onUsageMetadata?: (usage: TransportUsageMetadata) => void = undefined;
	/** Connection-lifecycle facts, property form (VoiceSession wires this one). */
	onConnectionLifecycle?: (event: ConnectionLifecycleEvent) => void = undefined;
	/** The current connection's credential expired (`credentialProvider` only). */
	onCredentialExpiry?: () => void;

	constructor(
		config: GeminiTransportConfig | GeminiProviderTransportConfig,
		callbacks: GeminiTransportCallbacks,
	) {
		if (config.realtimeInputConfig !== undefined && config.vadConfig !== undefined) {
			throw new ValidationError(
				'GeminiLiveTransport: realtimeInputConfig and vadConfig are mutually exclusive. ' +
					'vadConfig is shorthand for realtimeInputConfig: { automaticActivityDetection: vadConfig }; set only one.',
			);
		}
		if (config.credentialProvider !== undefined) {
			if (typeof config.credentialProvider !== 'function') {
				throw new ValidationError('GeminiLiveTransport: credentialProvider must be a function.');
			}
			if (config.apiKey !== undefined) {
				throw new ValidationError(
					'GeminiLiveTransport: apiKey and credentialProvider are mutually exclusive; set only one.',
				);
			}
		}
		this.credentialProvider = config.credentialProvider;
		// With a provider there is no client until a connect has its credential.
		this.ai = this.credentialProvider ? null : new GoogleGenAI({ apiKey: config.apiKey });
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

		// Per-dial: set once THIS dial's setupComplete arrives (stale dials' messages
		// are fenced out below), so a socket close can tell setup failure apart.
		let setupDone = false;
		const setupComplete = new Promise<void>((resolve) => {
			this.setupResolver = () => {
				setupDone = true;
				resolve();
			};
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

		// `false` is the opt-out: no key at all. An object wins over the vadConfig
		// alias (the constructor rejects both being supplied).
		if (this.config.realtimeInputConfig) {
			connectConfig.realtimeInputConfig = this.config.realtimeInputConfig;
		} else if (this.config.realtimeInputConfig === undefined && this.config.vadConfig) {
			connectConfig.realtimeInputConfig = { automaticActivityDetection: this.config.vadConfig };
		}

		if (this.config.systemInstruction) {
			connectConfig.systemInstruction = this.config.systemInstruction;
		}

		const toolEntries: Record<string, unknown>[] = [];
		if (this.config.googleSearch) {
			toolEntries.push({ googleSearch: {} });
		}
		this.liveBehaviors = {
			byTool: new Map((this.config.tools ?? []).map((t) => [t.name, t.behavior])),
			fallback: this.config.functionBehavior,
		};
		if (this.config.tools?.length) {
			toolEntries.push({
				functionDeclarations: this.config.tools.map((tool) =>
					toolToDeclaration(tool, this.config.functionBehavior),
				),
			});
		}
		if (toolEntries.length > 0) {
			connectConfig.tools = toolEntries;
		}

		// Session resumption resolution order (per design-context-caching.md §3):
		//   1. cfg.sessionResumption === false → omit (privacy/ZDR opt-out wins).
		//   2. effectiveResumptionHandle !== null → use it (server-issued or seeded).
		//   3. otherwise → {} (fresh resumable session, current default).
		// `handleSupplied` (lifecycle `attempt`) records whether this dial resumes.
		let handleSupplied = false;
		if (this.config.sessionResumption === false) {
			// omit sessionResumption entirely
		} else if (this.effectiveResumptionHandle !== null) {
			connectConfig.sessionResumption = { handle: this.effectiveResumptionHandle };
			handleSupplied = true;
		} else {
			connectConfig.sessionResumption = {};
		}

		if (this.config.speechConfig?.voiceName && !this._textMode) {
			connectConfig.speechConfig = {
				voiceConfig: { prebuiltVoiceConfig: { voiceName: this.config.speechConfig.voiceName } },
			};
		}

		if (this.config.compressionConfig) {
			// The API types both thresholds as int64-over-JSON, i.e. strings, and
			// omission means the server default. Sending `undefined` would not be omission.
			const { triggerTokens, targetTokens } = this.config.compressionConfig;
			const compression: { triggerTokens?: string; slidingWindow: { targetTokens?: string } } = {
				slidingWindow: {},
			};
			if (triggerTokens !== undefined) compression.triggerTokens = String(triggerTokens);
			if (targetTokens !== undefined) compression.slidingWindow.targetTokens = String(targetTokens);
			connectConfig.contextWindowCompression = compression;
		}

		if (this.config.mediaResolution) {
			connectConfig.mediaResolution = this.config.mediaResolution;
		}

		// The deadline covers the dial itself, not just the setupComplete wait: the
		// SDK's connect promise is resolve-only, so on a failed dial (DNS failure,
		// refused socket) it never settles.
		const timeoutMs = this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`Gemini connect timed out after ${timeoutMs}ms`)),
				timeoutMs,
			);
		});
		// A socket that closes before setupComplete fails the dial immediately
		// instead of at the deadline. It can close while the dial is still pending,
		// before anything awaits this promise, hence the pre-attached handler.
		let failSetup: (error: Error) => void = () => {};
		const closedBeforeSetup = new Promise<never>((_, reject) => {
			failSetup = reject;
		});
		closedBeforeSetup.catch(() => {});

		// A newer dial supersedes any credential fetch or expiry still pending.
		this.cancelCredentialFetch('Gemini dial superseded before setupComplete');
		this.clearCredentialExpiry();
		const gen = ++this.dialGen;
		this.lifecycle.beginAttempt(gen, handleSupplied);
		// Where a credential-provider attempt is, so a failure can say where it
		// failed (`ConnectFailure.source`); unused without a provider.
		const attempt: CredentialAttempt = { stage: 'provider' };
		const callbacks = {
			onopen: () => {
				attempt.stage = 'session';
			},
			onmessage: (msg: LiveServerMessage) => {
				if (gen !== this.dialGen) return;
				this.handleMessage(msg);
			},
			onerror: (e: { message?: string }) => {
				if (gen !== this.dialGen) return;
				attempt.lastError = e.message;
				const error = new Error(e.message ?? 'WebSocket error');
				this.callbacks.onError?.(error);
				if (this.onError) this.onError({ error, recoverable: true });
			},
			onclose: (e: { code?: number; reason?: string }) => {
				if (gen !== this.dialGen) return;
				const code = e?.code;
				const reason = e?.reason;
				let failure: ConnectFailure | undefined;
				if (!setupDone) {
					const error = new Error(
						`Gemini socket closed before setupComplete (code=${code})${reason ? `: ${reason}` : ''}`,
					);
					if (this.credentialProvider) {
						failure = closeFailure(attempt, error.message, code, reason);
						attempt.failure = failure;
					}
					failSetup(error);
				}
				this.clearCredentialExpiry(gen);
				this.lifecycle.socketClosed(code, reason, failure);
				this.callbacks.onClose?.(code, reason);
				if (this.onClose) this.onClose(code, reason);
			},
		};
		const provider = this.credentialProvider;
		// disconnect()'s hold on this connect until its setupComplete. Retiring it
		// is synchronous: the fence advances and the failure is reported before
		// disconnect() first awaits, so a credential resolved a microtask earlier
		// is never dialed, a reconnect() can tell this retirement from a newer
		// owner's (`retiredGen`), and the failure is reported before any next
		// attempt begins.
		let pending: PendingSetup | null = null;
		if (provider) {
			const hold: PendingSetup = {
				retire: () => {
					let error = new Error('Gemini transport disconnected before setupComplete');
					if (gen === this.dialGen) {
						const retiredGen = ++this.dialGen;
						hold.retiredGen = retiredGen;
						if (attempt.stage === 'provider') {
							this.cancelCredentialFetch('Gemini transport disconnected');
							error = this.credentialFailed(attempt, new Error('Gemini transport disconnected'));
						}
						// Unless an attempt-close observer dialed anew: the ledger's attempt
						// is then that dial's, as when a provider failure reaches the catch below.
						if (this.dialGen === retiredGen) {
							this.lifecycle.setupFailed(
								error.message,
								attempt.failure ?? stageFailure(attempt, error.message),
							);
						}
					}
					failSetup(error);
				},
			};
			pending = hold;
		}
		this.pendingSetup = pending;
		const dial = provider
			? this.dialWithCredential(provider, gen, model, connectConfig, callbacks, timeoutMs, attempt)
			: (this.ai as GoogleGenAI).live.connect({ model, config: connectConfig, callbacks });

		let dialSession: Session | undefined;
		try {
			dialSession = await Promise.race([dial, timeout, closedBeforeSetup]);
			if (gen !== this.dialGen) {
				// Superseded while dialing (abortIncumbent() or a newer dial): never
				// install a session nothing owns — the catch below closes it.
				throw new Error('Gemini dial superseded before setupComplete');
			}
			this.session = dialSession;
			await Promise.race([setupComplete, timeout, closedBeforeSetup]);
			// The connection is up: from here its credential's expiry closes it. A
			// connection detached meanwhile (by a setup-ok observer) gets no timer.
			if (
				attempt.expiresAtMs !== undefined &&
				gen === this.dialGen &&
				this.session === dialSession
			) {
				this.armCredentialExpiry(gen, attempt.expiresAtMs);
			}
		} catch (err) {
			if (gen === this.dialGen) {
				this.dialGen++;
				this.session = null;
				const message = err instanceof Error ? err.message : String(err);
				// Fenced like every other stale-dial signal (a superseded dial's late
				// failure would follow a newer attempt's setup-ok with a stale event),
				// and emitted after the fence advanced, so an observer that redials
				// from it starts a dial nothing supersedes.
				this.lifecycle.setupFailed(
					message,
					provider ? (attempt.failure ?? stageFailure(attempt, message)) : undefined,
				);
			} else if (dialSession !== undefined && this.session === dialSession) {
				this.session = null;
			}
			// Abandoned dial: its callbacks are already stranded by the fence; close
			// its socket if and when it resolves so it is never orphaned.
			dial.then((s) => s?.close?.()).catch(() => {});
			throw err;
		} finally {
			clearTimeout(timer);
			if (pending && this.pendingSetup === pending) this.pendingSetup = null;
		}
	}

	/**
	 * The dial of a `credentialProvider` connect: freeze the final setup, fetch
	 * this connection's credential with it (aborted at half the connect
	 * deadline, or when the attempt is retired), then dial with a client built
	 * for that credential alone. Rejects without dialing when the provider fails,
	 * its credential is refused, or the attempt was retired while it fetched, so
	 * a late credential is never used and holds nothing.
	 */
	private async dialWithCredential(
		provider: GeminiCredentialProvider,
		gen: number,
		model: string,
		connectConfig: Record<string, unknown>,
		callbacks: Parameters<GoogleGenAI['live']['connect']>[0]['callbacks'],
		timeoutMs: number,
		attempt: CredentialAttempt,
	): Promise<Session> {
		// A copy, so freezing it never freezes caller-owned objects the config
		// references (realtimeInputConfig, the default VAD constant).
		const setup: GeminiLiveSetup = deepFreeze({
			model,
			config: structuredClone(connectConfig) as LiveConnectConfig,
		});
		const fetch = new AbortController();
		this.credentialFetch = fetch;
		const fetchBudgetMs = Math.floor(timeoutMs / 2);
		const budget = setTimeout(
			() => fetch.abort(new Error(`Gemini credential fetch timed out after ${fetchBudgetMs}ms`)),
			fetchBudgetMs,
		);
		let credential: GeminiCredential;
		try {
			// A provider that throws synchronously fails the attempt like one that rejects.
			credential = await untilAborted(Promise.resolve(provider(setup, fetch.signal)), fetch.signal);
		} catch (err) {
			// Retired while fetching (abortIncumbent(), a newer dial, or disconnect(),
			// which reported its retirement itself): nothing more to report.
			if (gen !== this.dialGen) {
				throw new Error('Gemini dial superseded before setupComplete', { cause: err });
			}
			throw this.credentialFailed(attempt, err);
		} finally {
			clearTimeout(budget);
			if (this.credentialFetch === fetch) this.credentialFetch = null;
		}
		if (gen !== this.dialGen) throw new Error('Gemini dial superseded before setupComplete');
		// Recorded before the checks: a refused credential was still minted, and
		// its meta is how the owner matches this attempt's failure to it.
		if (typeof credential === 'object' && credential !== null) {
			this.lifecycle.credentialIssued(credential.meta);
		}
		const refusal = refuseCredential(credential, timeoutMs);
		if (refusal) throw this.credentialFailed(attempt, new ValidationError(refusal));
		attempt.expiresAtMs = credential.expiresAtMs;
		attempt.stage = 'dial';
		const ai = new GoogleGenAI({
			apiKey: credential.apiKey,
			vertexai: false,
			enterprise: false,
			...(credential.apiVersion ? { httpOptions: { apiVersion: credential.apiVersion } } : {}),
		});
		// A structurally identical copy of the frozen setup: the SDK writes
		// `config.tools` during connect, which a frozen object would refuse.
		return ai.live.connect({
			model: setup.model,
			config: structuredClone(setup.config) as LiveConnectConfig,
			callbacks,
		});
	}

	/** A provider failure of the current dial: recorded as a pre-setup close
	 *  carrying the provider's error, and returned as the error the dial
	 *  rejects with. */
	private credentialFailed(attempt: CredentialAttempt, err: unknown): Error {
		const error = err instanceof Error ? err : new Error(String(err));
		const failure: ConnectFailure = {
			source: 'provider',
			message: `Gemini credential provider failed: ${error.message}`,
			error: err,
		};
		attempt.failure = failure;
		this.lifecycle.closedBeforeDial(failure);
		return new Error(failure.message, { cause: err });
	}

	/** Abort the in-flight credential fetch, if any. */
	private cancelCredentialFetch(reason: string): void {
		const fetch = this.credentialFetch;
		if (!fetch) return;
		this.credentialFetch = null;
		fetch.abort(new Error(reason));
	}

	/** Close dial `gen`'s connection at its credential's expiry. One timer per
	 *  connection, armed at setupComplete (the refusal of a credential expiring
	 *  within the connect deadline keeps expiry out of the dial); a longer wait
	 *  than one timer can hold is re-armed in steps. */
	private armCredentialExpiry(gen: number, expiresAtMs: number): void {
		this.clearCredentialExpiry();
		const arm = (): void => {
			const wait = Math.min(
				Math.max(0, expiresAtMs - Date.now()),
				GeminiLiveTransport.MAX_TIMER_MS,
			);
			const timer = setTimeout(() => {
				if (this.credentialExpiry?.timer !== timer) return;
				if (Date.now() < expiresAtMs) {
					arm();
					return;
				}
				this.credentialExpiry = null;
				this.expireCredential(gen);
			}, wait);
			this.credentialExpiry = { gen, timer };
		};
		arm();
	}

	/** Drop the pending expiry: any, or only dial `gen`'s. */
	private clearCredentialExpiry(gen?: number): void {
		const expiry = this.credentialExpiry;
		if (!expiry || (gen !== undefined && expiry.gen !== gen)) return;
		clearTimeout(expiry.timer);
		this.credentialExpiry = null;
	}

	/**
	 * Dial `gen`'s credential expired. The owner may reconnect at once
	 * (`onCredentialExpiry`, as for a GoAway); if the connection is still
	 * attached when that returns, it is closed here and reported like a server
	 * close, so the owner's close handling reconnects, with a new credential,
	 * either way.
	 */
	private expireCredential(gen: number): void {
		const expiring = this.session;
		if (gen !== this.dialGen || !expiring) return;
		this.notifyObserver('onCredentialExpiry', () => this.callbacks.onCredentialExpiry?.());
		this.notifyObserver('onCredentialExpiry', () => this.onCredentialExpiry?.());
		if (gen !== this.dialGen || this.session !== expiring) return;
		// Nobody reconnected: close it ourselves. Fence first, so the socket's own
		// late close is not reported a second time.
		this.dialGen += 1;
		this.detachSession();
		this.lifecycle.localDisconnect(CREDENTIAL_EXPIRED);
		Promise.resolve()
			.then(() => expiring.close())
			.catch(() => {});
		this.callbacks.onClose?.(1000, CREDENTIAL_EXPIRED);
		if (this.onClose) this.onClose(1000, CREDENTIAL_EXPIRED);
	}

	/** Disconnect and reconnect, optionally with a new resumption handle or ReconnectState.
	 *  Accepts either a string handle (legacy API) or ReconnectState (LLMTransport API).
	 */
	async reconnect(stateOrHandle?: ReconnectState | string): Promise<void> {
		const timeoutMs = this.config.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS;
		// Generation-fenced force-kill: if a newer dial replaced the session while
		// this timer was pending, nulling would kill the replacement instead.
		const timerGen = this.dialGen;
		const timer = setTimeout(() => {
			if (this.dialGen === timerGen) this.session = null;
		}, timeoutMs);

		try {
			// disconnect() advances the generation itself when it retires a
			// credential-provider connect still before setupComplete: that advance,
			// and only that one, is this reconnect's own. Without a provider there
			// is none.
			const hold = this.pendingSetup;
			await this.disconnect();
			// The incumbent was aborted (or a newer dial started) while its close was
			// in flight: whoever advanced the generation owns what comes next, so
			// this reconnect must not dial.
			if (this.dialGen !== (hold?.retiredGen ?? timerGen)) return;

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
				this.#replayHistory(stateOrHandle.conversationHistory);
			}
		} finally {
			clearTimeout(timer);
		}
	}

	get currentDialGen(): number {
		return this.dialGen;
	}

	get currentTransportGeneration(): number {
		return this.transportGeneration;
	}

	/** Synchronously strand the incumbent connection: advance the dial generation
	 *  (its callbacks go stale, an in-flight `reconnect()` continuation will not
	 *  dial, and a later-resolving dial closes its own session), detach the
	 *  session before any await, reset server-turn state and discard both
	 *  resumption handle copies — a redial must never resume the abandoned
	 *  server-side session. Returns a close bounded by 5 s: the detached
	 *  session's `close()` or, when no session is attached, the close a
	 *  `disconnect()` already has in flight (that session was detached before
	 *  this call, and `disconnect()` alone would await it without a bound).
	 *  Resolves `'closed'` when that close completed in time (at once when
	 *  nothing is closing), `'forced'` on timeout or close error; never rejects.
	 *  Does not go through `disconnect()`. */
	abortIncumbent(): Promise<'closed' | 'forced'> {
		this.dialGen += 1;
		this.cancelCredentialFetch('Gemini connection retired by abortIncumbent()');
		const incumbent = this.detachSession();
		this.clearResumption();
		let closing: Promise<unknown>;
		if (incumbent) {
			closing = Promise.resolve().then(() => incumbent.close());
		} else if (this.pendingDisconnectClose) {
			closing = this.pendingDisconnectClose;
		} else {
			return Promise.resolve('closed');
		}
		return new Promise((resolve) => {
			const deadline = setTimeout(
				() => resolve('forced'),
				GeminiLiveTransport.ABORT_INCUMBENT_CLOSE_TIMEOUT_MS,
			);
			void closing.then(
				() => {
					clearTimeout(deadline);
					resolve('closed');
				},
				() => {
					clearTimeout(deadline);
					resolve('forced');
				},
			);
		});
	}

	/** Drop both resumption handle copies: the effective handle the next dial
	 *  resumes with and the legacy `config.resumptionHandle` alias. The next
	 *  dial then opens a fresh server session. The connection is untouched. */
	clearResumption(): void {
		this.effectiveResumptionHandle = null;
		this.config.resumptionHandle = undefined;
	}

	async disconnect(): Promise<void> {
		// A credential-provider connect still before setupComplete is for a
		// connection nobody wants now (a session closing during its dial): it is
		// retired below, before the first await — its fetch aborted, or its
		// socket closed the moment it opens (the dial's own failure path). Taken
		// before detaching, so a connect a generation-end observer starts inside
		// detachSession() is a newer owner this call leaves alone. Without a
		// provider a pending dial is left as before.
		const pending = this.pendingSetup;
		this.pendingSetup = null;
		// Detach before awaiting: a newer dial can install a replacement session
		// while close() is in flight, and it must survive this call untouched —
		// nothing below touches `this.session` once the close completes. Before
		// retiring, so the retired attempt's setup-failed sees it detached.
		const incumbent = this.detachSession();
		pending?.retire();
		if (!incumbent) return;
		// The socket's own onclose usually lands after the next dial has advanced
		// the fence, so a locally initiated close is reported here (once per
		// attempt; `abortIncumbent()` deliberately does not).
		this.lifecycle.localDisconnect();
		// Recorded so a concurrent abortIncumbent() can bound this close; cleared
		// only if no later disconnect() has recorded its own close since.
		const closing = (async () => {
			await incumbent.close();
		})();
		this.pendingDisconnectClose = closing;
		try {
			await closing;
		} catch {
			// Ignore close errors
		} finally {
			if (this.pendingDisconnectClose === closing) this.pendingDisconnectClose = null;
		}
	}

	/** Capture and null the current session, then reset per-connection turn
	 *  state — in that order, so a `generation.end` observer already sees the
	 *  transport detached. */
	private detachSession(): Session | null {
		const incumbent = this.session;
		this.session = null;
		this.clearCredentialExpiry();
		this._firstAudioFired = false;
		this._cachedGeminiUsage = null;
		this.resetServerTurnState();
		return incumbent;
	}

	// --- Upstream send accounting ---

	private noteAttempt(slot: UpstreamSlotCounters, rawBytes: number, wireBytes: number): void {
		slot.attempted++;
		slot.attemptedRawBytes += rawBytes;
		slot.attemptedWireBytesEstimate += wireBytes;
		slot.lastAttemptedAt = Date.now();
	}

	private noteSkip(slot: UpstreamSlotCounters, bump: () => void): void {
		bump();
		slot.lastSkippedAt = Date.now();
	}

	/** Runs the send; `queued` advances only on normal return. Exceptions are
	 *  counted and RETHROWN — instrumentation must not change error behavior. */
	private sendTracked(
		slot: UpstreamSlotCounters,
		rawBytes: number,
		wireBytes: number,
		send: () => void,
	): void {
		try {
			send();
		} catch (err) {
			slot.threw++;
			slot.lastThrewAt = Date.now();
			throw err;
		}
		slot.queued++;
		slot.queuedRawBytes += rawBytes;
		slot.queuedWireBytesEstimate += wireBytes;
		slot.lastQueuedAt = Date.now();
	}

	/** Shared tracked path for every text-slot send (both text APIs and the
	 *  replay batch): attempt, then a missing session or an empty payload
	 *  (nothing sent) is a skip, otherwise the dispatch is tracked. Callers that
	 *  buffer during the wind-down window do so first, so a buffered send is
	 *  counted when the deferred send runs. */
	private sendTextTracked(
		rawBytes: number,
		wireBytes: number,
		empty: boolean,
		send: (session: Session) => void,
	): void {
		const slot = this.upstream.text;
		this.noteAttempt(slot, rawBytes, wireBytes);
		const session = this.session;
		if (!session) {
			this.noteSkip(slot, () => slot.skippedNoSession++);
			return;
		}
		if (empty) {
			this.noteSkip(slot, () => slot.skippedEmpty++);
			return;
		}
		this.sendTracked(slot, rawBytes, wireBytes, () => send(session));
	}

	/** Send base64-encoded PCM audio to Gemini as realtime input. */
	sendAudio(base64Data: string): void {
		const slot = this.upstream.audio;
		const raw = Buffer.byteLength(base64Data, 'base64');
		this.noteAttempt(slot, raw, base64Data.length);
		const session = this.session;
		if (!session) {
			this.noteSkip(slot, () => slot.skippedNoSession++);
			return;
		}
		this.sendTracked(slot, raw, base64Data.length, () =>
			session.sendRealtimeInput({
				audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' },
			}),
		);
	}

	/** Send tool execution results back to Gemini (legacy API). */
	sendToolResponse(
		responses: Array<{ id?: string; name?: string; response?: Record<string, unknown> }>,
		scheduling?: 'SILENT' | 'WHEN_IDLE' | 'INTERRUPT',
	): void {
		if (!this.session) return;
		if (this.bufferIfWindingDown(() => this.sendToolResponse(responses, scheduling))) return;
		this.session.sendToolResponse({
			functionResponses: responses.map((r) =>
				r.response === undefined ? r : { ...r, response: sanitizeForStruct(r.response) },
			),
		});
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
		if (this.session && this.bufferIfWindingDown(() => this.sendClientContent(turns, turnComplete)))
			return;
		const { raw, wire } = clientContentBytes(turns);
		this.sendTextTracked(raw, wire, false, (session) =>
			session.sendClientContent({ turns, turnComplete }),
		);
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

	/** Snapshot, not a live reference — safe for a caller to hold across ticks. */
	getDiagnostics(): TransportDiagnostics {
		return {
			upstream: structuredClone(this.upstream),
			transportGeneration: this.transportGeneration,
		};
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
		if (this.session && this.bufferIfWindingDown(() => this.sendContent(turns, turnComplete)))
			return;
		if (turnComplete && this.shouldUseRealtimeTextForContent()) {
			const text = turns
				.map((t) => t.text.trim())
				.filter(Boolean)
				.join('\n\n');
			const bytes = Buffer.byteLength(text, 'utf8');
			this.sendTextTracked(bytes, bytes, text.length === 0, (session) =>
				session.sendRealtimeInput({ text }),
			);
			return;
		}
		const geminiTurns = turns.map((t) => ({
			role: t.role === 'assistant' ? 'model' : t.role,
			parts: [{ text: t.text }],
		}));
		const { raw, wire } = clientContentBytes(geminiTurns);
		this.sendTextTracked(raw, wire, false, (session) =>
			session.sendClientContent({ turns: geminiTurns, turnComplete }),
		);
	}

	/** Send live text as realtime input (`sendRealtimeInput({ text })`) on every
	 *  model, unlike `sendContent`, whose realtime path depends on the model name.
	 *  Several turns are joined with newlines, each prefixed with its role
	 *  (`assistant` becomes `model`) so the model can tell them apart; a single
	 *  turn is sent as is. Turns with no text are skipped, and there is no
	 *  `turnComplete`: server activity detection decides the turn boundary.
	 *
	 *  Returns `true` when the send was dispatched or accepted into the
	 *  wind-down buffer (flushed best effort, like the other buffered sends),
	 *  and `false` when there is no text, no session, or the send threw. Never
	 *  throws. */
	sendLiveText(turns: ContentTurn[]): boolean {
		const text = turns
			.map((t) => {
				const role = t.role === 'assistant' ? 'model' : t.role;
				if (!t.text) return '';
				return turns.length > 1 ? `${role}: ${t.text}` : t.text;
			})
			.filter(Boolean)
			.join('\n');
		// Realtime text can start a generation, so it is buffered during the
		// wind-down window like the other text sends. The flush goes back through
		// the instance method, so a wrapper installed on it (the dictation guard)
		// checks the send again at flush, as it does for buffered sendContent.
		if (text && this.session && this.bufferIfWindingDown(() => this.sendLiveText(turns)))
			return true;
		return this.sendRealtimeText(text);
	}

	/** Dispatch realtime text now; `sendLiveText` handles wind-down buffering. */
	private sendRealtimeText(text: string): boolean {
		const bytes = Buffer.byteLength(text, 'utf8');
		let sent = false;
		try {
			this.sendTextTracked(bytes, bytes, text.length === 0, (session) => {
				session.sendRealtimeInput({ text });
				sent = true;
			});
		} catch (err) {
			console.warn('[GeminiLiveTransport] sendLiveText: realtime text send failed:', err);
			return false;
		}
		return sent;
	}

	/** Send an image or audio file as realtime input.
	 *
	 *  Gemini Live's realtime input has separate slots per media kind, not a
	 *  generic one (the SDK's `media` field maps to the deprecated
	 *  `media_chunks` wire format, which Gemini 3.1 rejects with close code
	 *  1007):
	 *
	 *    image/* → `video` (an image is a single-frame video)
	 *    audio/* → `audio` (the slot `sendAudio` uses)
	 *    other   → a warning, nothing sent, counted as `unsupportedMime`
	 *
	 *  Use `sendInlineFile` for other file types (documents), which go inline
	 *  in client content instead. */
	sendFile(base64Data: string, mimeType: string): void {
		const slot = mimeType.startsWith('audio/') ? this.upstream.audio : this.upstream.video;
		const raw = Buffer.byteLength(base64Data, 'base64');
		this.noteAttempt(slot, raw, base64Data.length);
		const session = this.session;
		if (!session) {
			this.noteSkip(slot, () => slot.skippedNoSession++);
			return;
		}
		if (mimeType.startsWith('image/')) {
			this.sendTracked(slot, raw, base64Data.length, () =>
				session.sendRealtimeInput({ video: { data: base64Data, mimeType } }),
			);
			return;
		}
		if (mimeType.startsWith('audio/')) {
			this.sendTracked(slot, raw, base64Data.length, () =>
				session.sendRealtimeInput({ audio: { data: base64Data, mimeType } }),
			);
			return;
		}
		const video = this.upstream.video;
		this.noteSkip(video, () => video.unsupportedMime++);
		console.warn(
			`[GeminiLiveTransport] sendFile: unsupported mimeType "${mimeType}" — Gemini Live realtime input only supports image/* and audio/*. Use sendInlineFile for other file types.`,
		);
	}

	/** Send a file as inline data in client content (`turnComplete: false`),
	 *  for any MIME type, documents included.
	 *
	 *  Counted by media kind: `audio/*` on the audio slot, everything else on the
	 *  video slot. Every MIME type is sent inline here, so none counts as
	 *  `unsupportedMime`. A client upload frame is unchecked input, so a missing
	 *  `mimeType` counts on the video slot and the data is sent as received. */
	sendInlineFile(base64Data: string, mimeType: string): void {
		if (this.session && this.bufferIfWindingDown(() => this.sendInlineFile(base64Data, mimeType)))
			return;
		const isAudio = typeof mimeType === 'string' && mimeType.startsWith('audio/');
		const slot = isAudio ? this.upstream.audio : this.upstream.video;
		const raw = Buffer.byteLength(base64Data, 'base64');
		this.noteAttempt(slot, raw, base64Data.length);
		const session = this.session;
		if (!session) {
			this.noteSkip(slot, () => slot.skippedNoSession++);
			return;
		}
		this.sendTracked(slot, raw, base64Data.length, () =>
			session.sendClientContent({
				turns: [
					{ role: 'user', parts: [{ inlineData: { data: base64Data, mimeType } }] as never[] },
				],
				turnComplete: false,
			}),
		);
	}

	/** Send a tool result back to Gemini (LLMTransport API). */
	sendToolResult(result: TransportToolResult): void {
		if (!this.session) return;
		if (this.bufferIfWindingDown(() => this.sendToolResult(result))) return;
		// Gemini honours `scheduling` only on a NON_BLOCKING function, so it is sent only for a tool
		// declared that way on the connected session; every other result keeps the plain wire format.
		const behavior = this.liveBehaviors.byTool.get(result.name) ?? this.liveBehaviors.fallback;
		const scheduling =
			behavior === 'NON_BLOCKING' && result.scheduling
				? GEMINI_SCHEDULING[result.scheduling]
				: undefined;
		this.session.sendToolResponse({
			functionResponses: [
				{
					id: result.id,
					name: result.name,
					response: sanitizeForStruct(result.result),
					...(scheduling && { scheduling }),
				},
			],
		});
	}

	/** No-op for Gemini — generation is automatic after tool results and content injection. */
	triggerGeneration(_instructions?: string): void {
		// Gemini auto-generates after sendToolResponse and sendClientContent
	}

	// `elicitResponse` is deliberately NOT implemented for Gemini.
	//
	// A content-less nudge has no valid wire form here. `sendClientContent({
	// turns: [], turnComplete: true })` is rejected client-side by the SDK
	// ("contents are required"), and omitting `turns` altogether — the previous
	// workaround — is rejected *server-side*: the socket closes with 1007
	// "Request contains an invalid argument". That close arrives asynchronously,
	// so it cannot be caught at the call site; the response watchdog counts it as
	// a transport-close, reconnects, nudges again, and burns the reconnect budget
	// until the session dies with `reconnect_failed`.
	//
	// Omitting the method is the contract's documented path for transports that
	// auto-generate (see `LLMTransport.elicitResponse`): the reconnector falls
	// back to `triggerGeneration()`, a no-op above, so no invalid request is ever
	// sent. Real recovery is unaffected — it comes one tier earlier, from
	// `replayUserTurn` re-sending the retained utterance as inline audio.

	/** Replay a retained user utterance as a complete user turn — inline audio
	 *  content with an explicit `turnComplete`, deliberately NOT the realtime
	 *  channel (no server-VAD dependence; a brief utterance after a barge-in is
	 *  exactly what the server VAD dropped). Phase 0 validated this shape in both
	 *  clean and post-barge-in states (raw PCM, no input transcription emitted —
	 *  see design-retained-user-content-recovery.md). */
	replayUserTurn(turn: RetainedUserTurn): boolean {
		// Same winding-down discipline as sendContent/sendInlineFile: a replay must not
		// race a session draining toward close.
		if (this.session && this.bufferIfWindingDown(() => this.replayUserTurn(turn))) return true;
		// Recovery audio is upstream traffic like any other: counted on the audio
		// slot, raw PCM bytes vs base64 characters on the wire.
		const slot = this.upstream.audio;
		const data = turn.pcm.toString('base64');
		this.noteAttempt(slot, turn.pcm.length, data.length);
		const session = this.session;
		if (!session) {
			this.noteSkip(slot, () => slot.skippedNoSession++);
			return false;
		}
		this.sendTracked(slot, turn.pcm.length, data.length, () =>
			session.sendClientContent({
				turns: [
					{
						role: 'user',
						parts: [
							{
								inlineData: {
									data,
									mimeType: `audio/pcm;rate=${turn.sampleRateHz}`,
								},
							},
						] as never[],
					},
				],
				turnComplete: true,
			}),
		);
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
	 *  `bufferedUncancellableAudio` capability. */
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
				this.config.compressionConfig = config.providerOptions
					.compressionConfig as GeminiCompressionConfig;
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
			this.#replayHistory(state.conversationHistory);
		}
	}

	// --- Private helpers ---

	/** Apply LLMTransportConfig fields to the internal GeminiTransportConfig. */
	/** Merge LLMTransportConfig into the internal config. Only provided fields are applied;
	 *  undefined fields preserve existing constructor values.
	 */
	private applyTransportConfig(config: LLMTransportConfig): void {
		// A credential provider authenticates each connect: no static key replaces it.
		if (config.auth.type === 'api_key' && !this.credentialProvider) {
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
				this.config.compressionConfig = config.providerOptions
					.compressionConfig as GeminiCompressionConfig;
			}
		}
		if (config.responseModality !== undefined) {
			this._textMode = config.responseModality === 'text';
		}
	}

	/** Convert ReplayItem[] to Gemini Content format and send as client content.
	 *  ES-private (`#`) so the optional public `LLMTransport.replayHistory?` interface member does
	 *  not collide; reconnect/transfer recovery calls this directly (unguarded, may run per session).
	 *  A public initial-connect wrapper is deferred (see design-composer-resume-history.md). */
	#replayHistory(items: ReplayItem[]): void {
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

		// Replay is send traffic like any other: the whole history goes out as ONE
		// quiet clientContent batch, so it counts as one text-slot send whatever
		// the items hold (inline history media included).
		const { raw, wire } = clientContentBytes(turns);
		this.sendTextTracked(raw, wire, false, (session) =>
			session.sendClientContent({ turns, turnComplete: false }),
		);
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
		this._firstAudioFired = false;
		if (this._windingDownTimer) {
			clearTimeout(this._windingDownTimer);
			this._windingDownTimer = undefined;
		}
		this.flushWindingDownBuffer();
	}

	/** Reset all server-turn state (disconnect / reconnect). An open generation
	 *  ends `disconnected`, and the next connection starts from `idle`. */
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
		// Last, so its observers see the server-turn state already reset.
		this.endGeneration('disconnected');
		this._genState = 'idle';
	}

	// --- Generation state machine (see `_genState`) ---

	/**
	 * Open a generation if this provider output begins a NEW one. Call after
	 * `beginServerTurn()`, so the id is bound before `onModelTurnStart` fires.
	 *
	 * From `draining`, a tool call is the generation's tail but model output is
	 * a new answer — the asymmetry that keeps the machine from wedging when
	 * `generationComplete` never arrives. From `terminal`, model output inside
	 * the server turn the generation ended in is its trailing stream.
	 */
	private beginGenerationIfNew(signal: 'modelTurn' | 'toolCall'): void {
		if (this._genState === 'active') return;
		if (this._genState === 'draining' && signal === 'toolCall') return;
		if (
			this._genState === 'terminal' &&
			signal === 'modelTurn' &&
			this._genEndServerTurnId !== undefined &&
			this.getActiveServerTurnId() === this._genEndServerTurnId
		) {
			return;
		}
		if (this._genState === 'draining') this.endGeneration('superseded');
		this._genState = 'active';
		const id = `gen_${this._genSeq}`;
		this._genId = id;
		// Isolated: a throwing observer must not skip the others or the dispatch
		// of the message that opened the generation.
		this.notifyObserver('onModelTurnStart', () => this.callbacks.onModelTurnStart?.(id));
		this.notifyObserver('onModelTurnStart', () => this.onModelTurnStart?.(id));
		this.notifyObserver('onGenerationStart', () => this.callbacks.onGenerationStart?.(id));
		this.notifyObserver('onGenerationStart', () => this.onGenerationStart?.(id));
	}

	/** The single exit, so every terminal reason fires exactly one end. Its
	 *  observers are isolated: this runs inside `disconnect()` and
	 *  `abortIncumbent()` before the incumbent is closed. */
	private endGeneration(reason: GenerationEndReason): void {
		if (this._genState !== 'active' && this._genState !== 'draining') return;
		this._genState = 'terminal';
		this._genEndServerTurnId = this.getActiveServerTurnId();
		const id = this._genId;
		this._genSeq++;
		this.notifyObserver('onGenerationEnd', () => this.callbacks.onGenerationEnd?.(id, reason));
		this.notifyObserver('onGenerationEnd', () => this.onGenerationEnd?.(id, reason));
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

	/** Run one observer in isolation: its failure is logged and never reaches
	 *  message dispatch or the connection state machine. Lifecycle events fire
	 *  from inside `connect()`, socket close and `disconnect()`; usage rides on
	 *  the SAME message as audio, tool calls and goAway, so a throwing hook would
	 *  otherwise drop them. Each observer form (the constructor callback, then the
	 *  property form) is wrapped separately, so one failing never keeps the next
	 *  from running. */
	private notifyObserver(label: string, fn: () => void): void {
		try {
			fn();
		} catch (err) {
			console.warn(`[GeminiLiveTransport] ${label} observer threw; dispatch continues:`, err);
		}
	}

	// biome-ignore lint/suspicious/noExplicitAny: LiveServerMessage is a complex union type
	private handleMessage(msg: any): void {
		// BEFORE the branches below, which each return: usage rides along with
		// serverContent and friends, so a branch of its own would miss most of it.
		if (msg.usageMetadata) {
			const usage = msg.usageMetadata as LiveUsageMetadata;
			this.notifyObserver('onUsageMetadata', () => this.callbacks.onUsageMetadata?.(usage));
			this.notifyObserver('onUsageMetadata', () => this.onUsageMetadata?.(usage));
		}

		if (msg.setupComplete) {
			// A connection that completed setup is a new generation; its upstream
			// counters start at zero. Reset first, then mint: the ledger's emit
			// adopts the new generation before the setup-ok observers run.
			this.upstream = freshUpstreamCounters();
			// Set up: a disconnect() from here on (a setup-ok observer's included)
			// closes a connection, it no longer fails the connect.
			this.pendingSetup = null;
			this.lifecycle.setupOk();
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
			if (update) {
				this.notifyObserver('onRealtimeLLMUsage', () =>
					this.onRealtimeLLMUsage?.(this.tagUsage(update)),
				);
			}
		}

		if (msg.serverContent) {
			const content = msg.serverContent;

			// Model output — onModelTurnStart fires when it opens a new generation
			if (content.modelTurn?.parts) {
				this.beginServerTurn();
				this.beginGenerationIfNew('modelTurn');
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
				// Barged in on: this generation is over.
				this.endGeneration('interrupted');
				// Mirror interruption as speech-start signal for consumers that need
				// barge-in semantics while model audio/text may still be flushing.
				if (this.onSpeechStarted) this.onSpeechStarted();
				this.callbacks.onInterrupted?.(this._serverTurnId);
				if (this.onInterrupted) this.onInterrupted(this._serverTurnId);
			}

			// The provider finished generating, in any mode. Ends the generation
			// before the text-mode early turn end below.
			if (content.generationComplete) {
				this.endGeneration('generationComplete');
				this.notifyObserver('onGenerationComplete', () => this.callbacks.onGenerationComplete?.());
				this.notifyObserver('onGenerationComplete', () => this.onGenerationComplete?.());
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
				// DRAINING, not over: a late tool call still belongs to this generation.
				if (this._genState === 'active') this._genState = 'draining';
				const completedServerTurnId = this._serverTurnId;
				const firedEarly = this._serverTurnState === 'ended_early';
				// Final usage is only known at turnComplete.
				if (this._cachedGeminiUsage) {
					const fin = normalizeGeminiUsageMetadata(this._cachedGeminiUsage, 'final');
					if (fin) {
						this.notifyObserver('onRealtimeLLMUsage', () =>
							this.onRealtimeLLMUsage?.(this.tagUsage(fin)),
						);
					}
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
			// Opens a generation only if none is underway: after turnComplete it
			// is the draining generation's tail, NOT a new answer.
			this.beginGenerationIfNew('toolCall');
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

/** Convert a ToolDefinition to a Gemini function declaration (name + description + JSON Schema),
 *  with `behavior` when the tool or the transport sets one. */
export function toolToDeclaration(
	tool: ToolDefinition,
	fallbackBehavior?: FunctionBehavior,
): Record<string, unknown> {
	const behavior = tool.behavior ?? fallbackBehavior;
	return {
		name: tool.name,
		description: tool.description,
		parameters: zodToJsonSchema(tool.parameters),
		...(behavior && { behavior }),
	};
}
