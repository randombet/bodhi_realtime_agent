// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { resolveAgentWithKnowledgeBase } from '../agent/agent-context.js';
import { AgentRouter } from '../agent/agent-router.js';
import type { BackgroundAgent } from '../agent/background-agent.js';
import { PersistentSubagentManager } from '../agent/persistent-subagent-manager.js';
import type { SubagentMessage } from '../agent/subagent-session.js';
import { BehaviorManager } from '../behaviors/behavior-manager.js';
import { MemoryDistiller } from '../memory/memory-distiller.js';
import type { ToolRoutingInfo } from '../runtime/actors/tool-router-actor.js';
import { GeminiTransportAdapter } from '../runtime/adapters/gemini-transport-adapter.js';
import type { KnownNotificationLabel } from '../runtime/messages.js';
import { RuntimeOrchestrator } from '../runtime/runtime-orchestrator.js';
import { decodeMulawToPcm } from '../telephony/audio-codec.js';
import { ToolExecutor } from '../tools/tool-executor.js';
import { createClientChannel } from '../transport/client-channel-factory.js';
import { ClientTransport } from '../transport/client-transport.js';
import { DirectRtcClientChannel } from '../transport/direct-rtc-client-channel.js';
import {
	DEFAULT_GEMINI_LIVE_MODEL,
	GeminiLiveTransport,
	type GeminiRealtimeInputConfig,
	resolveGeminiRealtimeInputConfig,
} from '../transport/gemini-live-transport.js';
import type { MainAgent, SubagentConfig } from '../types/agent.js';
import type { BehaviorCategory } from '../types/behavior.js';
import {
	type ClientMediaProfile,
	DEFAULT_CLIENT_MEDIA_PROFILE,
	describeClientTransport,
} from '../types/client-media.js';
import type { ConversationHistoryStore } from '../types/history.js';
import type { FrameworkHooks } from '../types/hooks.js';
import type { ProcessedKnowledgeBase } from '../types/knowledge-base.js';
import type { MemoryStore } from '../types/memory.js';
import type { IClientChannel } from '../types/session-client.js';
import type { SessionClientSender } from '../types/session-client.js';
import type { ToolDefinition } from '../types/tool.js';
import type { LLMTransport, LLMTransportError, STTProvider } from '../types/transport.js';
import type { TTSProvider } from '../types/tts.js';
import type { ArtifactRef, ArtifactStore, SaveArtifactParams } from '../types/workspace.js';
import { AudioRouter } from './audio-router.js';
import { BackgroundNotificationQueue } from './background-notification-queue.js';
import { ClientMessageRouter } from './client-message-router.js';
import { ClientVadDetector, pcmChunksContainSpeech } from './client-vad-detector.js';
import { DEFAULT_REPLAY_MAX_AGE_MS, DEFAULT_RESPONSE_WATCHDOG_MS } from './constants.js';
import { ConversationContext } from './conversation-context.js';
import { ConversationHistoryWriter } from './conversation-history-writer.js';
import { DictationController } from './dictation-controller.js';
import { DirectiveManager } from './directive-manager.js';
import { EventBus } from './event-bus.js';
import { GreetingController } from './greeting-controller.js';
import { HooksManager } from './hooks.js';
import { InteractionModeManager } from './interaction-mode.js';
import { LastUtteranceRetainer } from './last-utterance-retainer.js';
import { MemoryCacheManager } from './memory-cache-manager.js';
import { MultiplexConversationHistoryStore } from './multiplex-conversation-history-store.js';
import {
	ActorNotificationSink,
	LegacyNotificationSink,
	type NotificationSink,
} from './notification-sink.js';
import { PlaybackCompletionArbiter } from './playback-completion-arbiter.js';
import { NativeAudioPlaybackGate, type PlaybackGate } from './playback-gate.js';
import { SessionManager } from './session-manager.js';
import { ToolCallRouter } from './tool-call-router.js';
import { TranscriptManager } from './transcript-manager.js';
import { TransportReconnector } from './transport-reconnector.js';
import { TtsPipeline } from './tts-pipeline.js';
import { TurnManager } from './turn-manager.js';
import type { Turn } from './turn.js';
import { computeCacheHitRatio, deriveProviderItemId, deriveUsageSource } from './usage-helpers.js';

/**
 * Public, stable transcription mode exposed to callers. The internal routing
 * switch may have additional transient states (starting_transcription,
 * stopping_transcription) — those are collapsed to the closest stable state
 * when read via `getTranscriptionMode()`.
 */
export type TranscriptionMode = 'agent' | 'transcription';

/**
 * Single-writer FIFO over async session mutations. Both `transferSession()`
 * and `setTranscriptionMode()` mutate session-level state and must serialise
 * so they never collide on the wire. Rejections do not poison the queue.
 */
class SessionMutationQueue {
	private chain: Promise<unknown> = Promise.resolve();
	enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.chain.then(
			() => fn(),
			() => fn(),
		);
		this.chain = next.catch(() => undefined);
		return next;
	}
}

/**
 * Tuning for the client-side energy-VAD barge-in — interrupting the assistant
 * when the user starts speaking over it. Defaults suit a headphones setup; on a
 * speakers setup, where the assistant's own TTS echoes back into the mic, the
 * raised in-TTS thresholds keep the assistant from interrupting itself. Set
 * `bargeInEnabled: false` to drop the client barge-in entirely and rely on the
 * transport's server-side VAD.
 */
export interface ClientAudioVadConfig {
	/** Enable the client-side energy-VAD barge-in. Default `true`. */
	bargeInEnabled?: boolean;
	/** Minimum ms of continuously-voiced audio before a barge-in fires —
	 *  filters transient echo / noise blips. Default `200`. */
	bargeInConfirmMs?: number;
	/** While the assistant's TTS is playing, a barge-in additionally requires
	 *  the frame's peak amplitude to reach this raised threshold — residual TTS
	 *  echo sits below a genuine close-mic barge-in. Default `2000`. */
	bargeInTtsPeakThreshold?: number;
	/** Companion to `bargeInTtsPeakThreshold` for average amplitude. Default `450`. */
	bargeInTtsAvgAbsThreshold?: number;
}

/** Resolved (defaults-applied) form of `ClientAudioVadConfig`. */
export type ResolvedClientAudioVadConfig = Required<ClientAudioVadConfig>;

/**
 * Pure energy gate: is this frame loud enough — peak AND average — to clear the
 * in-TTS echo floor? The energy half of `clientVadBargeInAllowed`, *without* the
 * `bargeInConfirmMs` time check, so it can mark a VAD segment a *potential*
 * barge-in the first loud frame, before the confirmation window elapses.
 */
export function clientVadBargeInEnergyEligible(
	cfg: ResolvedClientAudioVadConfig,
	maxAbs: number,
	avgAbs: number,
): boolean {
	return maxAbs >= cfg.bargeInTtsPeakThreshold && avgAbs >= cfg.bargeInTtsAvgAbsThreshold;
}

/**
 * Pure decision: while the assistant's TTS is playing, should the in-progress
 * client speech segment count as a real barge-in? Filters residual TTS echo —
 * a barge-in must be sustained past the confirmation window AND loud enough
 * (peak and average) to clear the echo floor. Unit-tested in isolation.
 */
export function clientVadBargeInAllowed(
	cfg: ResolvedClientAudioVadConfig,
	speechElapsedMs: number,
	maxAbs: number,
	avgAbs: number,
): boolean {
	if (!cfg.bargeInEnabled) return false;
	if (speechElapsedMs < cfg.bargeInConfirmMs) return false;
	return clientVadBargeInEnergyEligible(cfg, maxAbs, avgAbs);
}

const DEFAULT_CLIENT_AUDIO_VAD: ResolvedClientAudioVadConfig = {
	bargeInEnabled: true,
	bargeInConfirmMs: 200,
	bargeInTtsPeakThreshold: 2000,
	bargeInTtsAvgAbsThreshold: 450,
};

/** Upper bound (ms) for the greeting-interrupt grace window. Anything beyond
 *  ~5 s starts hiding real misconfigurations, so the resolver clamps and
 *  treats out-of-range values as `0`. */
const GRACE_MAX_MS = 5000;

/** Echo-skip window (ms) from the first assistant audio chunk of a turn before
 *  the framework client-VAD barge-in fallback may fire on the no-playback-gate
 *  (Gemini native) path. Bridges the gap that the greeting-interrupt grace
 *  covers for framework-owned-interrupt transports (grace is 0 for Gemini):
 *  keeps the agent's own opening audio from self-interrupting via mic echo,
 *  while still letting the user cut a long buffered greeting client-side. */
const NATIVE_BARGEIN_ECHO_SKIP_MS = 400;

/** Clamp a caller-supplied `greetingInterruptGraceMs` override to a sane
 *  numeric range. Returns `undefined` when omitted (no caller override —
 *  inherit transport default at pass 2); returns `0` for `NaN`, negative,
 *  or non-finite inputs; returns the clamped value otherwise.
 *  Exported for tests; consumers should not depend on this directly.
 *  See dev_docs/framework/design-greeting-interrupt-grace.md §5. */
export function clampGraceMs(raw: number | undefined): number | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 0;
	if (raw > GRACE_MAX_MS) return GRACE_MAX_MS;
	return raw;
}

/**
 * Configuration for creating a VoiceSession.
 */
export interface VoiceSessionConfig {
	/** Unique session identifier. */
	sessionId: string;
	/** User identifier (used for memory storage and history). */
	userId: string;
	/** Google API key for the Gemini Live API (used when no transport is provided). */
	apiKey: string;
	/** All agents available in this session. */
	agents: MainAgent[];
	/** Name of the agent to activate on start. */
	initialAgent: string;
	/** Background subagent configs keyed by tool name. */
	subagentConfigs?: Record<string, SubagentConfig>;
	/** Lifecycle hooks for observability. */
	hooks?: FrameworkHooks;
	/**
	 * Sender for all output to the client. The server owns the socket and feeds input
	 * via feedAudioFromClient / feedJsonFromClient and notifyClientConnected / notifyClientDisconnected.
	 */
	clientSender?: SessionClientSender;
	/**
	 * Supported seam for handling custom inbound JSON message types. Fired ONLY
	 * for an unrecognized `type` — it does **not** override built-in types
	 * (`behavior.set`, `ui.response`, `file_upload`, `text_input`,
	 * `playback.ended`, RTC signaling), and a *malformed* built-in type is dropped
	 * (not forwarded here). Without it wired, inbound JSON behavior is unchanged.
	 */
	onClientJson?: (message: Record<string, unknown>) => void;
	/**
	 * Client media plane profile (`websocket` PCM+JSON, or `direct_rtc` split plane: JSON on WS, RTC audio later).
	 * Defaults to WebSocket when omitted. See {@link createClientChannel}.
	 */
	clientMedia?: ClientMediaProfile;
	/** Port for the local client WebSocket server (legacy/local mode). */
	port?: number;
	/** Host for the local client WebSocket server (legacy/local mode). */
	host?: string;
	/** Listen timeout for local client WebSocket server startup (legacy/local mode). */
	listenTimeoutMs?: number;
	/** Model-silence watchdog (ms) after the user's turn ends. If the model emits
	 *  nothing for this long, force a reconnect. Default 5000; `<= 0` disables. */
	responseWatchdogMs?: number;
	/** Watchdog-stall recovery via retained-utterance replay (see
	 *  dev_docs/framework/design-retained-user-content-recovery.md). When true,
	 *  the last routed user utterance is retained (bounded, memory-only) and a
	 *  response-watchdog stall replays it — in-place first, then once more after
	 *  a reconnect. Default false (ships dark until live-validated). */
	watchdogReplayRecovery?: boolean;
	/** LLM model name (e.g. "gemini-3.1-flash-live-preview"). */
	geminiModel?: string;
	/** Vercel AI SDK model for subagent text generation. */
	model: LanguageModelV1;
	/** Voice configuration for Gemini's speech output. */
	speechConfig?: { voiceName?: string };
	/** Context window compression thresholds. */
	compressionConfig?: { triggerTokens: number; targetTokens: number };
	/** Enable server-side transcription of user audio input (default: true).
	 *  Has no effect when sttProvider is set (built-in is disabled automatically).
	 *  Use false to disable all input transcription for privacy or cost control. */
	inputAudioTranscription?: boolean;
	/**
	 * Gemini Live realtime input/VAD tuning. Applied only on the built-in
	 * Gemini transport path. When omitted, the framework applies
	 * `DEFAULT_GEMINI_REALTIME_INPUT_CONFIG` (END_SENSITIVITY_HIGH,
	 * silenceDurationMs=500). User-supplied fields deep-merge over the default
	 * at the `automaticActivityDetection` level. Has no effect when an external
	 * transport is injected via `config.transport` — that transport owns its
	 * own VAD config.
	 */
	realtimeInputConfig?: GeminiRealtimeInputConfig;
	/** External STT provider for user input transcription.
	 *  When set, transport built-in transcription is automatically disabled.
	 *  When omitted, the transport's built-in transcription is used. */
	sttProvider?: STTProvider;
	/** Sample rate of inbound client PCM (what `handleAudioFromClient` receives).
	 *  When omitted, defaults to `transport.audioFormat.inputSampleRate` — which
	 *  matches what the framework instructs clients to send (browser RTC, voice
	 *  WS clients are told to align to the transport's input rate, and Twilio's
	 *  G.711 decode lands at the transport's rate too). Override only if your
	 *  client genuinely sends a different rate and you've taken responsibility
	 *  for the resample upstream. */
	clientAudioInputRate?: number;
	/** Tuning for the client-side energy-VAD barge-in. See `ClientAudioVadConfig`.
	 *  Omitted fields fall back to defaults suited to a headphones setup. */
	clientAudioVad?: ClientAudioVadConfig;
	/** Fallback margin (ms) added to the estimated client playback end before
	 *  the server force-completes a TTS turn that received no client playback
	 *  signal. Default 1500; below the 500 ms floor is clamped up; invalid
	 *  values fall back to the default. */
	ttsPlaybackFallbackMarginMs?: number;
	/** Playback-state protocol mode for this session's client surface.
	 *  `'audio_done'` enables the `audio.done` / `playback.ended` handshake;
	 *  `'disabled'` (default) keeps the estimate-only fallback. Effective
	 *  participation additionally requires the client sender to support it.
	 *  See dev_docs/framework/design-playback-state-protocol.md. */
	playbackStateProtocol?: 'disabled' | 'audio_done';
	/** Rollout switch for native-audio playback-end gating (the OpenAI native
	 *  path). Default `false`. When `true`, and the session is on the native
	 *  audio path with a generation-gated transport and `playbackStateProtocol`
	 *  active, native turn completion is gated on playback end.
	 *  See dev_docs/framework/design-playback-end-gating-openai-native.md. */
	nativePlaybackGating?: boolean;
	/** Initial transcription mode for the session. Default `'agent'`.
	 *  - `'agent'` (default): mic audio flows to `transport`; the agent
	 *    responds. Existing behaviour.
	 *  - `'transcription'`: mic audio flows to `whisperProvider` and the
	 *    agent transport is quiesced. Transcripts accumulate in the
	 *    dictation buffer; injection back into the agent is explicit
	 *    (see `injectDictationBuffer` and the built-in `inject_dictation`
	 *    tool — design §3.5). */
	transcriptionMode?: TranscriptionMode;
	/** STT provider used in `'transcription'` mode. Must be a distinct instance
	 *  from `sttProvider` — sharing entangles the two lifecycles. Typically an
	 *  `OpenAIRealtimeWhisperSTTProvider`. */
	whisperProvider?: STTProvider;
	/** Behavior categories for dynamic runtime tuning (speech speed, verbosity, etc.). */
	behaviors?: BehaviorCategory[];
	/** Enable memory distillation. Extracts durable user facts from conversation and persists them. */
	memory?: {
		/** Where to persist extracted facts. */
		store: MemoryStore;
		/** Extract every N turns (default: 5). */
		turnFrequency?: number;
	};
	/** When provided, conversation items are persisted at turn boundaries and on session close.
	 *  For fan-out to multiple stores (e.g. JSON queryable + markdown human-readable), use
	 *  `conversationHistoryStores` instead — both fields can be combined; this singular field
	 *  is resolved first so existing read routing is preserved. */
	conversationHistoryStore?: ConversationHistoryStore;
	/** When provided alongside or in place of `conversationHistoryStore`, writes fan out to every
	 *  store via `MultiplexConversationHistoryStore`; reads delegate to the first configured store
	 *  (singular before plural). Use this to run a queryable store (JSON / Supabase) alongside a
	 *  write-only artifact store like `MarkdownConversationHistoryStore`. Sole-store configurations
	 *  (e.g. markdown alone) are valid; read methods will throw if your app calls them and the
	 *  first store does not support reads. */
	conversationHistoryStores?: ConversationHistoryStore[];
	/** Application metadata persisted alongside the session record (e.g. channel, surface, callSid). */
	sessionMetadata?: Record<string, unknown>;
	/** When provided, agents/tools can persist artifacts (images, docs, etc.) via session.workspace.saveArtifact(). */
	artifactStore?: ArtifactStore;
	/** External TTS provider for speech synthesis (actor-mode only).
	 *  When set, LLM is configured for text-mode responses.
	 *  When omitted, LLM-native audio generation is used (default).
	 *  Requires orchestrationMode: 'actor'. Ignored in legacy mode. */
	ttsProvider?: TTSProvider;
	/** Pre-constructed LLM transport. If provided, apiKey/geminiModel/speechConfig/compressionConfig are ignored. */
	transport?: LLMTransport;
	/** Orchestration engine for tool routing/subagent lifecycle (default: legacy). */
	orchestrationMode?: 'legacy' | 'actor';
	/** Optional per-session artifact registry for cross-tool binary sharing (images, documents). */
	artifactRegistry?: {
		store(
			base64: string,
			mimeType: string,
			description: string,
			source?: string,
			fileName?: string,
		): string;
		dispose(): void;
	};
	/**
	 * User-defined `BackgroundAgent` instances. Hosted by
	 * `BackgroundAgentHostActor`; each agent's `onStart` fires once on the
	 * first `session.connected` envelope. Actor-mode only — ignored in
	 * legacy mode (the legacy queue has no equivalent host). See
	 * `dev_docs/framework/design-background-notification-actor.md`.
	 */
	backgroundAgents?: BackgroundAgent[];
	/** Override the transport-recommended greeting interrupt grace window.
	 *  When the session's first assistant audio chunk arrives, the framework
	 *  suppresses user-driven interrupts and drops outbound mic frames for
	 *  this many ms so browser AEC can converge before echo events count as
	 *  barge-in. When omitted, falls back to
	 *  `transport.capabilities.greetingInterruptGraceMs` (OpenAI Realtime
	 *  defaults to 1000 ms when framework-owns-interrupt; Gemini defaults to
	 *  0 ms). Clamped to `[0, 5000]`. A session resolving > 0 against a
	 *  transport that does not advertise `frameworkOwnsInterrupt` (or does
	 *  not implement `cancelResponse`) is downgraded to `0` at connect time
	 *  with a warning log. Phone sessions should pass `0` explicitly (no
	 *  browser AEC; dropping caller audio would silence real speech).
	 *  See dev_docs/framework/design-greeting-interrupt-grace.md. */
	greetingInterruptGraceMs?: number;
}

