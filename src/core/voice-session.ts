// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { resolveInstructions } from '../agent/agent-context.js';
import { AgentRouter } from '../agent/agent-router.js';
import { BehaviorManager } from '../behaviors/behavior-manager.js';
import { MemoryDistiller } from '../memory/memory-distiller.js';
import { ToolExecutor } from '../tools/tool-executor.js';
import { ClientTransport } from '../transport/client-transport.js';
import { GeminiLiveTransport } from '../transport/gemini-live-transport.js';
import type { MainAgent, SubagentConfig } from '../types/agent.js';
import type { BehaviorCategory } from '../types/behavior.js';
import type { FrameworkHooks } from '../types/hooks.js';
import type { MemoryFact, MemoryStore } from '../types/memory.js';
import type { ToolDefinition } from '../types/tool.js';
import { ConversationContext } from './conversation-context.js';
import { EventBus } from './event-bus.js';
import { HooksManager } from './hooks.js';
import { SessionManager } from './session-manager.js';

/**
 * Configuration for creating a VoiceSession.
 */
export interface VoiceSessionConfig {
	/** Unique session identifier. */
	sessionId: string;
	/** User identifier (used for memory storage and history). */
	userId: string;
	/** Google API key for the Gemini Live API. */
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
	/** Gemini model name (e.g. "gemini-2.0-flash-live-001"). */
	geminiModel?: string;
	/** Vercel AI SDK model for subagent text generation. */
	model: LanguageModelV1;
	/** Voice configuration for Gemini's speech output. */
	speechConfig?: { voiceName?: string };
	/** Context window compression thresholds. */
	compressionConfig?: { triggerTokens: number; targetTokens: number };
	/** Enable server-side transcription of user audio input (default: true). */
	inputAudioTranscription?: boolean;
	/** Behavior categories for dynamic runtime tuning (speech speed, verbosity, etc.). */
	behaviors?: BehaviorCategory[];
	/** Enable memory distillation. Extracts durable user facts from conversation and persists them. */
	memory?: {
		/** Where to persist extracted facts. */
		store: MemoryStore;
		/** Extract every N turns (default: 5). */
		turnFrequency?: number;
	};
}

/**
 * Top-level integration hub that wires all framework components together.
 *
 * Manages the full lifecycle of a real-time voice session:
 * - **Audio fast-path**: Client audio → Gemini (and back) without touching the EventBus.
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
 *   model: google('gemini-2.0-flash'),
 * });
 * await session.start();
 * ```
 */
export class VoiceSession {
	readonly eventBus: EventBus;
	readonly sessionManager: SessionManager;
	readonly conversationContext: ConversationContext;
	readonly hooks: HooksManager;
	private geminiTransport: GeminiLiveTransport;
	private clientTransport: ClientTransport;
	private agentRouter: AgentRouter;
	private toolExecutor: ToolExecutor;
	private subagentConfigs: Record<string, SubagentConfig>;
	private behaviorManager?: BehaviorManager;
	private memoryDistiller?: MemoryDistiller;
	private memoryFactsCache: MemoryFact[] = [];
	private turnId = 0;
	private config: VoiceSessionConfig;
	private inputTranscriptBuffer = '';
	private outputTranscriptBuffer = '';
	/** Pre-tool-call output text, saved when a tool call splits a turn. */
	private outputTranscriptPrefix = '';
	/** Agent-scoped directives — cleared on agent transfer. */
	private agentDirectives = new Map<string, string>();
	/** Session-scoped directives (e.g. pacing) — persist across agent transfers. */
	private sessionDirectives = new Map<string, string>();
	/** Whether a client WebSocket connection is currently active. */
	private clientConnected = false;
	/** Whether the first audio chunk from Gemini has been received this turn (for TTFB logging). */
	private firstAudioReceived = false;
	/** Whether the most recent turn ended via interruption (user started speaking). */
	private lastTurnInterrupted = false;
	/** Queued background tool completion notifications waiting for Gemini to finish generating. */
	private pendingBackgroundNotifications: Array<{
		turns: Array<{ role: string; parts: Array<{ text: string }> }>;
		turnComplete: boolean;
	}> = [];

