// SPDX-License-Identifier: MIT

/**
 * QwenRealtimeTransport — Qwen Omni Realtime via Alibaba DashScope.
 *
 * A standalone `LLMTransport` on the raw `ws` package (no provider SDK). The
 * Qwen realtime protocol is OpenAI-Realtime-shaped; wire shapes were validated
 * live in the Phase 0 spike — see dev_docs/framework/design-qwen-realtime-transport.md.
 *
 * Key Phase 0 findings baked in here:
 *  - server_vad turn-taking works (auto `response.created` after trailing silence).
 *  - Tools are OpenAI-identical (`response.function_call_arguments.delta/done`,
 *    `function_call` items, `function_call_output` round-trip) → reuse the assembler.
 *  - Text item injection works (`conversation.item.create` with `input_text`).
 *  - Interrupt is FRAMEWORK-owned (`interrupt_response: false`, VoiceSession
 *    actuates via cancelResponse) → `frameworkOwnsInterrupt: true`. Qwen generates
 *    faster than realtime, so barge-in must work through the buffered-playback
 *    tail — sessions enable `nativePlaybackGating` + `playbackStateProtocol`.
 *  - In-place `session.update` works → `inPlaceSessionUpdate: true`.
 *  - Input transcription final text is in `...completed.transcript`.
 *  - Usage is at `response.done.response.usage`.
 */

import { WebSocket } from 'ws';
import { TransportError, ValidationError } from '../core/errors.js';
import type { ToolDefinition } from '../types/tool.js';
import {
	type AudioFormatSpec,
	type CancelResponseOptions,
	type ContentTurn,
	DEFAULT_TRANSPORT_CAPABILITIES,
	type LLMTransport,
	type LLMTransportConfig,
	type ReconnectState,
	type ReplayItem,
	type SessionUpdate,
	type TransportCapabilities,
	type TransportToolCall,
	type TransportToolResult,
} from '../types/transport.js';
import { OpenAIFunctionCallAssembler } from './openai-function-call-assembler.js';
import {
	DEFAULT_QWEN_REALTIME_MODEL,
	DEFAULT_QWEN_REALTIME_URL,
	type QwenRealtimeModel,
	supports,
} from './qwen-realtime-models.js';
import { normalizeQwenResponseUsage } from './realtime-usage-normalize.js';
import { zodToJsonSchema } from './zod-to-schema.js';

/** Qwen server_vad config. Only `type`/`threshold`/`silence_duration_ms` are
 *  doc-confirmed; other fields go through `providerOptions.qwen.turnDetection`. */
export interface QwenTurnDetection {
	type: 'server_vad';
	threshold?: number;
	silence_duration_ms?: number;
}

/** Configuration for constructing a QwenRealtimeTransport. */
export interface QwenRealtimeConfig {
	/** DashScope API key (QWEN_API_KEY / DASHSCOPE_API_KEY). */
	apiKey: string;
	/** Model id. Default `qwen3.5-omni-plus-realtime`. */
	model?: QwenRealtimeModel;
	/** Full wss base URL. Default: Singapore endpoint. */
	baseURL?: string;
	/** Voice name. Omit → server default (`Tina`). See qwen-realtime-models.ts caveat. */
	voice?: string;
	/** System instructions. */
	instructions?: string;
	/** server_vad config; `null` → manual mode (probe only). Default: server_vad. */
	turnDetection?: QwenTurnDetection | null;
	/** Response modality. 'text' → external-TTS path. Default 'audio'. */
	responseModality?: 'audio' | 'text';
	/** Tools the model may call. */
	tools?: ToolDefinition[];
	/** Native web search (off by default). */
	webSearch?: { enabled: boolean; enableSource?: boolean };
	/** Qwen-specific input-transcription config object (overrides the boolean toggle). */
	inputAudioTranscription?: Record<string, unknown>;
	/** Forward-compat escape hatch (whitelisted; never clobbers reserved fields). */
	providerOptions?: { qwen?: Record<string, unknown> };
}

const RESERVED_SESSION_KEYS = new Set([
	'modalities',
	'voice',
	'input_audio_format',
	'output_audio_format',
	'instructions',
	'turn_detection',
	'tools',
	'tool_choice',
	'input_audio_transcription',
]);

