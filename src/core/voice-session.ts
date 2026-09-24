import type { LanguageModelV1 } from 'ai';
import { resolveAgentWithKnowledgeBase } from '../agent/agent-context.js';
import { AgentRouter } from '../agent/agent-router.js';
import type { BackgroundAgent } from '../agent/background-agent.js';
import { PersistentSubagentManager } from '../agent/persistent-subagent-manager.js';
import type { SubagentMessage } from '../agent/subagent-session.js';
import { BehaviorManager } from '../behaviors/behavior-manager.js';
import { MemoryDistiller } from '../memory/memory-distiller.js';
import { getDefaultPostSessionPipeline } from '../post-session/default-pipeline.js';
import type {
	PostSessionPipeline,
	PostSessionSnapshot,
	PostSessionStores,
} from '../post-session/types.js';
import type { ToolRoutingInfo } from '../runtime/actors/tool-router-actor.js';
import { GeminiTransportAdapter } from '../runtime/adapters/gemini-transport-adapter.js';
import type { KnownNotificationLabel } from '../runtime/messages.js';
import { RuntimeOrchestrator } from '../runtime/runtime-orchestrator.js';
import { decodeMulawToPcm } from '../telephony/audio-codec.js';
import { ToolExecutor } from '../tools/tool-executor.js';
import { createClientChannel } from '../transport/client-channel-factory.js';
import { ClientTransport } from '../transport/client-transport.js';
import { DirectRtcClientChannel } from '../transport/direct-rtc-client-channel.js';
import { EchoGuard, type EchoGuardConfig } from '../transport/echo-guard.js';
import {
	DEFAULT_GEMINI_LIVE_MODEL,
	type GeminiCompressionConfig,
	GeminiLiveTransport,
	type GeminiMediaResolution,
	type GeminiRealtimeInputConfig,
	type GeminiVadConfig,
	resolveGeminiRealtimeInputConfig,
} from '../transport/gemini-live-transport.js';
import type { MainAgent, SubagentConfig } from '../types/agent.js';
import type { BehaviorCategory } from '../types/behavior.js';
import {
	type ClientMediaProfile,
	DEFAULT_CLIENT_MEDIA_PROFILE,
	describeClientTransport,
} from '../types/client-media.js';
import { MIN_PLAYBACK_RATE } from '../types/client-protocol.js';
import type { AnyServerToClientMessage, HostClientFrame } from '../types/client-protocol.js';
import type { ConversationItem } from '../types/conversation.js';
import type { ConversationHistoryStore, SessionAnalytics } from '../types/history.js';
import type { FrameworkHooks } from '../types/hooks.js';
import type { ProcessedKnowledgeBase } from '../types/knowledge-base.js';
import type { MemoryStore } from '../types/memory.js';
import type { ClientSocketHealth, IClientChannel } from '../types/session-client.js';
import type { SessionClientSender } from '../types/session-client.js';
import type {
	AssistantOutputInterceptor,
	AudioInputObserver,
	AudioOutputObserver,
} from '../types/session-seams.js';
import type { SessionEndReason } from '../types/session.js';
import type { ToolDefinition } from '../types/tool.js';
import type {
	ConnectionLifecycleEvent,
	ContentTurn,
	LLMTransport,
	LLMTransportError,
	STTProvider,
	TransportUsageMetadata,
	UpstreamCounters,
} from '../types/transport.js';
import type { TTSProvider } from '../types/tts.js';
import type { ArtifactRef, ArtifactStore, SaveArtifactParams } from '../types/workspace.js';
import { AudioRouter } from './audio-router.js';
import { BackgroundNotificationQueue } from './background-notification-queue.js';
import { ClientMessageRouter } from './client-message-router.js';
import { ClientVadDetector, pcmChunksContainSpeech } from './client-vad-detector.js';
import type { VadTerminalDescriptor } from './client-vad-semantics.js';
import {
	DEFAULT_RECONNECT_DEADLINE_MS,
	DEFAULT_REPLAY_MAX_AGE_MS,
	DEFAULT_RESPONSE_WATCHDOG_MS,
} from './constants.js';
import { ConversationContext } from './conversation-context.js';
import { ConversationHistoryWriter } from './conversation-history-writer.js';
import { DictationController } from './dictation-controller.js';
import { DirectiveManager } from './directive-manager.js';
import { SessionError, ValidationError } from './errors.js';
import { EventBus } from './event-bus.js';
import { GreetingController } from './greeting-controller.js';
import { HooksManager } from './hooks.js';
import {
	DialGenerationFence,
	HostRecoveryController,
	type RecoverUpstreamArgs,
	type RecoverUpstreamResult,
	type RecoveryCapabilities,
	SyntheticOutputHold,
} from './host-recovery.js';
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
import { decideBargeIn } from './policies/barge-in.policy.js';
import { decideFinalizationPath } from './policies/finalization.policy.js';
import { decideRetention } from './policies/retention.policy.js';
import { decideWatchdogArm } from './policies/watchdog-arm.policy.js';
import { ResponseTriggerCoordinator } from './response-trigger-coordinator.js';
import { SessionManager } from './session-manager.js';
import { ShadowSttController } from './shadow-stt-controller.js';
import { ToolCallRouter } from './tool-call-router.js';
import { TranscriptManager } from './transcript-manager.js';
import { TransportReconnector } from './transport-reconnector.js';
import { TtsPipeline } from './tts-pipeline.js';
import { TurnLatencyTracker } from './turn-latency-tracker.js';
import { TurnManager } from './turn-manager.js';
import type { Turn } from './turn.js';
import { computeCacheHitRatio, deriveProviderItemId, deriveUsageSource } from './usage-helpers.js';
import { UserTurnEvidenceLedger } from './user-turn-evidence.js';
import type { SegmentEvidence } from './user-turn-evidence.js';

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
 *  Exported for tests; consumers should not depend on this directly. */
export function clampGraceMs(raw: number | undefined): number | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 0;
	if (raw > GRACE_MAX_MS) return GRACE_MAX_MS;
	return raw;
}

/** Shape returned by {@link VoiceSession.getDiagnostics}. */
export interface VoiceSessionDiagnostics {
	/** Upstream send counters of the current transport generation; `null` on a
	 *  transport that does not report diagnostics. */
	upstream: UpstreamCounters | null;
	/** Increments on each connection that completes setup; `null` on a
	 *  transport that does not report diagnostics. */
	transportGeneration: number | null;
	/** Client audio frames suppressed as echo, monotonic per session; 0 when no
	 *  echo suppression is active. */
	echoSuppressed: number;
}

/** Options for {@link VoiceSession.injectText}. */
export interface InjectTextOptions {
	/**
	 * `'live'`: realtime input the model responds to, as if the user had just
	 * said it (`transport.sendLiveText`, or `sendContent(turns, true)` on a
	 * transport without it).
	 *
	 * `'quiet'`: context added to the conversation without completing the
	 * turn (`sendContent(turns, false)`), so it prompts no response by itself.
	 *
	 * Neither mode records the text in the session's `ConversationContext`.
	 */
	mode: 'live' | 'quiet';
}

/** Options of the internal injection path. The public `injectText` passes only
 *  `mode`; the rest serve framework-generated corrections. */