/**
 * Top-level integration hub that wires all framework components together.
 *
 * Manages the full lifecycle of a real-time voice session:
 * - **Audio fast-path**: Client audio → LLM (and back) without touching the EventBus.
 * - **Tool routing**: Inline tools execute synchronously; background tools hand off to subagents.
 * - **Agent transfers**: Intercepts `transfer_to_agent` tool calls and delegates to AgentRouter.
 * - **Reconnection**: Handles GoAway signals and unexpected disconnects via session resumption.
 * - **Conversation tracking**: Transcriptions populate ConversationContext automatically.
 *
 * @example
 * ```ts
 * const session = new VoiceSession({
 *   sessionId: 'session_1',
 *   userId: 'user_1',
 *   apiKey: process.env.GOOGLE_API_KEY,
 *   agents: [mainAgent, expertAgent],
 *   initialAgent: 'main',
 *   port: 9900,
 *   model: google('gemini-2.5-flash'),
 * });
 * await session.start();
 * ```
 */
export class VoiceSession {
	readonly eventBus: EventBus;
	readonly sessionManager: SessionManager;
	readonly conversationContext: ConversationContext;
	readonly hooks: HooksManager;
	private transport: LLMTransport;
	/** Assigned in `buildClientChannelAndGating`, called unconditionally from the constructor. */
	private clientTransport!: IClientChannel;
	/** Set when `clientMedia.kind === 'direct_rtc'` for WebSocket JSON signaling routing. */
	private directRtcChannel: DirectRtcClientChannel | null = null;
	/** Assigned in `buildAgentRouter`, called unconditionally from the constructor. */
	private agentRouter!: AgentRouter;
	private toolExecutor!: ToolExecutor;
	private toolCallRouter?: ToolCallRouter;
	private runtimeOrchestrator?: RuntimeOrchestrator;
	private runtimeToolRegistry?: Map<string, ToolRoutingInfo>;
	private subagentConfigs: Record<string, SubagentConfig>;
	private persistentSubagents = new PersistentSubagentManager();
	/** Resolved Gemini VAD config for the built-in transport path. Undefined when `config.transport` is injected. */
	private resolvedRealtimeInputConfig?: GeminiRealtimeInputConfig;
	private behaviorManager?: BehaviorManager;
	private memoryDistiller?: MemoryDistiller;
	private memoryCacheManager?: MemoryCacheManager;
	/** Latest `processKnowledgeBase` result for the active main agent (prompt slice + optional search tool metadata). */
	private processedKnowledgeBase: ProcessedKnowledgeBase | null = null;
	/** Turn lifecycle — numeric counter, current/previous `Turn` pointers,
	 *  per-turn usage sequence, finalized-input-turn set. `finalizeTurn` stays
	 *  here but drives the counter through this unit. See
	 *  dev_docs/framework/design-turn-lifecycle-refactor.md. */
	private readonly turns = new TurnManager({
		getActiveAgentName: () => this.agentRouter.activeAgent.name,
		getActiveServerTurnId: () => this.transport.getActiveServerTurnId?.(),
	});
	private sttProvider?: STTProvider;
	/** Last routed user utterance for watchdog-stall recovery replay. Only
	 *  constructed when `config.watchdogReplayRecovery` is true (dark rollout).
	 *  See dev_docs/framework/design-retained-user-content-recovery.md. */
	private utteranceRetainer?: LastUtteranceRetainer;
	/** R7c reconnect-window freshness tee (hosted): frames/speech observed at
	 *  `feedAudioFromClient` while RECONNECTING — captured BEFORE the router's
	 *  `isSessionActive()` drop, the only place that speech is still visible. */
	private _reconnectWindowFrames = 0;
	private _reconnectWindowSpeech = false;
	/** Resolved post-transport-construction from config.clientAudioInputRate
	 *  (default: transport.audioFormat.inputSampleRate — the rate the
	 *  framework instructs clients to send). */
	private clientAudioInputRate = 16000;
	/** Resolved TTS fallback-completion margin (validated config + defaults).
	 *  Assigned in the constructor. */
	private ttsPlaybackFallbackMarginMs!: number;
	/** Effective playback-state protocol participation for this session —
	 *  `playbackStateProtocol === 'audio_done'` AND the client channel reports
	 *  `supportsPlaybackStateProtocol`. Resolved once in the constructor. */
	private playbackStateProtocolActive = false;
	/** Effective native-audio playback-end gating for this session —
	 *  `playbackStateProtocolActive` AND `config.nativePlaybackGating` AND the
	 *  native audio path (no `ttsProvider`) AND a generation-gated transport
	 *  (`!capabilities.playbackGatedTurnComplete`). Resolved once in the
	 *  constructor. See design-playback-end-gating-openai-native.md. */
	private nativePlaybackGatingActive = false;
	/** Greeting send + greeting interrupt-grace state (grace window,
	 *  greeting-in-flight gate, first-audio arming, per-client reset).
	 *  VoiceSession delegates `sendGreeting`, `finalizeGreetingInterruptGrace`,
	 *  `maybeArmGraceOnFirstAudio`, `requestInterrupt`, `shouldDropOutbound`,
	 *  and `resetForClientConnected` to it. See `greeting-controller.ts`. */
	private greeting!: GreetingController;
	/** Per-session single-flight FIFO chaining direct-user-input bodies
	 *  (`handleTextInput`, `injectTranscript`, `injectDictationBuffer`). Each
	 *  body awaits `cancelResponse({ waitForDone: true })` then finalizes any
	 *  unfinalized active turn then sends the new content — and the next
	 *  enqueued body waits for the previous to fully finish. Prevents two
	 *  rapid inputs from both calling `response.create` and triggering
	 *  `conversation_already_has_active_response`.
	 *  See dev_docs/framework/design-greeting-interrupt-grace.md §7.5. */
	private _directInputChain: Promise<void> = Promise.resolve();
	/** Native-audio playback-end gate (the OpenAI native path). Present for every
	 *  native (non-TTS) session — its barge-in runs regardless of gating — but
	 *  only *arms* when `nativePlaybackGatingActive`. Owns the former `_native*`
	 *  timer/pending/turn/cursor/id state. See `playback-gate.ts`. */
	private nativeGate?: NativeAudioPlaybackGate;
	/** Per-response flag: true once the framework dispatches tool calls for the
	 *  current model response. Cleared at each response start
	 *  (`onModelTurnStart`); read by `handleTurnComplete` so the native gate
	 *  engages only on a turn's terminal spoken response (audio, no tool call). */
	private _nativeResponseDispatchedToolCall = false;
	/** Time (ms) of the current turn's first assistant audio chunk, or `null`
	 *  between/before turns. Barge-in *eligibility* policy for the no-`liveGate`,
	 *  `bufferedUncancellableAudio` shape (Gemini): a client-VAD barge-in is
	 *  honoured once audio has played past `NATIVE_BARGEIN_ECHO_SKIP_MS` (echo
	 *  rejection). Reset at response start + turn finalization. The trailing-audio
	 *  suppression itself lives in the transport's `cancelResponse`. See
	 *  design-noncancellable-transport-barge-in.md. */
	private _assistantAudioStartedAtMs: number | null = null;
	// --- Phase 3: transcription mode + dictation buffer + cross-provider quiesce ---
	/** Transcription/dictation subsystem: owns `internalMode`, the dictation
	 *  buffer, the Whisper provider, the §3.5 send-guard wrappers + pending
	 *  queues, and the mode-flip state machine. VoiceSession delegates the
	 *  enter/exit transitions (via the serialized `setTranscriptionMode`), the
	 *  buffer accessors, `prewarmTranscriptionMode`, and `prepareForStart`.
	 *  Every `internalMode` reader reads through it. See `dictation-controller.ts`. */
	private dictation!: DictationController;
	/** Serialises `setTranscriptionMode()` with `transferSession()` — concurrent
	 *  callers queue rather than race. Stays in VoiceSession. */
	private mutationQueue = new SessionMutationQueue();
	private _commitFiredForTurn = false;
	/** True when the current turn was interrupted — skips Gemini transcript correction. */
	private _turnWasInterrupted = false;
	// --- TTS state (actor-mode only) ---
	/** The external-TTS path as one unit — the provider plus its
	 *  `ExternalTtsPlaybackGate` and the transport↔provider callback wiring.
	 *  Present only when a `ttsProvider` is configured in actor mode; a session
	 *  is TTS *or* native, never both. See `tts-pipeline.ts`. */
	private ttsPipeline?: TtsPipeline;
	/** Playback-completion arbiter — owns the source-neutral playback-defer flag
	 *  and the completePlayback / finishOrDeferForVad routing. Constructed after
	 *  the gates. See `playback-completion-arbiter.ts`. */
	private completionArbiter!: PlaybackCompletionArbiter;
	/** Inbound client→server JSON dispatch (RTC signaling, behavior.set,
	 *  ui.response, file_upload, text_input, playback.ended). Constructed after
	 *  the client channel + arbiter. See `client-message-router.ts`. */
	private clientMessageRouter!: ClientMessageRouter;
	/** Transport reconnect + response-watchdog liveness timer. Owns
	 *  `triggerReconnect`, GoAway/transport-close handling, resumption updates,
	 *  the reconnect budget, and the watchdog. See `transport-reconnector.ts`. */
	private reconnector!: TransportReconnector;
	/** Resolved watchdog timeout (ms); `<= 0` disables. Set in the constructor. */
	private readonly responseWatchdogMs: number;
	// --- Server-turn finalization dedup (external-TTS turn completion).
	//     See dev_docs/framework/design-external-tts-turn-completion.md. ---
	private config: VoiceSessionConfig;
	private directiveManager = new DirectiveManager();
	private transcriptManager!: TranscriptManager;
	/** Whether a client WebSocket connection is currently active. */
	private clientConnected = false;
	/**
	 * Legacy in-process notification queue. Constructed only when
	 * `orchestrationMode !== 'actor'`; in actor mode NotificationActor
	 * (`src/runtime/actors/notification-actor.ts`) takes over. Notification
	 * dispatch now goes exclusively through `notificationSink` (below) — this
	 * field is only the queue the `LegacyNotificationSink` wraps.
	 */
	private notificationQueue?: BackgroundNotificationQueue;
	/**
	 * Mode-agnostic notification seam over `notificationQueue` (legacy) and
	 * `runtime.tell('notification.*')` (actor). Owns the once-per-turn
	 * `audio_started` debounce in actor mode. See `notification-sink.ts`.
	 */
	private notificationSink!: NotificationSink;
	private interactionMode = new InteractionModeManager();
	/** True when `config.orchestrationMode === 'actor'`. */
	private _isActorMode = false;
	/** Resolves when memory/directives are loaded; used so greeting is sent after load without blocking connect. */
	private _memoryReadyPromise: Promise<void> = Promise.resolve();
	private externalAudioHandler: ((data: Buffer) => void) | null = null;
	/** Client-side energy-VAD segment tracker. Owns the `audioVad*` /
	 *  `lastClientSpeech*` state; barge-in policy stays here (see the
	 *  `onVoicedFrame` handler wired at construction). */
	private clientVadDetector!: ClientVadDetector;
	/** Inbound client-audio fast path (mode dispatch + transition buffer + μ-law
	 *  encode). Constructed after the VAD detector. */
	private audioRouter!: AudioRouter;
	/** Resolved client-VAD barge-in tuning (config + defaults). */
	private readonly clientVad: ResolvedClientAudioVadConfig;
	private lastGeminiRecognitionLoggedForSpeechEndMs = 0;
	private lastInputTranscriptionLogText = '';
	private ownsClientTransport: boolean;
	/** Margin (ms) added to the VAD-defer force-completion timeout. */
	/** Default and floor (ms) for the TTS fallback-completion margin — estimate
	 *  padding before the server force-completes a turn with no playback signal.
	 *  See dev_docs/framework/design-playback-state-protocol.md. */
	private static readonly TTS_PLAYBACK_FALLBACK_MARGIN_DEFAULT_MS = 1500;
	private static readonly TTS_PLAYBACK_FALLBACK_MARGIN_FLOOR_MS = 500;
	/** Slowest client `playbackRate` — the fallback estimate divides the
	 *  synthesized (1.0×) audio duration by this so slowed playback cannot
	 *  pre-empt a healthy client's `playback.ended`. Must track the web
	 *  client's rate map (`slow | normal | fast → 0.85 | 1.0 | 1.2`). */
	private static readonly MIN_PLAYBACK_RATE = 0.85;

