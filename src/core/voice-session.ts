// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { resolveInstructions } from '../agent/agent-context.js';
import { AgentRouter } from '../agent/agent-router.js';
import type { SubagentMessage } from '../agent/subagent-session.js';
import { BehaviorManager } from '../behaviors/behavior-manager.js';
import { MemoryDistiller } from '../memory/memory-distiller.js';
import { ToolExecutor } from '../tools/tool-executor.js';
import { ClientTransport } from '../transport/client-transport.js';
import { GeminiLiveTransport } from '../transport/gemini-live-transport.js';
import type { MainAgent, SubagentConfig } from '../types/agent.js';
import type { BehaviorCategory } from '../types/behavior.js';
import type { FrameworkHooks } from '../types/hooks.js';
import type { MemoryStore } from '../types/memory.js';
import type { LLMTransport, LLMTransportError, STTProvider } from '../types/transport.js';
import { BackgroundNotificationQueue } from './background-notification-queue.js';
import { ConversationContext } from './conversation-context.js';
import { DirectiveManager } from './directive-manager.js';
import { EventBus } from './event-bus.js';
import { HooksManager } from './hooks.js';
import { InteractionModeManager } from './interaction-mode.js';
import { MemoryCacheManager } from './memory-cache-manager.js';
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
	/** Port for the client WebSocket server. */
	port: number;
	/** Host for the client WebSocket server (default: '0.0.0.0' for all interfaces). */
	host?: string;
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
	/** Pre-constructed LLM transport. If provided, apiKey/geminiModel/speechConfig/compressionConfig are ignored. */
	transport?: LLMTransport;
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
	private clientTransport: ClientTransport;
	private agentRouter: AgentRouter;
	private toolExecutor: ToolExecutor;
	private toolCallRouter!: ToolCallRouter;
	private subagentConfigs: Record<string, SubagentConfig>;
	private behaviorManager?: BehaviorManager;
	private memoryDistiller?: MemoryDistiller;
	private memoryCacheManager?: MemoryCacheManager;
	private turnId = 0;
	private sttProvider?: STTProvider;
	private _commitFiredForTurn = false;
	private config: VoiceSessionConfig;
	private directiveManager = new DirectiveManager();
	private transcriptManager!: TranscriptManager;
	/** Whether a client WebSocket connection is currently active. */
	private clientConnected = false;
	private notificationQueue!: BackgroundNotificationQueue;
	private interactionMode = new InteractionModeManager();
	/** Tracks consecutive reconnect attempts to prevent infinite reconnect storms. */
	private reconnectAttempts = 0;
	private static readonly MAX_RECONNECT_ATTEMPTS = 3;
	private static readonly RECONNECT_BACKOFF_MS = [1000, 2000, 4000];

	constructor(config: VoiceSessionConfig) {
		this.config = config;
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

		// NotificationQueue is created early but messageTruncation is not known until
		// transport is configured below. It defaults to false and is updated after
		// transport setup in the 'Wire LLMTransport' section. For pre-constructed
		// transports, capabilities are available immediately so we pass them here.
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
				},
			);
			this.log(`Memory distillation enabled (every ${freq} turns)`);
		}

		// Set up LLM transport
		const initialAgent = config.agents.find((a) => a.name === config.initialAgent);
		const instructions = initialAgent ? resolveInstructions(initialAgent) : '';
		const behaviorTools = this.behaviorManager?.tools ?? [];
		const allInitialTools = [...(initialAgent?.tools ?? []), ...behaviorTools];

		// Determine inputAudioTranscription setting:
		// When sttProvider is set, disable built-in transcription automatically.
		const inputTranscription = config.sttProvider ? false : config.inputAudioTranscription;

		if (config.transport) {
			// Use pre-constructed transport (OpenAI, mock, etc.)
			this.transport = config.transport;
			// Sync tools and instructions so they're available at connect time.
			// When an external STT provider is active, also disable transport built-in
			// transcription at the provider level (not just the callback) to avoid
			// duplicate backend processing and unnecessary cost.
			this.transport.updateSession({
				instructions,
				tools: allInitialTools.length ? allInitialTools : undefined,
				...(inputTranscription === false && {
					transcription: { input: false },
				}),
			});
		} else {
			// Construct GeminiLiveTransport from config (backward compatibility)
			this.transport = new GeminiLiveTransport(
				{
					apiKey: config.apiKey,
					model: config.geminiModel,
					systemInstruction: instructions,
					tools: allInitialTools.length ? allInitialTools : undefined,
					googleSearch: initialAgent?.googleSearch,
					speechConfig: config.speechConfig,
					compressionConfig: config.compressionConfig,
					inputAudioTranscription: inputTranscription,
				},
				{},
			);
		}

		// Wire LLMTransport property callbacks — works for both injected and default transports
		this.transport.onAudioOutput = (data) => this.handleAudioOutput(data);
		this.transport.onToolCall = (calls) => this.toolCallRouter.handleToolCalls(calls);
		this.transport.onToolCallCancel = (ids) => this.toolCallRouter.handleToolCallCancellation(ids);
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

		// Wire STT: exactly one transcript path is active per session.
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

			// Disable transport built-in input transcription
			this.transport.onInputTranscription = undefined;
		} else {
			// No external STT — use transport built-in transcription
			this.transport.onInputTranscription = (text) => this.transcriptManager.handleInput(text);
		}

		// Wire onModelTurnStart for STT commit trigger
		this.transport.onModelTurnStart = () => {
			if (this.sttProvider && !this._commitFiredForTurn) {
				this._commitFiredForTurn = true;
				this.sttProvider.commit(this.turnId);
			}
		};

		// Set up client transport
		this.clientTransport = new ClientTransport(
			config.port,
			{
				onAudioFromClient: (data) => this.handleAudioFromClient(data),
				onJsonFromClient: (message) => this.handleJsonFromClient(message),
				onClientConnected: () => this.handleClientConnected(),
				onClientDisconnected: () => this.handleClientDisconnected(),
			},
			config.host ?? '0.0.0.0',
		);

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
		);
		this.agentRouter.registerAgents(config.agents);
		this.agentRouter.setInitialAgent(config.initialAgent);

		// Set up tool call router
		this.toolCallRouter = new ToolCallRouter({
			toolExecutor: this.toolExecutor,
			agentRouter: this.agentRouter,
			conversationContext: this.conversationContext,
			notificationQueue: this.notificationQueue,
			transcriptManager: this.transcriptManager,
			subagentConfigs: this.subagentConfigs,
			sendToolResult: (result) => this.transport.sendToolResult(result),
			transfer: (toAgent) => this.transfer(toAgent),
			reportError: (component, error) => this.reportError(component, error),
			log: (msg) => this.log(msg),
		});
	}

	/**
	 * Queue a short spoken update for the user.
	 * Delivered immediately when possible, otherwise after the current turn.
	 */
	notifyBackground(
		text: string,
		options?: { priority?: 'normal' | 'high'; label?: 'SUBAGENT UPDATE' | 'SUBAGENT QUESTION' },
	): void {
		const label = options?.label ?? 'SUBAGENT UPDATE';
		this.notificationQueue.sendOrQueue(
			[{ role: 'user', parts: [{ text: `[${label}]: ${text}` }] }],
			true,
			{ priority: options?.priority ?? 'normal' },
		);
	}

	/** Start the client WebSocket server and connect to the LLM transport. */
	async start(): Promise<void> {
		await this.sttProvider?.start();
		await this.memoryCacheManager?.refresh();

		// Restore behavior presets from structured directives (deterministic lookup)
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

		this.log('Starting WS server...');
		await this.clientTransport.start();
		this.log('WS server ready. Connecting to LLM transport...');
		this.sessionManager.transitionTo('CONNECTING');
		if (this.config.transport) {
			// Pre-constructed transport — already configured, just connect
			await this.transport.connect();
		} else {
			// Default Gemini transport — pass config for backward compatibility
			await this.transport.connect({
				auth: { type: 'api_key', apiKey: this.config.apiKey },
				model: this.config.geminiModel ?? 'gemini-live-2.5-flash-preview',
			});
		}
		this.log('LLM transport connected and setup complete');
	}

	/** Gracefully shut down: disconnect Gemini, stop the WebSocket server, transition to CLOSED. */
	async close(_reason = 'normal'): Promise<void> {
		// Drop any queued background notifications — session is ending
		this.notificationQueue.clear();

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

		// Update tool executor with new agent's tools
		const agent = this.agentRouter.activeAgent;
		this.toolExecutor = this.createToolExecutor(agent.name);
		const behaviorTools = this.behaviorManager?.tools ?? [];
		this.toolExecutor.register([...agent.tools, ...behaviorTools]);
		this.toolCallRouter.toolExecutor = this.toolExecutor;

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

	// --- Audio fast-path (no EventBus) ---

	private handleAudioFromClient(data: Buffer): void {
		if (this.sessionManager.isActive) {
			const base64 = data.toString('base64');
			this.transport.sendAudio(base64);
			this.sttProvider?.feedAudio(base64);
		}
	}

	private handleAudioOutput(data: string): void {
		this.notificationQueue.markAudioReceived();
		const buffer = Buffer.from(data, 'base64');
		this.clientTransport.sendAudioToClient(buffer);
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
		if (this.clientConnected) {
			this.sendGreeting();
		}
	}

	private handleTurnComplete(): void {
		// A completed turn means the connection is healthy — reset reconnect counter
		this.reconnectAttempts = 0;

		// ORDERING: STT commit + cleanup BEFORE turnId increment.
		// This ensures commit(turnId) uses the turn being completed, and
		// stale-drop (turnId < this.turnId) correctly rejects prior-turn results.
		if (this.sttProvider) {
			if (!this._commitFiredForTurn) {
				this.sttProvider.commit(this.turnId); // Safety-net commit
			}
			this.sttProvider.handleTurnComplete();
			this._commitFiredForTurn = false;
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

			agent.onTurnCompleted(
				{
					sessionId: this.config.sessionId,
					agentName: agent.name,
					injectSystemMessage: (text) =>
						this.conversationContext.addAssistantMessage(`[system] ${text}`),
					getRecentTurns: (count = 10) => [...this.conversationContext.items].slice(-count),
					getMemoryFacts: () => this.memoryCacheManager?.facts ?? [],
				},
				transcript,
			);
		}

		// Trigger memory extraction (every N turns) and refresh cache
		if (this.memoryDistiller) {
			this.memoryDistiller.onTurnEnd();
			this.memoryCacheManager?.refresh();
		}

		// Reinforce active directives so Gemini doesn't drift
		this.reinforceDirectives();

		// Reset audio flag and flush one queued notification (skips if interrupted)
		this.notificationQueue.onTurnComplete();
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
		this.notificationQueue.resetAudio();

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
		this.sttProvider?.handleInterrupted();
		this.notificationQueue.resetAudio();
		this.notificationQueue.markInterrupted();
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
		this.notificationQueue.sendOrQueue(
			[{ role: 'user', parts: [{ text: `[${label}]: ${msg.text}` }] }],
			true,
			{ priority: msg.blocking ? 'high' : 'normal' },
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
				.reconnect({ conversationHistory: this.conversationContext.toReplayContent() })
				.then(() => {
					const buffered = this.clientTransport.stopBuffering();
					for (const chunk of buffered) {
						this.transport.sendAudio(chunk.toString('base64'));
					}
					this.sessionManager.transitionTo('ACTIVE');
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

		// Send audio format config so the client can negotiate correct sample rates
		this.clientTransport.sendJsonToClient({
			type: 'session.config',
			audioFormat: this.transport.audioFormat,
		});

		this.behaviorManager?.sendCatalog();
		if (this.sessionManager.isActive) {
			this.sendGreeting();
		}
	}

	private handleClientDisconnected(): void {
		this.log('Client disconnected');
		this.clientConnected = false;
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
			// Unexpected close — try to reconnect with backoff and retry limit
			const handle = this.sessionManager.resumptionHandle;
			if (handle && this.reconnectAttempts < VoiceSession.MAX_RECONNECT_ATTEMPTS) {
				const attempt = this.reconnectAttempts++;
				const delay = VoiceSession.RECONNECT_BACKOFF_MS[attempt] ?? 4000;
				this.log(
					`Reconnect attempt ${attempt + 1}/${VoiceSession.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
				);
				this.sessionManager.transitionTo('RECONNECTING');
				setTimeout(() => {
					this.transport
						.reconnect({ conversationHistory: this.conversationContext.toReplayContent() })
						.then(() => {
							this.sessionManager.transitionTo('ACTIVE');
						})
						.catch((err) => {
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
