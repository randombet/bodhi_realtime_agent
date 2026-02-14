import type { LanguageModelV1 } from 'ai';
import { AgentRouter } from '../agent/agent-router.js';
import { ToolExecutor } from '../tools/tool-executor.js';
import { ClientTransport } from '../transport/client-transport.js';
import { GeminiLiveTransport } from '../transport/gemini-live-transport.js';
import type { MainAgent, SubagentConfig } from '../types/agent.js';
import type { FrameworkHooks } from '../types/hooks.js';
import type { ToolDefinition } from '../types/tool.js';
import { ConversationContext } from './conversation-context.js';
import { EventBus } from './event-bus.js';
import { HooksManager } from './hooks.js';
import { SessionManager } from './session-manager.js';

export interface VoiceSessionConfig {
	sessionId: string;
	userId: string;
	apiKey: string;
	agents: MainAgent[];
	initialAgent: string;
	subagentConfigs?: Record<string, SubagentConfig>;
	hooks?: FrameworkHooks;
	port: number;
	geminiModel?: string;
	model: LanguageModelV1;
	speechConfig?: { voiceName?: string };
	compressionConfig?: { triggerTokens: number; targetTokens: number };
}

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
	private turnId = 0;
	private config: VoiceSessionConfig;

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

		// Set up Gemini transport
		const initialAgent = config.agents.find((a) => a.name === config.initialAgent);
		const instructions = initialAgent
			? typeof initialAgent.instructions === 'function'
				? initialAgent.instructions()
				: initialAgent.instructions
			: '';

		this.geminiTransport = new GeminiLiveTransport(
			{
				apiKey: config.apiKey,
				model: config.geminiModel,
				systemInstruction: instructions,
				tools: initialAgent?.tools,
				speechConfig: config.speechConfig,
				compressionConfig: config.compressionConfig,
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
				onGoAway: (timeLeft) => this.handleGoAway(timeLeft),
				onResumptionUpdate: (handle, resumable) => this.handleResumptionUpdate(handle, resumable),
				onError: (error) => this.handleTransportError(error),
				onClose: () => this.handleTransportClose(),
			},
		);

		// Set up client transport
		this.clientTransport = new ClientTransport(config.port, {
			onAudioFromClient: (data) => this.handleAudioFromClient(data),
			onClientConnected: () => this.handleClientConnected(),
			onClientDisconnected: () => this.handleClientDisconnected(),
		});

		// Set up tool executor
		this.toolExecutor = new ToolExecutor(
			this.hooks,
			this.eventBus,
			config.sessionId,
			config.initialAgent,
		);

		if (initialAgent?.tools.length) {
			this.toolExecutor.register(initialAgent.tools);
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
		);
		this.agentRouter.registerAgents(config.agents);
		this.agentRouter.setInitialAgent(config.initialAgent);
	}

	async start(): Promise<void> {
		await this.clientTransport.start();
		this.sessionManager.transitionTo('CONNECTING');
		await this.geminiTransport.connect();
	}

	async close(_reason = 'normal'): Promise<void> {
		// Fire turn end if we're mid-turn
		if (this.turnId > 0) {
			this.eventBus.publish('turn.end', {
				sessionId: this.config.sessionId,
				turnId: `turn_${this.turnId}`,
			});
		}

		await this.geminiTransport.disconnect();
		await this.clientTransport.stop();

		if (this.sessionManager.state !== 'CLOSED') {
			this.sessionManager.transitionTo('CLOSED');
		}

		this.eventBus.clear();
	}

	async transfer(toAgent: string): Promise<void> {
		await this.agentRouter.transfer(toAgent);

		// Update tool executor with new agent's tools
		const agent = this.agentRouter.activeAgent;
		this.toolExecutor = new ToolExecutor(
			this.hooks,
			this.eventBus,
			this.config.sessionId,
			agent.name,
		);
		this.toolExecutor.register(agent.tools);
	}

	// --- Audio fast-path (no EventBus) ---

	private handleAudioFromClient(data: Buffer): void {
		if (this.sessionManager.isActive) {
			this.geminiTransport.sendAudio(data.toString('base64'));
		}
	}

	private handleAudioOutput(data: string): void {
		const buffer = Buffer.from(data, 'base64');
		this.clientTransport.sendAudioToClient(buffer);
	}

	// --- Gemini event handlers ---

	private handleSetupComplete(_sessionId: string): void {
		if (this.sessionManager.state === 'CONNECTING') {
			this.sessionManager.transitionTo('ACTIVE');
		}
	}

	private handleToolCalls(
		calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
	): void {
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
		this.toolExecutor.handleToolCall(call).then((result) => {
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
		});
	}

	private handleBackgroundToolCall(
		call: { toolCallId: string; toolName: string; args: Record<string, unknown> },
		toolDef: ToolDefinition,
	): void {
		// Inject pending message
		if (toolDef.pendingMessage) {
			this.geminiTransport.sendToolResponse([
				{
					id: call.toolCallId,
					name: call.toolName,
					response: { status: 'pending', message: toolDef.pendingMessage },
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
		this.agentRouter.handoff(call, subagentConfig).then((result) => {
			this.conversationContext.addToolCall(call);
			this.conversationContext.addToolResult({
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				result: result.text,
			});

			this.geminiTransport.sendToolResponse([
				{
					id: call.toolCallId,
					name: call.toolName,
					response: { result: result.text },
				},
			]);
		});
	}

	private handleToolCallCancellation(ids: string[]): void {
		this.toolExecutor.cancel(ids);
		for (const id of ids) {
			this.agentRouter.cancelSubagent(id);
		}
	}

	private handleTurnComplete(): void {
		this.turnId++;
		const turnIdStr = `turn_${this.turnId}`;
		this.eventBus.publish('turn.end', {
			sessionId: this.config.sessionId,
			turnId: turnIdStr,
		});

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
					getMemoryFacts: () => [],
				},
				transcript,
			);
		}
	}

	private handleInterrupted(): void {
		this.eventBus.publish('turn.interrupted', {
			sessionId: this.config.sessionId,
			turnId: `turn_${this.turnId}`,
		});
	}

	private handleInputTranscription(text: string): void {
		if (text.trim()) {
			this.conversationContext.addUserMessage(text);
		}
	}

	private handleOutputTranscription(text: string): void {
		if (text.trim()) {
			this.conversationContext.addAssistantMessage(text);
		}
	}

	private handleGoAway(timeLeft: string): void {
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

	private handleClientConnected(): void {
		// Client connected, nothing to do here (audio relay is direct)
	}

	private handleClientDisconnected(): void {
		// Client disconnected — could trigger session close
	}

	// --- Error handling ---

	private handleTransportError(error: Error): void {
		this.reportError('gemini-transport', error);
	}

	private handleTransportClose(): void {
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
}