	constructor(config: VoiceSessionConfig) {
		this.config = config;
		this.ownsClientTransport = !config.clientSender;
		this.eventBus = new EventBus();
		this.hooks = new HooksManager();
		this.conversationContext = new ConversationContext();
		this.transcriptManager = new TranscriptManager({
			sendToClient: (msg) => this.clientTransport.sendJsonToClient(msg),
			addUserMessage: (text) => this.conversationContext.addUserMessage(text),
			addAssistantMessage: (text) => this.conversationContext.addAssistantMessage(text),
		});

		// Relay finalized user speech to an interactive subagent when one is
		// waiting for input. The callback captures `this` via closure and is only
		// invoked at runtime (agentRouter is initialized before any transcript fires).
		this.transcriptManager.onInputFinalized = (text) => {
			this.turns.markInputFinalized();
			const activeId = this.interactionMode.getActiveToolCallId();
			if (activeId) {
				const session = this.agentRouter.getSubagentSession(activeId);
				if (session && session.state === 'waiting_for_input') {
					session.sendToSubagent(text);
					this.interactionMode.deactivate(activeId);
				}
			}
		};

		this._isActorMode = config.orchestrationMode === 'actor';

		// Legacy mode: in-process BackgroundNotificationQueue. Actor mode skips
		// this — NotificationActor (constructed in RuntimeOrchestrator) takes
		// over and every legacy call site below is guarded.
		if (!this._isActorMode) {
			this.notificationQueue = new BackgroundNotificationQueue(
				(turns, turnComplete) => {
					// Convert the Gemini-format turns from the notification queue to ContentTurn[]
					const contentTurns = turns.map((t) => ({
						role: (t.role === 'model' ? 'assistant' : t.role) as 'user' | 'assistant',
						text: t.parts[0]?.text ?? '',
					}));
					this.transport.sendContent(contentTurns, turnComplete);
				},
				(msg) => this.log(msg),
				config.transport?.capabilities?.messageTruncation ?? false,
			);
			this.notificationSink = new LegacyNotificationSink(this.notificationQueue);
		} else {
			// The `tell` closure defers to `runtimeOrchestrator` at call time — it is
			// constructed later in this constructor, but no notification fires before
			// the session is running.
			this.notificationSink = new ActorNotificationSink((type, payload, to) =>
				this.runtimeOrchestrator?.runtime.tell(type, payload, to),
			);
		}

		if (config.hooks) {
			this.hooks.register(config.hooks);
		}

		this.sessionManager = new SessionManager(
			{
				sessionId: config.sessionId,
				userId: config.userId,
				initialAgent: config.initialAgent,
			},
			this.eventBus,
			this.hooks,
		);

		this.subagentConfigs = config.subagentConfigs ?? {};

		this.responseWatchdogMs = config.responseWatchdogMs ?? DEFAULT_RESPONSE_WATCHDOG_MS;

		const initialForLive = config.agents.find((a) => a.name === config.initialAgent);
		const liveResolved = initialForLive
			? resolveAgentWithKnowledgeBase(initialForLive)
			: { instructions: '', tools: [] as ToolDefinition[], processedKB: null };
		this.processedKnowledgeBase = liveResolved.processedKB;

		// Set up BehaviorManager early — tools must be declared to the LLM at connect time.
		// Callbacks capture `this` via closures and are only invoked at runtime (not during construction).
		if (config.behaviors?.length) {
			const memoryStore = config.memory?.store;
			const onPresetChange = memoryStore
				? () => {
						const presets = Object.fromEntries(this.behaviorManager?.activePresets ?? []);
						memoryStore.setDirectives(config.userId, presets).catch(() => {
							// Best-effort — directive persistence failure is non-fatal
						});
					}
				: undefined;

			this.behaviorManager = new BehaviorManager(
				config.behaviors,
				(key, value, scope) => this.directiveManager.set(key, value, scope),
				(msg) => this.clientTransport.sendJsonToClient(msg),
				onPresetChange,
			);
		}

		// Set up memory cache and distillation plugin
		if (config.memory) {
			this.memoryCacheManager = new MemoryCacheManager(config.memory.store, config.userId);
			const freq = config.memory.turnFrequency ?? 5;
			this.memoryDistiller = new MemoryDistiller(
				this.conversationContext,
				config.memory.store,
				this.hooks,
				config.model,
				{
					userId: config.userId,
					sessionId: config.sessionId,
					turnFrequency: freq,
					getKnowledgeBaseSummary: () => this.processedKnowledgeBase?.promptInjection ?? '',
				},
			);
			this.log(`Memory distillation enabled (every ${freq} turns)`);
		}

		// Persist conversation history when store(s) are provided. Singular field is appended
		// FIRST so that read routing (multiplex delegates reads to stores[0]) preserves existing
		// behavior when callers add markdown as an additional plural entry.
		const historyStores: ConversationHistoryStore[] = [
			...(config.conversationHistoryStore ? [config.conversationHistoryStore] : []),
			...(config.conversationHistoryStores ?? []),
		];
		if (historyStores.length > 0) {
			const resolvedStore =
				historyStores.length === 1
					? historyStores[0]
					: new MultiplexConversationHistoryStore({
							stores: historyStores,
							log: (msg) => this.log(msg),
						});
			new ConversationHistoryWriter(
				config.sessionId,
				config.userId,
				config.initialAgent,
				this.eventBus,
				this.conversationContext,
				resolvedStore,
				config.sessionMetadata,
			);
		}

		// Set up LLM transport — instructions/tools from KB-aware resolution (see `liveResolved` above)
		const { instructions, tools: agentTools } = liveResolved;
		const behaviorTools = this.behaviorManager?.tools ?? [];
		const allInitialTools = [...agentTools, ...behaviorTools];

		// Determine inputAudioTranscription setting:
		// Keep Gemini's built-in transcription enabled even when an external STT
		// provider is active — the built-in result is used as a post-hoc correction
		// for the STT transcript (more accurate language detection, better accuracy).
		const inputTranscription = config.inputAudioTranscription;

		if (config.transport) {
			// Use pre-constructed transport (OpenAI, mock, etc.)
			this.transport = config.transport;
			// Sync tools and instructions so they're available at connect time.
			// Pre-connect updateSession is state-only and resolves immediately;
			// floating the promise is safe (constructor cannot be async).
			void this.transport.updateSession({
				instructions,
				tools: allInitialTools.length ? allInitialTools : undefined,
				...(inputTranscription === false && {
					transcription: { input: false },
				}),
			});
		} else {
			// Construct GeminiLiveTransport from config (backward compatibility)
			this.resolvedRealtimeInputConfig = resolveGeminiRealtimeInputConfig(
				config.realtimeInputConfig,
			);
			this.transport = new GeminiLiveTransport(
				{
					apiKey: config.apiKey,
					model: config.geminiModel,
					systemInstruction: instructions,
					tools: allInitialTools.length ? allInitialTools : undefined,
					googleSearch: initialForLive?.googleSearch,
					speechConfig: config.speechConfig,
					compressionConfig: config.compressionConfig,
					inputAudioTranscription: inputTranscription,
					realtimeInputConfig: this.resolvedRealtimeInputConfig,
				},
				{},
			);
		}

		// Default the inbound client PCM rate to whatever the transport advertises —
		// matches what the framework tells clients to send (line ~1994 in this file).
		this.clientAudioInputRate =
			config.clientAudioInputRate ?? this.transport.audioFormat.inputSampleRate;

		// Resolve client-VAD barge-in tuning over the defaults.
		this.clientVad = { ...DEFAULT_CLIENT_AUDIO_VAD, ...config.clientAudioVad };

		// Client-VAD segment tracker. The detector owns the segment state and
		// energy math; the barge-in *policy* (gate-pending + grace + actuation)
		// and the playback-defer resolution stay here via these event handlers.
		// Last-utterance retention (watchdog-stall recovery) — transport rate is
		// known here, and retention must store the transport-normalized PCM.
		if (config.watchdogReplayRecovery) {
			this.utteranceRetainer = new LastUtteranceRetainer({
				sampleRateHz: this.transport.audioFormat.inputSampleRate,
			});
		}

		this.clientVadDetector = new ClientVadDetector(
			{
				onSpeechStart: () => {
					// New segment ends the input-transcription log-dedup window.
					this.lastInputTranscriptionLogText = '';
					this.utteranceRetainer?.markSpeechStart();
				},
				onVoicedFrame: (now, maxAbs, avgAbs) => this.runClientVadBargeInPolicy(now, maxAbs, avgAbs),
				onSegmentResolved: () => this.completionArbiter.resolveDeferredPlayback(),
				// User finished a turn → seal the retained utterance (recovery
				// replay candidate), then arm the response watchdog (the model now
				// owes a reply; silence past the timeout forces a reconnect).
				onUserTurnCompleted: () => {
					this.utteranceRetainer?.seal();
					this.reconnector.armResponseWatchdog();
				},
				// Ignored blip / forced reset: the segment can never seal — drop the
				// in-progress retained audio (keeps the sealed replay candidate) and
				// let a deferred watchdog replay re-evaluate instead of stranding.
				onSegmentAborted: () => {
					this.utteranceRetainer?.abortSegment();
					this.reconnector.notifySegmentAborted();
				},
			},
			(msg) => this.log(msg),
		);

		// Inbound client-audio fast path. Dependencies are read through
		// getters/predicates so the router observes the same call-time values the
		// former inline `handleAudioFromClient` did (providers, mode, gate, and
		// the late-bound external-audio handler are all wired after this point).
		this.audioRouter = new AudioRouter({
			transport: this.transport,
			vad: this.clientVadDetector,
			clientAudioInputRate: this.clientAudioInputRate,
			getSttProvider: () => this.sttProvider,
			getWhisperProvider: () => this.dictation.whisper,
			isSessionActive: () => this.sessionManager.isActive,
			isRtcAudioReady: () => this.directRtcChannel?.isRtcAudioReady ?? false,
			getMode: () => this.dictation.mode,
			shouldDropOutbound: () => this.greeting.shouldDropOutbound(),
			retainer: this.utteranceRetainer,
			routeExternalAudio: (data) => {
				if (this.agentRouter.activeAgent.audioMode !== 'external') return false;
				if (this.externalAudioHandler) {
					try {
						this.externalAudioHandler(data);
					} catch (err) {
						this.reportError('external-audio', err instanceof Error ? err : new Error(String(err)));
					}
				}
				return true;
			},
		});

		// Resolve the TTS fallback-completion margin: validate, clamp to the floor.
		this.ttsPlaybackFallbackMarginMs = this.resolveTtsPlaybackFallbackMarginMs(
			config.ttsPlaybackFallbackMarginMs,
		);

		// Transcription/dictation subsystem. Owns `internalMode`, the dictation
		// buffer, the Whisper provider, and the §3.5 send-guard wrappers — its
		// constructor installs the `transport.sendToolResult` / `sendContent`
		// interception (BOTH legacy and actor-mode dispatch paths go through the
		// transcription-mode guard) BEFORE `wireTransportCallbacks` below, and
		// seeds `internalMode` from `config.transcriptionMode`.
		this.dictation = new DictationController(
			{
				transport: this.transport,
				getAudioRouter: () => this.audioRouter,
				eventBus: this.eventBus,
				getSessionId: () => this.config.sessionId,
				reportError: (context, error) => this.reportError(context, error),
				log: (msg) => this.log(msg),
			},
			{
				whisperProvider: config.whisperProvider,
				sttProvider: config.sttProvider,
				transcriptionMode: config.transcriptionMode,
			},
		);

		// Wire LLMTransport property callbacks — works for both injected and default transports
		this.wireTransportCallbacks();

		// Wire STT: streaming provider for real-time display, Gemini built-in for
		// post-hoc correction. Both paths can be active simultaneously.
		if (config.sttProvider) {
			this.sttProvider = config.sttProvider;

			// Configure with the format VoiceSession actually FEEDS — not the
			// transport's wire format. routeAudioToAgent feeds raw client PCM
			// (16-bit, native rate) when the provider supports PCM; only the
			// rare μ-law-only provider gets the 8 kHz 8-bit path.
			const sttSupportsPcmu = this.sttProvider.supportedEncodings?.includes('pcmu');
			const sttSupportsPcm = (this.sttProvider.supportedEncodings ?? ['pcm']).includes('pcm');
			if (sttSupportsPcm) {
				this.sttProvider.configure({
					sampleRate: this.clientAudioInputRate,
					bitDepth: 16,
					channels: 1,
					encoding: 'pcm',
				});
			} else if (sttSupportsPcmu) {
				this.sttProvider.configure({
					sampleRate: 8000,
					bitDepth: 8,
					channels: 1,
					encoding: 'pcmu',
				});
			} else {
				throw new Error(
					'VoiceSession: sttProvider declares supportedEncodings that does not include pcm or pcmu',
				);
			}

			// Wire callbacks — turn-aware ordering protection.
			// Accept results from the current turn or the immediately preceding turn.
			// Batch STT providers fire results asynchronously (e.g., generateContent API call)
			// which may complete after handleTurnComplete advances the turn counter. Using
			// `turnId < turns.staleInputCutoff` prevents dropping valid late results while
			// still rejecting truly stale transcripts from 2+ turns ago.
			this.sttProvider.onTranscript = (text, turnId) => {
				if (turnId !== undefined && turnId < this.turns.staleInputCutoff) return; // Drop stale results (2+ turns old)
				if (turnId !== undefined && this.turns.isInputFinalized(turnId)) return;
				// New user input ends the post-interrupt correction-skip window, but
				// only for a genuinely *new* turn. The interrupted turn's own barge-in
				// utterance lands here late — its audio was committed at finalizeTurn
				// (commit(numericId)) before advance(), so it carries `numericId - 1`.
				// Clearing the gate for that late result would let the provider's
				// post-hoc (clipped) transcription overwrite this good transcript. So
				// keep the gate armed for the just-finalized turn's trailing STT and
				// clear it only once current-turn input (`turnId >= numericId`, or an
				// id-less provider) arrives. The interrupted turn's own finalizeTurn
				// already armed it; the next normal finalizeTurn clears it.
				if (turnId === undefined || turnId >= this.turns.numericId) {
					this._turnWasInterrupted = false;
				}
				this.transcriptManager.handleInput(text, turnId);
			};
			this.sttProvider.onPartialTranscript = (text) => {
				this.transcriptManager.handleInputPartial(text);
			};

			// Wire Gemini built-in transcription as authoritative correction.
			// On interrupted (barge-in) turns the realtime transcript can miss
			// audio spoken over model output, so it is NOT used to finalize the
			// message. But the batch STT result lags behind (a separate
			// generateContent call), so we still surface the realtime transcript
			// immediately as a display-only partial; the batch STT then corrects
			// and finalizes it via handleInput/flush.
			this.transport.onInputTranscription = (text) => {
				this.logInputTranscriptionLatency(text, 'provider-correction');
				if (this._turnWasInterrupted) {
					this.transcriptManager.showInterruptedInputPartial(text);
					return;
				}
				this.transcriptManager.correctInput(text);
			};
		} else {
			// No external STT — use transport built-in transcription
			this.transport.onInputTranscription = (text) => {
				this.logInputTranscriptionLatency(text, 'provider');
				this.transcriptManager.handleInput(text);
			};
		}

		// (Transcription-mode Whisper wiring + initial-mode seed live in the
		// DictationController constructed above.)

		// Wire onModelTurnStart for STT commit trigger.
		// P4: also allocate the eager turn id here. Chain pattern preserves
		// any pre-attached handler on injected transports.
		const prevModelTurnStart = this.transport.onModelTurnStart;
		this.transport.onModelTurnStart = () => {
			this.reconnector.disarmResponseWatchdog();
			try {
				prevModelTurnStart?.();
			} catch (e) {
				this.log(`pre-attached onModelTurnStart threw: ${(e as Error).message}`);
			}
			// Native playback-end gate: a new model response begins clean.
			this._nativeResponseDispatchedToolCall = false;
			// A genuinely new model response: reset the barge-in eligibility window.
			this._assistantAudioStartedAtMs = null;
			const modelTurn = this.turns.ensureCurrent();
			// Correlated model activity consumed the pending utterance — clear the
			// recovery-replay candidate and the replay stage. Trailing model-start
			// for a just-finalized turn (ensureCurrent → null) must NOT clear it
			// (correlate-before-mutate, same scoped rule as the disarm guards).
			if (modelTurn) {
				this.utteranceRetainer?.clearAnswered();
				this.reconnector.resetReplayState();
			}
			this.logProviderUserTurnRecognition('model/tool processing started');
			if (this.sttProvider && !this._commitFiredForTurn) {
				this._commitFiredForTurn = true;
				this.sttProvider.commit(this.turns.numericId);
			}
		};

		// Wire TTS provider (actor-mode only)
		if (config.ttsProvider && config.orchestrationMode === 'actor') {
			this.ttsPipeline = new TtsPipeline(config.ttsProvider, {
				transport: this.transport,
				getClientTransport: () => this.clientTransport,
				hooks: this.hooks,
				sessionId: config.sessionId,
				fallbackMarginMs: this.ttsPlaybackFallbackMarginMs,
				minPlaybackRate: VoiceSession.MIN_PLAYBACK_RATE,
				ensureCurrentTurn: () => this.turns.ensureCurrent(),
				getCurrentTurn: () => this.turns.current,
				handleTranscriptOutput: (text) => this.transcriptManager.handleOutput(text),
				isAgentMode: () => this.dictation.isAgentMode(),
				isPlaybackStateProtocolActive: () => this.playbackStateProtocolActive,
				getCompletionArbiter: () => this.completionArbiter,
				maybeArmGraceOnFirstAudio: () => this.maybeArmGraceOnFirstAudio(),
				signalAudioStarted: () => this.signalAudioStarted(),
				requestInterrupt: (source) => this.requestInterrupt(source),
				finalizeTurn: (turn, opts) => this.finalizeTurn(turn, opts),
				close: (reason) => this.close(reason),
				log: (msg) => this.log(msg),
			});
			this.ttsPipeline.wire();
		}

		this.buildClientChannelAndGating(config);

		// Wire EventBus subscriptions (GUI forwarding, STT lifecycle, subagent UI,
		// async agent transfer). Callbacks capture `this` and fire at runtime, so
		// they may reference collaborators (e.g. agentRouter) constructed below.
		this.wireEventBus();

		this.buildAgentRouter(config, allInitialTools, behaviorTools);

		// Usage + cache-bust observability — chained over any pre-attached handlers,
		// fired to the framework hook and mirrored to the EventBus.
		this.wireUsageCallbacks();

		this.buildOrchestration(config, agentTools, behaviorTools);
	}