	constructor(config: VoiceSessionConfig) {
		this.config = config;
		this.eventBus = new EventBus();
		this.hooks = new HooksManager();
		this.conversationContext = new ConversationContext();

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

		// Set up BehaviorManager early — tools must be declared to Gemini at connect time.
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
				(key, value, scope) => {
					const map = scope === 'session' ? this.sessionDirectives : this.agentDirectives;
					if (value === null) map.delete(key);
					else map.set(key, value);
				},
				(msg) => this.clientTransport.sendJsonToClient(msg),
				onPresetChange,
			);
		}

		// Set up memory distillation plugin
		if (config.memory) {
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

		// Set up Gemini transport
		const initialAgent = config.agents.find((a) => a.name === config.initialAgent);
		const instructions = initialAgent ? resolveInstructions(initialAgent) : '';
		const behaviorTools = this.behaviorManager?.tools ?? [];
		const allInitialTools = [...(initialAgent?.tools ?? []), ...behaviorTools];

		this.geminiTransport = new GeminiLiveTransport(
			{
				apiKey: config.apiKey,
				model: config.geminiModel,
				systemInstruction: instructions,
				tools: allInitialTools.length ? allInitialTools : undefined,
				googleSearch: initialAgent?.googleSearch,
				speechConfig: config.speechConfig,
				compressionConfig: config.compressionConfig,
				inputAudioTranscription: config.inputAudioTranscription,
			},
			{
				onSetupComplete: (sessionId) => this.handleSetupComplete(sessionId),
				onAudioOutput: (data) => this.handleAudioOutput(data),
				onToolCall: (calls) => this.handleToolCalls(calls),
				onToolCallCancellation: (ids) => this.handleToolCallCancellation(ids),
				onTurnComplete: () => this.handleTurnComplete(),
				onInterrupted: () => this.handleInterrupted(),
				onInputTranscription: (text) => this.handleInputTranscription(text),
				onOutputTranscription: (text) => this.handleOutputTranscription(text),
				onGroundingMetadata: (metadata) => this.handleGroundingMetadata(metadata),
				onGoAway: (timeLeft) => this.handleGoAway(timeLeft),
				onResumptionUpdate: (handle, resumable) => this.handleResumptionUpdate(handle, resumable),
				onError: (error) => this.handleTransportError(error),
				onClose: () => this.handleTransportClose(),
			},
		);

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

		// Set up tool executor
		this.toolExecutor = new ToolExecutor(
			this.hooks,
			this.eventBus,
			config.sessionId,
			config.initialAgent,
			(msg) => this.clientTransport.sendJsonToClient(msg),
			(key, value, scope) => {
				const map = scope === 'session' ? this.sessionDirectives : this.agentDirectives;
				if (value === null) map.delete(key);
				else map.set(key, value);
			},
		);

		if (allInitialTools.length) {
			this.toolExecutor.register(allInitialTools);
		}

		// Set up agent router
		this.agentRouter = new AgentRouter(
			this.sessionManager,
			this.eventBus,
			this.hooks,
			this.conversationContext,
			this.geminiTransport,
			this.clientTransport,
			config.model,
			() => this.getSessionDirectiveSuffix(),
			behaviorTools,
		);
		this.agentRouter.registerAgents(config.agents);
		this.agentRouter.setInitialAgent(config.initialAgent);
	}

	/** Start the client WebSocket server and connect to Gemini. */
	async start(): Promise<void> {
		await this.refreshMemoryCache();

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
		this.log('WS server ready. Connecting to Gemini...');
		this.sessionManager.transitionTo('CONNECTING');
		await this.geminiTransport.connect();
		this.log('Gemini connected and setup complete');
	}

	/** Gracefully shut down: disconnect Gemini, stop the WebSocket server, transition to CLOSED. */
	async close(_reason = 'normal'): Promise<void> {
		// Drop any queued background notifications — session is ending
		this.pendingBackgroundNotifications = [];

		// Flush any buffered transcription before closing
		this.flushTranscriptBuffers();

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

		await this.geminiTransport.disconnect();
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
		this.toolExecutor = new ToolExecutor(
			this.hooks,
			this.eventBus,
			this.config.sessionId,
			agent.name,
			(msg) => this.clientTransport.sendJsonToClient(msg),
			(key, value, scope) => {
				const map = scope === 'session' ? this.sessionDirectives : this.agentDirectives;
				if (value === null) map.delete(key);
				else map.set(key, value);
			},
		);
		const behaviorTools = this.behaviorManager?.tools ?? [];
		this.toolExecutor.register([...agent.tools, ...behaviorTools]);

		// Clear agent-scoped directives on transfer; session-scoped directives persist
		this.agentDirectives.clear();

		// Send the new agent's greeting if configured
		if (this.clientConnected) {
			this.sendGreeting();
		}
	}

	// --- Audio fast-path (no EventBus) ---

	private handleAudioFromClient(data: Buffer): void {
		if (this.sessionManager.isActive) {
			this.geminiTransport.sendAudio(data.toString('base64'));
		}
	}

	private handleAudioOutput(data: string): void {
		if (!this.firstAudioReceived) {
			this.firstAudioReceived = true;
			this.log('First audio chunk from Gemini (TTFB)');
		}
		const buffer = Buffer.from(data, 'base64');
		this.clientTransport.sendAudioToClient(buffer);
	}

	// --- Gemini event handlers ---

	private handleSetupComplete(_sessionId: string): void {
		this.log(`Gemini setup complete (clientConnected=${this.clientConnected})`);
		if (this.sessionManager.state === 'CONNECTING') {
			this.sessionManager.transitionTo('ACTIVE');
		}
		// During transfer, the transfer path handles greeting after context replay — skip here
		if (this.sessionManager.state === 'TRANSFERRING') {
			return;
		}
		if (this.clientConnected) {
			this.sendGreeting();
		}
	}

	private handleToolCalls(
		calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
	): void {
		const names = calls.map((c) => c.name).join(', ');
		this.log(`Tool calls from Gemini: [${names}]`);
		// Flush user's input transcript before tool calls so it appears first
		// in conversation context and logs. Safe because Gemini only calls tools
		// after processing the user's complete utterance.
		if (this.inputTranscriptBuffer.trim()) {
			this.conversationContext.addUserMessage(this.inputTranscriptBuffer.trim());
			this.clientTransport.sendJsonToClient({
				type: 'transcript',
				role: 'user',
				text: this.inputTranscriptBuffer.trim(),
				partial: false,
			});
			this.inputTranscriptBuffer = '';
		}

		// Save output transcript accumulated before tool call to avoid
		// duplication: Gemini transcribes ahead of tool calls, then
		// re-transcribes the same text after receiving the tool result.
		if (this.outputTranscriptBuffer.trim()) {
			this.outputTranscriptPrefix += this.outputTranscriptBuffer;
			this.outputTranscriptBuffer = '';
		}

		for (const call of calls) {
			const toolCall = {
				toolCallId: call.id,
				toolName: call.name,
				args: call.args,
			};

			// Check if this is a transfer tool
			if (call.name === 'transfer_to_agent' && call.args.agent_name) {
				this.transfer(call.args.agent_name as string).catch((err) => {
					this.reportError('agent-router', err);
				});
				// Send empty response to acknowledge
				this.geminiTransport.sendToolResponse([
					{ id: call.id, name: call.name, response: { status: 'transferred' } },
				]);
				return;
			}

			// Find tool definition to determine execution type
			const agent = this.agentRouter.activeAgent;
			const toolDef = agent.tools.find((t: ToolDefinition) => t.name === call.name);

			if (toolDef?.execution === 'background') {
				this.handleBackgroundToolCall(toolCall, toolDef);
			} else {
				this.handleInlineToolCall(toolCall);
			}
		}
	}

	private handleInlineToolCall(call: {
		toolCallId: string;
		toolName: string;
		args: Record<string, unknown>;
	}): void {
		this.toolExecutor
			.handleToolCall(call)
			.then((result) => {
				this.conversationContext.addToolCall(call);
				this.conversationContext.addToolResult(result);

				this.geminiTransport.sendToolResponse([
					{
						id: result.toolCallId,
						name: result.toolName,
						response: result.error
							? { error: result.error }
							: (result.result as Record<string, unknown>),
					},
				]);
			})
			.catch((err) => {
				this.reportError('tool-executor', err);
				// Always send a response so Gemini doesn't hang
				this.geminiTransport.sendToolResponse([
					{
						id: call.toolCallId,
						name: call.toolName,
						response: { error: err instanceof Error ? err.message : String(err) },
					},
				]);
			});
	}

	private handleBackgroundToolCall(
		call: { toolCallId: string; toolName: string; args: Record<string, unknown> },
		toolDef: ToolDefinition,
	): void {
		const hasPendingMessage = !!toolDef.pendingMessage;

		// Send a tool response to unblock Gemini (it stops generating until a response arrives).
		// Explicitly mark the task as still in progress so Gemini doesn't claim it's done.
		if (hasPendingMessage) {
			this.geminiTransport.sendToolResponse([
				{
					id: call.toolCallId,
					name: call.toolName,
					response: {
						status: 'still_in_progress',
						message: toolDef.pendingMessage,
						important:
							'This task is NOT complete yet. Do NOT tell the user it is ready. You will receive a notification when it finishes.',
					},
				},
			]);
		}

		// Find subagent config
		const subagentConfig = this.subagentConfigs[call.toolName];
		if (!subagentConfig) {
			// Fallback: run as inline tool
			this.handleInlineToolCall(call);
			return;
		}

		// Handoff to subagent
		this.agentRouter
			.handoff(call, subagentConfig)
			.then((result) => {
				this.conversationContext.addToolCall(call);
				this.conversationContext.addToolResult({
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					result: result.text,
				});

				if (hasPendingMessage) {
					// The pending message already satisfied the tool call from Gemini's perspective.
					// Inject the completion as a context message so Gemini naturally informs the user.
					// If Gemini is mid-generation, queue it until the current turn ends.
					this.sendOrQueueNotification(
						[
							{
								role: 'user',
								parts: [
									{
										text: `[SYSTEM: Background task "${call.toolName}" completed successfully. Result: ${result.text}. Please inform the user their content is ready now.]`,
									},
								],
							},
						],
						true,
					);
				} else {
					this.geminiTransport.sendToolResponse([
						{
							id: call.toolCallId,
							name: call.toolName,
							response: { result: result.text },
						},
					]);
				}
			})
			.catch((err) => {
				this.reportError('subagent-runner', err);
				if (hasPendingMessage) {
					this.sendOrQueueNotification(
						[
							{
								role: 'user',
								parts: [
									{
										text: `[SYSTEM: Background task "${call.toolName}" failed: ${err instanceof Error ? err.message : String(err)}. Please apologize to the user and let them know.]`,
									},
								],
							},
						],
						true,
					);
				} else {
					this.geminiTransport.sendToolResponse([
						{
							id: call.toolCallId,
							name: call.toolName,
							response: { error: err instanceof Error ? err.message : String(err) },
						},
					]);
				}
			});
	}

	private handleToolCallCancellation(ids: string[]): void {
		this.toolExecutor.cancel(ids);
		for (const id of ids) {
			this.agentRouter.cancelSubagent(id);
		}
	}

	private handleTurnComplete(): void {
		this.flushTranscriptBuffers();
		this.turnId++;
		this.firstAudioReceived = false;
		const wasInterrupted = this.lastTurnInterrupted;
		this.lastTurnInterrupted = false;
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
					getMemoryFacts: () => this.memoryFactsCache,
				},
				transcript,
			);
		}

		// Trigger memory extraction (every N turns) and refresh cache
		if (this.memoryDistiller) {
			this.memoryDistiller.onTurnEnd();
			this.refreshMemoryCache();
		}

		// Reinforce active directives so Gemini doesn't drift
		this.reinforceDirectives();

		// Flush one queued background notification now that Gemini finished generating.
		// Skip after interruptions — the user is speaking and the next natural turn
		// completion will flush instead.
		if (!wasInterrupted) {
			this.flushOneBackgroundNotification();
		}
	}

	/** Returns session-scoped directives formatted as a system instruction suffix (for agent transfers). */
	private getSessionDirectiveSuffix(): string {
		if (this.sessionDirectives.size === 0) return '';
		const text = [...this.sessionDirectives.values()].join('\n\n');
		return `\n\n[SESSION DIRECTIVES — user preferences that persist across agents]\n${text}`;
	}

	/** Inject all active directives into Gemini's context to prevent behavioral drift. */
	private reinforceDirectives(): void {
		if (this.sessionDirectives.size === 0 && this.agentDirectives.size === 0) return;
		// Merge both maps — agent directives override session directives with same key
		const merged = new Map([...this.sessionDirectives, ...this.agentDirectives]);
		const keys = [...merged.keys()];
		const text = [...merged.values()].join('\n\n');
		this.log(`Reinforcing directives [${keys.join(', ')}]: ${text.slice(0, 120)}...`);
		this.geminiTransport.sendClientContent(
			[
				{
					role: 'user',
					parts: [{ text: `[SYSTEM DIRECTIVES — follow these instructions]\n${text}` }],
				},
			],
			true,
		);
	}

	/**
	 * Send a background tool completion notification to Gemini, or queue it
	 * if Gemini is currently generating audio (where it would be silently absorbed).
	 */
	private sendOrQueueNotification(
		turns: Array<{ role: string; parts: Array<{ text: string }> }>,
		turnComplete: boolean,
	): void {
		if (this.firstAudioReceived) {
			this.log('Gemini is generating — queuing background notification');
			this.pendingBackgroundNotifications.push({ turns, turnComplete });
		} else {
			this.geminiTransport.sendClientContent(turns, turnComplete);
		}
	}

	/** Flush one queued background notification now that Gemini is idle. */
	private flushOneBackgroundNotification(): void {
		const notification = this.pendingBackgroundNotifications.shift();
		if (notification) {
			this.log(
				`Flushing queued background notification (${this.pendingBackgroundNotifications.length} remaining)`,
			);
			this.geminiTransport.sendClientContent(notification.turns, notification.turnComplete);
		}
	}

	/** Send the active agent's greeting prompt to Gemini to trigger a spoken greeting. */
	private sendGreeting(): void {
		const agent = this.agentRouter.activeAgent;
		if (!agent.greeting) return;
		this.log(`Sending greeting for agent "${agent.name}"`);
		this.firstAudioReceived = false;

		// Inject stored memory facts so Gemini knows the user from the first turn
		if (this.memoryFactsCache.length > 0) {
			const summary = this.memoryFactsCache.map((f) => `- ${f.content}`).join('\n');
			const memoryText = `[MEMORY — what you already know about this user from previous sessions]\n${summary}`;
			this.geminiTransport.sendClientContent(
				[{ role: 'user', parts: [{ text: memoryText }] }],
				true,
			);
			this.log(`Injected ${this.memoryFactsCache.length} memory facts`);
		}

		// Prepend session directives so the greeting response respects user preferences (e.g. pacing)
		const directiveSuffix = this.getSessionDirectiveSuffix();
		const greetingText = directiveSuffix
			? `${directiveSuffix}\n\n${agent.greeting}`
			: agent.greeting;
		this.geminiTransport.sendClientContent(
			[{ role: 'user', parts: [{ text: greetingText }] }],
			true,
		);
	}

	private handleInterrupted(): void {
		this.log('Interrupted by user');
		this.firstAudioReceived = false;
		this.lastTurnInterrupted = true;
		this.flushTranscriptBuffers();
		this.eventBus.publish('turn.interrupted', {
			sessionId: this.config.sessionId,
			turnId: `turn_${this.turnId}`,
		});
		this.clientTransport.sendJsonToClient({ type: 'turn.interrupted' });
	}

	private handleInputTranscription(text: string): void {
		if (text.trim()) {
			this.inputTranscriptBuffer += text;
			this.clientTransport.sendJsonToClient({
				type: 'transcript',
				role: 'user',
				text: this.inputTranscriptBuffer.trim(),
				partial: true,
			});
		}
	}

	private handleOutputTranscription(text: string): void {
		if (text.trim()) {
			this.outputTranscriptBuffer += text;
			const combined = this.combineOutputTranscript();
			this.clientTransport.sendJsonToClient({
				type: 'transcript',
				role: 'assistant',
				text: combined,
				partial: true,
			});
		}
	}

	private flushTranscriptBuffers(): void {
		if (this.inputTranscriptBuffer.trim()) {
			this.conversationContext.addUserMessage(this.inputTranscriptBuffer.trim());
			this.clientTransport.sendJsonToClient({
				type: 'transcript',
				role: 'user',
				text: this.inputTranscriptBuffer.trim(),
				partial: false,
			});
		}
		const outputText = this.combineOutputTranscript();
		if (outputText) {
			this.conversationContext.addAssistantMessage(outputText);
			this.clientTransport.sendJsonToClient({
				type: 'transcript',
				role: 'assistant',
				text: outputText,
				partial: false,
			});
		}
		this.inputTranscriptBuffer = '';
		this.outputTranscriptBuffer = '';
		this.outputTranscriptPrefix = '';
	}

	/**
	 * Combine pre-tool prefix and post-tool buffer, deduplicating any overlap.
	 *
	 * Gemini's outputTranscription can "leak" post-tool text into the pre-tool
	 * stream, then re-send it after the tool result. This finds the longest
	 * suffix of prefix that matches a prefix of buffer and removes the overlap.
	 */
	private combineOutputTranscript(): string {
		const prefix = this.outputTranscriptPrefix.trim();
		const buffer = this.outputTranscriptBuffer.trim();

		if (!prefix) return buffer;
		if (!buffer) return prefix;

		// If post-tool buffer is entirely contained in the prefix tail, skip it
		if (prefix.endsWith(buffer)) return prefix;

		// Find the longest suffix of prefix that matches a prefix of buffer
		const maxOverlap = Math.min(prefix.length, buffer.length);
		let overlap = 0;
		for (let i = 1; i <= maxOverlap; i++) {
			if (prefix.slice(-i) === buffer.slice(0, i)) {
				overlap = i;
			}
		}

		if (overlap > 0) {
			return prefix + buffer.slice(overlap);
		}
		return `${prefix} ${buffer}`;
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

			this.geminiTransport.reconnect(handle).then(() => {
				const buffered = this.clientTransport.stopBuffering();
				for (const chunk of buffered) {
					this.geminiTransport.sendAudio(chunk.toString('base64'));
				}
				this.sessionManager.transitionTo('ACTIVE');
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

		// Send image/document to Gemini as inline data
		this.geminiTransport.sendClientContent(
			[{ role: 'user', parts: [{ inlineData: { data: base64, mimeType } }] as never[] }],
			false,
		);

		// Record in conversation context
		this.conversationContext.addUserMessage(`[Uploaded file: ${fileName ?? 'file'}]`);
	}

	private handleTextInput(text: string): void {
		if (!this.sessionManager.isActive || !text.trim()) return;

		// Send text to Gemini
		this.geminiTransport.sendClientContent(
			[{ role: 'user', parts: [{ text: text.trim() }] }],
			true,
		);

		// Record in conversation context
		this.conversationContext.addUserMessage(text.trim());

		// Forward transcript to client for display
		this.clientTransport.sendJsonToClient({
			type: 'transcript',
			role: 'user',
			text: text.trim(),
		});
	}

	private handleClientConnected(): void {
		this.log(`Client connected (geminiActive=${this.sessionManager.isActive})`);
		this.clientConnected = true;
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

	private handleTransportError(error: Error): void {
		this.log(`Transport error: ${error.message}`);
		this.reportError('gemini-transport', error);
	}

	private handleTransportClose(): void {
		this.log(`Transport closed (state=${this.sessionManager.state})`);
		if (this.sessionManager.state === 'ACTIVE') {
			// Unexpected close — try to reconnect
			const handle = this.sessionManager.resumptionHandle;
			if (handle) {
				this.sessionManager.transitionTo('RECONNECTING');
				this.geminiTransport.reconnect(handle).then(() => {
					this.sessionManager.transitionTo('ACTIVE');
				});
			} else {
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

	/** Reload cached memory facts from the store (fire-and-forget safe). */
	private refreshMemoryCache(): Promise<void> {
		if (!this.config.memory) return Promise.resolve();
		return this.config.memory.store
			.getAll(this.config.userId)
			.then((facts) => {
				this.memoryFactsCache = facts;
			})
			.catch(() => {
				// Best-effort — keep stale cache on failure
			});
	}

	/** Compact diagnostic log: HH:MM:SS.mmm [VoiceSession] message */
	private log(msg: string): void {
		const t = new Date().toISOString().slice(11, 23);
		console.log(`${t} [VoiceSession] ${msg}`);
	}
}
