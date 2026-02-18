import type { LanguageModelV1 } from 'ai';
import { resolveInstructions } from '../agent/agent-context.js';
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
	private turnId = 0;
	private config: VoiceSessionConfig;
	private inputTranscriptBuffer = '';
	private outputTranscriptBuffer = '';
	/** Pre-tool-call output text, saved when a tool call splits a turn. */
	private outputTranscriptPrefix = '';
	/** Directive queued by a tool — triggers reconnect after tool response is sent. */
	private pendingDirective: string | null | undefined;

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
		const instructions = initialAgent ? resolveInstructions(initialAgent) : '';

		this.geminiTransport = new GeminiLiveTransport(
			{
				apiKey: config.apiKey,
				model: config.geminiModel,
				systemInstruction: instructions,
				tools: initialAgent?.tools,
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
		this.clientTransport = new ClientTransport(config.port, {
			onAudioFromClient: (data) => this.handleAudioFromClient(data),
			onJsonFromClient: (message) => this.handleJsonFromClient(message),
			onClientConnected: () => this.handleClientConnected(),
			onClientDisconnected: () => this.handleClientDisconnected(),
		});

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
			(directive) => {
				this.pendingDirective = directive;
			},
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

	/** Start the client WebSocket server and connect to Gemini. */
	async start(): Promise<void> {
		await this.clientTransport.start();
		this.sessionManager.transitionTo('CONNECTING');
		await this.geminiTransport.connect();
	}

	/** Gracefully shut down: disconnect Gemini, stop the WebSocket server, transition to CLOSED. */
	async close(_reason = 'normal'): Promise<void> {
		// Flush any buffered transcription before closing
		this.flushTranscriptBuffers();

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

	/** Transfer the active session to a different agent (reconnects with new config). */
	async transfer(toAgent: string): Promise<void> {
		await this.agentRouter.transfer(toAgent);

		// Update tool executor with new agent's tools
		const agent = this.agentRouter.activeAgent;
		this.toolExecutor = new ToolExecutor(
			this.hooks,
			this.eventBus,
			this.config.sessionId,
			agent.name,
			(msg) => this.clientTransport.sendJsonToClient(msg),
			(directive) => {
				this.pendingDirective = directive;
			},
		);
		this.toolExecutor.register(agent.tools);
	}

	/**
	 * Reconnect the Gemini session with an updated system instruction.
	 * Appends the directive to the active agent's base instructions (or resets if null).
	 * Follows the same pattern as agent transfer: buffer → disconnect → reconnect → replay.
	 */
	private async reconnectWithUpdatedInstruction(directive: string | null): Promise<void> {
		console.log('[VoiceSession] reconnectWithUpdatedInstruction: START');
		const agent = this.agentRouter.activeAgent;
		let instructions = resolveInstructions(agent);
		if (directive) {
			instructions += `\n\n${directive}`;
		}
		console.log(`[VoiceSession] reconnectWithUpdatedInstruction: instruction length=${instructions.length}, hasDirective=${!!directive}`);

		this.clientTransport.startBuffering();
		const handle = this.sessionManager.resumptionHandle;
		console.log(`[VoiceSession] reconnectWithUpdatedInstruction: handle=${handle ? `"${handle.slice(0, 20)}..."` : 'null'}`);

		this.sessionManager.transitionTo('RECONNECTING');
		this.geminiTransport.updateSystemInstruction(instructions);
		await this.geminiTransport.reconnect(handle ?? undefined);
		console.log('[VoiceSession] reconnectWithUpdatedInstruction: reconnect() resolved');

		const buffered = this.clientTransport.stopBuffering();
		console.log(`[VoiceSession] reconnectWithUpdatedInstruction: replaying ${buffered.length} buffered audio chunks`);

		const replayContent = this.conversationContext.toReplayContent();
		if (replayContent.length > 0) {
			console.log(`[VoiceSession] reconnectWithUpdatedInstruction: replaying ${replayContent.length} conversation turns`);
			this.geminiTransport.sendClientContent(replayContent, false);
		}

		for (const chunk of buffered) {
			this.geminiTransport.sendAudio(chunk.toString('base64'));
		}

		this.sessionManager.transitionTo('ACTIVE');
		console.log('[VoiceSession] reconnectWithUpdatedInstruction: DONE — session ACTIVE with updated instruction');
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
				this.pendingDirective = undefined;
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
		this.agentRouter
			.handoff(call, subagentConfig)
			.then((result) => {
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
			})
			.catch((err) => {
				this.reportError('subagent-runner', err);
				this.geminiTransport.sendToolResponse([
					{
						id: call.toolCallId,
						name: call.toolName,
						response: { error: err instanceof Error ? err.message : String(err) },
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
		this.flushTranscriptBuffers();
		this.turnId++;
		const turnIdStr = `turn_${this.turnId}`;
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
					getMemoryFacts: () => [],
				},
				transcript,
			);
		}

		// If a tool requested a reconnect with updated system instruction, do it now
		// (after the turn is fully complete so Gemini has processed the tool result)
		if (this.pendingDirective !== undefined) {
			const directive = this.pendingDirective;
			this.pendingDirective = undefined;
			console.log(`[VoiceSession] handleTurnComplete: pendingDirective found, triggering reconnect with directive=${directive ? `"${directive.slice(0, 40)}..."` : 'null (reset)'}`);
			this.reconnectWithUpdatedInstruction(directive).catch((err) => {
				console.error('[VoiceSession] reconnectWithUpdatedInstruction FAILED:', err);
				this.reportError('voice-session', err);
			});
		}
	}

	private handleInterrupted(): void {
		this.flushTranscriptBuffers();
		this.eventBus.publish('turn.interrupted', {
			sessionId: this.config.sessionId,
			turnId: `turn_${this.turnId}`,
		});
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
		if (message.type === 'ui.response' && message.payload) {
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