	private buildClientChannelAndGating(config: VoiceSessionConfig): void {
		const clientMedia = config.clientMedia ?? DEFAULT_CLIENT_MEDIA_PROFILE;
		const directRtcMedia =
			clientMedia.kind === 'direct_rtc' && clientMedia.rtcAudio === 'werift_opus'
				? {
						inputPcmSampleRate: this.transport.audioFormat.inputSampleRate,
						outputPcmSampleRate: this.transport.audioFormat.outputSampleRate,
						onInboundPcm: (pcm: Buffer) => this.audioRouter.handleFromClient(pcm, 'rtc'),
					}
				: undefined;
		this.clientTransport = createClientChannel({
			profile: clientMedia,
			clientSender: config.clientSender,
			directRtcMedia,
			port: config.port,
			host: config.host,
			listenTimeoutMs: config.listenTimeoutMs,
			callbacks: {
				onAudioFromClient: (data) => this.audioRouter.handleFromClient(data, 'websocket'),
				onJsonFromClient: (message) => this.handleJsonFromClient(message),
				onClientConnected: () => this.handleClientConnected(),
				onClientDisconnected: () => this.handleClientDisconnected(),
			},
		});
		this.directRtcChannel =
			this.clientTransport instanceof DirectRtcClientChannel ? this.clientTransport : null;

		// Resolve effective playback-state protocol participation: the surface
		// must intend it AND the client channel must support ordered delivery.
		this.playbackStateProtocolActive =
			config.playbackStateProtocol === 'audio_done' &&
			this.clientTransport.supportsPlaybackStateProtocol === true;

		// Resolve native-audio playback-end gating (the OpenAI native path): the
		// protocol must be active, the surface rolled in, the session on the
		// native audio path, and the transport generation-gated (not Gemini).
		this.nativePlaybackGatingActive =
			this.playbackStateProtocolActive &&
			config.nativePlaybackGating === true &&
			!this.ttsPipeline &&
			!this.transport.capabilities.playbackGatedTurnComplete;

		// Greeting send + greeting interrupt-grace controller. Pass 1 clamps the
		// caller override here; pass 2 (finalizeGreetingInterruptGrace) finalizes
		// against transport capabilities + cancelResponse availability in
		// handleSetupComplete(), BEFORE sendGreeting() can fire.
		// See design-greeting-interrupt-grace.md §5.
		this.greeting = new GreetingController(
			{
				transport: this.transport,
				getActiveAgent: () => this.agentRouter.activeAgent,
				getMemoryFacts: () => this.memoryCacheManager?.facts ?? [],
				getSessionSuffix: () => this.directiveManager.getSessionSuffix(),
				resetNotificationAudio: () => this.notificationSink.resetAudio(),
				log: (msg) => this.log(msg),
			},
			{ overrideGraceMs: clampGraceMs(config.greetingInterruptGraceMs) },
		);

		// Native (non-TTS) sessions get the native playback gate. Its barge-in is
		// installed for every native session (the !ttsProvider sibling of
		// wireTtsProvider); it only *arms* when nativePlaybackGatingActive.
		if (!this.ttsPipeline) {
			this.nativeGate = new NativeAudioPlaybackGate({
				audioFormat: this.transport.audioFormat,
				frameworkOwnsInterrupt: this.transport.capabilities.frameworkOwnsInterrupt === true,
				fallbackMarginMs: this.ttsPlaybackFallbackMarginMs,
				minPlaybackRate: VoiceSession.MIN_PLAYBACK_RATE,
				cancelResponse: (opts) => this.transport.cancelResponse?.(opts),
				requestInterrupt: (source) => this.requestInterrupt(source),
				getCurrentTurn: () => this.turns.current,
				onComplete: (turn, opts) => this.finalizeTurn(turn, opts),
				log: (msg) => this.log(msg),
			});
			this.nativeGate.installBargeIn(this.transport);
		}

		// Playback-completion arbiter — owns the defer flag + completion routing
		// across the (mutually exclusive) TTS and native gates.
		this.completionArbiter = new PlaybackCompletionArbiter({
			getLiveGate: () => this.liveGate(),
			nativePlaybackGatingActive: this.nativePlaybackGatingActive,
			getNativeGate: () => this.nativeGate,
			getTtsGate: () => this.ttsPipeline?.gate,
			vad: this.clientVadDetector,
			getBargeInConfig: () => ({
				bargeInEnabled: this.clientVad.bargeInEnabled,
				bargeInConfirmMs: this.clientVad.bargeInConfirmMs,
			}),
			finalizeTurn: (turn, opts) => this.finalizeTurn(turn, opts),
			log: (msg) => this.log(msg),
		});

		// Inbound client→server JSON dispatch. `handleJsonFromClient` stays the
		// thin VoiceSession entry/intercept point and delegates here.
		this.clientMessageRouter = new ClientMessageRouter({
			getDirectRtcChannel: () => this.directRtcChannel,
			getBehaviorManager: () => this.behaviorManager,
			eventBus: this.eventBus,
			getSessionActive: () => this.sessionManager.isActive,
			conversationContext: this.conversationContext,
			sendFile: (base64, mimeType) => this.transport.sendFile(base64, mimeType),
			getArbiter: () => this.completionArbiter,
			getLiveGate: () => this.liveGate(),
			getPlaybackStateProtocolActive: () => this.playbackStateProtocolActive,
			sessionId: this.config.sessionId,
			getArtifactRegistry: () => this.config.artifactRegistry,
			handleTextInput: (text) => this.handleTextInput(text),
			onClientJson: config.onClientJson,
			reportError: (context, error) => this.reportError(context, error),
			log: (msg) => this.log(msg),
		});

		// Transport reconnect + response-watchdog. GoAway reconnects immediately;
		// transport-close/watchdog go through the budgeted+backed-off path. The
		// `isAgentMode` thunk reads the DictationController (gates watchdog arming
		// and the post-reconnect nudge to agent-mode turns only).
		this.reconnector = new TransportReconnector(
			{
				sessionManager: this.sessionManager,
				clientTransport: this.clientTransport,
				transport: this.transport,
				toReplayContent: () => this.conversationContext.toReplayContent(),
				eventBus: this.eventBus,
				getSessionId: () => this.config.sessionId,
				isAgentMode: () => this.dictation.isAgentMode(),
				reportError: (context, error) => this.reportError(context, error),
				log: (msg) => this.log(msg),
				// Watchdog-stall recovery (watchdogReplayRecovery flag): without a
				// retainer this returns null and recovery keeps today's behavior.
				peekRetainedUtterance: () =>
					this.utteranceRetainer?.peek(DEFAULT_REPLAY_MAX_AGE_MS) ?? null,
				detectSpeech: (chunks) => pcmChunksContainSpeech(chunks),
				// Mid-speech watchdog deferral (R7a) is ALWAYS wired: it only reads the
				// client VAD's in-progress-segment flag and merely postpones recovery while
				// the user is talking, so flag-off sessions must not force a reconnect under
				// a live multi-segment utterance. The R7c hosted-freshness verdict below stays
				// scoped to the retained-replay rollout flag.
				isSpeechActive: () => this.clientVadDetector.isSpeechActive,
				hostedReconnectSpeech: this.utteranceRetainer
					? () => this.reconnectWindowSpeechVerdict()
					: undefined,
				onReconnectWindowStart: () => {
					this._reconnectWindowFrames = 0;
					this._reconnectWindowSpeech = false;
				},
				// R7b: a replayed turn emits no input transcription — promote the
				// pending batch-STT/display partial so the user's words appear.
				onReplayDispatched: this.utteranceRetainer
					? () => {
							if (this.transcriptManager.finalizeInterruptedInputPartial()) {
								this.log(
									'[Watchdog] Promoted pending input partial as the replayed turn transcript',
								);
							}
						}
					: undefined,
			},
			this.responseWatchdogMs,
		);
	}

	private buildAgentRouter(
		config: VoiceSessionConfig,
		allInitialTools: ToolDefinition[],
		behaviorTools: ToolDefinition[],
	): void {
		// Set up tool executor
		this.toolExecutor = this.createToolExecutor(config.initialAgent);

		if (allInitialTools.length) {
			this.toolExecutor.register(allInitialTools);
		}

		// Set up agent router
		this.agentRouter = new AgentRouter(
			this.sessionManager,
			this.eventBus,
			this.hooks,
			this.conversationContext,
			this.transport,
			this.clientTransport,
			config.model,
			() => this.directiveManager.getSessionSuffix(),
			behaviorTools,
			{
				onMessage: (toolCallId, msg) => this.handleSubagentMessage(toolCallId, msg),
				onSessionEnd: (toolCallId) => this.interactionMode.deactivate(toolCallId),
			},
			{
				setExternalAudioHandler: (handler) => {
					this.externalAudioHandler = handler;
				},
				sendAudioToClient: (data) => {
					this.clientTransport.sendAudioToClient(data);
				},
			},
			() => this.memoryCacheManager?.facts ?? [],
			() => {
				const t = this.processedKnowledgeBase?.promptInjection?.trim();
				return t && t.length > 0 ? t : undefined;
			},
		);
		this.agentRouter.registerAgents(config.agents);
		this.agentRouter.setInitialAgent(config.initialAgent);
		if (this.ttsPipeline) {
			this.agentRouter.responseModality = 'text';
		}
	}