/** `providerOptions.qwen` keys handled explicitly (mapped onto Qwen wire fields
 *  or merged elsewhere) — NOT passed through verbatim. */
const QWEN_ALIAS_KEYS = new Set([
	'enableSearch',
	'searchOptions',
	'inputAudioTranscription',
	'turnDetection',
]);

type Ev = { type?: string; [k: string]: unknown };

const CONNECT_TIMEOUT_MS = 15_000;
const CANCEL_DONE_TIMEOUT_MS = 2_000;

export class QwenRealtimeTransport implements LLMTransport {
	private config: QwenRealtimeConfig;
	private ws: WebSocket | null = null;
	private _connected = false;
	private sessionId: string | null = null;
	private firstUpdateAcked = false;

	private readonly assembler = new OpenAIFunctionCallAssembler();
	private completedToolCalls: TransportToolCall[] = [];
	private isGenerating = false;
	private suppressAudio = false;
	private inputTranscriptionEnabled = true;
	// Tool-result scheduling: 'when_idle' results buffered while the model is
	// generating (flushed on response.done); 'interrupt' results serialized
	// behind a cancel.
	private pendingWhenIdle: TransportToolResult[] = [];
	private interruptToolResultQueue: Promise<void> = Promise.resolve();

	// Serializes post-connect session.update calls; each awaits its session.updated ack.
	private sessionUpdateQueue: Promise<void> = Promise.resolve();
	private pendingUpdateAck: { resolve: () => void; reject: (e: Error) => void } | null = null;
	private resolveActiveResponseDone: (() => void) | null = null;

	private _capabilities: TransportCapabilities;
	private _audioFormat: AudioFormatSpec;

	// --- Callbacks ---
	onAudioOutput?: (base64Data: string) => void;
	onToolCall?: (calls: TransportToolCall[]) => void;
	onToolCallCancel?: (ids: string[]) => void;
	onTurnComplete?: (serverTurnId?: number) => void;
	onInterrupted?: (serverTurnId?: number) => void;
	onInputTranscription?: (text: string) => void;
	onOutputTranscription?: (text: string) => void;
	onSessionReady?: (sessionId: string) => void;
	onError?: (error: { error: Error; recoverable: boolean }) => void;
	onClose?: (code?: number, reason?: string) => void;
	onModelTurnStart?: () => void;
	onTextOutput?: (text: string) => void;
	onTextDone?: () => void;
	onSpeechStarted?: () => void;
	onRealtimeLLMUsage?: (usage: ReturnType<typeof normalizeQwenResponseUsage>) => void;

	constructor(config: QwenRealtimeConfig) {
		if (!config.apiKey) throw new ValidationError('QwenRealtimeTransport requires an apiKey');
		this.config = { ...config };
		this.inputTranscriptionEnabled = true;
		this._capabilities = this.resolveCapabilities();
		this._audioFormat = {
			inputSampleRate: 16000,
			outputSampleRate: 24000,
			channels: 1,
			bitDepth: 16,
			encoding: 'pcm',
			outputBitDepth: 16,
			outputEncoding: 'pcm',
		};
	}

	private resolveCapabilities(): TransportCapabilities {
		return {
			...DEFAULT_TRANSPORT_CAPABILITIES,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: true,
			textResponseModality: true,
			// Framework-owned interrupt (mirrors OpenAI Realtime): we set
			// `turn_detection.interrupt_response: false` so Qwen does NOT auto-cancel,
			// and VoiceSession actuates barge-in via cancelResponse(). Qwen generates
			// faster than realtime (response.done at generation end), so most barge-ins
			// land in the buffered-playback TAIL — the framework's nativePlaybackGating
			// path covers that, and only arms when frameworkOwnsInterrupt is true.
			frameworkOwnsInterrupt: true,
			// response.done is generation-gated (like OpenAI) — the session needs
			// nativePlaybackGating + playbackStateProtocol to arm tail barge-in.
			playbackGatedTurnComplete: false,
			// Grace window after first audio so browser AEC converges before
			// echo-triggered events count as barge-in (OpenAI default).
			greetingInterruptGraceMs: 1000,
		};
	}