interface InjectTextInternalOptions extends InjectTextOptions {
	/** Serialize on the direct-input FIFO and, at its head, cancel the in-flight
	 *  response and finalize its turn as interrupted before sending (the
	 *  `injectTranscript` preemption). */
	preempt?: boolean;
	/** Refuse to send while the synthetic-output hold is active, checked before
	 *  any preemption. Host content leaves this unset and bypasses the hold. */
	respectSyntheticHold?: boolean;
	/** Evaluated once: at the head of the direct-input FIFO before preemption
	 *  when `preempt` is set, otherwise immediately before sending. `false`
	 *  abandons the injection. */
	stillValid?: () => boolean;
	/** Label for log lines. */
	origin?: string;
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
	 * Host hooks between the provider's native assistant output and the
	 * session: screen or hold transcript chunks, drop audio chunks, and
	 * release held text before each transcript flush. See
	 * {@link AssistantOutputInterceptor}. Only native audio output passes
	 * through `transcript` and `audio`; text-mode and external-TTS output
	 * bypass them.
	 */
	outputInterceptor?: AssistantOutputInterceptor;
	/** Connection-lifecycle facts: attempt / setup-ok / setup-failed /
	 *  attempt-close / generation-close, correlated by `connectAttemptId`.
	 *  `handleSupplied` on the attempt is what lets a consumer track resumed
	 *  lineages without inferring them from log lines. Fires only on transports
	 *  that report lifecycle (the Gemini Live transport); on a transport that
	 *  declares neither this nor `onUsageMetadata`, a warning is logged at
	 *  construction. */
	onConnectionLifecycle?: (event: ConnectionLifecycleEvent) => void;
	/** Server-reported token accounting, the provider's raw payload, once per
	 *  message that carries it. `promptTokenCount` is the standing prompt size —
	 *  the signal for context growth. Fires alongside (not instead of) the
	 *  normalized `hooks.onRealtimeLLMUsage` / `realtime.usage`, and only on
	 *  transports that report it (the Gemini Live transport). */
	onUsageMetadata?: (usage: TransportUsageMetadata) => void;
	/** Optional diagnostic logger. Defaults to console.log. */
	log?: (message: string) => void;
	/**
	 * Injectable time source (milliseconds) for all metric/latency duration math.
	 * Defaults to `Date.now`. Shared with `ClientVadDetector` so session-side and
	 * VAD-side timestamps come from one clock (never subtract across clocks). Tests
	 * inject a fake clock to make latency assertions deterministic.
	 */
	nowMs?: () => number;
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
	 * Client protocol frames the built-in handlers do not recognize, such as a
	 * host's own retry command. Built-in types always run first and are never
	 * forwarded; a malformed built-in is dropped with a log line and reaches
	 * neither this hook nor `onClientJson`. Fires after `onClientJson` when both
	 * are set. Frames that arrive before the attach bootstrap has sent
	 * `session.config` are queued (up to 64) and dispatched after it. A throw
	 * from this hook or `onClientJson` is reported through `hooks.onError` and
	 * does not stop the other hook, the remaining queued frames or the attach.
	 */
	onClientCommand?: (message: Record<string, unknown>) => void;
	/**
	 * A real client attached: a connection on the local client WebSocket server
	 * (never a probe or verifier), or `notifyClientConnected()` with a host-owned
	 * channel. Runs synchronously once `clientConnected` is `true` and before the
	 * behavior catalog, `session.config` and any greeting, so the host can resend
	 * durable state first. A throw is reported through `hooks.onError` and does
	 * not stop the attach.
	 */
	onClientConnected?: () => void;
	/**
	 * The real client detached. Runs at the end of the detach handling, once
	 * `clientConnected` is `false`. A throw is reported through `hooks.onError`.
	 */
	onClientDisconnected?: () => void;
	/**
	 * Host gate for the automatic actions of a client attach, read once per
	 * attach after the behavior catalog and `session.config` are sent (and when
	 * the first setup completes with a client already attached). While it
	 * returns `true` the client is configured but nothing else happens: no
	 * greeting, no context replay, and no redial of a session parked in
	 * `UPSTREAM_LOST`. Under `upstreamLossPolicy: 'hold'` the reconnector reads
	 * it too: while it returns `true` the host owns recovery, so a lost provider
	 * connection parks the session at once instead of reconnecting on its own.
	 * Both reads log a throw from the gate and treat it as `false`.
	 */
	suppressClientAutoActions?: () => boolean;
	/**
	 * Greeting policy for a client that attaches to an ACTIVE session.
	 * - `'per-client'` (default): each newly attached client is greeted once.
	 * - `'until-first-turn'`: a client is greeted only while no turn has
	 *   completed; a client that attaches later is not greeted (see
	 *   `reattachContextReplay`).
	 */
	reattachGreeting?: 'per-client' | 'until-first-turn';
	/**
	 * With `reattachGreeting: 'until-first-turn'`, a client that attaches to an
	 * ACTIVE session after a completed turn gets the last ten user and assistant
	 * messages (150 characters each) injected as quiet context, which requests
	 * no response. Suppressed while synthetic output is held. Default `false`.
	 */
	reattachContextReplay?: boolean;
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
	/** Supplies the JSON state frame sent to `?probe=1` health-probe connections
	 *  on the local client WebSocket server. When absent, probes are upgraded and
	 *  closed (code 1000) without a frame. Probe sockets never attach as the
	 *  client and never run connect/disconnect handling. Local server only: with
	 *  `clientSender` the host owns the socket and must implement probes itself. */
	probeState?: () => object;
	/** A verification-role (`?verify=1`) connection attached to the local client
	 *  WebSocket server. Narrow hook for embedders (e.g. to wake the upstream);
	 *  real-client connect handling (greeting, `session.config`, attachment
	 *  accounting) never runs for it. Local server only. */
	onVerifierConnected?: () => void;
	/** The verification-role connection detached (clean close or preemption by
	 *  an arriving real client). Local server only. */
	onVerifierDisconnected?: () => void;
	/** Model-silence watchdog (ms) after the user's turn ends. If the model emits
	 *  nothing for this long, force a reconnect. Default 5000; `<= 0` disables. */
	responseWatchdogMs?: number;
	/** Watchdog-stall recovery via retained-utterance replay. When true,
	 *  the last routed user utterance is retained (bounded, memory-only) and a
	 *  response-watchdog stall replays it — in-place first, then once more after
	 *  a reconnect. Default false (ships dark until live-validated). */
	watchdogReplayRecovery?: boolean;
	/** @internal Rollback flag for H2 drain normalization (design G5).
	 *  Default `true`: admitted drained inbound frames are transformed
	 *  through the same resample/µ-law path as live agent audio — an
	 *  approved byte change on non-PCM/rate-mismatched transports. `false`
	 *  restores the legacy raw base64 send (rollback); gate-aware discard
	 *  semantics are unaffected by this flag. */
	normalizeDrainedInboundAudio?: boolean;
	/** LLM model name (e.g. "gemini-3.1-flash-live-preview"). */
	geminiModel?: string;
	/** Vercel AI SDK model for subagent text generation. */
	model: LanguageModelV1;
	/** Voice configuration for Gemini's speech output. */
	speechConfig?: { voiceName?: string };
	/** Context-window compression (Gemini only). Thresholds are in tokens; an
	 *  unset one is omitted so the server default applies (trigger at 80% of the
	 *  model limit, target half of it), and `{}` enables compression with both
	 *  defaults. */
	compressionConfig?: GeminiCompressionConfig;
	/** Enable server-side transcription of user audio input (default: true).
	 *  Has no effect when sttProvider is set (built-in is disabled automatically).
	 *  Use false to disable all input transcription for privacy or cost control. */
	inputAudioTranscription?: boolean;
	/**
	 * Gemini Live realtime input/VAD tuning. Applied only on the built-in
	 * Gemini transport path. When omitted (and `vadConfig` is not set), the
	 * framework applies `DEFAULT_GEMINI_REALTIME_INPUT_CONFIG`
	 * (END_SENSITIVITY_HIGH, silenceDurationMs=500). User-supplied fields
	 * deep-merge over the default at the `automaticActivityDetection` level.
	 * `false` opts out of the default: no `realtimeInputConfig` is sent at all,
	 * so the server's own VAD settings apply. Mutually exclusive with
	 * `vadConfig`. Has no effect when an external transport is injected via
	 * `config.transport` — that transport owns its own VAD config.
	 */
	realtimeInputConfig?: GeminiRealtimeInputConfig | false;
	/**
	 * Gemini automatic-VAD tuning, sent verbatim as
	 * `realtimeInputConfig.automaticActivityDetection` with no framework
	 * default merged in (built-in Gemini path only). Supplying it together with
	 * `realtimeInputConfig` (including `false`) throws a `ValidationError` at
	 * construction.
	 */
	vadConfig?: GeminiVadConfig;
	/** Session-wide media token cost for image/video input (Gemini only;
	 *  `MEDIA_RESOLUTION_LOW` = 64 tokens per frame). Applies to every
	 *  realtime-input image on the session; realtime input has no per-send
	 *  override. Omitted → server default. */
	mediaResolution?: GeminiMediaResolution;
	/** External STT provider for user input transcription.
	 *  When set, transport built-in transcription is automatically disabled.
	 *  When omitted, the transport's built-in transcription is used. */
	sttProvider?: STTProvider;
	/** Observation-only second transcription. Unlike `sttProvider` it does not
	 *  replace the transport's built-in transcription: the provider hears the
	 *  same client audio, its per-turn transcript is compared with what the
	 *  model itself heard, and a divergence is logged and reported through
	 *  `onTranscriptionDivergence`. What the model hears, answers and records is
	 *  unchanged (unless `divergenceCorrection` is on). A model mishearing is
	 *  otherwise invisible, since its transcript and its answer agree.
	 *
	 *  Ignored (with a log line) when `sttProvider` is set, since there is no
	 *  built-in transcription to compare against. Must be a distinct instance
	 *  from `whisperProvider`; sharing one throws a `ValidationError` at
	 *  construction. Receives no audio in transcription mode. */
	shadowSttProvider?: STTProvider;
	/** Called when the shadow transcription disagrees with the built-in one
	 *  (normalized comparison; a much shorter fragment of the other side counts
	 *  as streaming truncation, not a mishearing). `turnId` is the turn the
	 *  shadow result belongs to. */
	onTranscriptionDivergence?: (liveText: string, shadowText: string, turnId?: number) => void;
	/** With `shadowSttProvider` set, answer a meaningful divergence with a
	 *  spoken self-correction: the in-flight answer is interrupted and the
	 *  model is told what the user actually said. The shadow result arrives
	 *  after the answer has started, so the start of the wrong answer is still
	 *  heard. Only a result for the still-current turn corrects; a stale one,
	 *  transcription mode or the synthetic-output hold send nothing.
	 *  Default `false` (observation only). */
	divergenceCorrection?: boolean;
	/** Acoustic echo suppression at the audio-ingestion chokepoint: inbound
	 *  client audio whose energy envelope correlates with recently played
	 *  native model audio (speakerphone loopback) is dropped before the client
	 *  VAD, the model and STT hear it, which stops the model transcribing its
	 *  own voice as phantom user commands. OPT-IN: pass `{ enabled: true }` to
	 *  activate (double-talk on strong-echo paths can drop overlapped user
	 *  speech, a deliberate per-deployment choice); the environment variable
	 *  `BODHI_ECHO_GUARD=0` hard-disables it. The reference is the native
	 *  model audio only: `ttsProvider` output is not fed, and combining the
	 *  two logs a warning at construction. Suppressed frames are counted in
	 *  `getDiagnostics().echoSuppressed`. */
	echoGuard?: EchoGuardConfig;
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
	 *  participation additionally requires the client sender to support it. */
	playbackStateProtocol?: 'disabled' | 'audio_done';
	/** Rollout switch for native-audio playback-end gating (the OpenAI native
	 *  path). Default `false`. When `true`, and the session is on the native
	 *  audio path with a generation-gated transport and `playbackStateProtocol`
	 *  active, native turn completion is gated on playback end. */
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
	/** Resume: prior conversation turns to load into `ConversationContext` at `start()` and replay
	 *  into the transport's model. Supplied by the host (which owns fetch + authorization); the
	 *  full timeline for `attach`, or any subset for `copy`. See `historyResumeMode`. */
	initialHistory?: ConversationItem[];
	/** Resume persistence policy (default `'copy'`):
	 *  - `'copy'`: prior items are re-flushed into THIS session's record (checkpoint kept at 0);
	 *    the writer uses `createSession` (host typically supplies a fresh `sessionId`).
	 *  - `'attach'`: prior items are treated as already persisted (checkpoint advanced, not
	 *    re-flushed); the writer uses `ensureSession` + `reactivateSession` and appends only new
	 *    turns (host typically reuses the prior `sessionId`). Requires a store supporting
	 *    `ensureSession`. */
	historyResumeMode?: 'copy' | 'attach';
	/** Resume: prior aggregate analytics (the source `SessionRecord.analytics`) so the close report
	 *  reflects the full record (incl. `totalTokens`, which items cannot reconstruct). Optional. */
	initialAnalytics?: SessionAnalytics;
	/**
	 * Optional process-scoped post-session pipeline. When provided, the session
	 * registers a snapshot builder and `closeWithReason` dispatches the pipeline
	 * once on close. Absent → no post-session processing (unchanged behavior).
	 */
	postSessionPipeline?: PostSessionPipeline;
	/** Drain mode: await the post-session run before close() resolves (serverless hosts). */
	drainPostSession?: boolean;
	/** When provided, agents/tools can persist artifacts (images, docs, etc.) via session.workspace.saveArtifact(). */
	artifactStore?: ArtifactStore;
	/** External TTS provider for speech synthesis (actor-mode only).
	 *  When set, LLM is configured for text-mode responses.
	 *  When omitted, LLM-native audio generation is used (default).
	 *  Requires orchestrationMode: 'actor'. Ignored in legacy mode. */
	ttsProvider?: TTSProvider;
	/** Response modality. Default `'audio'` (LLM-native speech). Set to `'text'` to run the
	 *  model in TEXT mode WITHOUT a TTS provider — the assistant's text is surfaced via the
	 *  normal transcript events and no audio is produced. Used by text-only consumers (e.g.
	 *  the Agent Composer CLI). When `ttsProvider` is set, text mode is implied regardless of
	 *  this field. Requires a transport advertising `textResponseModality`. */
	responseModality?: 'audio' | 'text';
	/** Pre-constructed LLM transport. If provided, apiKey/geminiModel/speechConfig/compressionConfig/
	 *  mediaResolution/realtimeInputConfig/vadConfig are ignored. */
	transport?: LLMTransport;
	/** Orchestration engine for tool routing/subagent lifecycle (default: legacy). */
	orchestrationMode?: 'legacy' | 'actor';
	/**
	 * What happens when the provider connection is lost for good.
	 *
	 * - `'close'` (default): today's behavior. Once automatic reconnection is
	 *   exhausted (attempt budget spent, no resumption handle, or a failed or
	 *   timed-out attempt) the session closes with `reconnect_failed`, and a
	 *   failed first dial in `start()` closes it with `connect_failed`.
	 * - `'hold'`: the session parks in `UPSTREAM_LOST` instead. Nothing is
	 *   finalized (no `session.close`, no `onSessionEnd`, no post-session run),
	 *   the client listener stays up, and `session.upstreamLost` is published.
	 *   An external STT provider is stopped while parked, as during a
	 *   reconnect, and started again when a redial activates the session.
	 *   A failed first dial still rejects `start()` but leaves the session
	 *   parked; `close()` finalizes a parked session as usual. Only
	 *   `recoverUpstream()` redials a parked session, which a client attach
	 *   also calls unless `suppressClientAutoActions` returns `true`;
	 *   `parkUpstream()` parks it on purpose.
	 *
	 * `'hold'` also enables host recovery (`recoverUpstream()`,
	 * `parkUpstream()`, see `getRecoveryCapabilities()`), which `'close'`
	 * rejects with a `SessionError`. `'hold'` requires legacy orchestration:
	 * combining it with `orchestrationMode: 'actor'` throws a
	 * `ValidationError` at construction.
	 */
	upstreamLossPolicy?: 'close' | 'hold';
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
	 * legacy mode (the legacy queue has no equivalent host).
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
	 *  browser AEC; dropping caller audio would silence real speech). */
	greetingInterruptGraceMs?: number;
	/** When `false`, the greeting is uninterruptible end-to-end: from the
	 *  greeting send until the greeting turn finalizes (post-playback where
	 *  the playback protocol is active, else the fallback/estimate timer),
	 *  interrupts are suppressed and outbound mic frames are dropped — user
	 *  speech during the greeting is discarded, not queued. Works on every
	 *  transport (unlike the grace window it needs no `frameworkOwnsInterrupt`
	 *  or `cancelResponse`: withholding mic frames prevents server-side VAD
	 *  barge-in too). Independent of `greetingInterruptGraceMs`, which still
	 *  covers post-greeting AEC convergence. Default `true`. */
	greetingInterruptible?: boolean;
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
	/** Max wait for one reconnect attempt before giving up and closing the
	 *  session with `reconnect_failed`. Without this deadline, a reconnect whose
	 *  dial or setup never settles (an ECONNRESET on the in-flight WebSocket dial)
	 *  leaves the session in RECONNECTING forever. */
	static readonly RECONNECT_DEADLINE_MS = DEFAULT_RECONNECT_DEADLINE_MS;

	readonly eventBus: EventBus;
	readonly sessionManager: SessionManager;
	readonly conversationContext: ConversationContext;
	readonly hooks: HooksManager;
	/** Retained so `start()`/`close()` can await its resume start-phase and drain (see E5). */
	private historyWriter?: ConversationHistoryWriter;
	/** Resume: guards the one-time initial-connect model prefill (see handleSetupComplete). */
	private initialHistoryReplayed = false;
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
	/** The declared tool list: the active agent's tools plus the behavior
	 *  tools, as changed by `registerTools()` and `replaceTools()`. An agent
	 *  transfer resets it from the new agent. */
	private currentTools: ToolDefinition[] = [];
	/** Instructions set by the active agent definition or the last
	 *  `updateInstructions()`. An agent transfer resets it from the new agent. */
	private currentInstructions = '';
	/** Native assistant audio observers (`observeAudioOutput`). */
	private readonly audioOutputObservers = new Set<AudioOutputObserver>();
	/** Inbound client audio observers (`observeAudioInput`). */
	private readonly audioInputObservers = new Set<AudioInputObserver>();
	/** Resolved Gemini VAD config for the built-in transport path. Undefined when `config.transport` is
	 *  injected, with `realtimeInputConfig: false`, and with `vadConfig` (the transport sends that verbatim). */
	private resolvedRealtimeInputConfig?: GeminiRealtimeInputConfig;
	private behaviorManager?: BehaviorManager;
	private memoryDistiller?: MemoryDistiller;
	private memoryCacheManager?: MemoryCacheManager;
	/** Latest `processKnowledgeBase` result for the active main agent (prompt slice + optional search tool metadata). */
	private processedKnowledgeBase: ProcessedKnowledgeBase | null = null;
	/** Turn lifecycle — numeric counter, current/previous `Turn` pointers,
	 *  per-turn usage sequence, finalized-input-turn set. `finalizeTurn` stays
	 *  here but drives the counter through this unit. */
	private readonly turns = new TurnManager({
		getActiveAgentName: () => this.agentRouter.activeAgent.name,
		getActiveServerTurnId: () => this.transport.getActiveServerTurnId?.(),
	});
	private sttProvider?: STTProvider;
	/** Observation-only second transcription (`config.shadowSttProvider`).
	 *  Absent when unset or when `sttProvider` replaces built-in transcription. */
	private shadowStt?: ShadowSttController;
	/** Acoustic echo suppressor (`config.echoGuard`), fed the decoded native
	 *  model audio and consulted by the audio router. Absent when unset. */
	private echoGuard?: EchoGuard;
	/** Last routed user utterance for watchdog-stall recovery replay. Only
	 *  constructed when `config.watchdogReplayRecovery` is true (dark rollout). */
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
	/** Synthetic-output hold: the gate every framework-generated send (greeting,
	 *  directive reinforcement, guarded generation triggers, hold-respecting
	 *  injections, watchdog recovery) passes, released by fresh user evidence.
	 *  Nothing engages it outside a host recovery. See `host-recovery.ts`. */
	private hold!: SyntheticOutputHold;
	/** Drops tool results and external-STT captures that belong to a provider
	 *  connection a host recovery abandoned; inert until a recovery marks a
	 *  boundary. Wraps `transport.sendToolResult`. See `host-recovery.ts`. */
	private fence!: DialGenerationFence;
	/** Host-driven upstream recovery: `recoverUpstream`, `parkUpstream` and
	 *  the recovery boundary. See `host-recovery.ts`. */
	private hostRecovery!: HostRecoveryController;
	/** Per-session single-flight FIFO chaining direct-user-input bodies
	 *  (`handleTextInput`, `injectTranscript`, `injectDictationBuffer`). Each
	 *  body awaits `cancelResponse({ waitForDone: true })` then finalizes any
	 *  unfinalized active turn then sends the new content — and the next
	 *  enqueued body waits for the previous to fully finish. Prevents two
	 *  rapid inputs from both calling `response.create` and triggering
	 *  `conversation_already_has_active_response`. */
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
	/** Per-response latency stamps on the metric clock (`nowMs`), reset when a
	 *  model response begins. user-speech-end is read from the VAD at emit time.
	 *  Consumed by `emitTurnLatency` → `onTurnLatency`. */
	private _turnTiming: { modelStartMs: number | null; firstAudioMs: number | null } = {
		modelStartMs: null,
		firstAudioMs: null,
	};
	/** Metric-clock time of the last interrupt (yield), for re-entry latency;
	 *  cleared once the agent re-enters with audio. */
	private _lastInterruptAtMs: number | null = null;
	/** Origin of the NEXT model response, set explicitly at response-creating
	 *  call sites (text input, greeting, notifications, directives, re-elicit)
	 *  and consumed by the next `onModelTurnStart`. `null` → derived: a response
	 *  following a tool dispatch is `tool_continuation`, else `user_audio`.
	 *  Powers the `response.started.origin` latency-eligibility fact (§11). */
	private _pendingResponseOrigin: 'user_text' | 'assistant_initiated' | null = null;
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
	/** True when the model runs in TEXT mode (either via TTS, or the no-TTS text path). */
	private get isTextMode(): boolean {
		return this.ttsPipeline != null || this.config.responseModality === 'text';
	}
	/** True for the no-TTS text path: `responseModality: 'text'` with no TTS provider. */
	private get isNoTtsTextMode(): boolean {
		return this.config.responseModality === 'text' && this.ttsPipeline == null;
	}
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
	/** G5 drain-normalization flag (rollback = false → legacy raw bytes). */
	private readonly normalizeDrainedInbound: boolean;
	// --- Server-turn finalization dedup (external-TTS turn completion). ---
	private config: VoiceSessionConfig;
	/** Injectable ms clock for metric/latency math (default `Date.now`). */
	private readonly nowMs: () => number;
	/** §11 latency-fact correlator (bus subscriber with an async-edge ring). */
	private readonly turnLatencyTracker: TurnLatencyTracker;
	private directiveManager = new DirectiveManager();
	private transcriptManager!: TranscriptManager;
	/** Fallback-seal timers for user messages reserved while awaiting the
	 *  authoritative STT transcript, keyed by turn id. */
	private reservationTimers = new Map<number, ReturnType<typeof setTimeout>>();
	/** How long to wait for the authoritative transcript before sealing a
	 *  reserved user message with the transport's fallback text. Generous by
	 *  design: a batch STT round-trip is a whole-utterance model call. */
	private readonly reservationTimeoutMs = 20_000;
	/** Whether a real client is attached; read through the `clientConnected` getter. */
	private _clientConnected = false;
	/**
	 * Input admission follows the server bootstrap, not merely socket acceptance.
	 * A restored pacing preset must be sent before `session.config` opens the
	 * browser mic; this flag also protects server-owned clients that send early.
	 */
	private clientInputReady = true;
	/** Invalidates delayed memory/bootstrap callbacks across disconnect/reconnect. */
	private clientConnectionGeneration = 0;
	/** Prevents setup-complete and connect callbacks from greeting the same client twice. */
	private greetingClientGeneration = -1;
	/** JSON received after socket acceptance but before the restored behavior
	 * catalog/config bootstrap. Bounded to avoid an overeager client growing
	 * memory while provider setup is slow. */
	private pendingClientJson: Record<string, unknown>[] = [];
	private static readonly MAX_PENDING_CLIENT_JSON = 64;
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
	private memoryAndDirectivesReady = true;
	private externalAudioHandler: ((data: Buffer) => void) | null = null;
	/** Client-side energy-VAD segment tracker. Owns the `audioVad*` /
	 *  `lastClientSpeech*` state; barge-in policy stays here (see the
	 *  `onVoicedFrame` handler wired at construction). */
	private clientVadDetector!: ClientVadDetector;
	/** Inbound client-audio fast path (mode dispatch + transition buffer + μ-law
	 *  encode). Constructed after the VAD detector. */
	private audioRouter!: AudioRouter;
	/** Phase-1 evidence ledger (shadow mode — internal, no public surface).
	 *  Fed by the router (routed bits, frame-driven terminals) and by the
	 *  forced-terminal wrappers below; consumers are shadow-only until the
	 *  Phase-2 re-bind. */
	private readonly userTurnEvidence = new UserTurnEvidenceLedger();
	/** Count of model-turn starts (advisory epoch fact for SegmentEvidence). */
	private _responseEpoch = 0;
	/** Phase-3 trigger coordinator: competing framework triggers invalidate
	 *  the H1 greeting token synchronously before dispatch. */
	private readonly triggerCoordinator = new ResponseTriggerCoordinator({
		onCompetingTrigger: (cls) => this.greeting.invalidateForCompetingTrigger(cls),
	});
	/** Shadow-parity counters (observable, not log-scraped). With the Phase-2
	 *  re-bind, actuation IS the policy verdict, so expected/unexpected stay 0
	 *  by construction; `compared` keeps counting terminals for coverage
	 *  accounting. Exposed via the @internal accessor below. */
	private readonly _shadowCounters = { compared: 0, expected: 0, unexpected: 0 };
	/** Resolved client-VAD barge-in tuning (config + defaults). */
	private readonly clientVad: ResolvedClientAudioVadConfig;
	private lastGeminiRecognitionLoggedForSpeechEndMs = 0;
	private lastInputTranscriptionLogText = '';
	private ownsClientTransport: boolean;
	/** Margin (ms) added to the VAD-defer force-completion timeout. */
	/** Default and floor (ms) for the TTS fallback-completion margin — estimate
	 *  padding before the server force-completes a turn with no playback signal. */
	private static readonly TTS_PLAYBACK_FALLBACK_MARGIN_DEFAULT_MS = 1500;
	private static readonly TTS_PLAYBACK_FALLBACK_MARGIN_FLOOR_MS = 500;
	/** Slowest client `playbackRate` — the fallback estimate divides the
	 *  synthesized (1.0×) audio duration by this so slowed playback cannot
	 *  pre-empt a healthy client's `playback.ended`. Must track the web
	 *  client's rate map (`slow | normal | fast → 0.85 | 1.0 | 1.2`). */
	private static readonly MIN_PLAYBACK_RATE = MIN_PLAYBACK_RATE;

	constructor(config: VoiceSessionConfig) {
		// Parking a lost upstream is legacy-orchestration only: the actor runtime
		// runs its own retry loop, which must never contend with a held session.
		if (config.orchestrationMode === 'actor' && config.upstreamLossPolicy === 'hold') {
			throw new ValidationError(
				"VoiceSession: upstreamLossPolicy 'hold' requires legacy orchestration; " +
					"orchestrationMode 'actor' supports only 'close'.",
			);
		}
		// Checked before the dictation controller configures the whisper provider:
		// a shared instance would have its format and transcript callback taken
		// over by the shadow, and dictation would silently stop filling its buffer.
		if (config.shadowSttProvider && config.shadowSttProvider === config.whisperProvider) {
			throw new ValidationError(
				'VoiceSession: shadowSttProvider must be a distinct instance from whisperProvider. ' +
					'Sharing one instance lets the shadow take over the dictation transcript callback.',
			);
		}
		this.config = config;
		this.nowMs = config.nowMs ?? Date.now;
		this.ownsClientTransport = !config.clientSender;
		this.eventBus = new EventBus();
		this.hooks = new HooksManager();
		this.conversationContext = new ConversationContext();
		this.transcriptManager = new TranscriptManager(
			{
				sendToClient: (msg) => this.clientTransport.sendJsonToClient(msg),
				addUserMessage: (text) => this.conversationContext.addUserMessage(text),
				addAssistantMessage: (text) => this.conversationContext.addAssistantMessage(text),
				reserveUserMessage: (text) => this.conversationContext.reserveUserMessage(text),
				sealUserMessage: (id, text) => this.conversationContext.sealUserMessage(id, text),
			},
			{
				// An external STT provider is the authoritative transcript source;
				// the transport's own transcription is live display + fallback.
				expectsAuthoritativeInput: config.sttProvider !== undefined,
				currentTurnId: () => this.turns.numericId,
			},
		);

		// A user message was committed before its authoritative transcript arrived.
		// Arm the fallback seal so a failed/slow STT can never strand it unwritten.
		this.transcriptManager.onInputReserved = (turnId) => {
			const timer = setTimeout(() => {
				this.reservationTimers.delete(turnId);
				this.transcriptManager.sealPendingInput(turnId);
				this.log(`[Transcript] Reservation for turn ${turnId} sealed with fallback text`);
			}, this.reservationTimeoutMs);
			timer.unref?.();
			this.reservationTimers.set(turnId, timer);
		};

		// Relay finalized user speech to an interactive subagent when one is
		// waiting for input. The callback captures `this` via closure and is only
		// invoked at runtime (agentRouter is initialized before any transcript fires).
		this.transcriptManager.onInputFinalized = (text) => {
			this.turns.markInputFinalized();
			// Latency: user transcript finalized (S2T anchor). textLength only — never text.
			this.safeEmitHook('onTranscriptReady', () =>
				this.hooks.onTranscriptReady?.({
					sessionId: this.config.sessionId,
					turnId: this.turns.current?.id,
					atMs: this.nowMs(),
					textLength: text.length,
				}),
			);
			const activeId = this.interactionMode.getActiveToolCallId();
			if (activeId) {
				const session = this.agentRouter.getSubagentSession(activeId);
				if (session && session.state === 'waiting_for_input') {
					session.sendToSubagent(text);
					this.interactionMode.deactivate(activeId);
				}
			}
		};

		// The host's output interceptor releases held assistant text before each
		// flush commits the buffers. A throwing hook is reported and the flush
		// continues, so turn finalization and close still commit the buffers.
		const outputInterceptor = config.outputInterceptor;
		if (outputInterceptor?.beforeTranscriptFlush) {
			this.transcriptManager.onBeforeFlush = () => {
				try {
					outputInterceptor.beforeTranscriptFlush?.();
				} catch (e) {
					this.reportError('output-interceptor.beforeTranscriptFlush', e);
				}
			};
		}

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
					this.triggerCoordinator.dispatch('notification');
					this._pendingResponseOrigin = 'assistant_initiated';
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
		// The hold drives notification delivery through the sink: legacy only,
		// since the actor sink refuses to hold.
		this.hold = new SyntheticOutputHold({
			setNotificationsHeld: (held) => this.notificationSink.setHeld(held),
			drainNotifications: () => this.drainNotificationsWhenIdle(),
			log: (msg) => this.log(msg),
		});

		if (config.hooks) {
			this.hooks.register(config.hooks);
		}

		// Correlates the raw latency facts published on the bus into per-turn
		// segments (observability design §11). Pure subscriber — its only
		// coupling to this session is the bus topics + the hook emitters.
		this.turnLatencyTracker = new TurnLatencyTracker({
			sessionId: config.sessionId,
			bus: this.eventBus,
			emitLatency: (turnId, segments) =>
				this.safeEmitHook('onTurnLatency', () =>
					this.hooks.onTurnLatency?.({ sessionId: config.sessionId, turnId, segments }),
				),
			emitDrop: (reason, turnId) =>
				this.safeEmitHook('onTurnLatencyDropped', () =>
					this.hooks.onTurnLatencyDropped?.({ sessionId: config.sessionId, turnId, reason }),
				),
			log: (msg) => this.log(msg),
		});

		// Resolve the post-session pipeline: an explicit one wins; otherwise fall back
		// to the process-scoped default pipeline whenever memory is configured, so
		// final memory distillation runs for every session (replacing the old inline
		// forceExtract in close()). The built-in default drains (awaits) to preserve
		// the legacy "extraction attempted before close resolves" guarantee.
		const usingDefaultPipeline = !config.postSessionPipeline && !!config.memory;
		const postSessionPipeline =
			config.postSessionPipeline ?? (config.memory ? getDefaultPostSessionPipeline() : undefined);
		const drainPostSession = config.drainPostSession ?? usingDefaultPipeline;

		this.sessionManager = new SessionManager(
			{
				sessionId: config.sessionId,
				userId: config.userId,
				initialAgent: config.initialAgent,
			},
			this.eventBus,
			this.hooks,
			postSessionPipeline ? { pipeline: postSessionPipeline, drain: drainPostSession } : undefined,
			// Owned by this session: its reset() refuses once the session is finalized.
			true,
		);
		// Shared close-time finalization for EVERY path to CLOSED (graceful close,
		// reconnect-fail, transfer-fail). Runs inside closeWithReason before
		// session.close publishes and before the pipeline dispatches, so the
		// snapshot always reflects flushed transcript + finalized turn. This is the
		// only place these run — close() no longer does them inline.
		this.sessionManager.registerPreCloseFinalizer(() => this.finalizeForClose());
		// Snapshot builder for the post-session pipeline (no-op unless a pipeline is
		// active). Bounded, in-memory: copies the conversation timeline + derived
		// metrics frozen at close time, plus the per-session memory-extraction
		// capability the MemoryDistillationProcessor invokes.
		if (postSessionPipeline) {
			this.sessionManager.registerSnapshotBuilder((reason) =>
				this.buildPostSessionSnapshot(reason),
			);
		}

		this.subagentConfigs = config.subagentConfigs ?? {};
		// The deprecated model name is accepted but never selects a model:
		// reasoningModel wins, otherwise the session default runs.
		for (const [toolName, subagent] of Object.entries(this.subagentConfigs)) {
			if (subagent.model !== undefined && subagent.reasoningModel === undefined) {
				this.log(
					`[WARN] subagent "${subagent.name}" (tool "${toolName}") sets the deprecated SubagentConfig.model ("${subagent.model}"), which is ignored: it runs on the session model. Set reasoningModel to choose its model.`,
				);
			}
		}

		this.responseWatchdogMs = config.responseWatchdogMs ?? DEFAULT_RESPONSE_WATCHDOG_MS;
		this.normalizeDrainedInbound = config.normalizeDrainedInboundAudio !== false;

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
			this.historyWriter = new ConversationHistoryWriter(
				config.sessionId,
				config.userId,
				config.initialAgent,
				this.eventBus,
				this.conversationContext,
				resolvedStore,
				config.sessionMetadata,
				// Resume options (E5): mode + prior aggregates drive attach vs copy persistence.
				{
					historyResumeMode: config.historyResumeMode,
					initialAnalytics: config.initialAnalytics,
					initialItemCount: config.initialHistory?.length ?? 0,
				},
			);
		}

		// Set up LLM transport — instructions/tools from KB-aware resolution (see `liveResolved` above)
		const { instructions, tools: agentTools } = liveResolved;
		const behaviorTools = this.behaviorManager?.tools ?? [];
		const allInitialTools = [...agentTools, ...behaviorTools];
		this.currentTools = allInitialTools;
		this.currentInstructions = instructions;

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
			if (config.realtimeInputConfig !== undefined && config.vadConfig !== undefined) {
				throw new ValidationError(
					'VoiceSession: realtimeInputConfig and vadConfig are mutually exclusive. ' +
						'vadConfig is shorthand for realtimeInputConfig: { automaticActivityDetection: vadConfig }; set only one.',
				);
			}
			// vadConfig goes to the transport as given; only without it does the
			// realtimeInputConfig resolution (default, deep-merge or opt-out) apply.
			this.resolvedRealtimeInputConfig =
				config.vadConfig === undefined
					? resolveGeminiRealtimeInputConfig(config.realtimeInputConfig)
					: undefined;
			this.transport = new GeminiLiveTransport(
				{
					apiKey: config.apiKey,
					model: config.geminiModel,
					systemInstruction: instructions,
					tools: allInitialTools.length ? allInitialTools : undefined,
					googleSearch: initialForLive?.googleSearch,
					speechConfig: config.speechConfig,
					compressionConfig: config.compressionConfig,
					mediaResolution: config.mediaResolution,
					inputAudioTranscription: inputTranscription,
					realtimeInputConfig: this.resolvedRealtimeInputConfig,
					vadConfig: config.vadConfig,
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
					// Raw latency fact (§11): the DETECTED edge, not publish time.
					this.eventBus.publish('speech.user_started', {
						sessionId: this.config.sessionId,
						atMs: this.clientVadDetector.speechStartedAtMs,
						source: 'client-vad',
					});
				},
				onVoicedFrame: (now, maxAbs, avgAbs) => this.runClientVadBargeInPolicy(now, maxAbs, avgAbs),
				onSegmentResolved: () => this.completionArbiter.resolveDeferredPlayback(),
				// User finished a turn → seal the retained utterance (recovery
				// replay candidate), then arm the response watchdog (the model now
				// owes a reply; silence past the timeout forces a reconnect).
				// Phantom-arm guard (Phase 0 tactical fix): a segment whose voiced
				// audio was ALL dropped by the greeting gate never reached any
				// route — the model owes nothing. Abort the (unfed) retainer
				// segment so its pre-roll seed cannot leak into a candidate, and
				// notify the reconnector so an earlier deferred fire re-evaluates
				// instead of stranding.
				// Phase-2 re-bind: retainer/watchdog ACTUATION moved to the ledger's
				// terminal observer (actuateTerminalPolicies) — this legacy handler
				// keeps only playback resolution, latency/hook publication, and
				// event publishes (dual-track terminal ownership, design §1).
				onUserTurnCompleted: () => {
					// Latency: end-of-user-speech (S2FA/S2T anchor) on the shared metric clock.
					const atMs = this.clientVadDetector.lastSpeechCompletedMs || this.nowMs();
					// Raw latency fact (§11): the DETECTED edge (speechEndMs = lastVoiceMs).
					this.eventBus.publish('speech.user_ended', {
						sessionId: this.config.sessionId,
						atMs,
						source: 'client-vad',
					});
					this.safeEmitHook('onUserSpeechEnd', () =>
						this.hooks.onUserSpeechEnd?.({
							sessionId: this.config.sessionId,
							turnId: this.turns.current?.id,
							atMs,
							source: 'client-vad',
						}),
					);
				},
				// Ignored blip / forced reset: the segment can never seal — drop the
				// in-progress retained audio (keeps the sealed replay candidate) and
				// let a deferred watchdog replay re-evaluate instead of stranding.
				// Phase-2 re-bind: abort/notify actuation runs from the ledger's
				// terminal observer for ignored/aborted terminals.
				onSegmentAborted: () => {},
			},
			(msg) => this.log(msg),
			this.nowMs,
		);

		// Echo suppression: the router checks inbound audio against the native
		// model audio fed in `handleAudioOutput`. Opt-in inside the guard.
		if (config.echoGuard) {
			this.echoGuard = new EchoGuard({
				...config.echoGuard,
				log: config.echoGuard.log ?? ((msg) => this.log(msg)),
			});
			if (this.echoGuard.enabled) {
				this.log('EchoGuard enabled (envelope-correlation echo suppression)');
			}
		}

		// Inbound client-audio fast path. Dependencies are read through
		// getters/predicates so the router observes the same call-time values the
		// former inline `handleAudioFromClient` did (providers, mode, gate, and
		// the late-bound external-audio handler are all wired after this point).
		this.audioRouter = new AudioRouter({
			transport: this.transport,
			vad: this.clientVadDetector,
			ledger: this.userTurnEvidence,
			getResponseEpoch: () => this._responseEpoch,
			nowMs: () => this.nowMs(),
			clientAudioInputRate: this.clientAudioInputRate,
			getSttProvider: () => this.sttProvider,
			getShadowSttProvider: () => this.shadowStt,
			getWhisperProvider: () => this.dictation.whisper,
			isSessionActive: () => this.sessionManager.isActive && this.clientInputReady,
			isRtcAudioReady: () => this.directRtcChannel?.isRtcAudioReady ?? false,
			echoGuard: this.echoGuard,
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

		// Dial-generation fence: it wraps `transport.sendToolResult` here, BEFORE
		// the dictation controller below captures that sender, so tool results
		// the controller queues in transcription mode and drains later still
		// pass through the fence.
		this.fence = new DialGenerationFence(this.transport, (msg) => this.log(msg));

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
				// Placed by its capture, not its arrival: a capture committed on a
				// connection a host recovery abandoned is not fresh user evidence.
				const captureStale = this.fence.isSttCaptureStale(turnId);
				// A reserved user message for this turn is waiting on exactly this
				// transcript — resolve it even though the turn has already finalized
				// (and regardless of the stale cutoff, since the reservation, not the
				// turn counter, bounds how long we care). This is the normal path
				// whenever the batch call outlives its turn.
				if (turnId !== undefined && this.transcriptManager.sealReservedInput(turnId, text)) {
					this.clearReservationTimer(turnId);
					if (!captureStale) this.hold.release('external-stt-final');
					return;
				}
				if (turnId !== undefined && turnId < this.turns.staleInputCutoff) return; // Drop stale results (2+ turns old)
				// The turn window above admits the preceding turn, which is exactly
				// where a capture from before a host recovery lands: drop it.
				if (captureStale) {
					this.log(
						`[Transcript] Dropped transcript for turn ${turnId}: captured before a host recovery`,
					);
					return;
				}
				// Any capture in the window from the current connection is fresh
				// evidence, even one for a turn whose input has already finalized.
				this.hold.release('external-stt-final');
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
				// The provider heard the user: fresh evidence.
				this.hold.release('input-transcription');
				// Liveness: the provider is transcribing the committed turn, so a
				// response is in the pipeline — extend the response watchdog (capped)
				// instead of letting it force a reconnect under an active turn.
				this.reconnector.notifyProviderActivity();
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
				this.hold.release('input-transcription'); // fresh evidence (see above)
				this.reconnector.notifyProviderActivity(); // liveness (see above)
				this.logInputTranscriptionLatency(text, 'provider');
				this.shadowStt?.noteLiveTranscript(text);
				this.transcriptManager.handleInput(text);
			};
		}

		// Shadow STT: a second transcriber over the same client audio, compared
		// per turn with the built-in transcription above. Built-in transcription
		// stays the only transcript source; the shadow never reaches
		// transcriptManager (that would duplicate every user turn). With an
		// sttProvider there is no built-in transcription left to compare against.
		if (config.shadowSttProvider && !config.sttProvider) {
			this.shadowStt = new ShadowSttController({
				provider: config.shadowSttProvider,
				// The format the audio router feeds: raw client PCM.
				audio: {
					sampleRate: this.clientAudioInputRate,
					bitDepth: 16,
					channels: 1,
					encoding: 'pcm',
				},
				getCurrentTurnId: () => this.turns.numericId,
				onDivergence: config.onTranscriptionDivergence,
				correctionEnabled: config.divergenceCorrection === true,
				sendCorrection: (text, turnId) =>
					this.sendSyntheticLiveText([{ role: 'user', text }], 'shadow-stt-correction', turnId),
				log: (msg) => this.log(msg),
			});
		} else if (config.shadowSttProvider) {
			this.log('[ShadowSTT] ignored — sttProvider already replaces built-in transcription');
		}

		// (Transcription-mode Whisper wiring + initial-mode seed live in the
		// DictationController constructed above.)

		// Wire onModelTurnStart for STT commit trigger.
		// P4: also allocate the eager turn id here. Chain pattern preserves
		// any pre-attached handler on injected transports.
		const prevModelTurnStart = this.transport.onModelTurnStart;
		this.transport.onModelTurnStart = (generationId?: string) => {
			this._responseEpoch++;
			try {
				prevModelTurnStart?.(generationId);
			} catch (e) {
				this.log(`pre-attached onModelTurnStart threw: ${(e as Error).message}`);
			}
			// A response following a tool dispatch (in the same turn) is a
			// continuation — capture BEFORE the flag resets below.
			const wasToolContinuation = this._nativeResponseDispatchedToolCall;
			// Native playback-end gate: a new model response begins clean.
			this._nativeResponseDispatchedToolCall = false;
			// A genuinely new model response: reset the barge-in eligibility window.
			this._assistantAudioStartedAtMs = null;
			// Latency: stamp provider-response start; reset first-audio for this response.
			this._turnTiming.modelStartMs = this.nowMs();
			this._turnTiming.firstAudioMs = null;
			const modelTurn = this.turns.ensureCurrent();
			// A recovery the synthetic-output hold holds (rather than the greeting
			// gate, whose own model start is ambiguous) is answered by this start:
			// nothing synthetic can open a model turn while the hold is engaged,
			// so the model is responding. Idle it, or the first fresh evidence
			// would re-fire it mid-answer; the clears below then run as usual.
			if (
				modelTurn &&
				this.reconnector.isRecoveryHeld() &&
				!this.greeting.isUninterruptibleGreetingActive()
			) {
				this.reconnector.cancelHeldRecovery();
			}
			// Correlated model activity consumed the pending utterance — clear the
			// recovery-replay candidate, the replay stage, and the response
			// watchdog. Trailing model-start for a just-finalized turn
			// (ensureCurrent → null) must NOT clear them (correlate-before-mutate
			// — a disarm before this check would let a dead turn's trailing
			// content silence the watchdog while the awaited response is still
			// owed).
			if (modelTurn && !this.reconnector.isRecoveryHeld()) {
				// H4 held-state override: while a recovery is held behind the
				// greeting gate, ambiguous model activity (the greeting's own
				// start) must NOT clear the retained candidate or replay stage —
				// release-time re-evaluation decides (recovery.policy.ts). A held
				// recovery's watchdog already fired, so there is no armed timer
				// this disarm would silence.
				this.reconnector.disarmResponseWatchdog();
				this.utteranceRetainer?.clearAnswered();
				this.reconnector.resetReplayState();
			}
			// H1: offer the turn identity to the greeting-gate token (binds only
			// while live + unambiguous — see greeting-gate.policy.ts).
			this.greeting.onModelTurnStarted(modelTurn?.id);
			// Raw latency fact (§11): publish AFTER turn allocation so the payload
			// carries the turn id; origin is the explicit pending one when set.
			const origin =
				this._pendingResponseOrigin ?? (wasToolContinuation ? 'tool_continuation' : 'user_audio');
			this._pendingResponseOrigin = null;
			// Once per framework Turn, on its first model start. Both counters,
			// because they are different domains: the post-setup generation
			// (correlates with lifecycle setup-ok) and the dial epoch. Undefined on
			// transports without the getters.
			if (modelTurn?.markStartPublished()) {
				this.eventBus.publish('turn.start', {
					sessionId: this.config.sessionId,
					turnId: modelTurn.id,
					transportGeneration: this.transport.currentTransportGeneration,
					attemptEpoch: this.transport.currentDialGen,
				});
			}
			this.eventBus.publish('response.started', {
				sessionId: this.config.sessionId,
				turnId: this.turns.current?.id ?? 'unknown',
				atMs: this._turnTiming.modelStartMs,
				origin,
			});
			this.logProviderUserTurnRecognition('model/tool processing started');
			if (this.sttProvider && !this._commitFiredForTurn) {
				this._commitFiredForTurn = true;
				this.fence.stampSttCommit(this.turns.numericId);
				this.sttProvider.commit(this.turns.numericId);
			}
			// Once per turn id (the controller ignores repeats): snapshot the
			// turn's built-in transcript and have the shadow transcribe the turn.
			// Not for a trailing start of an already-finalized turn: the counter
			// has already moved on, and committing now would spend the next
			// turn's single commit before that turn's speech is heard.
			if (modelTurn) this.shadowStt?.commit(this.turns.numericId);
		};

		// Wire TTS provider (actor-mode only)
		if (config.ttsProvider && config.orchestrationMode === 'actor') {
			// The echo guard's reference is the native model audio only; external
			// TTS output never reaches it, so it cannot recognize echo of that speech.
			if (this.echoGuard) {
				this.log(
					'[WARN] echoGuard is configured with ttsProvider: external TTS output is not fed to the echo guard, so its echo is not suppressed',
				);
			}
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

		// Phase-2 re-bind: the ledger's post-routing terminal observer drives
		// retention + watchdog actuation from the policy verdicts — exactly
		// once per terminal, with routed evidence final (design §2 truth table).
		this.userTurnEvidence.observeTerminal((ev) => this.actuateTerminalPolicies(ev));

		this.buildClientChannelAndGating(config);

		// Wire EventBus subscriptions (GUI forwarding, STT lifecycle, subagent UI,
		// async agent transfer). Callbacks capture `this` and fire at runtime, so
		// they may reference collaborators (e.g. agentRouter) constructed below.
		this.wireEventBus();

		this.buildAgentRouter(config, allInitialTools, behaviorTools);
		// H2: capture-time classification for the local channel's inbound
		// buffer (gate read + lightweight energy at INGRESS — a drain-time
		// read would recreate the end-state race), plus the gate-aware
		// transfer drain. The channel holds only this closure, never a
		// GreetingController reference.
		(
			this.clientTransport as unknown as {
				installInboundCaptureClassifier?: (
					c: (data: Buffer) => { voiced: boolean; gateActive: boolean },
				) => void;
			}
		).installInboundCaptureClassifier?.((data) => ({
			voiced: pcmChunksContainSpeech([data]),
			gateActive: this.greeting.shouldDropOutbound(),
		}));
		this.agentRouter.drainBufferedInbound = () => this.drainCapturedInboundFrames('transfer');

		// Usage + cache-bust observability — chained over any pre-attached handlers,
		// fired to the framework hook and mirrored to the EventBus.
		this.wireUsageCallbacks();

		this.buildOrchestration(config, agentTools, behaviorTools);

		this.hostRecovery = new HostRecoveryController({
			transport: this.transport,
			sessionManager: this.sessionManager,
			reconnector: this.reconnector,
			clientTransport: this.clientTransport,
			eventBus: this.eventBus,
			hold: this.hold,
			fence: this.fence,
			getSessionId: () => this.config.sessionId,
			upstreamLossPolicy: config.upstreamLossPolicy ?? 'close',
			actorMode: this._isActorMode,
			dialTransport: async () => {
				await this.dialTransport();
			},
			flushTranscript: () => this.transcriptManager.flush(),
			abandonActiveTurn: () => this.abandonActiveTurn(),
			// Interrupted finalization keeps the provider's buffered audio (the
			// STT contract), and audio fed after a commit already fired would
			// otherwise ride into the replacement turn's first commit as fresh
			// input; a turn completion now, with the interruption consumed,
			// discards it.
			discardSttUtterance: () => this.sttProvider?.handleTurnComplete(),
			clearGreetingState: () => {
				// A greeting sent on the abandoned connection is over whether or
				// not its turn started: drop its suppression, grace and pending
				// response origin, sending nothing, or an uninterruptible greeting
				// would keep dropping microphone input to the replacement.
				this.greeting.resetForClientConnected();
				this._pendingResponseOrigin = null;
			},
			clearRetainedUtterances: () => this.utteranceRetainer?.clearAll(),
			injectRecentContext: (origin) => this.injectRecentContext(origin),
			reportError: (component, error) => this.reportError(component, error),
			log: (msg) => this.log(msg),
		});
	}

	private buildClientChannelAndGating(config: VoiceSessionConfig): void {
		const clientMedia = config.clientMedia ?? DEFAULT_CLIENT_MEDIA_PROFILE;
		const directRtcMedia =
			clientMedia.kind === 'direct_rtc' && clientMedia.rtcAudio === 'werift_opus'
				? {
						inputPcmSampleRate: this.transport.audioFormat.inputSampleRate,
						outputPcmSampleRate: this.transport.audioFormat.outputSampleRate,
						onInboundPcm: (pcm: Buffer) => this.ingestClientAudio(pcm, 'rtc'),
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
				onAudioFromClient: (data) => this.ingestClientAudio(data, 'websocket'),
				onJsonFromClient: (message) => this.handleJsonFromClient(message),
				onClientConnected: () => this.handleClientConnected(),
				onClientDisconnected: () => this.handleClientDisconnected(),
				// Verifier hooks go straight to the host: a verification-role
				// connection never runs handleClientConnected, so it never greets,
				// bootstraps or counts as the attached client.
				onVerifierConnected: config.onVerifierConnected,
				onVerifierDisconnected: config.onVerifierDisconnected,
			},
			// Spelled out on purpose: hosts detect probe support with
			// String(VoiceSession).includes('probeState'), so this property access
			// must stay in the class body.
			options: { probeState: config.probeState },
		});
		this.directRtcChannel =
			this.clientTransport instanceof DirectRtcClientChannel ? this.clientTransport : null;
		if (!(this.clientTransport instanceof ClientTransport)) {
			const roleOptions = [
				...(config.probeState ? ['probeState'] : []),
				...(config.onVerifierConnected ? ['onVerifierConnected'] : []),
				...(config.onVerifierDisconnected ? ['onVerifierDisconnected'] : []),
			];
			if (roleOptions.length > 0) {
				this.log(
					`[WARN] ${roleOptions.join(', ')} configured, but the client channel is host-owned (clientSender): the framework never sees the socket upgrade, so ?probe=1 and ?verify=1 connections are not recognized; probe isolation must be implemented by the host.`,
				);
			}
		}

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
				// H4: a held recovery re-evaluates when the gate releases.
				onGateReleased: () => this.reconnector.onGreetingGateReleased(),
				isSyntheticHeld: () => !this.hold.gate('greeting'),
				log: (msg) => this.log(msg),
			},
			{
				overrideGraceMs: clampGraceMs(config.greetingInterruptGraceMs),
				greetingInterruptible: config.greetingInterruptible !== false,
			},
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
			vad: ((detector: ClientVadDetector) => ({
				get isSpeechActive() {
					return detector.isSpeechActive;
				},
				get isBargeInEligible() {
					return detector.isBargeInEligible;
				},
				resetSegment: () => this.finalizeForcedVadTerminal(detector.resetSegment()),
			}))(this.clientVadDetector),
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
			sendInlineFile: this.transport.sendInlineFile
				? (base64, mimeType) => this.transport.sendInlineFile?.(base64, mimeType)
				: undefined,
			getArbiter: () => this.completionArbiter,
			getLiveGate: () => this.liveGate(),
			getPlaybackStateProtocolActive: () => this.playbackStateProtocolActive,
			sessionId: this.config.sessionId,
			getArtifactRegistry: () => this.config.artifactRegistry,
			handleTextInput: (text) => this.handleTextInput(text),
			onClientJson: config.onClientJson,
			onClientCommand: config.onClientCommand,
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
				// Phase-3 coordinator seam: a recovery response must never bind
				// as the greeting (H1) — invalidate before actuation.
				onRecoveryDispatch: () => this.triggerCoordinator.dispatch('watchdog-recovery'),
				// H4 hold predicate: FULL-greeting suppression only (the greeting
				// controller's uninterruptible state — never grace windows).
				isGreetingSuppressionArmed: () => this.greeting.isUninterruptibleGreetingActive(),
				// A watchdog fire under the synthetic-output hold is held, never
				// replayed, nudged or reconnected; the hold's release re-evaluates it.
				isSyntheticHeld: () => this.hold.isActive(),
				// Exhaustion policy, and the host-owned recovery gate it enables
				// under 'hold'.
				upstreamLossPolicy: config.upstreamLossPolicy ?? 'close',
				hostOwnsRecovery: () => this.config.suppressClientAutoActions?.() === true,
				// H2: gate-aware drain + candidate-wide replay freshness.
				drainBufferedInbound: (reason) => this.drainCapturedInboundFrames(reason),
				isCandidateReplayEligible: (retained) => {
					const t = this.userTurnEvidence.lastDrainedSpeechAtMs;
					return t === null || retained.sealedAtMs > t;
				},
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
		this.hold.onRelease(() => this.reconnector.onSyntheticHoldReleased());
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
		if (this.isTextMode) {
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
				// caller-supplied callback if any. `onTransportDeliver` is
				// unconditional: every actor-mode notification delivery is a
				// generation-capable path that must invalidate a live greeting
				// token before its wire-out (H1 enforcement).
				notification: {
					onTransportDeliver: () => this.triggerCoordinator.dispatch('notification'),
					...(this.hooks.onBackgroundNotification
						? { onBackgroundNotification: this.hooks.onBackgroundNotification }
						: {}),
				},
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
		const interceptor = this.config.outputInterceptor;
		this.transport.onAudioOutput = (data) => {
			// The host interceptor can drop a native audio chunk before the session
			// sees it. A throwing hook is reported and the chunk is delivered.
			if (interceptor?.audio) {
				let drop = false;
				try {
					drop = interceptor.audio(data) === false;
				} catch (e) {
					this.reportError('output-interceptor.audio', e);
				}
				if (drop) return;
			}
			this.handleAudioOutput(data);
		};
		// No-TTS text mode: the model emits text (not audio). Surface each chunk via the
		// normal transcript path (which the client-sender already emits as
		// `{ type:'transcript', role:'assistant', partial }`); turn finalization still flows
		// through the transport's `onTurnComplete` wired below. (TTS mode wires these in
		// TtsPipeline.wire() instead, so this branch only runs when there is no TTS.)
		if (this.isNoTtsTextMode) {
			this.transport.onTextOutput = (text) => {
				this.turns.ensureCurrent();
				this.transcriptManager.handleOutput(text);
			};
			this.transport.onTextDone = () => {};
		}
		// Raw latency facts (§11) from the provider's server VAD. onSpeechStarted
		// is chain-preserved by the later TTS/native-gate installers, so this
		// publisher survives their wiring. Provider stamps are receipt time
		// (bounded late bias — see the design doc).
		const prevSpeechStarted = this.transport.onSpeechStarted;
		this.transport.onSpeechStarted = () => {
			try {
				prevSpeechStarted?.();
			} catch (e) {
				this.log(`pre-attached onSpeechStarted threw: ${(e as Error).message}`);
			}
			this.eventBus.publish('speech.user_started', {
				sessionId: this.config.sessionId,
				atMs: this.nowMs(),
				source: 'provider',
			});
		};
		this.transport.onUserSpeechStopped = () => {
			const atMs = this.nowMs();
			this.eventBus.publish('speech.user_ended', {
				sessionId: this.config.sessionId,
				atMs,
				source: 'provider',
			});
			// Bridge to the public hook too — hook-based consumers (S2T) would
			// otherwise stay client-VAD-only and miss quiet-mic turns.
			this.safeEmitHook('onUserSpeechEnd', () =>
				this.hooks.onUserSpeechEnd?.({
					sessionId: this.config.sessionId,
					turnId: this.turns.current?.id,
					atMs,
					source: 'provider',
				}),
			);
		};
		// Latency: first audio chunk of the response (stop-to-first-audio anchor).
		this.transport.onFirstAudioChunk = () => {
			if (this._turnTiming.firstAudioMs !== null) return;
			this._turnTiming.firstAudioMs = this.nowMs();
			// Raw latency fact (§11).
			this.eventBus.publish('response.first_audio', {
				sessionId: this.config.sessionId,
				turnId: this.turns.current?.id ?? 'unknown',
				atMs: this._turnTiming.firstAudioMs,
			});
			// Re-entry latency: pause from the last interrupt (yield) to this audio.
			if (this._lastInterruptAtMs !== null) {
				const reentryMs = Math.max(0, this._turnTiming.firstAudioMs - this._lastInterruptAtMs);
				this._lastInterruptAtMs = null;
				this.safeEmitHook('onAgentReentry', () =>
					this.hooks.onAgentReentry?.({ sessionId: this.config.sessionId, reentryMs }),
				);
			}
			// JIR: agent audio began while the user is still speaking (false turn-end).
			if (this.clientVadDetector.isSpeechActive) {
				this.safeEmitHook('onJumpIn', () =>
					this.hooks.onJumpIn?.({
						sessionId: this.config.sessionId,
						turnId: this.turns.current?.id,
					}),
				);
			}
		};
		this.transport.onToolCall = (calls) => {
			// Stamp each call with the dial it was issued on, for the tool-result fence.
			this.fence.stampToolCalls(calls.map((c) => c.id));
			this.reconnector.disarmResponseWatchdog();
			// Native playback-end gate: this response dispatched a tool call, so
			// it is not the turn's terminal spoken response.
			this._nativeResponseDispatchedToolCall = true;
			if (this.runtimeOrchestrator) {
				const names = calls.map((c) => c.name).join(', ');
				this.logProviderUserTurnRecognition('tool call received');
				const sinceVadEnd = this.clientVadDetector.lastSpeechCompletedMs
					? ` (${this.nowMs() - this.clientVadDetector.lastSpeechCompletedMs}ms after client audio VAD end)`
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
		// The generation pair, chained over handlers a pre-configured injected
		// transport already attached. Not turn.*: a generation outlives the
		// provider's turn boundary (see events.ts).
		const prevGenerationStart = this.transport.onGenerationStart;
		this.transport.onGenerationStart = (generationId) => {
			try {
				prevGenerationStart?.(generationId);
			} catch (e) {
				this.log(`pre-attached onGenerationStart threw: ${(e as Error).message}`);
			}
			this.eventBus.publish('generation.start', {
				sessionId: this.config.sessionId,
				generationId,
			});
		};
		const prevGenerationEnd = this.transport.onGenerationEnd;
		this.transport.onGenerationEnd = (generationId, reason) => {
			try {
				prevGenerationEnd?.(generationId, reason);
			} catch (e) {
				this.log(`pre-attached onGenerationEnd threw: ${(e as Error).message}`);
			}
			this.eventBus.publish('generation.end', {
				sessionId: this.config.sessionId,
				generationId,
				reason,
			});
		};
		this.transport.onOutputTranscription = (text) => {
			const turn = this.turns.ensureCurrent();
			if (!turn) {
				this.log(
					'[Watchdog] Ignored output transcription for already-finalized turn; watchdog NOT disarmed',
				);
				return;
			}
			this.reconnector.disarmResponseWatchdog();
			// No-TTS text mode: the assistant text already arrives via `onTextOutput`
			// (`part.text`). Gemini also echoes it as `outputTranscription`, so feeding it
			// here too would double every chunk. Skip it (onTextOutput is the source).
			if (this.isNoTtsTextMode) return;
			// The host interceptor may hold a chunk and forward it later, for
			// example from its beforeTranscriptFlush hook. A throwing hook is
			// reported and the original chunk is forwarded unchanged.
			if (interceptor?.transcript) {
				try {
					interceptor.transcript(text, (forwarded) =>
						this.transcriptManager.handleOutput(forwarded),
					);
				} catch (e) {
					this.reportError('output-interceptor.transcript', e);
					this.transcriptManager.handleOutput(text);
				}
				return;
			}
			this.transcriptManager.handleOutput(text);
		};
		this.transport.onSessionReady = (sessionId) => this.handleSetupComplete(sessionId);
		this.transport.onError = (error) => this.handleTransportError(error);
		this.transport.onClose = (code, reason) => this.handleTransportClose(code, reason);
		this.transport.onGoAway = (timeLeft) => this.handleGoAway(timeLeft);
		this.transport.onResumptionUpdate = (handle, resumable) =>
			this.reconnector.handleResumptionUpdate(handle, resumable);
		this.transport.onGroundingMetadata = (metadata) => this.handleGroundingMetadata(metadata);
		this.wireDiagnosticsCallbacks();
	}

	/** Wire the config's raw diagnostics callbacks, only those configured (an
	 *  unconfigured one leaves the transport's hook untouched), chained over any
	 *  handler a pre-configured injected transport already attached. The
	 *  transport isolates each observer from its dispatch and connection state
	 *  machine. */
	private wireDiagnosticsCallbacks(): void {
		const { onConnectionLifecycle, onUsageMetadata } = this.config;
		const configured = [
			...(onConnectionLifecycle ? ['onConnectionLifecycle'] : []),
			...(onUsageMetadata ? ['onUsageMetadata'] : []),
		];
		if (configured.length === 0) return;
		// Read before assigning below: assignment would create the members.
		if (!('onConnectionLifecycle' in this.transport) && !('onUsageMetadata' in this.transport)) {
			this.log(
				`[WARN] ${configured.join(' and ')} configured, but the transport declares neither onConnectionLifecycle nor onUsageMetadata (e.g. OpenAI, Qwen); ${configured.length > 1 ? 'they are' : 'it is'} not expected to fire.`,
			);
		}
		if (onConnectionLifecycle) {
			const prevLifecycle = this.transport.onConnectionLifecycle;
			this.transport.onConnectionLifecycle = (event) => {
				try {
					prevLifecycle?.(event);
				} catch (e) {
					this.log(`pre-attached onConnectionLifecycle threw: ${(e as Error).message}`);
				}
				onConnectionLifecycle(event);
			};
		}
		if (onUsageMetadata) {
			const prevUsage = this.transport.onUsageMetadata;
			this.transport.onUsageMetadata = (usage) => {
				try {
					prevUsage?.(usage);
				} catch (e) {
					this.log(`pre-attached onUsageMetadata threw: ${(e as Error).message}`);
				}
				onUsageMetadata(usage);
			};
		}
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

		// Bind STT lifecycle to session state: start when ACTIVE (agent ready), stop when disconnecting.
		// A session parked in UPSTREAM_LOST is disconnected too (and routes no
		// microphone audio), so STT stops there as well; a redial's activation
		// starts it again.
		this.eventBus.subscribe('session.stateChange', (payload: { toState: string }) => {
			if (payload.toState === 'ACTIVE') {
				this.startSttProvider();
				this.startShadowStt();
			} else if (
				payload.toState === 'RECONNECTING' ||
				payload.toState === 'TRANSFERRING' ||
				payload.toState === 'UPSTREAM_LOST'
			) {
				void this.sttProvider?.stop();
				this.shadowStt
					?.stop()
					.catch((err) =>
						this.log(
							`[ShadowSTT] stop failed: ${err instanceof Error ? err.message : String(err)}`,
						),
					);
			}
			// Parked, nothing can reach the model: a notification sent now would
			// be dropped by the disconnected transport, and synthetic output has
			// nowhere to go. The dial window holds both until a recovery's
			// replacement connection activates. Only legacy sessions park.
			if (payload.toState === 'UPSTREAM_LOST') this.hold.engageDialWindow();
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
			// Isolated: a throwing hook must not stop the `realtime.usage` publish below.
			this.safeEmitHook('onRealtimeLLMUsage', () =>
				this.hooks.onRealtimeLLMUsage?.({
					sessionId: this.config.sessionId,
					agentName,
					usage,
				}),
			);
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

		// Provider-evidence wiring (design §1): declare what this transport's
		// adapter can ever emit (undeclared ⇒ 'not-observable', stated once),
		// and route delivered events into the ledger.
		this.userTurnEvidence.declareProviderCapability(
			this.transport.capabilities.providerEvidenceKinds ?? [],
		);
		this.transport.onProviderEvidence = (ev) =>
			this.userTurnEvidence.applyProviderEvidenceEvent(ev);
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
	 * Actor-mode SYSTEM notifications. Centralizes the
	 * `runtime.tell('notification.publish', ...)` call shape used by the
	 * background-tool completion path. Caller passes only the body text;
	 * TransportActor wraps it as `[SYSTEM]: text` at the wire-out boundary.
	 *
	 * Public so integrations with out-of-band signals (e.g. the Sutando
	 * adapter's offline-Mac notice — see examples/lib/sutando-tools.ts) can
	 * bind their notify hooks to the same delivery path the runtime uses.
	 */
	/** Disarm the fallback-seal timer for a reservation that resolved normally. */
	private clearReservationTimer(turnId: number): void {
		const timer = this.reservationTimers.get(turnId);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.reservationTimers.delete(turnId);
	}

	publishSystemNotification(text: string): void {
		// Actor-only callers (the background-tool completion path, guarded by the
		// actor-construction block). Routed through the sink for uniformity; the
		// legacy sink is never reached from here.
		this.notificationSink.publish('SYSTEM', text, 'normal');
	}

	/**
	 * Observable-acceptance variant of {@link publishSystemNotification}:
	 * returns false when the session cannot accept the notification — already
	 * CLOSED, or actor mode without a live runtime — so claim/ack delivery
	 * protocols (e.g. Sutando recovery notices) can requeue instead of silently
	 * losing the message. `true` means enqueued; spoken delivery remains
	 * at-most-once by design (queues are in-memory).
	 */
	tryPublishSystemNotification(text: string): boolean {
		if (this.sessionManager.state === 'CLOSED') return false;
		if (this._isActorMode && !this.runtimeOrchestrator) return false;
		this.publishSystemNotification(text);
		return true;
	}

	/**
	 * Start the client WebSocket server and connect to the LLM transport.
	 *
	 * When `recoverUpstream()` runs while the session is CONNECTING, it
	 * replaces the first dial and owns the session from then on: `start()`
	 * neither closes, parks nor transitions the session, and runs no
	 * post-connect step. If the recovery came before `start()` began its dial
	 * (called the transport's `connect()`), from a `session.stateChange`
	 * subscriber of the CONNECTING transition or during the text-mode session
	 * update a pre-constructed transport gets before it connects, nothing is
	 * dialed and the returned promise resolves. Otherwise it settles with the
	 * stranded dial's own settlement: it rejects with that dial's error, or
	 * resolves if the dial completes late. For a dial stranded before setup
	 * completed that can take up to the transport's connect deadline. Await
	 * the recovery's `activated` to learn when the session is ready.
	 */
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
		// No-TTS text mode: same capability requirement, without a TTS provider.
		if (this.isNoTtsTextMode && !this.transport.capabilities.textResponseModality) {
			throw new Error(
				'responseModality: "text" requires a transport that supports textResponseModality',
			);
		}
		// Resume (§2): populate the conversation timeline BEFORE connect/persistence so
		// ConversationContext-derived features (summary, subagent snapshots, analytics) are
		// history-aware. `attach` marks the loaded items as already-persisted (checkpoint advanced,
		// not re-flushed mid-session); `copy` leaves the checkpoint so the writer re-persists them.
		const hasResume = (this.config.initialHistory?.length ?? 0) > 0;
		if (hasResume && this.config.initialHistory) {
			this.conversationContext.loadItems(this.config.initialHistory, {
				alreadyPersisted: this.config.historyResumeMode === 'attach',
			});
		}
		await this.sttProvider?.start();
		await this.shadowStt?.start();
		await this.ttsPipeline?.provider.start();
		// Phase 3: when constructed with initial transcriptionMode='transcription',
		// bring Whisper up and quiesce the agent transport before start() resolves.
		// Audio dropped during these awaits is bounded by clientTransport buffering.
		await this.dictation.prepareForStart();
		if (this.runtimeOrchestrator) {
			await this.runtimeOrchestrator.start();
		}

		// Load memory and directives in parallel with the provider connect. Client
		// bootstrap/input admission waits on this promise so restored pacing is
		// observable before a client can trigger the first response.
		if (this.config.memory) {
			this.memoryAndDirectivesReady = false;
			this.clientInputReady = false;
			this._memoryReadyPromise = this.loadMemoryAndDirectives().then(
				() => {
					this.memoryAndDirectivesReady = true;
				},
				(error) => {
					// Memory is best-effort. A store failure must not strand a connected
					// client behind the input gate forever.
					this.memoryAndDirectivesReady = true;
					this.log(
						`Memory/directive restore failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				},
			);
		} else {
			this.memoryAndDirectivesReady = true;
			this._memoryReadyPromise = Promise.resolve();
		}

		await this.clientTransport.start();
		this.log('Connecting to LLM transport...');
		this.sessionManager.transitionTo('CONNECTING');
		// recoverUpstream() during CONNECTING strands this dial and dials the
		// replacement itself, which then owns the session. Only a recovery that
		// starts from CONNECTING says so: one that runs after this dial set up
		// (the session is ACTIVE) leaves the completion below to run as usual.
		const replacedByRecovery = () => this.hostRecovery.firstDialReplaced;
		// A recovery from a subscriber of the CONNECTING transition has already
		// dialed: dialing here too would supersede its replacement.
		if (replacedByRecovery()) {
			this.log(
				'A host recovery replaced the first dial before it began — leaving the session to the recovery',
			);
			return;
		}
		let connected: boolean;
		try {
			connected = await this.dialTransport(replacedByRecovery);
		} catch (error) {
			if (replacedByRecovery()) {
				const message = error instanceof Error ? error.message : String(error);
				this.log(
					`LLM transport first dial failed after a host recovery replaced it: ${message} — leaving the session to the recovery`,
				);
				throw error;
			}
			// A failed initial dial must not wedge the session in CONNECTING. The
			// providers, runtime and client listener started above are already
			// live, so run the full close() teardown, not a bare state change.
			// Under upstreamLossPolicy 'hold' the session parks in UPSTREAM_LOST
			// instead, unfinalized and with the listener still up, so a host can
			// redial it later; start() still rejects.
			if (this.sessionManager.state === 'CONNECTING') {
				const message = error instanceof Error ? error.message : String(error);
				if (this.config.upstreamLossPolicy === 'hold') {
					this.log(`LLM transport connect failed: ${message} — session parked in UPSTREAM_LOST`);
					this.reconnector.parkUpstreamLost('connect-failed', { reason: message });
				} else {
					this.log(`LLM transport connect failed: ${message} — closing session`);
					try {
						await this.close('connect_failed');
					} catch (closeError) {
						this.log(
							`close('connect_failed') failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
						);
					}
				}
			}
			throw error;
		}
		if (replacedByRecovery()) {
			this.log(
				connected
					? 'LLM transport first dial completed after a host recovery replaced it — the recovery dial stays in place'
					: 'A host recovery replaced the first dial before it dialed — leaving the session to the recovery',
			);
			return;
		}
		// (Resume model prefill happens in handleSetupComplete, before the ACTIVE transition /
		// greeting — see the transport.replayHistory?.() call there.)
		//
		// Ordered persistence (E5): the ACTIVE transition above published `session.start`
		// synchronously, so the writer has enqueued its start-phase (copy: createSession; attach:
		// ensureSession + reactivateSession). Await it so a resumed `attach` record reads `active`
		// (terminal fields cleared) by the time `start()` resolves.
		await this.historyWriter?.drain();
		this.log('LLM transport connected and setup complete');
	}

	/** Dial the LLM transport: the initial connect in `start()` and the
	 *  replacement dial of a host recovery. `skipConnect`, checked right before
	 *  connecting (after any pre-connect session update), abandons the dial.
	 *  Resolves `true` when it connected, `false` when it was abandoned. */
	private async dialTransport(skipConnect?: () => boolean): Promise<boolean> {
		if (this.config.transport && this.isTextMode) {
			await this.transport.updateSession({ responseModality: 'text' });
		}
		if (skipConnect?.()) return false;
		if (this.config.transport) {
			await this.transport.connect();
			return true;
		}
		await this.transport.connect({
			auth: { type: 'api_key', apiKey: this.config.apiKey },
			model: this.config.geminiModel ?? DEFAULT_GEMINI_LIVE_MODEL,
			...(this.resolvedRealtimeInputConfig
				? {
						realtimeInputConfig: this.resolvedRealtimeInputConfig as Record<string, unknown>,
					}
				: {}),
			...(this.isTextMode ? { responseModality: 'text' as const } : {}),
		});
		return true;
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
	/**
	 * Build the immutable post-session snapshot + live stores. Bounded, in-memory:
	 * copies the conversation timeline and derives metrics from it. Used only when a
	 * post-session pipeline is wired (see VoiceSessionConfig.postSessionPipeline).
	 */
	private buildPostSessionSnapshot(reason: SessionEndReason): {
		snapshot: PostSessionSnapshot;
		stores: PostSessionStores;
	} {
		const items = [...this.conversationContext.items];
		let finalAgentName = this.config.initialAgent;
		try {
			finalAgentName = this.agentRouter.activeAgent.name;
		} catch {
			// no active agent (never went active) — keep initial
		}
		// Reconstruct the full agent path from the recorded transfer timeline
		// (`Transfer: <from> → <to>`), preserving multi-hop and A→B→A returns.
		const transferPath = [this.config.initialAgent];
		for (const item of items) {
			if (item.role !== 'transfer') continue;
			const match = /→\s*(.+)$/.exec(item.content);
			if (match) transferPath.push(match[1].trim());
		}
		const startedAt = this.sessionManager.startedAtMs ?? Date.now();
		const endedAt = Date.now();
		const snapshot: PostSessionSnapshot = {
			sessionId: this.config.sessionId,
			userId: this.config.userId,
			initialAgentName: this.config.initialAgent,
			finalAgentName,
			transferPath,
			reason,
			startedAt,
			endedAt,
			durationMs: Math.max(0, endedAt - startedAt),
			metadata: this.config.sessionMetadata,
			conversation: { items },
			metrics: {
				turnCount: items.filter((i) => i.role === 'assistant').length,
				toolCallCount: items.filter((i) => i.role === 'tool_call').length,
				agentTransferCount: items.filter((i) => i.role === 'transfer').length,
			},
		};
		return {
			snapshot,
			stores: {
				memory: this.config.memory?.store,
				// v1 bridge: the MemoryDistillationProcessor invokes this per-session
				// capability (closing over the session's distiller) instead of the
				// removed inline forceExtract in close().
				memoryExtraction: this.memoryDistiller
					? () => this.memoryDistiller?.forceExtract() ?? Promise.resolve()
					: undefined,
			},
		};
	}

	/**
	 * Close-time finalization, registered as SessionManager's pre-close finalizer so
	 * it runs for EVERY path to CLOSED before session.close publishes and the
	 * post-session pipeline dispatches. Non-fallible, quick, in-memory: quiesce
	 * session-scoped state, flush the transcript, reset the latency tracker, and
	 * finalize any in-flight turn — so the post-session snapshot is complete.
	 */
	private finalizeForClose(): void {
		// Drop any queued background notifications — session is ending.
		this.notificationQueue?.clear();
		// Retained user audio is session-scoped and memory-only — drop it now.
		this.utteranceRetainer?.clearAll();
		this.reconnector.resetReplayState();

		// Flush any buffered transcription before closing.
		this.transcriptManager.flush();

		// Release every outstanding transcript reservation with its fallback text.
		// A still-pending reservation is a flush barrier — leaving one set here
		// would strand that user message (and everything after it) unpersisted,
		// since this runs before session.close reaches ConversationHistoryWriter.
		for (const timer of this.reservationTimers.values()) clearTimeout(timer);
		this.reservationTimers.clear();
		this.transcriptManager.sealPendingInput();

		// §11 close ordering: (1) flush — already-finalized buffered turns still
		// emit; (2) session.reset quiesces the tracker; (3) the teardown turn.end
		// below then lands on a quiesced tracker and can never emit a sample.
		this.turnLatencyTracker.flush();
		this.eventBus.publish('session.reset', {
			sessionId: this.config.sessionId,
			reason: 'close',
		});
		this.turnLatencyTracker.flush(); // process the reset synchronously

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
	}

	/** Run one best-effort teardown step; a throw is logged, never aborts the rest. */
	private async safeTeardown(label: string, fn: () => unknown): Promise<void> {
		try {
			await fn();
		} catch (err) {
			this.log(
				`close teardown '${label}' failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	async close(reason: SessionEndReason = 'normal'): Promise<void> {
		// 1. Close funnel FIRST: runs the shared pre-close finalizer (transcript
		//    flush, turn.end, reset), publishes session.close, and dispatches the
		//    post-session pipeline (drain mode awaits it) — all BEFORE the fallible
		//    teardown below, so a teardown failure can never prevent close/dispatch.
		//    Awaited UNCONDITIONALLY: closeWithReason is idempotent and returns the
		//    memoized close promise, so if a failure path (reconnect/transfer) already
		//    claimed close with a still-pending drain, we await THAT before teardown /
		//    eventBus.clear() rather than racing it.
		//    The reconnector and the host recovery controller are disposed
		//    synchronously BEFORE that await: the state stays ACTIVE/RECONNECTING
		//    while async finalizers run, so a pending backoff dial, a transport
		//    close or a host recovery arriving mid-finalization would otherwise
		//    dial a session that is closing.
		try {
			this.reconnector.dispose();
		} catch (err) {
			this.log(`close: reconnector.dispose threw: ${String(err)}`);
		}
		try {
			this.hostRecovery.dispose();
		} catch (err) {
			this.log(`close: hostRecovery.dispose threw: ${String(err)}`);
		}
		await this.sessionManager.closeWithReason(reason);

		// 2. Fallible resource teardown, each isolated so one failure doesn't abort
		//    the rest (the session is already CLOSED and post-session work dispatched).
		await this.safeTeardown('stt.stop', () => this.sttProvider?.stop());
		await this.safeTeardown('shadowStt.stop', () => this.shadowStt?.stop());
		// Stop the dictation-mode Whisper provider so prewarmed/active sockets don't
		// survive session close. Idempotent.
		await this.safeTeardown('dictation.stopWhisper', () => this.dictation.stopWhisper());
		await this.safeTeardown('ttsGate.clearTimers', () => this.ttsPipeline?.gate.clearTimers());
		// Cancels a pending backoff dial and an in-flight reconnect (aborting the
		// transport incumbent and the attempt deadline), the response watchdog and a
		// held recovery.
		await this.safeTeardown('greetingGate.dispose', () => this.greeting.dispose());
		// close() bypasses finalizeTurn — tear down the native gate directly so no
		// native playback timer outlives the session.
		if (this.nativePlaybackGatingActive) {
			await this.safeTeardown('nativeGate.clear', () => {
				this.nativeGate?.clear();
				this.completionArbiter.clearDefer();
			});
		}
		await this.safeTeardown('tts.stop', () => this.ttsPipeline?.provider.stop());
		if (this.runtimeOrchestrator) {
			await this.safeTeardown('runtimeOrchestrator.stop', () => this.runtimeOrchestrator?.stop());
		}
		await this.safeTeardown('subagents.dispose', () =>
			this.persistentSubagents.disposeAllPersistent(),
		);
		await this.safeTeardown('artifactRegistry.dispose', () =>
			this.config.artifactRegistry?.dispose(),
		);
		await this.safeTeardown('transport.disconnect', () => this.transport.disconnect());
		await this.safeTeardown('clientTransport.stop', () => this.clientTransport.stop());

		// Ordered persistence (E5): the CLOSED transition published `session.close` synchronously,
		// enqueueing the final flush + saveSessionReport. Await the writer's queue to drain before
		// tearing down the event bus, so the report always lands (it is otherwise fire-and-forget).
		await this.historyWriter?.drain();

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
		// Discard in-flight latency stamps — the transfer reconnects the transport (§11).
		this.eventBus.publish('session.reset', {
			sessionId: this.config.sessionId,
			reason: 'transfer',
		});
		await this.agentRouter.transfer(toAgent);
		this.log(`Transfer to "${toAgent}" complete`);

		// Update tool executor with new agent's tools (include KB-generated tools)
		const agent = this.agentRouter.activeAgent;
		const resolved = resolveAgentWithKnowledgeBase(agent);
		this.processedKnowledgeBase = resolved.processedKB;
		this.toolExecutor = this.createToolExecutor(agent.name);
		const behaviorTools = this.behaviorManager?.tools ?? [];
		this.toolExecutor.register([...resolved.tools, ...behaviorTools]);
		// A transfer re-resolves tools and instructions from the new agent's
		// definition, dropping registerTools(), replaceTools() and
		// updateInstructions() changes.
		this.currentTools = [...resolved.tools, ...behaviorTools];
		this.currentInstructions = resolved.instructions;
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
		if (this._clientConnected && this.greeting.sendGreeting()) {
			this._pendingResponseOrigin = 'assistant_initiated';
		}
	}

	private createToolExecutor(agentName: string): ToolExecutor {
		return new ToolExecutor(
			this.hooks,
			this.eventBus,
			this.config.sessionId,
			agentName,
			(msg) => this.sendHostFrame(msg),
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
			sendJsonToClient: (message: AnyServerToClientMessage) => {
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
		// Pure A1-A6 decision (barge-in.policy.ts); the ordered gate check,
		// one-shot marking, actuation, and metrics stay here (A4/C2 sequencing).
		const decision = decideBargeIn(
			this.clientVad,
			{ maxAbs, avgAbs, elapsedMs: now - this.clientVadDetector.speechStartedAtMs },
			{ assistantAudioActive: this.isAssistantAudioActive() },
			{ fired: this.clientVadDetector.hasBargeInFired },
		);
		if (decision.markEligible) this.clientVadDetector.markBargeInEligible();
		if (!decision.attempt) return;
		// Grace check goes BEFORE marking fired — otherwise a frame at t=500ms
		// within a 1s grace would set the "fired" flag, and the `hasBargeInFired`
		// guard above would skip the next loud frame at t=1100ms (post-grace),
		// defeating real barge-ins.
		if (!this.requestInterrupt('client-vad')) {
			// Threshold-passing barge-in declined (e.g. greeting grace): a *missed*
			// barge-in. Emit once per segment so the rate isn't inflated per-frame.
			if (!this.clientVadDetector.hasBargeInMissed) {
				this.clientVadDetector.markBargeInMissed();
				const at = this.nowMs();
				this.safeEmitHook('onBargeInDetected', () =>
					this.hooks.onBargeInDetected?.({
						sessionId: this.config.sessionId,
						speechStartedAtMs: this.clientVadDetector.speechStartedAtMs,
						detectedAtMs: now,
						cancelRequestedAtMs: at,
						latencyMs: Math.max(0, at - now),
						successful: false,
					}),
				);
			}
			return;
		}
		this.clientVadDetector.markBargeInFired();
		this.log(
			`[Latency] client-VAD barge-in actuated (path=${this.liveGate() ? 'gate' : 'native-fallback'}; peak=${maxAbs}; avgAbs=${avgAbs})`,
		);
		// Barge-in latency = detection (`now`) → cancel actuation, on the metric clock.
		// (Confirm delay is detectedAtMs − speechStartedAtMs; cancel latency is the
		// detect→actuate span this hook reports.)
		const cancelRequestedAtMs = this.nowMs();
		this.handleClientTtsBargeIn();
		this.safeEmitHook('onBargeInDetected', () =>
			this.hooks.onBargeInDetected?.({
				sessionId: this.config.sessionId,
				speechStartedAtMs: this.clientVadDetector.speechStartedAtMs,
				detectedAtMs: now,
				cancelRequestedAtMs,
				latencyMs: Math.max(0, cancelRequestedAtMs - now),
				successful: true,
			}),
		);
	}

	private logInputTranscriptionLatency(text: string, source: string): void {
		const trimmed = text.trim();
		if (!trimmed || trimmed === this.lastInputTranscriptionLogText) return;
		this.lastInputTranscriptionLogText = trimmed;
		const sinceVadEnd = this.clientVadDetector.lastSpeechCompletedMs
			? `; ${this.nowMs() - this.clientVadDetector.lastSpeechCompletedMs}ms after client audio VAD end`
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

	/** Phase-2 terminal actuation (design §2 truth table): the ledger's
	 *  post-routing observer calls the pure policies and actuates EXACTLY once
	 *  per terminal — `seal()`/`abortSegment()` for retention,
	 *  `armResponseWatchdog()`/`notifySegmentAborted()` for the reconnector.
	 *  `notifySegmentAborted` on every non-arm terminal keeps deferred fires
	 *  from stranding (no-op unless one was deferred). */
	private actuateTerminalPolicies(ev: Readonly<SegmentEvidence>): void {
		this._shadowCounters.compared++;
		const retention = decideRetention(ev, {
			replayRecovery: this.utteranceRetainer !== undefined,
		});
		if (retention === 'seal') this.utteranceRetainer?.seal();
		else this.utteranceRetainer?.abortSegment();

		const verdict = decideWatchdogArm(ev, { agentMode: this.dictation.isAgentMode() });
		if (verdict === 'arm' && this.responseWatchdogMs > 0) {
			if (ev.routed.llm) this.greeting.noteRoutedUserTurn();
			this.reconnector.armResponseWatchdog();
			return;
		}
		if (verdict === 'skip-no-eligible-route' && ev.outcome === 'completed' && ev.voicedFrames > 0) {
			this.log('[Watchdog] arm skipped — segment audio gated during greeting');
		}
		this.reconnector.notifySegmentAborted();
	}

	/** H2 gate-aware drain (design §3): pulls capture-tagged inbound frames
	 *  from the local channel, DISCARDS frames whose gate was active at
	 *  capture, transform-sends the rest (router helper — no retention, no
	 *  live gate read), records BufferedInboundEvidence, and returns the
	 *  ADMITTED buffers for the reconnect speech verdict. Channels without
	 *  inbound capture (hosted adapter, Direct RTC) fall back to their
	 *  legacy stopBuffering contract (returns []). */
	private drainCapturedInboundFrames(reason: 'reconnect' | 'goaway' | 'transfer'): Buffer[] {
		const channel = this.clientTransport as unknown as {
			stopInboundCapture?: () => Array<{
				data: Buffer;
				voiced: boolean;
				gateActiveAtCapture: boolean;
			}>;
		};
		const admitted: Buffer[] = [];
		let voicedCount = 0;
		let discarded = 0;
		if (typeof channel.stopInboundCapture === 'function') {
			for (const f of channel.stopInboundCapture()) {
				if (f.gateActiveAtCapture) {
					discarded++;
					continue;
				}
				// Count ADMITTED voiced frames only: gate-discarded speech never
				// reached the model, so it must not advance the replay-freshness
				// anchor and invalidate an older (still-newest-delivered) candidate.
				if (f.voiced) voicedCount++;
				admitted.push(f.data);
			}
		} else {
			for (const data of this.clientTransport.stopBuffering()) admitted.push(data);
		}
		for (const data of admitted) {
			if (this.normalizeDrainedInbound) {
				this.audioRouter.sendPreAdmitted(data);
			} else {
				this.transport.sendAudio(data.toString('base64')); // G5 rollback: legacy raw bytes
			}
		}
		if (discarded > 0) {
			this.log(`[H2] drain discarded ${discarded} gate-captured frame(s) (reason=${reason})`);
		}
		this.userTurnEvidence.recordBufferedInbound({
			reason,
			voicedFrameCount: voicedCount,
			admittedCount: admitted.length,
			destination: 'llm',
			recordedAtMs: this.nowMs(),
		});
		return admitted;
	}

	/** @internal Observable shadow-parity counters (Phase-1 exit criteria). */
	getSpeechEvidenceShadowCounters(): { compared: number; expected: number; unexpected: number } {
		return { ...this._shadowCounters };
	}

	/** Dual-track forced terminals (Phase 1): forced `complete()` /
	 *  `resetSegment()` calls return the descriptor AFTER their legacy
	 *  callbacks ran; the caller finalizes the ledger with it here. */
	private finalizeForcedVadTerminal(
		desc: VadTerminalDescriptor | null,
	): VadTerminalDescriptor | null {
		if (desc) {
			this.userTurnEvidence.noteResponseEpochAtTerminal(this._responseEpoch);
			this.userTurnEvidence.finalizeSegment({
				segmentId: desc.segmentId,
				outcome: desc.outcome,
				terminalCause: desc.terminalCause,
				resolvedAtMs: desc.resolvedAtMs,
			});
		}
		return desc;
	}

	private logProviderUserTurnRecognition(reason: string): void {
		this.finalizeForcedVadTerminal(this.clientVadDetector.complete('provider-recognition'));
		if (!this.clientVadDetector.lastSpeechCompletedMs) return;
		if (
			this.lastGeminiRecognitionLoggedForSpeechEndMs ===
			this.clientVadDetector.lastSpeechCompletedMs
		)
			return;
		this.lastGeminiRecognitionLoggedForSpeechEndMs = this.clientVadDetector.lastSpeechCompletedMs;
		this.log(
			`[Latency] Provider recognized user input completed (${reason}; ${this.nowMs() - this.clientVadDetector.lastSpeechCompletedMs}ms after client audio VAD end; clientSpeechDuration=${this.clientVadDetector.lastSpeechDurationMs}ms)`,
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
		if (this._assistantAudioStartedAtMs === null) this._assistantAudioStartedAtMs = this.nowMs();
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
		// Echo reference: remember what is being played so the audio router can
		// recognize (and drop) its echo coming back through the client mic.
		this.echoGuard?.feedReference(buffer, this.transport.audioFormat.outputSampleRate);
		if (this.audioOutputObservers.size > 0) {
			this.notifyAudioObservers(this.audioOutputObservers, 'audio-output-observer', buffer, {
				turnId: turn.id,
				sampleRate: this.transport.audioFormat.outputSampleRate,
				encoding: 'pcm',
			});
		}
		this.clientTransport.sendAudioToClient(buffer);
	}

	/** Call each audio observer in turn; a throwing observer is reported through
	 *  `hooks.onError` and never stops the others or the audio path. */
	private notifyAudioObservers<M>(
		observers: ReadonlySet<(pcm: Buffer, meta: M) => void>,
		component: string,
		pcm: Buffer,
		meta: M,
	): void {
		for (const observer of observers) {
			try {
				observer(pcm, meta);
			} catch (e) {
				this.reportError(component, e);
			}
		}
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
		this.log(`LLM transport setup complete (clientConnected=${this._clientConnected})`);
		// Greeting-grace pass 2: finalize the effective grace window against
		// the transport's post-connect capabilities, BEFORE any sendGreeting()
		// call below can request the first audio chunk. Idempotent — safe to
		// re-run on transfer/reconnect setup-complete callbacks, but in
		// practice runs once per VoiceSession lifecycle.
		this.finalizeGreetingInterruptGrace();
		// Resume (§2): prefill the model with the loaded history on the INITIAL connect, BEFORE the
		// ACTIVE transition and any greeting/first send — so the first turn always sees the prior
		// conversation. "Never been ACTIVE" scopes this to the first connection that sets up: the
		// first dial of start(), or the replacement of a host recovery that stranded it before
		// setup (the session is RECONNECTING then, not CONNECTING). Transfer/reconnect of a session
		// that was ACTIVE is excluded (transports self-replay from ReconnectState); the flag + the
		// transport's own guard keep it to exactly one seeding. `replayHistory?.` is a no-op on a
		// transport that does not implement the optional method.
		if (
			this.sessionManager.startedAtMs === null &&
			!this.initialHistoryReplayed &&
			(this.config.initialHistory?.length ?? 0) > 0
		) {
			this.initialHistoryReplayed = true;
			this.transport.replayHistory?.(
				this.conversationContext.toReplayContent({ log: (m) => this.log(m) }),
			);
		}
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
		// Send the greeting only after the same post-restore bootstrap that admits
		// client input. Both setup-complete and client-connect can reach this path;
		// the generation guard keeps it exactly once for the live connection. The
		// host gate and the reattach policy apply here as on the attach path.
		if (this._clientConnected) {
			const generation = this.clientConnectionGeneration;
			const greet = () => {
				if (this.clientAutoActionsSuppressed() || !this.reattachGreetingAllowed()) return;
				this.maybeSendGreetingForClient(generation);
			};
			if (this.memoryAndDirectivesReady) greet();
			else void this._memoryReadyPromise.then(greet);
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

	/** Start the shadow STT when the session becomes ACTIVE. Fire-and-forget. */
	private startShadowStt(): void {
		if (!this.shadowStt) return;
		this.shadowStt.start().catch((err) => this.reportError('shadow-stt', err));
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

		// C1 finalization-path selector (finalization.policy.ts) — the effect
		// ordering below stays here; only the branch decision is extracted.
		const path = decideFinalizationPath(
			{ nativePlaybackGatingActive: this.nativePlaybackGatingActive },
			{ ttsEnabled: this.ttsPipeline !== undefined },
			{
				hasAudio: this.nativeGate?.hasAudio === true,
				dispatchedToolCall: this._nativeResponseDispatchedToolCall,
			},
		);
		// TTS turn gating: when TTS is active, defer turn completion until TTS finishes
		const ttsGate = this.ttsPipeline?.gate;
		if (path === 'tts-gate' && ttsGate) {
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
		if (path === 'native-gate' && this.nativeGate) {
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
	 */
	private finalizeTurn(turn: Turn | null, opts: { interrupted: boolean }): void {
		if (!turn) return;
		if (!turn.finalize()) return; // not the first caller — structural no-op
		// The turn is no longer speaking — close the barge-in eligibility window.
		// (Trailing-audio suppression after an interrupt is the transport's job,
		// via cancelResponse — see handleClientTtsBargeIn.)
		this._assistantAudioStartedAtMs = null;

		// Full-greeting suppression (greetingInterruptible: false) releases at
		// the greeting turn's finalization — the post-playback point on gated
		// paths, turn-bound when the H1 token bound. No-op when unarmed.
		this.greeting.onTurnFinalized(turn.id);

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
			// Re-entry latency anchor: time of this yield (next agent audio closes it).
			this._lastInterruptAtMs = this.nowMs();
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
				this.fence.stampSttCommit(this.turns.numericId);
				safeStep('stt.commit', () => this.sttProvider?.commit(this.turns.numericId));
			}
			safeStep('stt.complete', () => this.sttProvider?.handleTurnComplete());
			this._commitFiredForTurn = false;
		}
		this._turnWasInterrupted = opts.interrupted;

		safeStep('transcript.flush', () => this.transcriptManager.flush());
		// onTurnLatency is emitted by the TurnLatencyTracker on its drain tick,
		// driven by the turn.end publish below (§11) — no direct emission here.
		this.turns.advance();
		this.log(`Turn complete: ${turn.id}`);
		safeStep('publish.turn_end', () => {
			this.eventBus.publish('turn.end', {
				sessionId: this.config.sessionId,
				turnId: turn.id,
			});
			this.clientTransport.sendJsonToClient({ type: 'turn.end', turnId: turn.id });
		});
		safeStep('hook.onTurnFinalized', () =>
			this.hooks.onTurnFinalized?.({
				sessionId: this.config.sessionId,
				turnId: turn.id,
				interrupted: opts.interrupted,
			}),
		);

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

	/** Inject all active directives into the LLM's context to prevent behavioral drift.
	 *
	 *  Sent with turnComplete=false: appends the directive to the conversation
	 *  WITHOUT requesting a model response. A generation-triggering injection makes
	 *  the model speak an unsolicited "self-talk" turn in reply to its own directive
	 *  reminder, so we deliberately leave the turn open and let the user's next audio
	 *  turn commit it via server VAD. Runs on every clean (non-interrupted) turn. */
	private reinforceDirectives(): void {
		const text = this.directiveManager.getReinforcementText();
		if (!text) return;
		if (!this.hold.gate('directive-reinforcement')) return;
		this.log(`Reinforcing directives: ${text.slice(0, 120)}...`);
		this.transport.sendContent([{ role: 'user', text }], false);
	}

	private handleInterrupted(serverTurnId?: number): void {
		// The provider detected user speech over model output: fresh evidence,
		// whichever turn the interrupt resolves to.
		this.hold.release('provider-interrupted');
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

	/** Host recovery boundary: finalize the active turn, if any, as
	 *  interrupted while the incumbent connection is still open. Interrupted
	 *  finalization publishes `turn.interrupted` then `turn.end` once, sends the
	 *  client frames, advances the turn, resets the STT commit latch so the
	 *  replacement turn can commit, and sends no directive reinforcement and no
	 *  notification flush. */
	private abandonActiveTurn(): void {
		this.finalizeTurn(this.turns.active(), { interrupted: true });
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
		// Discard in-flight latency stamps — a reconnect is coming (§11).
		this.eventBus.publish('session.reset', {
			sessionId: this.config.sessionId,
			reason: 'reconnect',
		});
		this.reconnector.handleGoAway(timeLeft);
	}

	// --- Client transport handlers ---

	/**
	 * Thin entry/intercept point for inbound client→server JSON. Stays on
	 * VoiceSession because an example monkey-patches it (and external consumers
	 * may too); the actual dispatch lives in {@link ClientMessageRouter}.
	 */
	private handleJsonFromClient(message: Record<string, unknown>): void {
		// RTC negotiation does not generate model output and must remain available
		// while the media channel is being established. All other client input waits
		// for the post-restore bootstrap; registration order guarantees that the
		// bootstrap callback sends the catalog/config before this callback dispatches.
		const isRtcSignaling =
			typeof message.type === 'string' &&
			(message.type === 'rtc.offer' || message.type === 'rtc.ice_candidate');
		if (!this.clientInputReady && !isRtcSignaling) {
			if (this.pendingClientJson.length >= VoiceSession.MAX_PENDING_CLIENT_JSON) {
				this.log('Dropping client JSON while bootstrap queue is full');
				return;
			}
			this.pendingClientJson.push(message);
			return;
		}
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
			this.nowMs() - this._assistantAudioStartedAtMs >= NATIVE_BARGEIN_ECHO_SKIP_MS
		);
	}

	/**
	 * The live playback-completion gate for this session — the external-TTS gate
	 * when a `ttsProvider` is set, the native-audio gate when native playback-end
	 * gating is active, else `null`. A session is TTS *or* native, never both.
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
	 *  `injectTranscript` / `injectDictationBuffer` interleaving. */
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
	 *  steps complete. */
	private async preEmptForDirectInput(): Promise<void> {
		// Direct input supersedes any held voice candidate: idle a recovery
		// held behind the greeting gate BEFORE the dispatch below releases
		// that gate, or the release would immediately replay the stale
		// utterance ahead of the new input (design §3 supersession rule).
		this.reconnector.cancelHeldRecovery();
		// H1 voice-only guarantee: typed/injected input invalidates the greeting
		// token synchronously (and releases the gate) BEFORE dispatch.
		this.triggerCoordinator.dispatch('direct-input');
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

	/** Typed or injected text is direct user action: fresh evidence that
	 *  releases the synthetic-output hold. It also supersedes a watchdog fire
	 *  the hold held, so that recovery is idled first, as
	 *  `preEmptForDirectInput` does for the greeting gate: the release would
	 *  otherwise re-fire it (replay, nudge or reconnect) ahead of the text. */
	private releaseHoldForDirectInput(): void {
		if (!this.hold.isActive()) return;
		this.reconnector.cancelHeldRecovery();
		this.hold.release('typed-input');
	}

	private handleTextInput(text: string): Promise<void> {
		if (!this.sessionManager.isActive || !text.trim()) return Promise.resolve();
		this.releaseHoldForDirectInput();
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
			this._pendingResponseOrigin = 'user_text';
			this.transport.sendContent([{ role: 'user', text: trimmed }], true);
			this.conversationContext.addUserMessage(trimmed);
		});
	}

	private handleClientConnected(): void {
		this.log(`Client connected (geminiActive=${this.sessionManager.isActive})`);
		this._clientConnected = true;
		this.clientInputReady = false;
		const generation = ++this.clientConnectionGeneration;
		// Greeting interrupt grace: a fresh browser tab / RTC audio context
		// typically means a cold AEC. Reset the window so the next first
		// audio chunk re-arms cleanly. Leaving any prior session's grace
		// active would suppress new-client mic frames before its own first
		// audio chunk armed — leaking the prior session's grace into a
		// different audio context.
		this.greeting.resetForClientConnected();
		// Host attach hook before the bootstrap below: a host resending durable
		// state must reach the client ahead of any automatic output.
		this.safeEmitHook('onClientConnected', () => this.config.onClientConnected?.());
		const bootstrap = () => {
			if (!this._clientConnected || generation !== this.clientConnectionGeneration) return;
			const transportInfo = describeClientTransport(this.config.clientMedia);

			// Restore is complete here. Send pacing before `session.config`, because
			// receiving config is the browser's signal to open its microphone gate.
			this.behaviorManager?.sendCatalog();
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

			this.clientInputReady = true;
			const pending = this.pendingClientJson.splice(0);
			for (const message of pending) this.clientMessageRouter.dispatch(message);
			// Host gate: the client is configured above, but a host that owns
			// recovery also owns what the attach does next (no greeting, context
			// replay or redial).
			if (this.clientAutoActionsSuppressed()) return;
			this.runClientAttachPolicy(generation);
		};

		if (this.memoryAndDirectivesReady) bootstrap();
		else void this._memoryReadyPromise.then(bootstrap);
	}

	/** Reads the host gate once; logs when it suppresses the automatic actions.
	 *  The gate is a host hook read from the attach bootstrap and the setup
	 *  completion, so, as in the reconnector's recovery-ownership check, a throw
	 *  is logged and read as false: the attach runs its automatic actions. */
	private clientAutoActionsSuppressed(): boolean {
		let suppressed: boolean;
		try {
			suppressed = this.config.suppressClientAutoActions?.() === true;
		} catch (e) {
			this.log(
				`Host client auto-action gate threw (treated as not suppressed): ${e instanceof Error ? e.message : String(e)}`,
			);
			return false;
		}
		if (!suppressed) return false;
		this.log('Client auto-actions suppressed by host gate');
		return true;
	}

	/** Whether the reattach greeting policy lets a client be greeted now:
	 *  always under `'per-client'`, and only before the first completed turn
	 *  under `'until-first-turn'`. */
	private reattachGreetingAllowed(): boolean {
		return this.config.reattachGreeting !== 'until-first-turn' || this.turns.numericId === 0;
	}

	/**
	 * What a client attach does once the client is configured, by session state:
	 * ACTIVE greets the client when the reattach policy allows, otherwise
	 * injects the recent conversation as quiet context when
	 * `reattachContextReplay` is set; UPSTREAM_LOST redials through
	 * `recoverUpstream` (fresh dial, no greeting, context after activation);
	 * any other state does nothing.
	 */
	private runClientAttachPolicy(generation: number): void {
		const state = this.sessionManager.state;
		if (state === 'ACTIVE') {
			if (this.reattachGreetingAllowed()) {
				this.maybeSendGreetingForClient(generation);
			} else if (this.config.reattachContextReplay === true) {
				this.injectRecentContext('client-reconnect-context');
			}
			return;
		}
		if (state !== 'UPSTREAM_LOST') return;
		try {
			const { attemptEpoch } = this.recoverUpstream({
				reason: 'human-retry',
				skipContextInjection: false,
				holdSyntheticUntilFreshSpeech: false,
			});
			this.log(`client attach: redialing UPSTREAM_LOST session, attempt ${attemptEpoch}`);
		} catch (error) {
			// Refused synchronously (for example a transport without the recovery
			// primitives): the session stays parked. A dial that fails later
			// parks it again on its own.
			this.log(
				`client attach: cannot redial UPSTREAM_LOST session: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.reportError('recover-upstream', error);
		}
	}

	private maybeSendGreetingForClient(generation: number): void {
		if (
			!this._clientConnected ||
			!this.clientInputReady ||
			generation !== this.clientConnectionGeneration ||
			this.greetingClientGeneration === generation
		) {
			return;
		}
		this.greetingClientGeneration = generation;
		// Only mark the origin when a greeting was actually sent (none configured
		// or held sends nothing) — a stale pending origin would otherwise taint
		// the next real response.
		if (this.greeting.sendGreeting()) {
			this._pendingResponseOrigin = 'assistant_initiated';
		}
	}

	private handleClientDisconnected(): void {
		this.log('Client disconnected');
		this._clientConnected = false;
		this.clientInputReady = false;
		this.pendingClientJson = [];
		this.clientConnectionGeneration++;
		this.safeEmitHook('onClientDisconnected', () => this.config.onClientDisconnected?.());
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
		this.ingestClientAudio(data, 'websocket');
	}

	/** The single entry for inbound client audio from every ingress: the local
	 *  client WebSocket, the direct RTC audio plane and `feedAudioFromClient`.
	 *  Input observers see the frame before the audio router gates it. */
	private ingestClientAudio(data: Buffer, source: 'websocket' | 'rtc'): void {
		if (this.audioInputObservers.size > 0) {
			this.notifyAudioObservers(this.audioInputObservers, 'audio-input-observer', data, {
				source,
				sampleRate: this.clientAudioInputRate,
			});
		}
		this.audioRouter.handleFromClient(data, source);
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

	/** Whether a real client is attached: a connection on the local client
	 *  WebSocket server (never a probe or verifier), or between
	 *  `notifyClientConnected()` and `notifyClientDisconnected()` with a
	 *  host-owned channel. */
	get clientConnected(): boolean {
		return this._clientConnected;
	}

	/**
	 * `readyState` and `bufferedAmount` of the attached client socket, for
	 * example to watch outbound backpressure. `null` when no socket is attached,
	 * and always with `clientSender` or `direct_rtc`, where the host owns the
	 * socket.
	 */
	getClientSocketHealth(): ClientSocketHealth | null {
		return this.clientTransport.getSocketHealth?.() ?? null;
	}

	/**
	 * Close the attached client connection with the given WebSocket close code
	 * and reason (for example `4000, 'goodbye'`). The listener keeps accepting
	 * connections and the session stays up; the socket's close then runs the
	 * usual disconnect handling. Returns `false` when no socket was attached,
	 * and always with `clientSender` or `direct_rtc`, where the host owns the
	 * socket and closes it itself.
	 */
	closeClientConnection(code?: number, reason?: string): boolean {
		return this.clientTransport.closeClient?.(code, reason) ?? false;
	}

	/** Session ID for logging and multi-user association. */
	getSessionId(): string {
		return this.config.sessionId;
	}

	/**
	 * Point-in-time send-path diagnostics; safe to sample on any tick.
	 *
	 * `upstream`/`transportGeneration` are null on transports that do not report
	 * diagnostics (injected fakes, OpenAI, Qwen) — null means unobserved, never
	 * zero. `echoSuppressed` is session-owned (suppressed frames never reach the
	 * transport counters): the echo guard's suppressed count, 0 without one.
	 */
	getDiagnostics(): VoiceSessionDiagnostics {
		const t = this.transport.getDiagnostics?.();
		return {
			upstream: t?.upstream ?? null,
			transportGeneration: t?.transportGeneration ?? null,
			echoSuppressed: this.echoGuard?.suppressedCount ?? 0,
		};
	}

	// --- Host upstream recovery ---

	/**
	 * What this session's recovery surface supports. `RECOVERY_CAPABILITIES`
	 * (everything) for a legacy-orchestration session with
	 * `upstreamLossPolicy: 'hold'` on a transport with `abortIncumbent`,
	 * `currentDialGen` and `currentTransportGeneration` (the Gemini transport).
	 * Otherwise, under policy `'close'`, in actor mode or on another transport,
	 * `recoverUpstream`, `reconnectBoundary` and `syntheticHold` are `false`,
	 * `turnStartPublication` is `true` and `transportGenerations` reports the
	 * transport's generation counters. Gate host recovery on this.
	 */
	getRecoveryCapabilities(): RecoveryCapabilities {
		return this.hostRecovery.getRecoveryCapabilities();
	}

	/**
	 * Abandon the current provider connection and dial a fresh one, without
	 * closing the session. Allowed from CONNECTING, ACTIVE, RECONNECTING
	 * (taking over an automatic reconnect) and UPSTREAM_LOST; the session goes
	 * to RECONNECTING at once and to ACTIVE when the replacement is set up.
	 * From CONNECTING it replaces the first dial of `start()`, still pending,
	 * whose late outcome then settles only `start()`'s promise, or, when the
	 * recovery comes before `start()` dials, `start()` dials nothing and
	 * resolves. Throws `SessionError` when
	 * `getRecoveryCapabilities().recoverUpstream` is `false`, while closing,
	 * or from any other state.
	 *
	 * Before returning it finalizes the active turn as interrupted, aborts the
	 * incumbent connection, publishes `session.reset` and one
	 * `session.reconnectBoundary`, and clears the resumption handle, so the
	 * redial resumes nothing. Tool results and external-STT captures from the
	 * abandoned connection are dropped. No greeting is sent on activation;
	 * with `skipContextInjection: false` the recent conversation is injected
	 * as quiet context. Notifications are held during the dial and one is
	 * delivered on activation when the model is idle.
	 *
	 * Single-flight: a call while a recovery is in flight, including one made
	 * from an event subscriber during this call, returns that recovery's
	 * result. `activated` rejects when the dial or another recovery step
	 * fails, which reports a `recover-upstream` error and parks the session
	 * in UPSTREAM_LOST, or when the session closes or `parkUpstream()` runs
	 * first.
	 */
	recoverUpstream(args: RecoverUpstreamArgs): RecoverUpstreamResult {
		return this.hostRecovery.recoverUpstream(args);
	}

	/**
	 * Clear the resumption handle the session and the transport hold, so the
	 * next dial opens a fresh server session. Returns `true` when the session
	 * held a handle. The connection itself is untouched.
	 */
	clearResumption(): boolean {
		return this.hostRecovery.clearResumption();
	}

	/**
	 * Take the provider connection down on purpose, for example when no client
	 * has been attached for a while: cancels automatic recovery, parks the
	 * session in UPSTREAM_LOST without finalizing it (publishing
	 * `session.upstreamLost` with reason `'host-parked'` and `reason` as its
	 * `detail`), then disconnects the transport. Nothing redials it until
	 * `recoverUpstream()`, which a client attach also calls unless
	 * `suppressClientAutoActions` returns `true`. Rejects with `SessionError`
	 * in actor mode, under `upstreamLossPolicy: 'close'`, while closing, and
	 * outside ACTIVE, RECONNECTING and UPSTREAM_LOST.
	 */
	parkUpstream(reason: string): Promise<void> {
		return this.hostRecovery.parkUpstream(reason);
	}

	// --- Conversation continuity ---

	/**
	 * Start the in-memory conversation over without ending the session, and
	 * return how many items were dropped. Everything up to now is persisted
	 * first, in this order: buffered transcripts are flushed into the context;
	 * every pending user message is sealed with the text it already holds (its
	 * fallback transcript, since a reset cannot wait for an external STT
	 * result); the history writer persists the unflushed items once; then the
	 * items, the checkpoint and the pending ids are cleared, and the retained
	 * user audio and the reconnect replay state are dropped. `reason` is only
	 * logged; no event is published.
	 *
	 * The history stores keep the pre-reset items. Later history flushes, the
	 * next memory extraction, the close report's items, the post-session
	 * snapshot and the context replayed on a reconnect or transfer cover only
	 * items added after the reset. With `memory` configured, an extraction
	 * still in flight during the reset can mark items added after the reset as
	 * processed when it completes. The memory distiller and the history writer
	 * share one checkpoint, so the distiller then skips those items and the
	 * history writer never appends them to the history stores; only the close
	 * report's items list them. A warning is logged on every reset while
	 * `memory` is set.
	 */
	resetConversationContext(reason: string): { cleared: number } {
		if (this.config.memory) {
			this.log(
				'[WARN] resetConversationContext: memory is configured; a memory extraction in flight during the reset can mark items added after the reset as processed when it completes. The memory distiller and the history writer share one checkpoint, so those items are then skipped by the distiller and never appended to the history store.',
			);
		}
		this.transcriptManager.flush();
		for (const timer of this.reservationTimers.values()) clearTimeout(timer);
		this.reservationTimers.clear();
		this.transcriptManager.sealPendingInput();
		this.historyWriter?.flushNow();
		const cleared = this.conversationContext.clear();
		this.utteranceRetainer?.clearAll();
		this.reconnector.resetReplayState();
		this.log(`Conversation context reset (${reason}): ${cleared} item(s) cleared`);
		return { cleared };
	}

	// --- Audio observers ---

	/**
	 * Observe each chunk of native assistant audio as PCM, with its turn id,
	 * right before it is sent to the client. Audio from an external TTS
	 * provider is not observed. A throwing observer is reported through
	 * `hooks.onError` and does not stop delivery. Returns a function that
	 * removes the observer.
	 */
	observeAudioOutput(observer: AudioOutputObserver): () => void {
		this.audioOutputObservers.add(observer);
		return () => {
			this.audioOutputObservers.delete(observer);
		};
	}

	/**
	 * Observe each inbound client audio frame as it enters the session, before
	 * routing or gating, from the local client WebSocket, the direct RTC audio
	 * plane and `feedAudioFromClient()`. A throwing observer is reported
	 * through `hooks.onError` and does not stop the frame. Returns a function
	 * that removes the observer.
	 */
	observeAudioInput(observer: AudioInputObserver): () => void {
		this.audioInputObservers.add(observer);
		return () => {
			this.audioInputObservers.delete(observer);
		};
	}

	// --- Runtime tool and instruction updates ---

	/**
	 * Add tools at runtime: each becomes executable at once and is merged by
	 * name into the declared tool list, which is sent with
	 * `transport.updateSession({ tools })` (applied in place where the
	 * transport supports it, on the next connect on Gemini). A tool missing
	 * from the active agent definition executes inline with immediate
	 * scheduling. An agent transfer declares the new agent's tools instead.
	 *
	 * If `updateSession` rejects, the declared list is restored and the
	 * rejection is passed on; the new executors stay registered. Rejects with
	 * `SessionError` with `orchestrationMode: 'actor'`.
	 */
	async registerTools(tools: ToolDefinition[]): Promise<void> {
		this.assertLegacyOrchestration('registerTools');
		this.toolExecutor.register(tools);
		const merged = new Map(this.currentTools.map((tool) => [tool.name, tool]));
		for (const tool of tools) merged.set(tool.name, tool);
		await this.declareTools([...merged.values()]);
	}

	/**
	 * Replace the declared tool list with exactly `tools`, sent with
	 * `transport.updateSession({ tools })`, for example to restrict what the
	 * model may call. Only the declarations change: every tool registered so
	 * far stays executable. A later `replaceTools()` with the full list
	 * restores the hidden tools.
	 *
	 * If `updateSession` rejects, the declared list is restored and the
	 * rejection is passed on. Rejects with `SessionError` with
	 * `orchestrationMode: 'actor'`.
	 */
	async replaceTools(tools: ToolDefinition[]): Promise<void> {
		this.assertLegacyOrchestration('replaceTools');
		await this.declareTools([...tools]);
	}

	/**
	 * Replace the system instructions, sent with
	 * `transport.updateSession({ instructions })` (applied in place where the
	 * transport supports it, on the next connect on Gemini). An agent transfer
	 * applies the new agent's instructions instead. Rejects with
	 * `SessionError` with `orchestrationMode: 'actor'`.
	 */
	async updateInstructions(instructions: string): Promise<void> {
		this.assertLegacyOrchestration('updateInstructions');
		const previous = this.currentInstructions;
		this.currentInstructions = instructions;
		try {
			await this.transport.updateSession({ instructions });
		} catch (err) {
			if (this.currentInstructions === instructions) this.currentInstructions = previous;
			throw err;
		}
	}

	/** Record `tools` as the declared list and send it to the transport,
	 *  restoring the previous list when the transport rejects it (unless a
	 *  later call has replaced it meanwhile). */
	private async declareTools(tools: ToolDefinition[]): Promise<void> {
		const previous = this.currentTools;
		this.currentTools = tools;
		try {
			await this.transport.updateSession({ tools });
		} catch (err) {
			if (this.currentTools === tools) this.currentTools = previous;
			throw err;
		}
	}

	/** Runtime tool and instruction updates drive the legacy tool router; the
	 *  actor runtime keeps its own tool registry. */
	private assertLegacyOrchestration(method: string): void {
		if (this._isActorMode) {
			throw new SessionError(
				`${method}() is not supported with orchestrationMode 'actor'; runtime tool and instruction updates require legacy orchestration`,
			);
		}
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
		// Discard in-flight latency stamps — unexpected close triggers a
		// reconnect attempt (harmless duplicate after a session close: the
		// tracker is already quiesced then). (§11)
		this.eventBus.publish('session.reset', {
			sessionId: this.config.sessionId,
			reason: 'reconnect',
		});
		this.reconnector.handleTransportClose(code, reason);
	}

	private reportError(component: string, error: unknown): void {
		const err = error instanceof Error ? error : new Error(String(error));
		if (this.hooks.onError) {
			try {
				this.hooks.onError({
					sessionId: this.config.sessionId,
					component,
					error: err,
					severity: 'error',
				});
			} catch (e) {
				// onError is itself a user hook — a throw here must not escape the
				// error-reporting path (it would defeat safeStep/safeEmitHook guards).
				this.log(`onError hook threw: ${(e as Error).message}`);
			}
		}
	}

	/** Invoke an observability hook with throw isolation. FrameworkHooks are
	 *  fire-and-forget: a throwing user-supplied hook must never disrupt the
	 *  turn/VAD/transport path that emitted it. */
	private safeEmitHook(name: string, fn: () => void): void {
		try {
			fn();
		} catch (e) {
			this.log(`hook ${name} threw: ${(e as Error).message}`);
			this.reportError(`hook.${name}`, e);
		}
	}

	/** Compact diagnostic log: HH:MM:SS.mmm [VoiceSession] message */
	private log(msg: string): void {
		const t = new Date().toISOString().slice(11, 23);
		const line = `${t} [VoiceSession] ${msg}`;
		if (this.config.log) this.config.log(line);
		else console.log(line);
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
	 *  Accepts core frames, registered `ClientProtocolServerExtensions`, or an
	 *  application `HostClientFrame` whose `type` is not a core frame type.
	 *
	 *  Safe to call any time after `start()`; no-op when no client is connected. */
	sendJsonToClient<T extends string>(message: AnyServerToClientMessage | HostClientFrame<T>): void {
		this.sendHostFrame(message);
	}

	/** Internal boundary between the host-facing `sendJsonToClient` methods
	 *  (VoiceSession, ToolContext) and the strict `IClientChannel`. Channels
	 *  serialize frames verbatim, and registered frames are already enforced
	 *  at the host method's type, so application frames cross here with one
	 *  cast; `IClientChannel`/`SessionClientSender` stay strict. */
	private sendHostFrame(message: AnyServerToClientMessage | HostClientFrame): void {
		this.clientTransport.sendJsonToClient(message as AnyServerToClientMessage);
	}

	/** Lower-level: inject an arbitrary user message. Serialized via the
	 *  shared direct-input FIFO so back-to-back calls don't race the
	 *  cancel-then-create sequence. */
	injectTranscript(text: string): Promise<void> {
		if (!text) return Promise.resolve();
		// Also the path injectDictationBuffer takes.
		this.releaseHoldForDirectInput();
		return this.enqueueDirectInput(async () => {
			await this.preEmptForDirectInput();
			this._pendingResponseOrigin = 'user_text';
			this.transport.sendContent([{ role: 'user', text }], /* turnComplete */ true);
			// Mirror the existing text-input path: persist into ConversationContext
			// so the user turn shows up in history / memory / subagent context.
			this.conversationContext.addUserMessage(text);
		});
	}

	/**
	 * Inject host-generated text into the model's conversation: live input the
	 * model responds to, or quiet context (see {@link InjectTextOptions}).
	 *
	 * Resolves `true` once the text was handed to the transport (in live mode,
	 * a send the transport accepts into a send buffer counts as handed over)
	 * and `false` when nothing was sent: empty text, the transport not
	 * connected, transcription mode, or a transport send that failed (logged).
	 * It never rejects for a transport failure, so callers can fire and forget
	 * it.
	 *
	 * Unlike {@link injectTranscript}, the text is not recorded in the
	 * `ConversationContext` and an in-flight response is not cancelled.
	 */
	injectText(input: string | ContentTurn[], opts: InjectTextOptions): Promise<boolean> {
		return this.injectTextInternal(input, { mode: opts.mode });
	}

	/**
	 * Send an image or audio clip (base64) to the model as realtime input
	 * through `transport.sendFile`, e.g. a camera or screen frame. Nothing is
	 * recorded in the conversation history. Returns `false`, sending nothing,
	 * in transcription mode or when the transport is not connected, and
	 * `false` when the transport send throws (the error is logged, never
	 * rethrown); otherwise `true`, and the transport decides which MIME types it
	 * carries (the Gemini transport takes `image/*` and `audio/*`).
	 */
	sendRealtimeMedia(base64Data: string, mimeType: string): boolean {
		if (!this.transport.isConnected || !this.dictation.isAgentMode()) return false;
		try {
			this.transport.sendFile(base64Data, mimeType);
		} catch (err) {
			this.log(
				`sendRealtimeMedia(${mimeType}) failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
		return true;
	}

	/** The injection path behind {@link injectText}, with the options that
	 *  framework-generated corrections need. With `preempt` it runs on the
	 *  direct-input FIFO; otherwise it sends immediately. */
	private injectTextInternal(
		input: string | ContentTurn[],
		opts: InjectTextInternalOptions,
	): Promise<boolean> {
		const turns: ContentTurn[] =
			typeof input === 'string' ? [{ role: 'user', text: input }] : input;
		if (!turns.some((t) => t.text.trim())) return Promise.resolve(false);
		if (!opts.preempt) return this.sendInjectedText(turns, opts);
		let sent = false;
		return this.enqueueDirectInput(async () => {
			sent = await this.sendInjectedText(turns, opts);
		}).then(() => sent);
	}

	/** A framework-generated live correction for turn `turnId` (the shadow STT's
	 *  self-correction). It runs on the direct-input FIFO, pre-empts the
	 *  in-flight answer, and sends nothing while the synthetic-output hold is
	 *  engaged or outside agent mode. Its validity is checked once at the head
	 *  of the FIFO, before its own preemption finalizes the turn: newer typed
	 *  input that already pre-empted `turnId` has moved the turn on, and the
	 *  correction is dropped. Resolves whether it was sent. */
	private sendSyntheticLiveText(
		turns: ContentTurn[],
		origin: string,
		turnId: number,
	): Promise<boolean> {
		return this.injectTextInternal(turns, {
			mode: 'live',
			preempt: true,
			respectSyntheticHold: true,
			origin,
			stillValid: () => this.turns.numericId === turnId,
		});
	}

	/** Checks, optional preemption and the send itself. Never rejects. */
	private async sendInjectedText(
		turns: ContentTurn[],
		opts: InjectTextInternalOptions,
	): Promise<boolean> {
		const origin = opts.origin ?? 'host-inject';
		const skip = (why: string): false => {
			this.log(`injectText (${origin}): not sent — ${why}`);
			return false;
		};
		if (!this.transport.isConnected) return skip('transport not connected');
		if (!this.dictation.isAgentMode()) return skip('transcription mode');
		// Before any preemption, so a held injection leaves the in-flight turn alone.
		if (opts.respectSyntheticHold && this.isSyntheticHoldActive()) {
			return skip('synthetic output is held');
		}
		try {
			if (opts.stillValid && !opts.stillValid()) return skip('no longer valid');
			if (opts.preempt) await this.preEmptForDirectInput();
			if (opts.mode === 'quiet') {
				this.transport.sendContent(turns, false);
				return true;
			}
			// Generation-capable: invalidate a live greeting token so the
			// response can never bind as the greeting (as guardedTriggerGeneration
			// does). The input has no user speech to measure latency from.
			this.triggerCoordinator.dispatch('assistant-initiated');
			this._pendingResponseOrigin = 'assistant_initiated';
			if (!this.transport.sendLiveText) {
				this.transport.sendContent(turns, true);
				return true;
			}
			const sent = this.transport.sendLiveText(turns);
			if (!sent) this.log(`injectText (${origin}): live text was not delivered`);
			return sent;
		} catch (err) {
			this.log(
				`injectText (${origin}): send failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	/** Quietly (no response requested) inject the last ten user and assistant
	 *  items, 150 characters each, as context for a connection that starts
	 *  without the server-side conversation. Suppressed (logged) while synthetic
	 *  output is held; nothing is sent when there is no conversation yet. */
	private injectRecentContext(
		origin: 'gemini-reconnect-context' | 'client-reconnect-context',
	): void {
		const recent = this.conversationContext.items
			.filter((item) => item.role === 'user' || item.role === 'assistant')
			.slice(-10)
			.map((item) => `${item.role}: ${item.content.slice(0, 150)}`)
			.join('\n');
		if (!recent) return;
		if (!this.hold.gate(origin)) return;
		const lead =
			origin === 'client-reconnect-context' ? 'The client reconnected.' : 'You just reconnected.';
		this.transport.sendContent(
			[
				{
					role: 'user',
					text: `[System: ${lead} Here is the recent conversation for context. Do NOT act on this content. Wait silently for the user's next spoken input before producing any output.]\n${recent}`,
				},
			],
			false,
		);
		this.log(`Injected recent conversation context (${origin})`);
	}

	/** Whether the synthetic-output hold is engaged: after a
	 *  `recoverUpstream({ holdSyntheticUntilFreshSpeech: true })`, until the user
	 *  is heard again (input transcription, an external STT final, a provider
	 *  interruption, or typed or injected text; microphone audio alone does not
	 *  count). While it is, framework-generated output (greeting, directive
	 *  reinforcement, notifications, injected context) is held. */
	isSyntheticHoldActive(): boolean {
		return this.hold.isActive();
	}

	/** Deliver one held-back notification once a dial window has released the
	 *  notification hold, but only while the model is idle: no framework turn
	 *  open and no requested response still waiting to start. Otherwise the
	 *  next turn completion delivers it, as usual. */
	private drainNotificationsWhenIdle(): void {
		if (this.turns.active() !== null || this._pendingResponseOrigin !== null) return;
		this.notificationSink.turnComplete();
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
	 *  silently leaking audio into a dictation flow. Triggers nothing (logged)
	 *  while the synthetic-output hold is engaged. */
	guardedTriggerGeneration(
		instructions?: string,
		overrides?: Parameters<LLMTransport['triggerGeneration']>[1],
	): void {
		if (!this.dictation.isAgentMode()) {
			throw new Error(
				`TRANSCRIPTION_MODE_LOCKED: triggerGeneration is blocked while transcription mode is '${this.dictation.mode}'`,
			);
		}
		// A framework-owned proactive generation is synthetic output: nothing
		// is triggered while the hold is engaged.
		if (!this.hold.gate('assistant-initiated')) return;
		// Generation-capable path: invalidate a live greeting token so the
		// triggered turn can never bind as the greeting (H1 enforcement).
		this.triggerCoordinator.dispatch('assistant-initiated');
		this._pendingResponseOrigin = 'assistant_initiated';
		this.transport.triggerGeneration(instructions, overrides);
	}
}