	private buildOrchestration(
		config: VoiceSessionConfig,
		agentTools: ToolDefinition[],
		behaviorTools: ToolDefinition[],
	): void {
		if (config.orchestrationMode === 'actor') {
			this.runtimeToolRegistry = this.buildRuntimeToolRegistry([...agentTools, ...behaviorTools]);

			this.runtimeOrchestrator = new RuntimeOrchestrator({
				adapter: new GeminiTransportAdapter(this.transport),
				tools: this.runtimeToolRegistry,
				inlineExecutor: {
					execute: async (call) => {
						const toolCall = {
							toolCallId: call.toolCallId,
							toolName: call.toolName,
							args: call.args,
						};
						const result = await this.toolExecutor.handleToolCall(toolCall);
						this.conversationContext.addToolCall(toolCall);
						this.conversationContext.addToolResult(result);
						return {
							result: result.error ? { error: result.error } : result.result,
							error: result.error,
						};
					},
				},
				clientSend: (message) => this.clientTransport.sendJsonToClient(message),
				onTransferRequested: async (toAgent) => {
					await this.transfer(toAgent);
				},
				backgroundExecutor: async (request, signal) => {
					const toolCall = {
						toolCallId: request.toolCallId,
						toolName: request.toolName,
						args: request.args,
					};
					const registeredConfig = this.subagentConfigs[request.toolName];
					if (!registeredConfig) {
						throw new Error(`No subagent config for tool "${request.toolName}"`);
					}
					const hasPendingMessage = !!this.runtimeToolRegistry?.get(request.toolName)
						?.pendingMessage;
					const backgroundStartedAt = Date.now();
					this.log(
						`Background task started: ${request.toolName} (toolCallId=${request.toolCallId}, lifetime=${request.lifetime})`,
					);

					this.conversationContext.addToolCall(toolCall);
					try {
						let resultText: string;
						const usePersistentRuntimePath =
							request.lifetime === 'persistent_session' && !!registeredConfig.persistentFactory;

						if (usePersistentRuntimePath) {
							const persistentKey = request.configName;
							// Safe: usePersistentRuntimePath checks !!registeredConfig.persistentFactory above
							const factory = registeredConfig.persistentFactory as NonNullable<
								typeof registeredConfig.persistentFactory
							>;
							await this.persistentSubagents.acquirePersistent(
								persistentKey,
								registeredConfig,
								factory,
							);
							resultText = await this.persistentSubagents.invoke(
								persistentKey,
								`Execute tool: ${request.toolName}`,
								request.args,
								signal,
							);
						} else {
							const subagentConfig = registeredConfig.createInstance
								? registeredConfig.createInstance()
								: registeredConfig;
							const result = await this.agentRouter.handoff(toolCall, subagentConfig, signal);
							resultText = result.text;
						}

						this.conversationContext.addToolResult({
							toolCallId: toolCall.toolCallId,
							toolName: toolCall.toolName,
							result: resultText,
						});
						if (hasPendingMessage) {
							// Actor mode: publish the SYSTEM completion notification through
							// NotificationActor. TransportActor wraps it as "[SYSTEM]: text"
							// at the wire-out boundary (centralized label rendering).
							this.publishSystemNotification(
								`Background task "${request.toolName}" completed successfully. Result: ${resultText}. Please inform the user now.`,
							);
						}
						this.log(
							`Background task completed: ${request.toolName} (toolCallId=${request.toolCallId}, duration=${Date.now() - backgroundStartedAt}ms)`,
						);
						return resultText;
					} catch (err) {
						this.conversationContext.addToolResult({
							toolCallId: toolCall.toolCallId,
							toolName: toolCall.toolName,
							result: null,
							error: err instanceof Error ? err.message : String(err),
						});
						if (hasPendingMessage) {
							const msg = err instanceof Error ? err.message : String(err);
							this.publishSystemNotification(
								`Background task "${request.toolName}" failed. Exact error details: ${msg}. Tell the user the exact error details first, then ask how to proceed.`,
							);
						}
						this.log(
							`Background task failed: ${request.toolName} (toolCallId=${request.toolCallId}, duration=${Date.now() - backgroundStartedAt}ms): ${err instanceof Error ? err.message : String(err)}`,
						);
						throw err;
					}
				},
				agents: config.agents.map((agent) => {
					const resolved = resolveAgentWithKnowledgeBase(agent);
					return {
						name: agent.name,
						instructions: resolved.instructions,
						tools: resolved.tools,
						providerOptions: agent.providerOptions,
						onEnter: async () => agent.onEnter?.(this.createAgentContext(agent.name)),
						onExit: async () => agent.onExit?.(this.createAgentContext(agent.name)),
					};
				}),
				initialAgent: config.initialAgent,
				hooks: {
					onAgentTransfer: (info) => {
						this.eventBus.publish('agent.transfer', {
							sessionId: this.sessionManager.sessionId,
							fromAgent: info.fromAgent,
							toAgent: info.toAgent,
						});
					},
					onError: (info) => this.reportError(info.component, info.error),
				},
				// Session id is threaded into the BackgroundAgentContext (Phase 2)
				// and into the onBackgroundNotification event payload below.
				sessionId: config.sessionId,
				userId: config.userId,
				backgroundAgents: config.backgroundAgents,
				// Wire FrameworkHooks.onBackgroundNotification through to the
				// RuntimeOrchestrator's NotificationHooksObserverActor. We only
				// supply the callback when one is actually registered so the
				// orchestrator stays zero-overhead (it skips constructing the
				// observer when this is undefined). At session-construction
				// time the user has already registered hooks via config.hooks
				// (HooksManager.register fired up top), so reading
				// `this.hooks.onBackgroundNotification` here yields the
				// caller-supplied callback if any.
				notification: this.hooks.onBackgroundNotification
					? { onBackgroundNotification: this.hooks.onBackgroundNotification }
					: undefined,
			});
		} else {
			// Set up legacy tool call router. notificationQueue is guaranteed
			// to be defined on this branch (constructed above when
			// orchestrationMode !== 'actor'); the non-null assertion just
			// communicates that to TypeScript.
			this.toolCallRouter = new ToolCallRouter({
				toolExecutor: this.toolExecutor,
				agentRouter: this.agentRouter,
				conversationContext: this.conversationContext,
				// biome-ignore lint/style/noNonNullAssertion: legacy branch only
				notificationQueue: this.notificationQueue!,
				transcriptManager: this.transcriptManager,
				subagentConfigs: this.subagentConfigs,
				// transport.sendToolResult is wrapped at session-construction
				// time to enforce the transcription-mode guard for both legacy
				// and actor-mode paths.
				sendToolResult: (result) => this.transport.sendToolResult(result),
				transfer: (toAgent) => this.transfer(toAgent),
				reportError: (component, error) => this.reportError(component, error),
				log: (msg) => this.log(msg),
			});
		}
	}

	/** Wire the LLMTransport lifecycle property callbacks (audio / tool / turn /
	 *  error / grounding). Works for both injected and default transports. The
	 *  TTS and native text/speech-started callbacks are wired separately
	 *  (`wireTtsProvider` / the native gate's `installBargeIn`). */
	private wireTransportCallbacks(): void {
		this.transport.onAudioOutput = (data) => this.handleAudioOutput(data);
		this.transport.onToolCall = (calls) => {
			this.reconnector.disarmResponseWatchdog();
			// Native playback-end gate: this response dispatched a tool call, so
			// it is not the turn's terminal spoken response.
			this._nativeResponseDispatchedToolCall = true;
			if (this.runtimeOrchestrator) {
				const names = calls.map((c) => c.name).join(', ');
				this.logProviderUserTurnRecognition('tool call received');
				const sinceVadEnd = this.clientVadDetector.lastSpeechCompletedMs
					? ` (${Date.now() - this.clientVadDetector.lastSpeechCompletedMs}ms after client audio VAD end)`
					: '';
				this.log(`Tool calls from LLM: [${names}]${sinceVadEnd}`);
				this.transcriptManager.flushInput();
				this.transcriptManager.saveOutputPrefix();
			}
			this.toolCallRouter?.handleToolCalls(calls);
		};
		this.transport.onToolCallCancel = (ids) => {
			if (this.runtimeOrchestrator) {
				this.toolExecutor.cancel(ids);
			}
			this.toolCallRouter?.handleToolCallCancellation(ids);
		};
		this.transport.onTurnComplete = (serverTurnId) => this.handleTurnComplete(serverTurnId);
		this.transport.onInterrupted = (serverTurnId) => this.handleInterrupted(serverTurnId);
		this.transport.onOutputTranscription = (text) => {
			const turn = this.turns.ensureCurrent();
			if (!turn) {
				this.log(
					'[Watchdog] Ignored output transcription for already-finalized turn; watchdog NOT disarmed',
				);
				return;
			}
			this.reconnector.disarmResponseWatchdog();
			this.transcriptManager.handleOutput(text);
		};
		this.transport.onSessionReady = (sessionId) => this.handleSetupComplete(sessionId);
		this.transport.onError = (error) => this.handleTransportError(error);
		this.transport.onClose = (code, reason) => this.handleTransportClose(code, reason);
		this.transport.onGoAway = (timeLeft) => this.handleGoAway(timeLeft);
		this.transport.onResumptionUpdate = (handle, resumable) =>
			this.reconnector.handleResumptionUpdate(handle, resumable);
		this.transport.onGroundingMetadata = (metadata) => this.handleGroundingMetadata(metadata);
	}