	get capabilities(): TransportCapabilities {
		return this._capabilities;
	}

	get audioFormat(): AudioFormatSpec {
		return this._audioFormat;
	}

	get isConnected(): boolean {
		return this._connected;
	}

	// --- Lifecycle ---

	async connect(transportConfig?: LLMTransportConfig): Promise<void> {
		if (transportConfig) this.applyTransportConfig(transportConfig);
		const model = this.config.model ?? DEFAULT_QWEN_REALTIME_MODEL;
		const tools = this.config.tools ?? [];
		if (tools.length > 0 && !supports(model, 'tools')) {
			throw new ValidationError(`Qwen Realtime model '${model}' does not support tool calling`);
		}

		const base = this.config.baseURL ?? DEFAULT_QWEN_REALTIME_URL;
		const url = `${base}?model=${encodeURIComponent(model)}`;

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					this.ws?.close();
				} catch {
					/* */
				}
				reject(new TransportError('Qwen connect timed out'));
			}, CONNECT_TIMEOUT_MS);

			const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.config.apiKey}` } });
			this.ws = ws;

			ws.on('open', () => {
				ws.send(JSON.stringify({ type: 'session.update', session: this.buildSessionConfig() }));
			});
			ws.on('message', (raw) => {
				let e: Ev;
				try {
					e = JSON.parse(raw.toString());
				} catch {
					return; // ignore malformed frames
				}
				// Resolve connect on the first session.updated (config acked).
				if (!settled && (e.type === 'session.updated' || e.type === 'error')) {
					settled = true;
					clearTimeout(timer);
					if (e.type === 'error') {
						reject(
							new TransportError(
								`Qwen session.update rejected: ${JSON.stringify((e as { error?: unknown }).error ?? e)}`,
							),
						);
						try {
							ws.close();
						} catch {
							/* */
						}
						return;
					}
					this._connected = true;
					this.firstUpdateAcked = true;
					if (this.sessionId && this.onSessionReady) this.onSessionReady(this.sessionId);
					resolve();
				}
				this.handleEvent(e);
			});
			ws.on('error', (err) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(err instanceof Error ? err : new TransportError(String(err)));
				} else if (this.onError) {
					this.onError({
						error: err instanceof Error ? err : new Error(String(err)),
						recoverable: true,
					});
				}
			});
			ws.on('close', (code, reasonBuf) => {
				const wasConnected = this._connected;
				this.cleanupOnClose();
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(new TransportError(`Qwen socket closed before session.updated (code ${code})`));
					return;
				}
				if (wasConnected && this.onClose) this.onClose(code, reasonBuf?.toString());
			});
		});
	}

	async disconnect(): Promise<void> {
		this._connected = false;
		// Reject any pending session.update ack / cancel waiter so callers don't hang.
		this.pendingUpdateAck?.reject(new TransportError('disconnected'));
		this.pendingUpdateAck = null;
		this.resolveActiveResponseDone?.();
		this.resolveActiveResponseDone = null;
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			try {
				ws.removeAllListeners();
				ws.close();
			} catch {
				/* */
			}
		}
		this.assembler.clear();
		this.completedToolCalls = [];
		this.pendingWhenIdle = [];
		this.isGenerating = false;
	}

	async reconnect(state?: ReconnectState): Promise<void> {
		await this.disconnect();
		await this.connect();
		if (state?.conversationHistory?.length) this.replayHistory(state.conversationHistory);
	}

	private cleanupOnClose(): void {
		this._connected = false;
		this.pendingUpdateAck?.reject(new TransportError('socket closed'));
		this.pendingUpdateAck = null;
		this.resolveActiveResponseDone?.();
		this.resolveActiveResponseDone = null;
		this.assembler.clear();
		this.completedToolCalls = [];
		this.pendingWhenIdle = [];
		this.isGenerating = false;
	}

	// --- Audio ---

	sendAudio(base64Data: string): void {
		this.send({ type: 'input_audio_buffer.append', audio: base64Data });
	}

	commitAudio(): void {
		// Server VAD auto-commits; only meaningful in manual mode.
		if (this.config.turnDetection === null) this.send({ type: 'input_audio_buffer.commit' });
	}

	clearAudio(): void {
		this.send({ type: 'input_audio_buffer.clear' });
	}

	clearInputAudio(): void {
		this.clearAudio();
	}

	// --- Interrupt actuation (cancelResponse) ---

	async cancelResponse(opts?: CancelResponseOptions): Promise<void> {
		try {
			if (!this._connected) return;
			if (!this.isGenerating) return;
			const wait = opts?.waitForDone
				? new Promise<void>((resolve) => {
						this.resolveActiveResponseDone = resolve;
						setTimeout(resolve, CANCEL_DONE_TIMEOUT_MS);
					})
				: null;
			this.suppressAudio = true;
			this.send({ type: 'response.cancel' });
			this.isGenerating = false;
			if (wait) await wait;
		} catch {
			// Never reject — fire-and-forget callers must not see unhandled rejections.
		}
	}

	// --- Session configuration ---

	async updateSession(config: SessionUpdate): Promise<void> {
		if (config.transcription?.input === false) this.inputTranscriptionEnabled = false;
		else if (config.transcription?.input === true) this.inputTranscriptionEnabled = true;
		if (config.responseModality) this.config.responseModality = config.responseModality;
		if (config.instructions !== undefined) this.config.instructions = config.instructions;
		if (config.tools !== undefined) this.config.tools = config.tools;
		// Merge incoming provider options so post-connect Qwen knobs (e.g. web search)
		// take effect on the next session.update.
		const incomingQwen = (config.providerOptions as { qwen?: Record<string, unknown> } | undefined)
			?.qwen;
		if (incomingQwen) {
			this.config.providerOptions = {
				qwen: { ...this.config.providerOptions?.qwen, ...incomingQwen },
			};
		}

		// Pre-connect: coalesce into the initial session.update (sent at connect).
		if (!this._connected) return;

		const session = this.buildSessionConfig(config);
		// Serialize: one wire session.update per call, await its ack.
		const run = this.sessionUpdateQueue.then(() => this.sendSessionUpdateAndWait(session));
		this.sessionUpdateQueue = run.catch(() => undefined);
		return run;
	}

	async transferSession(config: SessionUpdate, _state?: ReconnectState): Promise<void> {
		// inPlaceSessionUpdate === true (Phase 0): in-place update, no reconnect.
		return this.updateSession(config);
	}

	private sendSessionUpdateAndWait(session: Record<string, unknown>): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pendingUpdateAck) {
					this.pendingUpdateAck = null;
					reject(new TransportError('session.update ack timed out'));
				}
			}, CONNECT_TIMEOUT_MS);
			this.pendingUpdateAck = {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			};
			this.send({ type: 'session.update', session });
		});
	}

	// --- Content injection ---

	sendContent(turns: ContentTurn[], turnComplete?: boolean): void {
		for (const turn of turns) {
			const contentType = turn.role === 'user' ? 'input_text' : 'output_text';
			this.send({
				type: 'conversation.item.create',
				item: {
					type: 'message',
					role: turn.role,
					content: [{ type: contentType, text: turn.text }],
				},
			});
		}
		if (turnComplete) this.send({ type: 'response.create' });
	}

	sendFile(_base64Data: string, _mimeType: string): void {
		throw new ValidationError('QwenRealtimeTransport does not support file/image input in V1');
	}

	// --- Tool interaction ---

	sendToolResult(result: TransportToolResult): void {
		const model = this.config.model ?? DEFAULT_QWEN_REALTIME_MODEL;
		if (!supports(model, 'tools')) {
			throw new ValidationError(`Qwen Realtime model '${model}' does not support tool calling`);
		}
		if (!this._connected) return;
		const scheduling = result.scheduling ?? 'immediate';

		// 'when_idle': background results wait for the model to finish speaking so
		// they don't cut off the current response. Buffered, flushed on response.done.
		if (scheduling === 'when_idle' && this.isGenerating) {
			this.pendingWhenIdle.push(result);
			return;
		}

		// 'interrupt': cancel the active response first, then deliver. Serialized so
		// the cancel's response.done(cancelled) lands before the new response.create.
		if (
			scheduling === 'interrupt' &&
			(this.isGenerating || this.resolveActiveResponseDone !== null)
		) {
			const run = async () => {
				try {
					if (!this._connected) return;
					await this.cancelResponse({ waitForDone: true });
					if (!this._connected) return;
					this.sendToolResultNow(result);
				} catch {
					/* per-item failure must not poison the queue */
				}
			};
			this.interruptToolResultQueue = this.interruptToolResultQueue.then(run, run);
			return;
		}

		this.sendToolResultNow(result);
	}

	private sendToolResultNow(result: TransportToolResult): void {
		const output =
			typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
		this.send({
			type: 'conversation.item.create',
			item: { type: 'function_call_output', call_id: result.id, output },
		});
		// 'silent': inject the result without triggering a new response.
		if (result.scheduling !== 'silent') this.send({ type: 'response.create' });
	}

	private flushPendingWhenIdle(): void {
		if (this.pendingWhenIdle.length === 0) return;
		const queued = this.pendingWhenIdle;
		this.pendingWhenIdle = [];
		for (const result of queued) {
			const output =
				typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
			this.send({
				type: 'conversation.item.create',
				item: { type: 'function_call_output', call_id: result.id, output },
			});
		}
		this.send({ type: 'response.create' });
	}

	// --- Generation control ---

	triggerGeneration(instructions?: string): void {
		// O4: response.instructions is accepted (cache-safe inline form).
		const response: Record<string, unknown> = {};
		if (instructions) response.instructions = instructions;
		this.send(
			Object.keys(response).length > 0
				? { type: 'response.create', response }
				: { type: 'response.create' },
		);
	}

	// --- Internal ---

	private send(msg: Record<string, unknown>): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
	}

	private applyTransportConfig(tc: LLMTransportConfig): void {
		if (tc.auth) {
			if (tc.auth.type !== 'api_key') {
				throw new ValidationError(
					`QwenRealtimeTransport requires api_key auth, got ${tc.auth.type}`,
				);
			}
			this.config.apiKey = tc.auth.apiKey;
		}
		if (tc.model) this.config.model = tc.model;
		if (tc.instructions !== undefined) this.config.instructions = tc.instructions;
		if (tc.tools !== undefined) this.config.tools = tc.tools;
		if (tc.voice !== undefined) this.config.voice = tc.voice;
		if (tc.responseModality) this.config.responseModality = tc.responseModality;
		if (tc.transcription?.input === false) this.inputTranscriptionEnabled = false;
		const qwen = (tc.providerOptions as { qwen?: Record<string, unknown> } | undefined)?.qwen;
		if (qwen)
			this.config.providerOptions = { qwen: { ...this.config.providerOptions?.qwen, ...qwen } };
	}

	/** Modality resolver: 'text' → ['text']; else Qwen audio shape. */
	private resolveModalities(): string[] {
		return this.config.responseModality === 'text' ? ['text'] : ['text', 'audio'];
	}

	private buildToolsArray(): Array<Record<string, unknown>> | undefined {
		const tools = this.config.tools;
		if (!tools || tools.length === 0) return undefined;
		return tools.map((t) => ({
			type: 'function',
			name: t.name,
			description: t.description,
			parameters: zodToJsonSchema(t.parameters, 'standard'),
		}));
	}

	/** Build the `session` object. When `patch` is given (updateSession), only the
	 *  patched fields plus always-safe formats are sent. */
	private buildSessionConfig(patch?: SessionUpdate): Record<string, unknown> {
		const session: Record<string, unknown> = {
			modalities: this.resolveModalities(),
			input_audio_format: 'pcm',
			output_audio_format: 'pcm',
		};
		if (this.config.voice) session.voice = this.config.voice;
		if (this.config.instructions !== undefined) session.instructions = this.config.instructions;

		// turn_detection: default server_vad; null = manual. Framework-owned
		// interrupt sets `interrupt_response: false` so Qwen does NOT auto-cancel
		// (VoiceSession actuates barge-in via cancelResponse). `prefix_padding_ms`
		// /`create_response`/`interrupt_response` overrides go via
		// providerOptions.qwen.turnDetection.
		if (this.config.turnDetection === null) {
			session.turn_detection = null;
		} else {
			const base = this.config.turnDetection ?? { type: 'server_vad' };
			const rawOverrides =
				(this.config.providerOptions?.qwen?.turnDetection as Record<string, unknown> | undefined) ??
				{};
			const { interrupt_response: _ignoredInterruptResponse, ...overrides } = rawOverrides;
			session.turn_detection = {
				...base,
				...(this._capabilities.frameworkOwnsInterrupt === true
					? { interrupt_response: false }
					: {}),
				...overrides,
			};
		}

		const tools = this.buildToolsArray();
		if (tools) {
			session.tools = tools;
			session.tool_choice = 'auto';
		}

		const qwen = this.config.providerOptions?.qwen ?? {};

		// Input transcription: null to disable; else typed config wins, then the
		// providerOptions.qwen.inputAudioTranscription alias, then default-on (omit).
		if (!this.inputTranscriptionEnabled) {
			session.input_audio_transcription = null;
		} else {
			const iat =
				this.config.inputAudioTranscription ??
				(qwen.inputAudioTranscription as Record<string, unknown> | undefined);
			if (iat) session.input_audio_transcription = iat;
		}

		// Web search: typed `webSearch` is canonical; `providerOptions.qwen.enableSearch`
		// / `searchOptions` are lower-precedence aliases. Map both onto the Qwen wire
		// fields `enable_search` / `search_options`.
		const searchEnabled = this.config.webSearch?.enabled ?? Boolean(qwen.enableSearch);
		if (searchEnabled) {
			session.enable_search = true;
			if (this.config.webSearch?.enableSource !== undefined) {
				session.search_options = { enable_source: this.config.webSearch.enableSource };
			} else if (qwen.searchOptions !== undefined) {
				session.search_options = qwen.searchOptions;
			} else {
				session.search_options = { enable_source: false };
			}
		}

		// Forward-compat: pass through remaining providerOptions.qwen keys verbatim
		// (skipping reserved fields and the aliases mapped above).
		for (const [k, v] of Object.entries(qwen)) {
			if (!RESERVED_SESSION_KEYS.has(k) && !QWEN_ALIAS_KEYS.has(k)) session[k] = v;
		}

		// For a targeted patch, override with the patched fields (still send formats
		// so the provider never loses them).
		if (patch) {
			if (patch.instructions !== undefined) session.instructions = patch.instructions;
			if (patch.responseModality)
				session.modalities = patch.responseModality === 'text' ? ['text'] : ['text', 'audio'];
			if (patch.transcription?.input === false) session.input_audio_transcription = null;
		}
		return session;
	}

	private replayHistory(history: ReplayItem[]): void {
		for (const item of history) {
			if (item.type === 'text') {
				const contentType = item.role === 'user' ? 'input_text' : 'output_text';
				this.send({
					type: 'conversation.item.create',
					item: {
						type: 'message',
						role: item.role,
						content: [{ type: contentType, text: item.text }],
					},
				});
			} else if (item.type === 'tool_result') {
				const output = typeof item.result === 'string' ? item.result : JSON.stringify(item.result);
				this.send({
					type: 'conversation.item.create',
					item: { type: 'function_call_output', call_id: item.id, output },
				});
			}
		}
	}

	private handleEvent(e: Ev): void {
		switch (e.type) {
			case 'session.created':
				this.sessionId = (e as { session?: { id?: string } }).session?.id ?? this.sessionId;
				break;
			case 'session.updated':
				if (this.firstUpdateAcked) {
					// Post-connect ack.
					this.pendingUpdateAck?.resolve();
					this.pendingUpdateAck = null;
				}
				break;
			case 'input_audio_buffer.speech_started':
				// Always signal speech start (drives the framework's barge-in path).
				if (this.onSpeechStarted) this.onSpeechStarted();
				// Framework-owned mode (default): VoiceSession actuates the interrupt
				// via cancelResponse() — do NOT fire onInterrupted here (would
				// double-actuate; the interface forbids callbacks from cancelResponse).
				// Provider-owned mode only: interrupt locally on barge-in mid-generation.
				if (this._capabilities.frameworkOwnsInterrupt !== true && this.isGenerating) {
					this.suppressAudio = true;
					this.isGenerating = false;
					if (this.onInterrupted) this.onInterrupted();
				}
				break;
			case 'conversation.item.input_audio_transcription.completed': {
				if (this.inputTranscriptionEnabled && this.onInputTranscription) {
					this.onInputTranscription((e as { transcript?: string }).transcript ?? '');
				}
				break;
			}
			case 'response.created':
				this.isGenerating = true;
				this.suppressAudio = false;
				this.completedToolCalls = [];
				if (this.onModelTurnStart) this.onModelTurnStart();
				break;
			case 'response.output_item.added': {
				const item = (e as { item?: { type?: string; call_id?: string; name?: string } }).item;
				if (item?.type === 'function_call' && item.call_id && item.name) {
					this.assembler.startCall(item.call_id, item.name);
				}
				break;
			}
			case 'response.function_call_arguments.delta': {
				const ev = e as { call_id?: string; delta?: string };
				if (ev.call_id && typeof ev.delta === 'string')
					this.assembler.appendDelta(ev.call_id, ev.delta);
				break;
			}
			case 'response.function_call_arguments.done': {
				const ev = e as { call_id?: string };
				if (ev.call_id) {
					const done = this.assembler.finalize(ev.call_id);
					if (done)
						this.completedToolCalls.push({ id: done.callId, name: done.name, args: done.args });
				}
				break;
			}
			case 'response.audio.delta': {
				const delta = (e as { delta?: string }).delta;
				if (!this.suppressAudio && typeof delta === 'string' && this.onAudioOutput)
					this.onAudioOutput(delta);
				break;
			}
			case 'response.audio_transcript.delta': {
				const delta = (e as { delta?: string }).delta;
				if (typeof delta === 'string' && this.onOutputTranscription)
					this.onOutputTranscription(delta);
				break;
			}
			case 'response.text.delta': {
				const delta = (e as { delta?: string }).delta;
				if (typeof delta === 'string' && this.onTextOutput) this.onTextOutput(delta);
				break;
			}
			case 'response.text.done':
				if (this.onTextDone) this.onTextDone();
				break;
			case 'response.done':
				this.handleResponseDone(e);
				break;
			case 'error':
				if (this.onError) {
					this.onError({
						error: new TransportError(
							`Qwen error: ${JSON.stringify((e as { error?: unknown }).error ?? e)}`,
						),
						recoverable: true,
					});
				}
				// An error may also terminate the in-flight response.
				this.resolveActiveResponseDone?.();
				this.resolveActiveResponseDone = null;
				this.pendingUpdateAck?.reject(new TransportError('session.update error'));
				this.pendingUpdateAck = null;
				break;
		}
	}

	private handleResponseDone(e: Ev): void {
		// Unblock any cancelResponse({ waitForDone }) waiter (any status terminates).
		this.resolveActiveResponseDone?.();
		this.resolveActiveResponseDone = null;

		const resp = (e as { response?: { id?: string; usage?: unknown; status?: string } }).response;
		const usage = normalizeQwenResponseUsage(resp?.usage, resp?.id);
		if (usage && this.onRealtimeLLMUsage) this.onRealtimeLLMUsage(usage);

		if (resp?.status === 'cancelled') {
			// Trailing done of a barge-in / explicit cancel. onInterrupted already
			// fired; do NOT finalize a turn or dispatch the cancelled response's calls.
			this.completedToolCalls = [];
			this.isGenerating = false;
			return;
		}

		if (this.completedToolCalls.length > 0 && this.onToolCall) {
			const calls = this.completedToolCalls;
			this.completedToolCalls = [];
			this.onToolCall(calls);
		} else {
			this.completedToolCalls = [];
		}
		this.isGenerating = false;
		// Model is idle now — deliver any 'when_idle' tool results that were buffered.
		this.flushPendingWhenIdle();
		if (this.onTurnComplete) this.onTurnComplete();
	}
}
