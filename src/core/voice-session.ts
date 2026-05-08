// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { resolveAgentWithKnowledgeBase } from '../agent/agent-context.js';
import { AgentRouter } from '../agent/agent-router.js';
import type { BackgroundAgent } from '../agent/background-agent.js';
import { PersistentSubagentManager } from '../agent/persistent-subagent-manager.js';
import type { SubagentMessage } from '../agent/subagent-session.js';
import { resamplePcm } from '../audio/resample.js';
import { BehaviorManager } from '../behaviors/behavior-manager.js';
import { MemoryDistiller } from '../memory/memory-distiller.js';
import type { ToolRoutingInfo } from '../runtime/actors/tool-router-actor.js';
import { GeminiTransportAdapter } from '../runtime/adapters/gemini-transport-adapter.js';
import type { KnownNotificationLabel } from '../runtime/messages.js';
import { RuntimeOrchestrator } from '../runtime/runtime-orchestrator.js';
import { ToolExecutor } from '../tools/tool-executor.js';
import { createClientChannel } from '../transport/client-channel-factory.js';
import { DirectRtcClientChannel } from '../transport/direct-rtc-client-channel.js';
import {
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
import { tryParseRtcClientSignaling } from '../types/rtc-signaling.js';
import type { IClientChannel } from '../types/session-client.js';
import type { SessionClientSender } from '../types/session-client.js';
import type { ToolDefinition } from '../types/tool.js';
import type { LLMTransport, LLMTransportError, STTProvider } from '../types/transport.js';
import type { TTSAudioConfig, TTSProvider } from '../types/tts.js';
import type { ArtifactRef, ArtifactStore, SaveArtifactParams } from '../types/workspace.js';
import { BackgroundNotificationQueue } from './background-notification-queue.js';
import { ConversationContext } from './conversation-context.js';
import { ConversationHistoryWriter } from './conversation-history-writer.js';
import { DirectiveManager } from './directive-manager.js';
import { EventBus } from './event-bus.js';
import { HooksManager } from './hooks.js';
import { InteractionModeManager } from './interaction-mode.js';
import { MemoryCacheManager } from './memory-cache-manager.js';
import { MultiplexConversationHistoryStore } from './multiplex-conversation-history-store.js';
import { SessionManager } from './session-manager.js';
import { ToolCallRouter } from './tool-call-router.js';
import { TranscriptManager } from './transcript-manager.js';

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
	/** LLM model name (e.g. "gemini-live-2.5-flash-preview"). */
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
	private clientTransport: IClientChannel;
	/** Set when `clientMedia.kind === 'direct_rtc'` for WebSocket JSON signaling routing. */
	private directRtcChannel: DirectRtcClientChannel | null = null;
	private agentRouter: AgentRouter;
	private toolExecutor: ToolExecutor;
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
	private turnId = 0;
	private sttProvider?: STTProvider;
	private _commitFiredForTurn = false;
	/** True when the current turn was interrupted — skips Gemini transcript correction. */
	private _turnWasInterrupted = false;
	// --- TTS state (actor-mode only) ---
	private ttsProvider?: TTSProvider;
	private _ttsCurrentRequestId = 0;
	private _ttsTurnHasText = false;
	private _ttsLlmTextDone = false;
	private _ttsAudioDone = false;
	private _ttsSpeaking = false;
	private _ttsFormat?: TTSAudioConfig;
	private _ttsIdleTimer?: ReturnType<typeof setTimeout>;
	private _ttsHardTimer?: ReturnType<typeof setTimeout>;
	private _ttsFirstTextMs = 0;
	private _ttsFirstAudioMs = 0;
	private _ttsTextLength = 0;
	private config: VoiceSessionConfig;
	private directiveManager = new DirectiveManager();
	private transcriptManager!: TranscriptManager;
	/** Whether a client WebSocket connection is currently active. */
	private clientConnected = false;
	/**
	 * Legacy in-process notification queue. Constructed only when
	 * `orchestrationMode !== 'actor'`. In actor mode, NotificationActor
	 * (`src/runtime/actors/notification-actor.ts`) takes over, and every
	 * legacy call site that touches `this.notificationQueue` is guarded
	 * with `if (this.notificationQueue)` or branched on `_isActorMode`.
	 */
	private notificationQueue?: BackgroundNotificationQueue;
	private interactionMode = new InteractionModeManager();
	/** True when `config.orchestrationMode === 'actor'`. */
	private _isActorMode = false;
	/**
	 * Per-turn debounce flag for `notification.audio_started` (actor mode only).
	 * Set on first audio chunk of a turn; cleared on turn-complete, interrupt,
	 * and pre-greeting. The audio-fast-path contract requires we send the
	 * debounced control-plane signal once per turn — never per chunk.
	 */
	private _audioStartedThisTurn = false;
	/** Tracks consecutive reconnect attempts to prevent infinite reconnect storms. */
	private reconnectAttempts = 0;
	private static readonly MAX_RECONNECT_ATTEMPTS = 3;
	private static readonly RECONNECT_BACKOFF_MS = [1000, 2000, 4000];
	/** Resolves when memory/directives are loaded; used so greeting is sent after load without blocking connect. */
	private _memoryReadyPromise: Promise<void> = Promise.resolve();
	private externalAudioHandler: ((data: Buffer) => void) | null = null;
	private audioVadSpeechActive = false;
	private audioVadSpeechStartMs = 0;
	private audioVadLastVoiceMs = 0;
	private lastClientSpeechCompletedMs = 0;
	private lastClientSpeechDurationMs = 0;
	private lastGeminiRecognitionLoggedForSpeechEndMs = 0;
	private lastInputTranscriptionLogText = '';
	private ownsClientTransport: boolean;
	private static readonly AUDIO_VAD_SILENCE_MS = 500;
	private static readonly AUDIO_VAD_MIN_SPEECH_MS = 120;
	private static readonly AUDIO_VAD_PEAK_THRESHOLD = 1200;
	private static readonly AUDIO_VAD_AVG_ABS_THRESHOLD = 220;

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
			this.transport.updateSession({
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

		// Wire LLMTransport property callbacks — works for both injected and default transports
		this.transport.onAudioOutput = (data) => this.handleAudioOutput(data);
		this.transport.onToolCall = (calls) => {
			if (this.runtimeOrchestrator) {
				const names = calls.map((c) => c.name).join(', ');
				this.logGeminiUserTurnRecognition('tool call received');
				const sinceVadEnd = this.lastClientSpeechCompletedMs
					? ` (${Date.now() - this.lastClientSpeechCompletedMs}ms after client audio VAD end)`
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
		this.transport.onTurnComplete = () => this.handleTurnComplete();
		this.transport.onInterrupted = () => this.handleInterrupted();
		this.transport.onOutputTranscription = (text) => this.transcriptManager.handleOutput(text);
		this.transport.onSessionReady = (sessionId) => this.handleSetupComplete(sessionId);
		this.transport.onError = (error) => this.handleTransportError(error);
		this.transport.onClose = (code, reason) => this.handleTransportClose(code, reason);
		this.transport.onGoAway = (timeLeft) => this.handleGoAway(timeLeft);
		this.transport.onResumptionUpdate = (handle, resumable) =>
			this.handleResumptionUpdate(handle, resumable);
		this.transport.onGroundingMetadata = (metadata) => this.handleGroundingMetadata(metadata);

		// Wire STT: streaming provider for real-time display, Gemini built-in for
		// post-hoc correction. Both paths can be active simultaneously.
		if (config.sttProvider) {
			this.sttProvider = config.sttProvider;

			// Configure with the transport's actual audio format
			this.sttProvider.configure({
				sampleRate: this.transport.audioFormat.inputSampleRate,
				bitDepth: this.transport.audioFormat.bitDepth,
				channels: this.transport.audioFormat.channels,
			});

			// Wire callbacks — turn-aware ordering protection.
			// Accept results from the current turn or the immediately preceding turn.
			// Batch STT providers fire results asynchronously (e.g., generateContent API call)
			// which may complete after handleTurnComplete increments this.turnId. Using
			// `turnId < this.turnId - 1` prevents dropping valid late results while still
			// rejecting truly stale transcripts from 2+ turns ago.
			this.sttProvider.onTranscript = (text, turnId) => {
				if (turnId !== undefined && turnId < this.turnId - 1) return; // Drop stale results (2+ turns old)
				this.transcriptManager.handleInput(text);
			};
			this.sttProvider.onPartialTranscript = (text) => {
				this.transcriptManager.handleInputPartial(text);
			};

			// Wire Gemini built-in transcription as authoritative correction.
			// Skipped on interrupted turns — Gemini may miss audio spoken during
			// model output, producing incomplete transcripts.
			this.transport.onInputTranscription = (text) => {
				this.logInputTranscriptionLatency(text, 'gemini-correction');
				if (this._turnWasInterrupted) return;
				this.transcriptManager.correctInput(text);
			};
		} else {
			// No external STT — use transport built-in transcription
			this.transport.onInputTranscription = (text) => {
				this.logInputTranscriptionLatency(text, 'gemini');
				this.transcriptManager.handleInput(text);
			};
		}

		// Wire onModelTurnStart for STT commit trigger
		this.transport.onModelTurnStart = () => {
			this.logGeminiUserTurnRecognition('model/tool processing started');
			if (this.sttProvider && !this._commitFiredForTurn) {
				this._commitFiredForTurn = true;
				this.sttProvider.commit(this.turnId);
			}
		};

		// Wire TTS provider (actor-mode only)
		if (config.ttsProvider && config.orchestrationMode === 'actor') {
			this.ttsProvider = config.ttsProvider;
			this.wireTtsProvider();
		}

		const clientMedia = config.clientMedia ?? DEFAULT_CLIENT_MEDIA_PROFILE;
		const directRtcMedia =
			clientMedia.kind === 'direct_rtc' && clientMedia.rtcAudio === 'werift_opus'
				? {
						inputPcmSampleRate: this.transport.audioFormat.inputSampleRate,
						outputPcmSampleRate: this.transport.audioFormat.outputSampleRate,
						onInboundPcm: (pcm: Buffer) => this.handleAudioFromClient(pcm, 'rtc'),
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
				onAudioFromClient: (data) => this.handleAudioFromClient(data, 'websocket'),
				onJsonFromClient: (message) => this.handleJsonFromClient(message),
				onClientConnected: () => this.handleClientConnected(),
				onClientDisconnected: () => this.handleClientDisconnected(),
			},
		});
		this.directRtcChannel =
			this.clientTransport instanceof DirectRtcClientChannel ? this.clientTransport : null;

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
		if (this.ttsProvider) {
			this.agentRouter.responseModality = 'text';
		}

		this.transport.onRealtimeLLMUsage = (usage) => {
			if (this.hooks.onRealtimeLLMUsage) {
				this.hooks.onRealtimeLLMUsage({
					sessionId: this.config.sessionId,
					agentName: this.agentRouter.activeAgent.name,
					usage,
				});
			}
		};

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
				sendToolResult: (result) => this.transport.sendToolResult(result),
				transfer: (toAgent) => this.transfer(toAgent),
				reportError: (component, error) => this.reportError(component, error),
				log: (msg) => this.log(msg),
			});
		}
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
		if (this._isActorMode) {
			this.runtimeOrchestrator?.runtime.tell(
				'notification.publish',
				{ label, text, priority },
				'notification',
			);
			return;
		}
		this.notificationQueue?.sendOrQueue(
			[{ role: 'user', parts: [{ text: `[${label}]: ${text}` }] }],
			true,
			{ priority },
		);
	}

	/**
	 * Internal helper for actor-mode SYSTEM notifications. Centralizes the
	 * `runtime.tell('notification.publish', ...)` call shape used by the
	 * background-tool completion path. Caller passes only the body text;
	 * TransportActor wraps it as `[SYSTEM]: text` at the wire-out boundary.
	 */
	private publishSystemNotification(text: string): void {
		this.runtimeOrchestrator?.runtime.tell(
			'notification.publish',
			{ label: 'SYSTEM', text, priority: 'normal' },
			'notification',
		);
	}

	/** Start the client WebSocket server and connect to the LLM transport. */
	async start(): Promise<void> {
		// Validate TTS config
		if (this.ttsProvider) {
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
		await this.ttsProvider?.start();
		if (this.runtimeOrchestrator) {
			await this.runtimeOrchestrator.start();
		}

		// Load memory and directives in parallel with Gemini connect so session starts fast
		this._memoryReadyPromise = this.loadMemoryAndDirectives();

		await this.clientTransport.start();
		this.log('Connecting to LLM transport...');
		this.sessionManager.transitionTo('CONNECTING');
		if (this.config.transport) {
			if (this.ttsProvider) {
				this.transport.updateSession({ responseModality: 'text' });
			}
			await this.transport.connect();
		} else {
			await this.transport.connect({
				auth: { type: 'api_key', apiKey: this.config.apiKey },
				model: this.config.geminiModel ?? 'gemini-live-2.5-flash-preview',
				...(this.resolvedRealtimeInputConfig
					? {
							realtimeInputConfig: this.resolvedRealtimeInputConfig as Record<string, unknown>,
						}
					: {}),
				...(this.ttsProvider ? { responseModality: 'text' as const } : {}),
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

		// Flush any buffered transcription before closing
		this.transcriptManager.flush();

		// Fire turn end if we're mid-turn
		if (this.turnId > 0) {
			this.eventBus.publish('turn.end', {
				sessionId: this.config.sessionId,
				turnId: `turn_${this.turnId}`,
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
		this.ttsClearTimers();
		await this.ttsProvider?.stop();
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
			this.sendGreeting();
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

	// --- Audio fast-path (no EventBus) ---

	private handleAudioFromClient(data: Buffer, source: 'websocket' | 'rtc' = 'websocket'): void {
		if (source === 'websocket' && this.directRtcChannel?.isRtcAudioReady) {
			return;
		}
		if (this.sessionManager.isActive) {
			this.updateClientAudioVad(data);
			// When active agent uses external audio, don't forward to LLM transport.
			// Route mic frames to the active external audio handler (e.g., TwilioBridge).
			if (this.agentRouter.activeAgent.audioMode === 'external') {
				if (this.externalAudioHandler) {
					try {
						this.externalAudioHandler(data);
					} catch (err) {
						this.reportError('external-audio', err instanceof Error ? err : new Error(String(err)));
					}
				}
				return;
			}
			const base64 = data.toString('base64');
			this.transport.sendAudio(base64);
			this.sttProvider?.feedAudio(base64);
		}
	}

	private updateClientAudioVad(data: Buffer): void {
		if (data.length < 2) return;

		let maxAbs = 0;
		let sumAbs = 0;
		let samples = 0;
		for (let i = 0; i + 1 < data.length; i += 2) {
			const abs = Math.abs(data.readInt16LE(i));
			if (abs > maxAbs) maxAbs = abs;
			sumAbs += abs;
			samples += 1;
		}
		if (samples === 0) return;

		const now = Date.now();
		const avgAbs = sumAbs / samples;
		const hasVoice =
			maxAbs >= VoiceSession.AUDIO_VAD_PEAK_THRESHOLD ||
			avgAbs >= VoiceSession.AUDIO_VAD_AVG_ABS_THRESHOLD;

		if (hasVoice) {
			if (!this.audioVadSpeechActive) {
				this.audioVadSpeechActive = true;
				this.audioVadSpeechStartMs = now;
				this.lastInputTranscriptionLogText = '';
				this.log(
					`[Latency] User voice input started (client audio VAD; peak=${maxAbs}; avgAbs=${Math.round(avgAbs)})`,
				);
			}
			this.audioVadLastVoiceMs = now;
			return;
		}

		if (
			this.audioVadSpeechActive &&
			this.audioVadLastVoiceMs > 0 &&
			now - this.audioVadLastVoiceMs >= VoiceSession.AUDIO_VAD_SILENCE_MS
		) {
			this.completeClientAudioVad(now, 'silence');
		}
	}

	private completeClientAudioVad(now: number, reason: string): 'completed' | 'ignored' | 'none' {
		if (!this.audioVadSpeechActive || this.audioVadLastVoiceMs <= 0) return 'none';
		const speechEndMs = this.audioVadLastVoiceMs;
		const speechDurationMs = Math.max(0, speechEndMs - this.audioVadSpeechStartMs);
		const silenceObservedMs = now - speechEndMs;
		this.audioVadSpeechActive = false;
		this.audioVadSpeechStartMs = 0;
		this.audioVadLastVoiceMs = 0;
		if (speechDurationMs < VoiceSession.AUDIO_VAD_MIN_SPEECH_MS) {
			this.log(
				`[Latency] User voice input ignored (client audio VAD; reason=${reason}; speechDuration=${speechDurationMs}ms; silenceObserved=${silenceObservedMs}ms; minSpeechDuration=${VoiceSession.AUDIO_VAD_MIN_SPEECH_MS}ms)`,
			);
			return 'ignored';
		}
		this.lastClientSpeechCompletedMs = speechEndMs;
		this.lastClientSpeechDurationMs = speechDurationMs;
		this.log(
			`[Latency] User voice input completed (client audio VAD; reason=${reason}; speechDuration=${this.lastClientSpeechDurationMs}ms; silenceObserved=${silenceObservedMs}ms)`,
		);
		return 'completed';
	}

	private logInputTranscriptionLatency(text: string, source: string): void {
		const trimmed = text.trim();
		if (!trimmed || trimmed === this.lastInputTranscriptionLogText) return;
		this.lastInputTranscriptionLogText = trimmed;
		const sinceVadEnd = this.lastClientSpeechCompletedMs
			? `; ${Date.now() - this.lastClientSpeechCompletedMs}ms after client audio VAD end`
			: '';
		const preview = trimmed.replace(/\s+/g, ' ').slice(0, 120);
		this.log(
			`[Latency] Gemini input transcription update (${source}; chars=${trimmed.length}${sinceVadEnd}; text="${preview}")`,
		);
	}

	private logGeminiUserTurnRecognition(reason: string): void {
		this.completeClientAudioVad(Date.now(), 'gemini-recognition');
		if (!this.lastClientSpeechCompletedMs) return;
		if (this.lastGeminiRecognitionLoggedForSpeechEndMs === this.lastClientSpeechCompletedMs) return;
		this.lastGeminiRecognitionLoggedForSpeechEndMs = this.lastClientSpeechCompletedMs;
		this.log(
			`[Latency] Gemini Live recognized user input completed (${reason}; ${Date.now() - this.lastClientSpeechCompletedMs}ms after client audio VAD end; clientSpeechDuration=${this.lastClientSpeechDurationMs}ms)`,
		);
	}

	private handleAudioOutput(data: string): void {
		this.signalAudioStarted();
		const buffer = Buffer.from(data, 'base64');
		this.clientTransport.sendAudioToClient(buffer);
	}

	/**
	 * Signal that the model has begun producing audio this turn. In legacy
	 * mode this calls `notificationQueue.markAudioReceived()`. In actor mode
	 * this debounces (once per turn) and sends `notification.audio_started`
	 * through the runtime — keeping audio chunks themselves off the actor
	 * mailbox per the audio fast-path contract.
	 */
	private signalAudioStarted(): void {
		if (this._isActorMode) {
			if (!this._audioStartedThisTurn) {
				this._audioStartedThisTurn = true;
				this.runtimeOrchestrator?.runtime.tell('notification.audio_started', {}, 'notification');
			}
			return;
		}
		this.notificationQueue?.markAudioReceived();
	}

	// --- TTS wiring (actor-mode only) ---

	/** Wire TTSProvider callbacks and override transport callbacks for text mode. */
	private wireTtsProvider(): void {
		const tts = this.ttsProvider;
		if (!tts) return;

		// Configure TTS with preferred output format
		const preferredFormat: TTSAudioConfig = {
			sampleRate: this.transport.audioFormat.outputSampleRate,
			bitDepth: 16,
			channels: 1,
			encoding: 'pcm',
		};
		this._ttsFormat = tts.configure(preferredFormat);

		// Wire LLM text output → TTS provider + transcript
		this.transport.onTextOutput = (text) => {
			this.transcriptManager.handleOutput(text);
			// Skip empty/whitespace-only chunks for TTS to avoid invalid transcript
			// errors from providers that require meaningful initial text.
			if (!text || text.trim().length === 0) {
				return;
			}

			if (!this._ttsTurnHasText) {
				this._ttsCurrentRequestId++;
				this._ttsTurnHasText = true;
				this._ttsFirstTextMs = Date.now();
				this._ttsFirstAudioMs = 0;
				this._ttsTextLength = 0;
			}
			this._ttsTextLength += text.length;
			tts.synthesize(text, this._ttsCurrentRequestId);
		};

		// When LLM text stream ends — flush TTS buffer (does NOT mean end-of-request)
		this.transport.onTextDone = () => {
			if (this._ttsTurnHasText) {
				tts.synthesize('', this._ttsCurrentRequestId, { flush: true });
			}
		};

		// Wire TTS audio output → client (fast-path, with stale filtering + resampling)
		tts.onAudio = (base64Pcm, _durationMs, requestId) => {
			if (requestId !== this._ttsCurrentRequestId) return; // stale
			let buffer: Buffer = Buffer.from(base64Pcm, 'base64');
			if (
				this._ttsFormat &&
				this._ttsFormat.sampleRate !== this.transport.audioFormat.outputSampleRate
			) {
				buffer = resamplePcm(
					buffer,
					this._ttsFormat.sampleRate,
					this.transport.audioFormat.outputSampleRate,
					this._ttsFormat.bitDepth,
				);
			}
			this.clientTransport.sendAudioToClient(buffer);
			this.signalAudioStarted();
			this._ttsSpeaking = true;
			if (this._ttsFirstAudioMs === 0) {
				this._ttsFirstAudioMs = Date.now();
			}
			// Reset idle watchdog on each audio chunk
			this.ttsResetIdleTimer();
		};

		// Wire TTS done → turn gating + hook
		tts.onDone = (requestId) => {
			if (requestId !== this._ttsCurrentRequestId) return; // stale
			this._ttsAudioDone = true;
			this._ttsSpeaking = false;
			this.ttsClearTimers();
			// Fire TTS synthesis hook with timing metrics
			if (this.hooks.onTTSSynthesis && this._ttsFirstTextMs > 0) {
				const now = Date.now();
				this.hooks.onTTSSynthesis({
					sessionId: this.config.sessionId,
					provider: tts.constructor.name,
					textLength: this._ttsTextLength,
					durationMs: now - this._ttsFirstTextMs,
					audioMs: 0, // Would require tracking total audio duration
					ttfbMs: this._ttsFirstAudioMs > 0 ? this._ttsFirstAudioMs - this._ttsFirstTextMs : 0,
					requestId,
				});
			}
			this.ttsMaybeCompleteTurn();
		};

		// Wire TTS errors
		tts.onError = (error, fatal) => {
			this.log(`TTS error (fatal=${fatal}): ${error.message}`);
			if (this.hooks.onError) {
				this.hooks.onError({
					component: 'tts',
					error,
					severity: fatal ? 'fatal' : 'warn',
				});
			}
			if (fatal) {
				this.close('tts_fatal_error');
			}
		};

		// Wire word boundaries to client
		tts.onWordBoundary = (word, offsetMs, requestId) => {
			if (requestId !== this._ttsCurrentRequestId) return;
			this.clientTransport.sendJsonToClient({
				type: 'word_boundary',
				word,
				offsetMs,
				requestId,
			});
		};

		// Wire speech-started for TTS barge-in (LLM idle but TTS still playing)
		this.transport.onSpeechStarted = () => {
			if (this._ttsSpeaking && this._ttsLlmTextDone) {
				this.handleInterrupted();
			}
		};

		// Disable native audio output and output transcription in TTS mode
		this.transport.onAudioOutput = undefined;
		this.transport.onOutputTranscription = undefined;
	}

	/** Turn gating: check if both LLM and TTS are done. */
	private ttsMaybeCompleteTurn(): void {
		if (this._ttsLlmTextDone && this._ttsAudioDone) {
			this._ttsLlmTextDone = false;
			this._ttsAudioDone = false;
			this._ttsTurnHasText = false;
			this.ttsClearTimers();
			this.handleTurnCompleteInternal();
		}
	}

	/** Reset the idle watchdog timer (called on each TTS audio chunk). */
	private ttsResetIdleTimer(): void {
		if (this._ttsIdleTimer) clearTimeout(this._ttsIdleTimer);
		this._ttsIdleTimer = setTimeout(() => {
			this.log('TTS idle watchdog fired — forcing turn completion');
			this._ttsAudioDone = true;
			this._ttsSpeaking = false;
			this._ttsCurrentRequestId++; // Invalidate late-arriving chunks
			this.ttsMaybeCompleteTurn();
		}, 2000);
	}

	/** Clear all TTS timers. */
	private ttsClearTimers(): void {
		if (this._ttsIdleTimer) {
			clearTimeout(this._ttsIdleTimer);
			this._ttsIdleTimer = undefined;
		}
		if (this._ttsHardTimer) {
			clearTimeout(this._ttsHardTimer);
			this._ttsHardTimer = undefined;
		}
	}

	// --- Gemini event handlers ---

	private handleSetupComplete(_sessionId: string): void {
		this.log(`Gemini setup complete (clientConnected=${this.clientConnected})`);
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
			this._memoryReadyPromise.then(() => this.sendGreeting());
		}
	}

	/** Start STT when session becomes ACTIVE (agent ready). Fire-and-forget. */
	private startSttProvider(): void {
		if (!this.sttProvider) return;
		this.sttProvider.start().catch((err) => this.reportError('stt', err));
	}

	private handleTurnComplete(): void {
		// A completed turn means the connection is healthy — reset reconnect counter
		this.reconnectAttempts = 0;

		// TTS turn gating: when TTS is active, defer turn completion until TTS finishes
		if (this.ttsProvider) {
			this._ttsLlmTextDone = true;
			if (!this._ttsTurnHasText) {
				// Tool-call-only turn — no text synthesized, TTS won't fire onDone
				this._ttsAudioDone = true;
			} else {
				// Start hard cap timer (60s) to prevent stuck turns
				if (!this._ttsHardTimer) {
					this._ttsHardTimer = setTimeout(() => {
						this.log('TTS hard cap timer fired — forcing turn completion');
						this._ttsAudioDone = true;
						this._ttsSpeaking = false;
						this._ttsCurrentRequestId++; // Invalidate late-arriving chunks
						this.ttsMaybeCompleteTurn();
					}, 60000);
				}
			}
			this.ttsMaybeCompleteTurn();
			return; // Defer — actual turn-end runs via ttsMaybeCompleteTurn
		}

		this.handleTurnCompleteInternal();
	}

	/** Core turn-end logic — called directly (no TTS) or via ttsMaybeCompleteTurn (TTS gate). */
	private handleTurnCompleteInternal(): void {
		// ORDERING: STT commit + cleanup BEFORE turnId increment.
		// This ensures commit(turnId) uses the turn being completed, and
		// stale-drop (turnId < this.turnId) correctly rejects prior-turn results.
		if (this.sttProvider) {
			if (!this._commitFiredForTurn) {
				this.sttProvider.commit(this.turnId); // Safety-net commit
			}
			this.sttProvider.handleTurnComplete();
			this._commitFiredForTurn = false;
			this._turnWasInterrupted = false;
		}

		this.transcriptManager.flush();
		this.turnId++;
		const turnIdStr = `turn_${this.turnId}`;
		this.log(`Turn complete: ${turnIdStr}`);
		this.eventBus.publish('turn.end', {
			sessionId: this.config.sessionId,
			turnId: turnIdStr,
		});
		this.clientTransport.sendJsonToClient({ type: 'turn.end', turnId: turnIdStr });

		// Notify active agent
		const agent = this.agentRouter.activeAgent;
		if (agent.onTurnCompleted) {
			const transcript = this.conversationContext.items
				.slice(-5)
				.map((i) => `[${i.role}]: ${i.content}`)
				.join('\n');

			agent.onTurnCompleted(this.createAgentContext(agent.name), transcript);
		}

		// Trigger memory extraction (every N turns) and refresh cache
		if (this.memoryDistiller) {
			this.memoryDistiller.onTurnEnd();
			this.memoryCacheManager?.refresh();
		}

		// Reinforce active directives so Gemini doesn't drift
		this.reinforceDirectives();

		// Reset audio flag and flush one queued notification (skips if interrupted).
		// We send notification.turn_complete from HERE (the effective turn
		// boundary) rather than from TransportActor's raw adapter.onTurnComplete
		// callback. When an external TTSProvider is wired, handleTurnComplete
		// defers via ttsMaybeCompleteTurn until TTS audio actually finishes,
		// so this is the only place where the model-and-audio turn really
		// ends. The legacy queue's `onTurnComplete()` is called from this same
		// site for the same reason — actor-mode parity matches.
		if (this._isActorMode) {
			this._audioStartedThisTurn = false;
			this.runtimeOrchestrator?.runtime.tell('notification.turn_complete', {}, 'notification');
		} else {
			this.notificationQueue?.onTurnComplete();
		}
	}

	/** Inject all active directives into the LLM's context to prevent behavioral drift. */
	private reinforceDirectives(): void {
		const text = this.directiveManager.getReinforcementText();
		if (!text) return;
		this.log(`Reinforcing directives: ${text.slice(0, 120)}...`);
		this.transport.sendContent([{ role: 'user', text }], true);
	}

	/** Send the active agent's greeting prompt to the LLM to trigger a spoken greeting. */
	private sendGreeting(): void {
		const agent = this.agentRouter.activeAgent;
		if (!agent.greeting) return;
		this.log(`Sending greeting for agent "${agent.name}"`);
		// Pre-greeting audio-gate reset: legacy queue.resetAudio() vs actor
		// notification.reset_audio. In actor mode also clear the debounce flag.
		if (this._isActorMode) {
			this._audioStartedThisTurn = false;
			this.runtimeOrchestrator?.runtime.tell('notification.reset_audio', {}, 'notification');
		} else {
			this.notificationQueue?.resetAudio();
		}

		// Inject stored memory facts so the LLM knows the user from the first turn
		const cachedFacts = this.memoryCacheManager?.facts ?? [];
		if (cachedFacts.length > 0) {
			const summary = cachedFacts.map((f) => `- ${f.content}`).join('\n');
			const memoryText = `[MEMORY — what you already know about this user from previous sessions]\n${summary}`;
			this.transport.sendContent([{ role: 'user', text: memoryText }], true);
			this.log(`Injected ${cachedFacts.length} memory facts`);
		}

		// Prepend session directives so the greeting response respects user preferences (e.g. pacing)
		const directiveSuffix = this.directiveManager.getSessionSuffix();
		const greetingText = directiveSuffix
			? `${directiveSuffix}\n\n${agent.greeting}`
			: agent.greeting;
		this.transport.sendContent([{ role: 'user', text: greetingText }], true);
	}

	private handleInterrupted(): void {
		this.log('Interrupted by user');
		this._turnWasInterrupted = true;
		this.sttProvider?.handleInterrupted();
		// Cancel TTS and invalidate in-flight audio
		if (this.ttsProvider) {
			this.ttsProvider.cancel();
			this._ttsSpeaking = false;
			this._ttsLlmTextDone = false;
			this._ttsAudioDone = false;
			this._ttsTurnHasText = false;
			this._ttsCurrentRequestId++;
			this.ttsClearTimers();
		}
		// Audio-gate reset + interrupted flag. We own these sends in
		// VoiceSession (not TransportActor) because handleInterrupted is also
		// the entry point for TTS speech-started barge-in (line 1340 area)
		// — that path doesn't traverse adapter.onInterrupted, so a TransportActor
		// mirror would miss it. The legacy queue's resetAudio()+markInterrupted()
		// pair is called here for the same reason; actor-mode parity matches.
		// Order matters: reset_audio FIRST (clears the gate), then interrupted
		// (suppresses the next flush).
		if (this._isActorMode) {
			this._audioStartedThisTurn = false;
			this.runtimeOrchestrator?.runtime.tell('notification.reset_audio', {}, 'notification');
			this.runtimeOrchestrator?.runtime.tell('notification.interrupted', {}, 'notification');
		} else {
			this.notificationQueue?.resetAudio();
			this.notificationQueue?.markInterrupted();
		}
		this.transcriptManager.flush();
		this.eventBus.publish('turn.interrupted', {
			sessionId: this.config.sessionId,
			turnId: `turn_${this.turnId}`,
		});
		this.clientTransport.sendJsonToClient({ type: 'turn.interrupted' });
	}

	/** Handle a message from an interactive subagent (question, progress update). */
	private handleSubagentMessage(toolCallId: string, msg: SubagentMessage): void {
		if (msg.type === 'result') return; // Results are delivered by ToolCallRouter

		if (msg.blocking) {
			this.interactionMode.activate(toolCallId);
		}

		const label = msg.type === 'question' ? 'SUBAGENT QUESTION' : 'SUBAGENT UPDATE';
		const priority = msg.blocking ? 'high' : 'normal';
		if (this._isActorMode) {
			this.runtimeOrchestrator?.runtime.tell(
				'notification.publish',
				{ label, text: msg.text, priority },
				'notification',
			);
			return;
		}
		this.notificationQueue?.sendOrQueue(
			[{ role: 'user', parts: [{ text: `[${label}]: ${msg.text}` }] }],
			true,
			{ priority },
		);
	}

	private handleGroundingMetadata(metadata: Record<string, unknown>): void {
		this.clientTransport.sendJsonToClient({ type: 'grounding', payload: metadata });
	}

	private handleGoAway(timeLeft: string): void {
		this.log(`GoAway from Gemini (timeLeft=${timeLeft})`);
		this.eventBus.publish('session.goaway', {
			sessionId: this.config.sessionId,
			timeLeft,
		});

		// Initiate reconnection
		const handle = this.sessionManager.resumptionHandle;
		if (handle) {
			this.sessionManager.transitionTo('RECONNECTING');
			this.clientTransport.startBuffering();

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
				})
				.catch((err) => {
					this.clientTransport.stopBuffering();
					this.reportError('reconnect', err);
					this.sessionManager.transitionTo('CLOSED');
				});
		}
	}

	private handleResumptionUpdate(handle: string, _resumable: boolean): void {
		this.sessionManager.updateResumptionHandle(handle);
	}

	// --- Client transport handlers ---

	private handleJsonFromClient(message: Record<string, unknown>): void {
		if (this.directRtcChannel) {
			const rtc = tryParseRtcClientSignaling(message);
			if (rtc) {
				this.directRtcChannel.feedSignaling(rtc);
				return;
			}
		}

		if (
			message.type === 'behavior.set' &&
			typeof message.key === 'string' &&
			typeof message.preset === 'string'
		) {
			this.behaviorManager?.handleClientSet(message.key, message.preset);
		} else if (message.type === 'ui.response' && message.payload) {
			this.eventBus.publish('subagent.ui.response', {
				sessionId: this.config.sessionId,
				response: message.payload as {
					requestId: string;
					selectedOptionId?: string;
					formData?: Record<string, unknown>;
				},
			});
		} else if (message.type === 'file_upload' && message.data) {
			const data = message.data as { base64: string; mimeType: string; fileName?: string };
			this.handleFileUpload(data.base64, data.mimeType, data.fileName);
		} else if (message.type === 'text_input' && typeof message.text === 'string') {
			this.handleTextInput(message.text);
		}
	}

	private handleFileUpload(base64: string, mimeType: string, fileName?: string): void {
		if (!this.sessionManager.isActive) return;

		// Send image/document to the LLM as inline data
		this.transport.sendFile(base64, mimeType);

		// Record in conversation context
		this.conversationContext.addUserMessage(`[Uploaded file: ${fileName ?? 'file'}]`);

		// Store in artifact registry for cross-tool access (supported binary image types only).
		if (this.config.artifactRegistry && mimeType.startsWith('image/')) {
			try {
				this.config.artifactRegistry.store(
					base64,
					mimeType,
					fileName ?? `upload_${Date.now()}`,
					'uploaded',
					fileName,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.log(`Failed to store artifact: ${msg}`);
				this.eventBus.publish('gui.notification', {
					sessionId: this.config.sessionId,
					message: `File uploaded to voice session but cannot be forwarded to agents: ${msg}`,
				});
			}
		}
	}

	private handleTextInput(text: string): void {
		if (!this.sessionManager.isActive || !text.trim()) return;

		const trimmed = text.trim();

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
	}

	private handleClientConnected(): void {
		this.log(`Client connected (geminiActive=${this.sessionManager.isActive})`);
		this.clientConnected = true;
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
			this._memoryReadyPromise.then(() => this.sendGreeting());
		}
	}

	private handleClientDisconnected(): void {
		this.log('Client disconnected');
		this.clientConnected = false;
	}

	/** Feed client audio into the session (LLM + STT). Used when the server owns the socket (multi-user). */
	feedAudioFromClient(data: Buffer): void {
		this.handleAudioFromClient(data, 'websocket');
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

	private handleTransportClose(code?: number, reason?: string): void {
		const detail = code != null ? ` code=${code}${reason ? ` reason="${reason}"` : ''}` : '';
		this.log(`Transport closed (state=${this.sessionManager.state}${detail})`);
		if (this.sessionManager.state === 'ACTIVE') {
			const handle = this.sessionManager.resumptionHandle;
			if (handle && this.reconnectAttempts < VoiceSession.MAX_RECONNECT_ATTEMPTS) {
				const attempt = this.reconnectAttempts++;
				const delay = VoiceSession.RECONNECT_BACKOFF_MS[attempt] ?? 4000;
				this.log(
					`Reconnect attempt ${attempt + 1}/${VoiceSession.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
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
}