	/** Wire EventBus subscriptions: GUI event → client forwarding, STT lifecycle
	 *  binding, subagent UI button responses, and async agent-transfer requests.
	 *  Callbacks fire at runtime, so referencing collaborators constructed later
	 *  (e.g. `agentRouter`) is safe. */
	private wireEventBus(): void {
		// Forward GUI events from EventBus to the client as JSON text frames
		this.eventBus.subscribe('gui.update', (payload) => {
			this.clientTransport.sendJsonToClient({ type: 'gui.update', payload });
		});
		this.eventBus.subscribe('gui.notification', (payload) => {
			this.clientTransport.sendJsonToClient({ type: 'gui.notification', payload });
		});
		this.eventBus.subscribe('subagent.ui.send', (payload) => {
			this.clientTransport.sendJsonToClient({ type: 'ui.payload', payload: payload.payload });
		});

		// Bind STT lifecycle to session state: start when ACTIVE (agent ready), stop when disconnecting
		this.eventBus.subscribe('session.stateChange', (payload: { toState: string }) => {
			if (payload.toState === 'ACTIVE') {
				this.startSttProvider();
			} else if (payload.toState === 'RECONNECTING' || payload.toState === 'TRANSFERRING') {
				void this.sttProvider?.stop();
			}
		});

		// Route UI button responses back to the waiting SubagentSession
		this.eventBus.subscribe(
			'subagent.ui.response',
			(payload: {
				sessionId: string;
				response: { requestId: string; selectedOptionId?: string };
			}) => {
				const { requestId, selectedOptionId } = payload.response;
				if (!requestId || !selectedOptionId) return;

				const session = this.agentRouter.findSessionByRequestId(requestId);
				if (!session) return;

				const option = session.resolveOption(requestId, selectedOptionId);
				const answerText = option?.label ?? selectedOptionId;
				session.trySendToSubagent(answerText);
			},
		);

		// Subscribe to async agent transfer requests (from external audio agents like Twilio)
		this.eventBus.subscribe('agent.transfer_requested', (payload) => {
			setImmediate(() => {
				this.transfer(payload.toAgent).catch((err) => {
					this.log(
						`Transfer requested to "${payload.toAgent}" failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
			});
		});
	}

	/** Wire the realtime usage + cache-bust observability callbacks. Each chains
	 *  over any handler a pre-configured injected transport already attached, then
	 *  fires the framework hook and mirrors the event onto the EventBus (P4). */
	private wireUsageCallbacks(): void {
		const prevUsage = this.transport.onRealtimeLLMUsage;
		this.transport.onRealtimeLLMUsage = (usage) => {
			try {
				prevUsage?.(usage);
			} catch (e) {
				this.log(`pre-attached onRealtimeLLMUsage threw: ${(e as Error).message}`);
			}
			const source = deriveUsageSource(usage);
			// Derive the turnId for this usage event without creating a Turn.
			// Input-transcription usage is not turn-bound. Otherwise resolveTurn
			// maps it to its Turn (a `match` — including trailing winding-down
			// usage for the just-finalized turn); a `new`/`stale` result means a
			// turn not yet born, which gets `turn_${turnId+1}` — the id it will
			// be born with.
			let turnId: string | null;
			let agentName: string;
			if (source === 'openai.transcription') {
				turnId = null;
				agentName = this.turns.active()?.agentName ?? this.agentRouter.activeAgent.name;
			} else {
				const r = this.turns.resolve(usage.serverTurnId, 'usage');
				if (r.kind === 'match') {
					turnId = r.turn.id;
					agentName = r.turn.agentName;
				} else {
					turnId = this.turns.nextLabel;
					agentName = this.agentRouter.activeAgent.name;
				}
			}
			if (this.hooks.onRealtimeLLMUsage) {
				this.hooks.onRealtimeLLMUsage({
					sessionId: this.config.sessionId,
					agentName,
					usage,
				});
			}
			const seqKey = `${turnId ?? 'no_turn'}:${source}`;
			const sequence = this.turns.nextUsageSequence(seqKey);
			const ratio = computeCacheHitRatio(usage, source);
			this.eventBus.publish('realtime.usage', {
				sessionId: this.config.sessionId,
				agentName,
				turnId,
				source,
				providerItemId: deriveProviderItemId(usage, source),
				sequence,
				emittedAt: Date.now(),
				usage,
				...(ratio !== undefined ? { cacheHitRatio: ratio } : {}),
			});
		};

		const prevCacheBust = this.transport.onCacheBust;
		this.transport.onCacheBust = (reason) => {
			try {
				prevCacheBust?.(reason);
			} catch (e) {
				this.log(`pre-attached onCacheBust threw: ${(e as Error).message}`);
			}
			const active = this.turns.active();
			this.eventBus.publish('realtime.cache.bust', {
				sessionId: this.config.sessionId,
				agentName: active?.agentName ?? this.agentRouter.activeAgent.name,
				turnId: active?.id ?? null,
				reason,
			});
		};
	}

	/**
	 * Queue a short spoken update for the user.
	 * Delivered immediately when possible, otherwise after the current turn.
	 *
	 * `options.label` is widened from the original
	 * `'SUBAGENT UPDATE' | 'SUBAGENT QUESTION'` union to allow user-defined
	 * labels (e.g. `'TIME REMINDER'`). Non-breaking: the two literal strings
	 * still type-check. NotificationActor normalizes the label on ingest in
	 * actor mode (uppercase + sanitize to `[A-Z0-9 _-]`, max 32 chars,
	 * fallback to `'SYSTEM'` if empty after sanitize).
	 */
	notifyBackground(
		text: string,
		options?: {
			priority?: 'normal' | 'high';
			label?: KnownNotificationLabel | (string & {});
		},
	): void {
		const label = options?.label ?? 'SUBAGENT UPDATE';
		const priority = options?.priority ?? 'normal';
		this.notificationSink.publish(label, text, priority);
	}

	/**
	 * Internal helper for actor-mode SYSTEM notifications. Centralizes the
	 * `runtime.tell('notification.publish', ...)` call shape used by the
	 * background-tool completion path. Caller passes only the body text;
	 * TransportActor wraps it as `[SYSTEM]: text` at the wire-out boundary.
	 */
	private publishSystemNotification(text: string): void {
		// Actor-only callers (the background-tool completion path, guarded by the
		// actor-construction block). Routed through the sink for uniformity; the
		// legacy sink is never reached from here.
		this.notificationSink.publish('SYSTEM', text, 'normal');
	}

	/** Start the client WebSocket server and connect to the LLM transport. */
	async start(): Promise<void> {
		// Validate TTS config
		if (this.ttsPipeline) {
			if (this.config.orchestrationMode !== 'actor') {
				throw new Error('TTSProvider requires orchestrationMode: "actor"');
			}
			if (!this.transport.capabilities.textResponseModality) {
				throw new Error(
					'TTSProvider requires text-mode responses, but the transport does not support textResponseModality',
				);
			}
		}
		await this.sttProvider?.start();
		await this.ttsPipeline?.provider.start();
		// Phase 3: when constructed with initial transcriptionMode='transcription',
		// bring Whisper up and quiesce the agent transport before start() resolves.
		// Audio dropped during these awaits is bounded by clientTransport buffering.
		await this.dictation.prepareForStart();
		if (this.runtimeOrchestrator) {
			await this.runtimeOrchestrator.start();
		}

		// Load memory and directives in parallel with Gemini connect so session starts fast
		this._memoryReadyPromise = this.loadMemoryAndDirectives();

		await this.clientTransport.start();
		this.log('Connecting to LLM transport...');
		this.sessionManager.transitionTo('CONNECTING');
		if (this.config.transport) {
			if (this.ttsPipeline) {
				await this.transport.updateSession({ responseModality: 'text' });
			}
			await this.transport.connect();
		} else {
			await this.transport.connect({
				auth: { type: 'api_key', apiKey: this.config.apiKey },
				model: this.config.geminiModel ?? DEFAULT_GEMINI_LIVE_MODEL,
				...(this.resolvedRealtimeInputConfig
					? {
							realtimeInputConfig: this.resolvedRealtimeInputConfig as Record<string, unknown>,
						}
					: {}),
				...(this.ttsPipeline ? { responseModality: 'text' as const } : {}),
			});
		}
		this.log('LLM transport connected and setup complete');
	}

	/** Load memory cache and restore behavior directives; used in parallel with connect(). */
	private async loadMemoryAndDirectives(): Promise<void> {
		await this.memoryCacheManager?.refresh();
		if (this.config.memory && this.behaviorManager) {
			try {
				const directives = await this.config.memory.store.getDirectives(this.config.userId);
				const restored: string[] = [];
				for (const [key, presetName] of Object.entries(directives)) {
					if (this.behaviorManager.restorePreset(key, presetName)) {
						restored.push(key);
					}
				}
				if (restored.length > 0) {
					this.log(`Restored behavior presets from directives: ${restored.join(', ')}`);
				}
			} catch {
				// Best-effort — directive loading failure is non-fatal
			}
		}
	}

	/**
	 * Workspace API for persisting artifacts (images, videos, docs, etc.) produced by agents/tools.
	 * When no artifactStore is configured, saveArtifact returns null without persisting.
	 */
	get workspace(): {
		saveArtifact(params: SaveArtifactParams): Promise<ArtifactRef | null>;
	} {
		const sessionId = this.config.sessionId;
		const userId = this.config.userId;
		const store = this.config.artifactStore;
		return {
			async saveArtifact(params: SaveArtifactParams): Promise<ArtifactRef | null> {
				if (!store) return null;
				const full: SaveArtifactParams = {
					...params,
					sessionId: params.sessionId ?? sessionId,
					userId: params.userId ?? userId,
				};
				return store.saveArtifact(full);
			},
		};
	}

	/** Gracefully shut down: disconnect Gemini, stop the WebSocket server, transition to CLOSED. */
	async close(_reason = 'normal'): Promise<void> {
		// Drop any queued background notifications — session is ending.
		// Actor mode: NotificationActor.onStop clears its own state when the
		// runtime orchestrator stops below.
		this.notificationQueue?.clear();
		// Retained user audio is session-scoped and memory-only — drop it now.
		this.utteranceRetainer?.clearAll();
		this.reconnector.resetReplayState();

		// Flush any buffered transcription before closing
		this.transcriptManager.flush();

		// Fire turn end if a turn is still active. Teardown only does the
		// lifecycle transition — NOT finalizeTurn (its completion effects, e.g.
		// reinforceDirectives, must not run against a closing transport).
		const teardownTurn = this.turns.current;
		if (teardownTurn?.finalize()) {
			this.eventBus.publish('turn.end', {
				sessionId: this.config.sessionId,
				turnId: teardownTurn.id,
			});
		}

		// Final memory extraction before closing
		if (this.memoryDistiller) {
			this.log('Running final memory extraction...');
			try {
				await this.memoryDistiller.forceExtract();
				this.log('Final memory extraction complete');
			} catch {
				this.log('Final memory extraction failed (best-effort)');
			}
		}

		await this.sttProvider?.stop();
		// Phase 3: stop the dictation-mode Whisper provider so prewarmed or
		// active sockets don't survive session close. Idempotent.
		await this.dictation.stopWhisper();
		this.ttsPipeline?.gate.clearTimers();
		this.reconnector.disarmResponseWatchdog();
		// close() bypasses finalizeTurn — tear down the native gate directly so
		// no native playback timer outlives the session.
		if (this.nativePlaybackGatingActive) {
			this.nativeGate?.clear();
			this.completionArbiter.clearDefer();
		}
		await this.ttsPipeline?.provider.stop();
		if (this.runtimeOrchestrator) {
			await this.runtimeOrchestrator.stop();
		}
		await this.persistentSubagents.disposeAllPersistent();
		this.config.artifactRegistry?.dispose();
		await this.transport.disconnect();
		await this.clientTransport.stop();

		if (this.sessionManager.state !== 'CLOSED') {
			this.sessionManager.transitionTo('CLOSED');
		}

		this.eventBus.clear();
	}

	/** Transfer the active session to a different agent (reconnects with new config). */
	async transfer(toAgent: string): Promise<void> {
		// Serialise with setTranscriptionMode() — both mutate session-level
		// state and emit greetings / session.update on the wire; running them
		// concurrently could leak agent content into dictation mode or
		// produce out-of-order session.updated events.
		return this.mutationQueue.enqueue(() => this._transferInner(toAgent));
	}

	private async _transferInner(toAgent: string): Promise<void> {
		this.log(`Transferring to agent "${toAgent}"...`);
		await this.agentRouter.transfer(toAgent);
		this.log(`Transfer to "${toAgent}" complete`);

		// Update tool executor with new agent's tools (include KB-generated tools)
		const agent = this.agentRouter.activeAgent;
		const resolved = resolveAgentWithKnowledgeBase(agent);
		this.processedKnowledgeBase = resolved.processedKB;
		this.toolExecutor = this.createToolExecutor(agent.name);
		const behaviorTools = this.behaviorManager?.tools ?? [];
		this.toolExecutor.register([...resolved.tools, ...behaviorTools]);
		if (this.toolCallRouter) {
			this.toolCallRouter.toolExecutor = this.toolExecutor;
		}
		if (this.runtimeToolRegistry) {
			this.runtimeToolRegistry.clear();
			for (const [name, info] of this.buildRuntimeToolRegistry([
				...resolved.tools,
				...behaviorTools,
			])) {
				this.runtimeToolRegistry.set(name, info);
			}
		}

		// Clear agent-scoped directives on transfer; session-scoped directives persist
		this.directiveManager.clearAgent();

		// Send the new agent's greeting if configured
		if (this.clientConnected) {
			this.greeting.sendGreeting();
		}
	}

	private createToolExecutor(agentName: string): ToolExecutor {
		return new ToolExecutor(
			this.hooks,
			this.eventBus,
			this.config.sessionId,
			agentName,
			(msg) => this.clientTransport.sendJsonToClient(msg),
			(key, value, scope) => this.directiveManager.set(key, value, scope),
		);
	}

	private createAgentContext(agentName: string): import('../types/agent.js').AgentContext {
		return {
			sessionId: this.config.sessionId,
			agentName,
			injectSystemMessage: (text: string) =>
				this.conversationContext.addAssistantMessage(`[system] ${text}`),
			getRecentTurns: (count = 10) => [...this.conversationContext.items].slice(-count),
			getMemoryFacts: () => this.memoryCacheManager?.facts ?? [],
			requestTransfer: (toAgent: string) => {
				setImmediate(() => {
					this.eventBus.publish('agent.transfer_requested', {
						sessionId: this.config.sessionId,
						toAgent,
					});
				});
			},
			stopBufferingAndDrain: (handler: (chunk: Buffer) => void) => {
				const buffered = this.clientTransport.stopBuffering();
				for (const chunk of buffered) {
					handler(chunk);
				}
			},
			sendJsonToClient: (message: Record<string, unknown>) => {
				this.clientTransport.sendJsonToClient(message);
			},
			sendAudioToClient: (data: Buffer) => {
				this.clientTransport.sendAudioToClient(data);
			},
			setExternalAudioHandler: (handler: ((data: Buffer) => void) | null) => {
				this.externalAudioHandler = handler;
			},
		};
	}

	private buildRuntimeToolRegistry(
		tools: { name: string; execution: 'inline' | 'background'; pendingMessage?: string }[],
	): Map<string, ToolRoutingInfo> {
		const registry = new Map<string, ToolRoutingInfo>();
		for (const tool of tools) {
			registry.set(tool.name, {
				name: tool.name,
				execution: tool.execution,
				// Keep the transport tool result name aligned with the model-facing tool name.
				configName: tool.name,
				pendingMessage: tool.pendingMessage,
				lifetime: this.subagentConfigs[tool.name]?.lifetime,
			});
		}
		return registry;
	}

	// --- Audio fast-path (no EventBus) — inbound routing lives in AudioRouter ---

	/**
	 * Barge-in policy for the in-progress client-VAD segment — run on every
	 * voiced frame (the detector's `onVoicedFrame`). Fires a barge-in when the
	 * segment is genuine (sustained past the confirmation window, loud enough to
	 * clear the TTS-echo floor) AND a playback gate is pending AND the grace
	 * window allows it. Fires at most once per segment. See `clientVadBargeInAllowed`.
	 */
	private runClientVadBargeInPolicy(now: number, maxAbs: number, avgAbs: number): void {
		// Mark the segment a *potential* barge-in once a frame clears the in-TTS
		// energy floor — UNCONDITIONALLY, even before a playback gate is armed,
		// so a segment that begins just before `handleTurnComplete` arms the
		// native gate is still recognised. `finishOrDeferForVad` keys on this.
		if (clientVadBargeInEnergyEligible(this.clientVad, maxAbs, avgAbs)) {
			this.clientVadDetector.markBargeInEligible();
		}
		// The interrupt fires only while assistant audio is actively playing —
		// a pending playback gate (TTS/native) OR, on the no-gate Gemini native
		// path, an active turn whose buffered audio is still playing.
		if (!this.isAssistantAudioActive()) return;
		if (this.clientVadDetector.hasBargeInFired) return;
		if (
			!clientVadBargeInAllowed(
				this.clientVad,
				now - this.clientVadDetector.speechStartedAtMs,
				maxAbs,
				avgAbs,
			)
		) {
			return;
		}
		// Grace check goes BEFORE marking fired — otherwise a frame at t=500ms
		// within a 1s grace would set the "fired" flag, and the `hasBargeInFired`
		// guard above would skip the next loud frame at t=1100ms (post-grace),
		// defeating real barge-ins. See dev_docs/framework/design-greeting-interrupt-grace.md §4.
		if (!this.requestInterrupt('client-vad')) return;
		this.clientVadDetector.markBargeInFired();
		this.log(
			`[Latency] client-VAD barge-in actuated (path=${this.liveGate() ? 'gate' : 'native-fallback'}; peak=${maxAbs}; avgAbs=${avgAbs})`,
		);
		this.handleClientTtsBargeIn();
	}

	private logInputTranscriptionLatency(text: string, source: string): void {
		const trimmed = text.trim();
		if (!trimmed || trimmed === this.lastInputTranscriptionLogText) return;
		this.lastInputTranscriptionLogText = trimmed;
		const sinceVadEnd = this.clientVadDetector.lastSpeechCompletedMs
			? `; ${Date.now() - this.clientVadDetector.lastSpeechCompletedMs}ms after client audio VAD end`
			: '';
		const preview = trimmed.replace(/\s+/g, ' ').slice(0, 120);
		this.log(
			`[Latency] Input transcription update (${source}; chars=${trimmed.length}${sinceVadEnd}; text="${preview}")`,
		);
	}

	private handleClientTtsBargeIn(): void {
		if (!this.isAssistantAudioActive()) return;
		// Stop the current response reaching the user — uniformly, per the
		// `cancelResponse` contract: framework-owned transports cancel generation
		// on the wire; non-cancellable ones (Gemini) suppress their remaining
		// outbound audio. A no-op when nothing is generating, so it is safe across
		// native and TTS paths. See design-noncancellable-transport-barge-in.md.
		this.transport.cancelResponse?.({});
		// The client-side VAD holds the Turn by reference — no server-turn id
		// needed. A native gate finalizes the captured _nativePlaybackTurn; a
		// later provider onInterrupted resolves to this same finalized Turn and
		// no-ops structurally.
		this.finalizeTurn(this.nativeGate?.capturedTurn ?? this.turns.current, { interrupted: true });
	}

	private logProviderUserTurnRecognition(reason: string): void {
		this.clientVadDetector.complete('provider-recognition');
		if (!this.clientVadDetector.lastSpeechCompletedMs) return;
		if (
			this.lastGeminiRecognitionLoggedForSpeechEndMs ===
			this.clientVadDetector.lastSpeechCompletedMs
		)
			return;
		this.lastGeminiRecognitionLoggedForSpeechEndMs = this.clientVadDetector.lastSpeechCompletedMs;
		this.log(
			`[Latency] Provider recognized user input completed (${reason}; ${Date.now() - this.clientVadDetector.lastSpeechCompletedMs}ms after client audio VAD end; clientSpeechDuration=${this.clientVadDetector.lastSpeechDurationMs}ms)`,
		);
	}

	private handleAudioOutput(data: string): void {
		// Phase 3 framework-layer guard: when not in agent mode, drop transport
		// audio at this seam. Belt-and-braces backup for transports that don't
		// implement quiesce(); guarantees no model audio leaks into dictation
		// mode even if a quiesce race occurs.
		if (!this.dictation.isAgentMode()) return;
		const turn = this.turns.ensureCurrent();
		if (!turn) {
			this.log('[Watchdog] Ignored output audio for already-finalized turn; watchdog NOT disarmed');
			return;
		}
		// Mark the turn's first assistant audio — drives the client-VAD barge-in
		// eligibility window (`isAssistantAudioActive`). Trailing-audio suppression
		// after a barge-in is the transport's job (cancelResponse), not here.
		if (this._assistantAudioStartedAtMs === null) this._assistantAudioStartedAtMs = Date.now();
		this.reconnector.disarmResponseWatchdog();

		// Greeting interrupt grace: arm on the first assistant audio chunk.
		// Idempotent — subsequent chunks no-op inside the class.
		this.maybeArmGraceOnFirstAudio();

		this.signalAudioStarted();
		const raw = Buffer.from(data, 'base64');
		if (this.nativePlaybackGatingActive) this.nativeGate?.noteAudioChunk(raw.length);
		// Telephony mode: transport emits G.711 μ-law on the wire; client
		// transports (web RTC, mic playback) expect PCM. Decode at this seam
		// using the OUTPUT-side encoding (input encoding may differ on mixed
		// telephony configs). The TwilioBridge code path bypasses this fork;
		// it consumes the transport's audioFormat directly via its own bridge.
		const outEnc = this.transport.audioFormat.outputEncoding ?? this.transport.audioFormat.encoding;
		const buffer: Buffer = outEnc === 'pcmu' ? decodeMulawToPcm(raw) : raw;
		this.clientTransport.sendAudioToClient(buffer);
	}

	/**
	 * Signal that the model has begun producing audio this turn. The sink routes
	 * to `notificationQueue.markAudioReceived()` (legacy) or a once-per-turn
	 * debounced `notification.audio_started` (actor) — keeping audio chunks off
	 * the actor mailbox per the audio fast-path contract.
	 */
	private signalAudioStarted(): void {
		this.notificationSink.audioStarted();
	}

	/** Validate a configured TTS fallback margin: invalid (negative, NaN,
	 *  non-finite) → default with a warning; valid but below the floor →
	 *  clamped up to the floor. */
	private resolveTtsPlaybackFallbackMarginMs(raw: number | undefined): number {
		if (raw === undefined) return VoiceSession.TTS_PLAYBACK_FALLBACK_MARGIN_DEFAULT_MS;
		if (!Number.isFinite(raw) || raw < 0) {
			this.log(
				`Invalid ttsPlaybackFallbackMarginMs=${raw}; using default ${VoiceSession.TTS_PLAYBACK_FALLBACK_MARGIN_DEFAULT_MS}ms`,
			);
			return VoiceSession.TTS_PLAYBACK_FALLBACK_MARGIN_DEFAULT_MS;
		}
		return Math.max(raw, VoiceSession.TTS_PLAYBACK_FALLBACK_MARGIN_FLOOR_MS);
	}

	// --- Gemini event handlers ---

	private handleSetupComplete(_sessionId: string): void {
		this.log(`LLM transport setup complete (clientConnected=${this.clientConnected})`);
		// Greeting-grace pass 2: finalize the effective grace window against
		// the transport's post-connect capabilities, BEFORE any sendGreeting()
		// call below can request the first audio chunk. Idempotent — safe to
		// re-run on transfer/reconnect setup-complete callbacks, but in
		// practice runs once per VoiceSession lifecycle.
		// See dev_docs/framework/design-greeting-interrupt-grace.md §5.
		this.finalizeGreetingInterruptGrace();
		if (this.sessionManager.state === 'CONNECTING') {
			this.sessionManager.transitionTo('ACTIVE');
		}
		// During transfer or reconnect, the caller handles post-connect logic — skip greeting here
		if (
			this.sessionManager.state === 'TRANSFERRING' ||
			this.sessionManager.state === 'RECONNECTING'
		) {
			return;
		}
		// Send greeting after memory/directives are loaded (no blocking of connect)
		if (this.clientConnected) {
			this._memoryReadyPromise.then(() => this.greeting.sendGreeting());
		}
	}

	/** Pass 2 of greeting-grace resolution (§5). Thin delegator —
	 *  see `GreetingController.finalizeGreetingInterruptGrace`. */
	private finalizeGreetingInterruptGrace(): void {
		this.greeting.finalizeGreetingInterruptGrace();
	}

	/** Idempotent first-audio grace arming. Thin delegator — see
	 *  `GreetingController.maybeArmGraceOnFirstAudio`. Called from every
	 *  assistant-audio chunk site (native `handleAudioOutput`, external TTS). */
	private maybeArmGraceOnFirstAudio(): void {
		this.greeting.maybeArmGraceOnFirstAudio();
	}

	/** Returns `true` if the caller should proceed with the interrupt; `false`
	 *  (and logs) if the greeting grace is currently suppressing it. Thin
	 *  delegator — see `GreetingController.requestInterrupt`. Kept on
	 *  VoiceSession so its many injection sites (gates, tts, vad) are
	 *  untouched. */
	private requestInterrupt(source: string): boolean {
		return this.greeting.requestInterrupt(source);
	}

	/** Start STT when session becomes ACTIVE (agent ready). Fire-and-forget. */
	private startSttProvider(): void {
		if (!this.sttProvider) return;
		this.sttProvider.start().catch((err) => this.reportError('stt', err));
	}

	private handleTurnComplete(serverTurnId?: number): void {
		// Correlate the completion to its Turn. `stale` → a long-gone turn,
		// ignore; `new` → a turn that produced no model output, birth it.
		const r = this.turns.resolve(serverTurnId, 'completion');
		if (r.kind === 'stale') {
			this.log(
				`[Watchdog] Ignored stale turnComplete (serverTurnId=${serverTurnId}); watchdog NOT disarmed`,
			);
			return;
		}
		const turn = r.kind === 'new' ? this.turns.ensureCurrent(serverTurnId) : r.turn;
		// Drop a trailing / superseded completion before touching any gate state.
		if (!turn || turn.isFinalized || turn !== this.turns.current) {
			this.log(
				`[Watchdog] Ignored turnComplete for already-finalized/superseded turn (serverTurnId=${serverTurnId}); watchdog NOT disarmed`,
			);
			return;
		}

		this.reconnector.disarmResponseWatchdog();
		// A completed turn means the connection is healthy — reset reconnect counter
		this.reconnector.resetAttempts();

		// TTS turn gating: when TTS is active, defer turn completion until TTS finishes
		const ttsGate = this.ttsPipeline?.gate;
		if (ttsGate) {
			ttsGate.markLlmTextDone();
			if (!ttsGate.hasTurnText) {
				// Tool-call-only turn — no text synthesized, TTS won't fire onDone
				ttsGate.markNoTextTurnAudioDone();
			} else {
				// Hard cap (60s) prevents a stuck turn. onClearDefer resets the
				// session-owned playback-defer flag (not owned by the gate).
				ttsGate.armHardCapIfNeeded(() => {
					this.completionArbiter.clearDefer();
				});
			}
			ttsGate.maybeComplete();
			return; // Defer — actual turn-end runs via gate.maybeComplete → finalizeTurn
		}

		// Native playback-end gate: when this terminal response produced audio
		// and dispatched no tool call, defer finalization until the client
		// reports playback end (playback.ended) or the fallback timer fires.
		// See dev_docs/framework/design-playback-end-gating-openai-native.md.
		if (
			this.nativePlaybackGatingActive &&
			this.nativeGate?.hasAudio &&
			!this._nativeResponseDispatchedToolCall
		) {
			// Arm the gate fully BEFORE sendJsonAfterAudio so a sender that
			// synchronously echoes audio.done back as playback.ended meets an
			// armed gate rather than a premature-rejected signal. The gate's
			// fallback timer is id-guarded internally.
			const armedId = this.nativeGate.arm(turn, () =>
				this.completionArbiter.finishOrDeferForVad('fallback'),
			);
			this.clientTransport.sendJsonAfterAudio?.({ type: 'audio.done', playbackId: armedId });
			return; // Defer — completion runs via playback.ended / the fallback.
		}

		this.finalizeTurn(turn, { interrupted: false });
	}

	/**
	 * The single idempotent turn-finalization transition — replaces the former
	 * handleTurnCompleteInternal() and handleInterrupted() bodies. Idempotency
	 * is structural: Turn.finalize() runs the side effects only for the first
	 * caller; every later signal resolving to the same Turn is a no-op.
	 *
	 * See dev_docs/framework/design-turn-lifecycle-refactor.md § Idempotent finalization.
	 */
	private finalizeTurn(turn: Turn | null, opts: { interrupted: boolean }): void {
		if (!turn) return;
		if (!turn.finalize()) return; // not the first caller — structural no-op
		// The turn is no longer speaking — close the barge-in eligibility window.
		// (Trailing-audio suppression after an interrupt is the transport's job,
		// via cancelResponse — see handleClientTtsBargeIn.)
		this._assistantAudioStartedAtMs = null;

		// Throw-safety: a throw in one effect must not strand the rest, or the
		// turn would be terminal with a half-published boundary.
		const safeStep = (name: string, fn: () => void): void => {
			try {
				fn();
			} catch (e) {
				this.log(`finalizeTurn: ${name} failed: ${(e as Error).message}`);
				this.reportError('finalizeTurn', e as Error);
			}
		};

		// Native playback-end gate teardown — runs on both the clean and the
		// interrupted path. gate.clear() bumps the playback id so a late
		// playback.ended / fallback for this turn cannot match a later one; the
		// shared playback-defer flag is reset alongside.
		if (this.nativePlaybackGatingActive) {
			this.nativeGate?.clear();
			this.completionArbiter.clearDefer();
		}

		if (opts.interrupted) {
			this.log('Interrupted by user');
			const estEnd = this.ttsPipeline?.gate.estimatedPlaybackEndMs ?? null;
			if (estEnd !== null && Date.now() > estEnd) {
				this.log('[Latency] barge-in finalized after the estimated playback end');
			}
			// Hazard-2 order: invalidate TTS gate state and bump the requestId
			// BEFORE ttsProvider.cancel() so a synchronous onDone cannot complete
			// the turn mid-interrupt.
			safeStep('stt.interrupt', () => this.sttProvider?.handleInterrupted());
			if (this.ttsPipeline) {
				this.ttsPipeline.gate.resetForInterrupt();
				this.completionArbiter.clearDefer();
				safeStep('tts.cancel', () => this.ttsPipeline?.provider.cancel());
			}
			// Order matters: reset_audio FIRST (clears the gate), then interrupted
			// (suppresses the next flush).
			safeStep('notif.reset_audio', () => this.notificationSink.resetAudio());
			safeStep('notif.interrupted', () => this.notificationSink.interrupted());
			// Flush BEFORE turn.interrupted — as the former handleInterrupted() did.
			safeStep('transcript.flush', () => this.transcriptManager.flush());
			safeStep('publish.interrupted', () => {
				this.eventBus.publish('turn.interrupted', {
					sessionId: this.config.sessionId,
					turnId: turn.id,
				});
				this.clientTransport.sendJsonToClient({ type: 'turn.interrupted' });
			});
		}

		// --- Completion effects (the former handleTurnCompleteInternal body) ---
		// ORDERING: STT commit + cleanup BEFORE turnId increment, so commit(turnId)
		// uses the turn being completed and stale-drop rejects prior-turn results.
		if (this.sttProvider) {
			if (!this._commitFiredForTurn) {
				safeStep('stt.commit', () => this.sttProvider?.commit(this.turns.numericId));
			}
			safeStep('stt.complete', () => this.sttProvider?.handleTurnComplete());
			this._commitFiredForTurn = false;
		}
		this._turnWasInterrupted = opts.interrupted;

		safeStep('transcript.flush', () => this.transcriptManager.flush());
		this.turns.advance();
		this.log(`Turn complete: ${turn.id}`);
		safeStep('publish.turn_end', () => {
			this.eventBus.publish('turn.end', {
				sessionId: this.config.sessionId,
				turnId: turn.id,
			});
			this.clientTransport.sendJsonToClient({ type: 'turn.end', turnId: turn.id });
		});

		// Turn-bound usage sources reset per turn; non-turn-bound (`no_turn:*`)
		// keep their session-scoped counter.
		this.turns.resetTurnScopedUsage();

		// Notify the active agent (the agent active at finalization, as today).
		const agent = this.agentRouter.activeAgent;
		if (agent.onTurnCompleted) {
			safeStep('agent.onTurnCompleted', () => {
				const transcript = this.conversationContext.items
					.slice(-5)
					.map((i) => `[${i.role}]: ${i.content}`)
					.join('\n');
				agent.onTurnCompleted?.(this.createAgentContext(agent.name), transcript);
			});
		}

		// Trigger memory extraction (every N turns) and refresh cache.
		if (this.memoryDistiller) {
			safeStep('memory.onTurnEnd', () => {
				this.memoryDistiller?.onTurnEnd();
				this.memoryCacheManager?.refresh();
			});
		}

		// Generation-triggering effect — only on a clean completion. An interrupt
		// must not issue a response.create into the provider's cancellation window.
		if (!opts.interrupted) {
			safeStep('reinforceDirectives', () => this.reinforceDirectives());
		}

		// notification.turn_complete from the effective turn boundary. On an
		// interrupted turn the prior notification.interrupted suppresses the flush.
		safeStep('notif.turn_complete', () => this.notificationSink.turnComplete());
	}

	/** Inject all active directives into the LLM's context to prevent behavioral drift. */
	private reinforceDirectives(): void {
		const text = this.directiveManager.getReinforcementText();
		if (!text) return;
		this.log(`Reinforcing directives: ${text.slice(0, 120)}...`);
		// turnComplete=false: append to context WITHOUT requesting a response.
		// A generation-triggering injection here makes the model answer its own
		// directive reminder, which completes another clean turn and re-fires this
		// reinforcement — an unbounded self-talk loop.
		this.transport.sendContent([{ role: 'user', text }], false);
	}

	private handleInterrupted(serverTurnId?: number): void {
		// Correlate the interrupt to its Turn. A `stale` interrupt for a
		// long-gone turn is ignored; `new` (no turn / interrupt before any model
		// output) births one via the no-turn net. The structural idempotency of
		// finalizeTurn replaces the old trailing-interrupt / dedup-set guards.
		const r = this.turns.resolve(serverTurnId, 'interrupt');
		if (r.kind === 'stale') {
			this.log(
				`[Watchdog] Ignored stale interrupted (serverTurnId=${serverTurnId}); watchdog NOT disarmed`,
			);
			return;
		}
		const turn = r.kind === 'new' ? this.turns.ensureCurrent(serverTurnId) : r.turn;
		if (!turn || turn.isFinalized || turn !== this.turns.current) {
			this.log(
				`[Watchdog] Ignored interrupted for already-finalized/superseded turn (serverTurnId=${serverTurnId}); watchdog NOT disarmed`,
			);
			return;
		}

		this.reconnector.disarmResponseWatchdog();
		this.finalizeTurn(turn, { interrupted: true });
	}

	/** Handle a message from an interactive subagent (question, progress update). */
	private handleSubagentMessage(toolCallId: string, msg: SubagentMessage): void {
		if (msg.type === 'result') return; // Results are delivered by ToolCallRouter

		if (msg.blocking) {
			this.interactionMode.activate(toolCallId);
		}

		const label = msg.type === 'question' ? 'SUBAGENT QUESTION' : 'SUBAGENT UPDATE';
		const priority = msg.blocking ? 'high' : 'normal';
		this.notificationSink.publish(label, msg.text, priority);
	}

	private handleGroundingMetadata(metadata: Record<string, unknown>): void {
		this.clientTransport.sendJsonToClient({ type: 'grounding', payload: metadata });
	}

	/** Thin delegator — kept for parity with the other transport-callback intercept
	 *  points. The immediate (unbudgeted) GoAway reconnect lives in
	 *  {@link TransportReconnector}. */
	private handleGoAway(timeLeft: string): void {
		this.reconnector.handleGoAway(timeLeft);
	}

	// --- Client transport handlers ---

	/**
	 * Thin entry/intercept point for inbound client→server JSON. Stays on
	 * VoiceSession because an example monkey-patches it (and external consumers
	 * may too); the actual dispatch lives in {@link ClientMessageRouter}.
	 */
	private handleJsonFromClient(message: Record<string, unknown>): void {
		this.clientMessageRouter.dispatch(message);
	}

	/**
	 * True when assistant audio is actively playing to the client and a user
	 * barge-in should be honoured.
	 *
	 * - TTS / native-gated transports (OpenAI, Qwen): the live playback gate is
	 *   `pending` — unchanged behaviour.
	 * - `bufferedUncancellableAudio` transports (Gemini native): `liveGate()` is
	 *   `null`. A barge-in is honoured once the turn has emitted audio past the
	 *   echo-skip window. Such a transport buffers the whole response client-side
	 *   and its provider VAD does not reliably interrupt the buffered tail, so
	 *   this gives the user a deterministic, client-driven barge-in; the trailing
	 *   audio is then stopped by `cancelResponse`.
	 *   See design-noncancellable-transport-barge-in.md.
	 */
	private isAssistantAudioActive(): boolean {
		const gate = this.liveGate();
		if (gate) return gate.pending === true; // TTS / native-gated — unchanged
		// No playback gate: a client-VAD barge-in is honoured only for transports
		// that declare buffered, uncancellable audio (Gemini). Other no-gate
		// transports (OpenAI/Qwen on mobile/phone) keep today's behaviour (none).
		if (this.transport.capabilities.bufferedUncancellableAudio !== true) return false;
		return (
			this._assistantAudioStartedAtMs !== null &&
			Date.now() - this._assistantAudioStartedAtMs >= NATIVE_BARGEIN_ECHO_SKIP_MS
		);
	}

	/**
	 * The live playback-completion gate for this session — the external-TTS gate
	 * when a `ttsProvider` is set, the native-audio gate when native playback-end
	 * gating is active, else `null`. A session is TTS *or* native, never both.
	 * See dev_docs/framework/design-playback-end-gating-openai-native.md §6.
	 */
	private liveGate(): PlaybackGate | null {
		if (this.ttsPipeline) {
			return this.ttsPipeline.gate;
		}
		if (this.nativePlaybackGatingActive) {
			return this.nativeGate ?? null;
		}
		return null;
	}

	/** Single-flight FIFO for direct-input bodies. Each enqueued body runs
	 *  to completion before the next begins, even across `handleTextInput` /
	 *  `injectTranscript` / `injectDictationBuffer` interleaving.
	 *  See dev_docs/framework/design-greeting-interrupt-grace.md §7.5. */
	private enqueueDirectInput(work: () => Promise<void>): Promise<void> {
		// `.then(work, work)` lets the chain continue even if a prior body
		// rejected. We then catch on the chain itself so a rejection does not
		// poison subsequent enqueues, while still returning the original
		// promise to the caller so they can `await` and observe failures.
		const next = this._directInputChain.then(work, work);
		this._directInputChain = next.catch(() => {});
		return next;
	}

	/** Cancel any in-flight response on the wire (framework-owned mode) AND
	 *  finalize the framework-side active turn as interrupted, before a new
	 *  direct-input body sends `sendContent`. When the transport implements
	 *  `cancelResponse`, awaits the trailing `response.done(cancelled)` so the
	 *  next `response.create` does not race the cancel. Returns when both
	 *  steps complete.
	 *  See dev_docs/framework/design-greeting-interrupt-grace.md §7.5. */
	private async preEmptForDirectInput(): Promise<void> {
		const turn = this.turns.current;
		// Always await the cancel: when no response is in flight, cancelResponse
		// returns Promise.resolve() (true no-op). When in flight, the
		// {waitForDone:true} promise races a 2000 ms timeout so we never hang.
		await this.transport.cancelResponse?.({ waitForDone: true });
		if (turn && !turn.isFinalized) {
			this.finalizeTurn(turn, { interrupted: true });
		} else if (this.nativeGate?.pending) {
			// Native playback-tail interruption — pre-existing behaviour.
			this.finalizeTurn(this.nativeGate.capturedTurn, { interrupted: true });
		}
	}

	private handleTextInput(text: string): Promise<void> {
		if (!this.sessionManager.isActive || !text.trim()) return Promise.resolve();
		const trimmed = text.trim();
		return this.enqueueDirectInput(async () => {
			await this.preEmptForDirectInput();

			// Relay to interactive subagent if one is waiting for input.
			// Use trySendToSubagent for race safety — a UI button response may
			// have already resolved the waiting ask_user.
			const activeId = this.interactionMode.getActiveToolCallId();
			if (activeId) {
				const session = this.agentRouter.getSubagentSession(activeId);
				if (session?.trySendToSubagent(trimmed)) {
					this.interactionMode.deactivate(activeId);
				}
			}

			// Always send to main LLM so it stays informed of user messages
			this.transport.sendContent([{ role: 'user', text: trimmed }], true);
			this.conversationContext.addUserMessage(trimmed);
		});
	}

	private handleClientConnected(): void {
		this.log(`Client connected (geminiActive=${this.sessionManager.isActive})`);
		this.clientConnected = true;
		// Greeting interrupt grace: a fresh browser tab / RTC audio context
		// typically means a cold AEC. Reset the window so the next first
		// audio chunk re-arms cleanly. Leaving any prior session's grace
		// active would suppress new-client mic frames before its own first
		// audio chunk armed — leaking the prior session's grace into a
		// different audio context.
		// See dev_docs/framework/design-greeting-interrupt-grace.md §6.
		this.greeting.resetForClientConnected();
		const transportInfo = describeClientTransport(this.config.clientMedia);

		// Send audio format config so the client can negotiate correct sample rates
		this.clientTransport.sendJsonToClient({
			type: 'session.config',
			audioFormat: this.transport.audioFormat,
			clientMedia: transportInfo.clientMedia,
			clientSignalSource: transportInfo.clientSignalSource,
			clientAudioSource: transportInfo.clientAudioSource,
		});

		if (this.ownsClientTransport) {
			this.clientTransport.sendJsonToClient({
				type: 'session.ready',
				userId: this.config.userId,
				sessionId: this.config.sessionId,
				agentProfile: this.agentRouter.activeAgent.name,
				clientMedia: transportInfo.clientMedia,
				clientSignalSource: transportInfo.clientSignalSource,
				clientAudioSource: transportInfo.clientAudioSource,
			});
		}

		this.behaviorManager?.sendCatalog();
		if (this.sessionManager.isActive) {
			this._memoryReadyPromise.then(() => this.greeting.sendGreeting());
		}
	}

	private handleClientDisconnected(): void {
		this.log('Client disconnected');
		this.clientConnected = false;
	}

	/** Feed client audio into the session (LLM + STT). Used when the server owns the socket (multi-user). */
	feedAudioFromClient(data: Buffer): void {
		// R7c input-side freshness tee: while RECONNECTING the router drops input
		// at the isSessionActive() gate, so the speech-energy verdict for the
		// reconnect window must be captured here, before the drop.
		if (this.utteranceRetainer && this.sessionManager.state === 'RECONNECTING') {
			this._reconnectWindowFrames++;
			if (!this._reconnectWindowSpeech && pcmChunksContainSpeech([data])) {
				this._reconnectWindowSpeech = true;
			}
		}
		this.audioRouter.handleFromClient(data, 'websocket');
	}

	/** R7c hosted reconnect-window verdict (consulted by the recovery controller
	 *  when the channel drain returned no inbound chunks). Local `ClientTransport`
	 *  sessions buffer inbound mic at the WS layer — there the drain is the
	 *  authoritative signal and an empty drain proves the client sent nothing. */
	private reconnectWindowSpeechVerdict(): 'none' | 'hosted-speech' | 'unknown' {
		if (this.clientTransport instanceof ClientTransport) return 'none';
		if (this._reconnectWindowSpeech) return 'hosted-speech';
		// Hosted clients stream continuously (silence included): zero frames in
		// the window means the forwarding path itself went quiet — unsafe to
		// conclude the user stayed silent.
		return this._reconnectWindowFrames > 0 ? 'none' : 'unknown';
	}

	/** Feed client JSON (text_input, file_upload, etc.) into the session. Used when the server owns the socket. */
	feedJsonFromClient(message: Record<string, unknown>): void {
		this.handleJsonFromClient(message);
	}

	/** Notify the session that the client connected. Used when the server owns the socket (multi-user). */
	notifyClientConnected(): void {
		this.handleClientConnected();
	}

	/** Notify the session that the client disconnected. Used when the server owns the socket (multi-user). */
	notifyClientDisconnected(): void {
		this.handleClientDisconnected();
	}

	/** Session ID for logging and multi-user association. */
	getSessionId(): string {
		return this.config.sessionId;
	}

	// --- Error handling ---

	private handleTransportError(error: Error | LLMTransportError): void {
		const err = error instanceof Error ? error : error.error;
		this.log(`Transport error: ${err.message}`);
		this.reportError('llm-transport', err);
	}

	/** Thin delegator — a test invokes this private method directly. The reconnect
	 *  logic lives in {@link TransportReconnector}. */
	private handleTransportClose(code?: number, reason?: string): void {
		this.reconnector.handleTransportClose(code, reason);
	}

	private reportError(component: string, error: unknown): void {
		const err = error instanceof Error ? error : new Error(String(error));
		if (this.hooks.onError) {
			this.hooks.onError({
				sessionId: this.config.sessionId,
				component,
				error: err,
				severity: 'error',
			});
		}
	}

	/** Compact diagnostic log: HH:MM:SS.mmm [VoiceSession] message */
	private log(msg: string): void {
		const t = new Date().toISOString().slice(11, 23);
		console.log(`${t} [VoiceSession] ${msg}`);
	}

	// ───────────────────────────────────────────────────────────────────────
	// Phase 3: transcription mode + dictation buffer + cross-provider quiesce
	// See design-openai-realtime-transport-v2.md §3.
	// ───────────────────────────────────────────────────────────────────────

	/** Public stable mode. Transient `starting_*` / `stopping_*` states are
	 *  collapsed to the closest stable mode so callers never observe them. */
	getTranscriptionMode(): TranscriptionMode {
		switch (this.dictation.mode) {
			case 'agent':
			case 'stopping_transcription':
				return 'agent';
			case 'starting_transcription':
			case 'transcription':
				return 'transcription';
		}
	}

	/** Snapshot of dictated text since the last clear, joined with spaces.
	 *  Useful for built-in tools (e.g. `inject_dictation_as_user_message`)
	 *  and for ops surfaces that want to preview the buffer. */
	getDictationBuffer(): string {
		return this.dictation.getDictationBuffer();
	}

	/** Discard buffered dictation without injecting it. */
	clearDictationBuffer(): void {
		this.dictation.clearDictationBuffer();
	}

	/** Inject the dictation buffer as a user message into the agent's
	 *  conversation, then clear it. No-ops if the buffer is empty or the
	 *  current mode is not `'agent'`. Mirrors the existing text-input path:
	 *  writes to the transport AND records the user turn in
	 *  ConversationContext (so history/memory/subagent context see it). */
	injectDictationBuffer(): Promise<void> {
		const text = this.dictation.takeDictationBufferForInjection();
		if (!text) return Promise.resolve();
		return this.injectTranscript(text);
	}

	/** Send an arbitrary JSON message to the connected client over the
	 *  client transport (WebSocket / RTC data channel). Used by apps that
	 *  want to surface custom progress or UI state — e.g. an example pushing
	 *  Whisper transcript fragments to a web UI during transcription mode.
	 *
	 *  Safe to call any time after `start()`; no-op when no client is connected. */
	sendJsonToClient(message: Record<string, unknown>): void {
		this.clientTransport.sendJsonToClient(message);
	}

	/** Lower-level: inject an arbitrary user message. Serialized via the
	 *  shared direct-input FIFO so back-to-back calls don't race the
	 *  cancel-then-create sequence. */
	injectTranscript(text: string): Promise<void> {
		if (!text) return Promise.resolve();
		return this.enqueueDirectInput(async () => {
			await this.preEmptForDirectInput();
			this.transport.sendContent([{ role: 'user', text }], /* turnComplete */ true);
			// Mirror the existing text-input path: persist into ConversationContext
			// so the user turn shows up in history / memory / subagent context.
			this.conversationContext.addUserMessage(text);
		});
	}

	/** Pre-start the whisper session without flipping audio routing. Useful
	 *  for masking the ~150–500 ms whisper-start latency on the first flip. */
	async prewarmTranscriptionMode(): Promise<void> {
		await this.dictation.prewarmTranscriptionMode();
	}

	/** Switch between `'agent'` and `'transcription'`. Idempotent. Serialised
	 *  with `transferSession()` via the SessionMutationQueue — concurrent
	 *  callers queue rather than race. The mode-flip mechanics live in the
	 *  DictationController; the serialization stays here. */
	async setTranscriptionMode(mode: TranscriptionMode): Promise<void> {
		return this.mutationQueue.enqueue(async () => {
			if (mode === this.getTranscriptionMode()) return;
			if (mode === 'transcription') {
				if (!this.dictation.whisper) {
					throw new Error('setTranscriptionMode: no whisperProvider configured on VoiceSession');
				}
				await this.dictation.enterTranscriptionMode();
			} else {
				await this.dictation.exitTranscriptionMode();
			}
		});
	}

	/** Defensive wrapper around triggerGeneration. Throws if invoked while
	 *  not in agent mode — surfaces preset bugs loudly in tests rather than
	 *  silently leaking audio into a dictation flow. */
	guardedTriggerGeneration(
		instructions?: string,
		overrides?: Parameters<LLMTransport['triggerGeneration']>[1],
	): void {
		if (!this.dictation.isAgentMode()) {
			throw new Error(
				`TRANSCRIPTION_MODE_LOCKED: triggerGeneration is blocked while transcription mode is '${this.dictation.mode}'`,
			);
		}
		this.transport.triggerGeneration(instructions, overrides);
	}
}
