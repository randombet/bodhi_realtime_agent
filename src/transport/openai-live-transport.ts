/**
 * OpenAILiveTransport — GPT-Live (`gpt-live-1`) over the primary Live WebSocket.
 *
 * GPT-Live is a full-duplex voice model: it listens while it speaks, decides when
 * to talk on its own, and hands reasoning and tool use to a *backend* through
 * **delegation**. It is not the Realtime API: a different endpoint
 * (`wss://api.openai.com/v1/live/sessions`), different events, and no turn
 * boundaries on the wire. This transport maps that protocol onto `LLMTransport`
 * so `VoiceSession` can drive it like any other provider.
 *
 * Wire facts this file is built on (validated live, 2026-10-17, probes in the
 * design notes):
 *  - `session.start` → `session.started` (~0.6–1.6 s). Audio in/out is base64
 *    PCM16 (16 or 24 kHz) or G.711 inside JSON events.
 *  - Output audio is a CONTINUOUS stream: `session.output_audio.delta` keeps
 *    arriving (100 ms frames of silence) while the model is quiet. There is no
 *    response-start / response-done / interrupted event. Model "turns" are
 *    therefore derived here from output speech activity (frame energy, plus
 *    `session.output_transcript.delta`), and silent frames are dropped so the
 *    rest of the framework sees the bursty audio shape it expects.
 *  - Transcripts arrive as fragments with `start_ms`/`end_ms` on the session
 *    timeline, for both speakers, with no utterance boundary.
 *  - With **Responses delegation** the backend's streaming events arrive nested
 *    in `response.event` envelopes; function calls are read from the nested
 *    `response.output_item.done` items, answered with `response.item.create`
 *    (`function_call_output`) and continued with ONE `response.create` once
 *    every call of that response has its output.
 *  - With **client delegation** `session.delegation.created` carries only an id
 *    and a timestamp; the task text is whatever the transcript says. Results go
 *    back as `session.commentary.append` (spoken, paraphrased) or
 *    `session.thinking.append` (silent), ≤500 tokens per append.
 *  - `session.close` → `session.closed` (final `usage.seconds`), then the
 *    server drops the socket (1006).
 *
 * Mapping summary:
 *  - Responses delegation → each backend function call is an `onToolCall`; the
 *    tool result is the function output; a second result for the same call id
 *    (a background tool's final answer after its pending message) is spoken via
 *    `session.commentary.append`.
 *  - Client delegation → every delegation becomes ONE synthesized tool call
 *    (`clientDelegationTool`, default `delegate(request)`) whose argument is the
 *    recent transcript; `sendToolResult` for that id is appended as commentary
 *    (or thinking when `scheduling: 'silent'`).
 *  - Barge-in is the model's own: `frameworkOwnsInterrupt: false`,
 *    `cancelResponse` is a no-op. A speaking run that stops shortly after the
 *    user's transcript resumed is reported through `onInterrupted` (heuristic);
 *    every other run ends with `onTurnComplete`.
 */

import { WebSocket } from 'ws';
import { type FrameEnergy, analyzeFrameInto } from '../core/audio-frame-analyzer.js';
import { TransportError, ValidationError } from '../core/errors.js';
import type { ToolDefinition } from '../types/tool.js';
import {
	type AudioFormatSpec,
	type CancelResponseOptions,
	type ContentTurn,
	DEFAULT_TRANSPORT_CAPABILITIES,
	type GenerationEndReason,
	type LLMTransport,
	type LLMTransportConfig,
	type LLMTransportError,
	type RealtimeLLMUsageEvent,
	type ReconnectState,
	type ReplayItem,
	type SessionUpdate,
	type TransportCapabilities,
	type TransportToolCall,
	type TransportToolResult,
} from '../types/transport.js';
import { zodToJsonSchema } from './zod-to-schema.js';

export const DEFAULT_OPENAI_LIVE_MODEL = 'gpt-live-1';
export const DEFAULT_OPENAI_LIVE_URL = 'wss://api.openai.com/v1/live/sessions';
export const DEFAULT_OPENAI_LIVE_VOICE = 'marin';

/** Audio format on the Live WebSocket. One format for both directions, fixed at
 *  startup. A-law (`audio/pcma`) exists on the wire but `AudioFormatSpec` has
 *  no encoding for it, so it is rejected here. */
export type OpenAILiveAudioFormat =
	| { type: 'audio/pcm'; rate?: 16000 | 24000 }
	| { type: 'audio/pcmu' };

/** Hosted tools the Responses backend may run itself (no application result). */
export type OpenAILiveHostedTool = { type: 'web_search' } | { type: string; [k: string]: unknown };

/** Who does the thinking when GPT-Live delegates. */
export type OpenAILiveDelegation =
	| {
			/** Your application: every delegation is one synthesized tool call. */
			type: 'client';
	  }
	| {
			/** A Responses model run by OpenAI, with this transport's `tools` as its
			 *  function tools. The model's function calls come back as `onToolCall`. */
			type: 'responses';
			/** Backend model, e.g. `gpt-5.6-luna`. Required. */
			model: string;
			/** Backend prompt (task procedures, business rules). Separate from the
			 *  Live `instructions`, which only shape the conversation. */
			instructions?: string;
			toolChoice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string };
			parallelToolCalls?: boolean;
			maxOutputTokens?: number;
			reasoning?: { effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' };
			serviceTier?: 'auto' | 'default' | 'flex' | 'priority';
			/** Hosted tools appended after the function tools. */
			hostedTools?: OpenAILiveHostedTool[];
	  };

/** How a client delegation is presented to the framework. */
export interface OpenAILiveClientDelegationTool {
	/** Tool name of the synthesized call (a `ToolDefinition` of this name must be
	 *  registered on the agent — e.g. a background tool handing the request to a
	 *  subagent). Default `delegate`. */
	name: string;
	/** Argument that receives the recent transcript. Default `request`. */
	argument: string;
	/** How far back the transcript goes, on the session timeline. Default 90 s. */
	contextMs?: number;
}

export interface OpenAILiveConfig {
	apiKey: string;
	/** Default `gpt-live-1`. */
	model?: string;
	/** Default `wss://api.openai.com/v1/live/sessions`. */
	baseURL?: string;
	/** Default `marin`. Fixed at startup. */
	voice?: string;
	/** The Live (frontend) prompt: identity, speaking style, when to delegate.
	 *  ≤16,384 tokens, fixed at startup; later changes are appended in chunks. */
	instructions?: string;
	/** Function tools. With Responses delegation they are the backend's tools. With
	 *  client delegation only `clientDelegationTool.name` is ever called. */
	tools?: ToolDefinition[];
	/** Default `{ type: 'client' }` (the API default). */
	delegation?: OpenAILiveDelegation;
	clientDelegationTool?: Partial<OpenAILiveClientDelegationTool>;
	/** Default PCM16 at 24 kHz. */
	audioFormat?: OpenAILiveAudioFormat;
	/** Store the session for forking / recording download. Default false. */
	store?: boolean;
	/** Silence after the last voiced output frame (or transcript fragment) that
	 *  closes a model turn. Default 700 ms. */
	speechGapMs?: number;
	/** Mean absolute PCM16 amplitude at or above which an output frame counts as
	 *  speech. Default 24. Only used for PCM. */
	silenceThreshold?: number;
	/** Forward the model's silent output frames too (continuous stream) instead
	 *  of dropping them. Default false. Always true for G.711 (no energy read). */
	forwardSilence?: boolean;
	/** A speaking run that ends within this long after the user's transcript
	 *  resumed is reported as interrupted. Default 1500 ms; 0 disables. */
	interruptWindowMs?: number;
	/** Extra keys merged into the `session.start` session object (forward compat). */
	providerOptions?: { live?: Record<string, unknown> };
	/** Diagnostic sink. */
	log?: (message: string) => void;
}

type Ev = { type?: string; [k: string]: unknown };

const CONNECT_TIMEOUT_MS = 15_000;
const ACK_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 5_000;
/** Conservative bound for the 500-token append limit. */
const APPEND_MAX_CHARS = 1_200;
/** `session.input` at startup: 128 messages, 8,192 tokens. */
const INPUT_MAX_ITEMS = 128;
const INPUT_MAX_CHARS = 24_000;
/** Silent output frames still forwarded after the last voiced one. */
const SILENCE_HANGOVER_MS = 200;
/** The function output a background call gets at once, so the backend's response can finish. */
const BACKGROUND_STARTED_OUTPUT =
	'Started in the background. The result is not available yet; it will be delivered later as a ' +
	'separate message. Tell the user in one short sentence that it has started, then continue the conversation.';

/** A gap this long in the user's transcript starts a new utterance. */
const USER_UTTERANCE_GAP_MS = 1_000;

const LIVE_SESSION_KEYS = new Set([
	'model',
	'instructions',
	'audio',
	'delegation',
	'input',
	'store',
	'client',
	'triggers',
]);

/** Split text into appends of at most `max` characters, at sentence or word
 *  boundaries where possible. */
export function chunkForAppend(text: string, max = APPEND_MAX_CHARS): string[] {
	const out: string[] = [];
	let rest = text.trim();
	while (rest.length > max) {
		let cut = -1;
		const head = rest.slice(0, max);
		for (const re of [/[.!?。！？]\s/g, /\s/g]) {
			let last = -1;
			for (const m of head.matchAll(re)) last = (m.index ?? 0) + m[0].length;
			if (last > max / 3) {
				cut = last;
				break;
			}
		}
		if (cut <= 0) cut = max;
		out.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) out.push(rest);
	return out;
}

interface TranscriptFragment {
	role: 'user' | 'assistant';
	text: string;
	startMs: number;
	endMs: number;
}

export class OpenAILiveTransport implements LLMTransport {
	private config: OpenAILiveConfig;
	private ws: WebSocket | null = null;
	private _connected = false;
	private sessionId: string | null = null;
	private closedReason: string | null = null;
	private eventSeq = 0;

	private readonly _capabilities: TransportCapabilities;
	private readonly _audioFormat: AudioFormatSpec;
	private readonly forwardSilence: boolean;
	private readonly energy: FrameEnergy = { maxAbs: 0, avgAbs: 0, samples: 0 };

	// --- Output speech activity → framework turns ---
	private speaking = false;
	private generationSeq = 0;
	private openGenerationId: string | null = null;
	private lastVoicedAt = 0;
	private gapTimer: ReturnType<typeof setTimeout> | null = null;
	private firstAudioFired = false;
	private suppressOutput = false;
	private quiesced = false;

	// --- User speech evidence (transcript) ---
	private lastInputTranscriptAt = 0;
	private userResumedAt = 0;

	// --- Transcript ledger (client delegation context) ---
	private fragments: TranscriptFragment[] = [];

	// --- Delegation state ---
	private readonly clientDelegations = new Set<string>();
	/** Responses mode: function calls awaiting an output, per backend response. */
	private readonly awaitingOutputs = new Map<string, Set<string>>();
	private readonly callToResponse = new Map<string, string>();
	private readonly collectedCalls = new Map<string, TransportToolCall[]>();
	private backendBusy = 0;
	private pendingWhenIdle: TransportToolResult[] = [];

	// --- Acks ---
	private readonly pendingAcks = new Map<
		string,
		{ resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	private sessionUpdateQueue: Promise<void> = Promise.resolve();
	private resolveClosed: (() => void) | null = null;

	// --- LLMTransport callbacks ---
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
	onFirstAudioChunk?: () => void;
	onSpeechStarted?: () => void;
	onRealtimeLLMUsage?: (usage: RealtimeLLMUsageEvent) => void;
	/** Backend (Responses delegation) text as it completes — the fact the model
	 *  will paraphrase aloud. Not part of `LLMTransport`; diagnostics only. */
	onBackendText?: (text: string, delegationId: string | null) => void;

	constructor(config: OpenAILiveConfig) {
		if (!config.apiKey) throw new ValidationError('OpenAILiveTransport requires an apiKey');
		this.config = { ...config };
		const fmt = config.audioFormat ?? { type: 'audio/pcm', rate: 24000 };
		if ((fmt as { type: string }).type === 'audio/pcma') {
			throw new ValidationError('OpenAILiveTransport: audio/pcma has no AudioFormatSpec encoding');
		}
		if (
			fmt.type === 'audio/pcm' &&
			fmt.rate !== undefined &&
			fmt.rate !== 16000 &&
			fmt.rate !== 24000
		) {
			throw new ValidationError(
				`OpenAILiveTransport: audio/pcm accepts 16000 or 24000 Hz, got ${String(fmt.rate)}`,
			);
		}
		const pcm = fmt.type === 'audio/pcm';
		const rate = pcm ? (fmt.rate ?? 24000) : 8000;
		this._audioFormat = {
			inputSampleRate: rate,
			outputSampleRate: rate,
			channels: 1,
			bitDepth: pcm ? 16 : 8,
			encoding: pcm ? 'pcm' : 'pcmu',
			outputBitDepth: pcm ? 16 : 8,
			outputEncoding: pcm ? 'pcm' : 'pcmu',
		};
		// No energy read on G.711 frames: forward everything, turns come from the transcript.
		this.forwardSilence = !pcm || config.forwardSilence === true;
		const delegation = this.config.delegation ?? { type: 'client' };
		if (delegation.type === 'responses' && !delegation.model) {
			throw new ValidationError(
				'OpenAILiveTransport: Responses delegation requires a backend model',
			);
		}
		this._capabilities = {
			...DEFAULT_TRANSPORT_CAPABILITIES,
			// The model listens and decides when to speak; nothing to commit.
			turnDetection: true,
			userTranscription: true,
			// Responses settings (model, tools, backend prompt) update in place.
			inPlaceSessionUpdate: true,
			sessionResumption: false,
			// The server summarizes old history into a replacement engine itself.
			contextCompression: true,
			parallelToolCalls: delegation.type === 'responses' && delegation.parallelToolCalls !== false,
			// GPT-Live talks ("let me check…") while the backend works.
			automaticPreambles: true,
			quiescible: true,
			// Turns are derived from speech activity, not playback; the native
			// playback-end gate supplies playback gating.
			playbackGatedTurnComplete: false,
			// Barge-in belongs to the model: it stops itself when spoken over.
			frameworkOwnsInterrupt: false,
			greetingInterruptGraceMs: 0,
			bufferedUncancellableAudio: false,
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

	private get delegation(): OpenAILiveDelegation {
		return this.config.delegation ?? { type: 'client' };
	}

	private get clientTool(): OpenAILiveClientDelegationTool {
		return {
			name: 'delegate',
			argument: 'request',
			contextMs: 90_000,
			...this.config.clientDelegationTool,
		};
	}

	private log(message: string): void {
		this.config.log?.(`[OpenAILiveTransport] ${message}`);
	}

	// --- Lifecycle ---

	async connect(transportConfig?: LLMTransportConfig): Promise<void> {
		if (transportConfig) this.applyTransportConfig(transportConfig);
		await this.dial(undefined);
	}

	private dial(input: Array<Record<string, unknown>> | undefined): Promise<void> {
		const url = this.config.baseURL ?? DEFAULT_OPENAI_LIVE_URL;
		this.closedReason = null;
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					this.ws?.close();
				} catch {
					/* */
				}
				reject(new TransportError('GPT-Live connect timed out'));
			}, CONNECT_TIMEOUT_MS);

			const ws = new WebSocket(url, {
				headers: { Authorization: `Bearer ${this.config.apiKey}` },
			});
			this.ws = ws;

			ws.on('open', () => {
				ws.send(
					JSON.stringify({
						type: 'session.start',
						event_id: this.nextEventId(),
						session: this.buildSessionConfig(input),
					}),
				);
			});
			ws.on('message', (raw) => {
				let e: Ev;
				try {
					e = JSON.parse(raw.toString());
				} catch {
					return;
				}
				if (!settled && (e.type === 'session.started' || e.type === 'error')) {
					settled = true;
					clearTimeout(timer);
					if (e.type === 'error') {
						const err = (e as { error?: { message?: string; code?: string } }).error;
						reject(
							new TransportError(
								`GPT-Live session.start rejected: ${err?.code ?? 'error'}: ${err?.message ?? ''}`,
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
					this.sessionId =
						(e as { session?: { id?: string } }).session?.id ?? this.sessionId ?? 'unknown';
					this.onSessionReady?.(this.sessionId);
					resolve();
					return;
				}
				this.handleEvent(e);
			});
			ws.on('error', (err) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(err instanceof Error ? err : new TransportError(String(err)));
				} else {
					this.onError?.({
						error: err instanceof Error ? err : new Error(String(err)),
						recoverable: true,
					});
				}
			});
			ws.on('close', (code, reasonBuf) => {
				const wasConnected = this._connected;
				const closedReason = this.closedReason;
				this.cleanupOnClose();
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					reject(
						new TransportError(`GPT-Live socket closed before session.started (code ${code})`),
					);
					return;
				}
				// After a graceful `session.closed` the server drops the socket (1006):
				// report the session's own reason, not the socket's.
				if (wasConnected) this.onClose?.(code, closedReason ?? reasonBuf?.toString());
			});
		});
	}

	async disconnect(): Promise<void> {
		const ws = this.ws;
		if (ws && this._connected && ws.readyState === WebSocket.OPEN) {
			// Graceful close: `session.closed` carries the final usage.
			const closed = new Promise<void>((resolve) => {
				this.resolveClosed = resolve;
				setTimeout(resolve, CLOSE_TIMEOUT_MS);
			});
			this.send({ type: 'session.close', event_id: this.nextEventId() });
			await closed;
		}
		this._connected = false;
		this.ws = null;
		this.cleanupOnClose();
		if (ws) {
			try {
				ws.removeAllListeners();
				ws.close();
			} catch {
				/* */
			}
		}
	}

	/** A new session seeded with the text of the conversation so far: GPT-Live
	 *  has no resumption handle (forking needs a stored, finalized recording). */
	async reconnect(state?: ReconnectState): Promise<void> {
		await this.disconnect();
		const input = state?.conversationHistory?.length
			? this.historyToInput(state.conversationHistory)
			: undefined;
		await this.dial(input);
	}

	private cleanupOnClose(): void {
		this._connected = false;
		if (this.gapTimer) clearTimeout(this.gapTimer);
		this.gapTimer = null;
		if (this.openGenerationId) {
			const id = this.openGenerationId;
			this.openGenerationId = null;
			this.speaking = false;
			this.onGenerationEnd?.(id, 'disconnected');
		}
		this.speaking = false;
		for (const ack of this.pendingAcks.values()) {
			clearTimeout(ack.timer);
			ack.reject(new TransportError('socket closed'));
		}
		this.pendingAcks.clear();
		this.resolveClosed?.();
		this.resolveClosed = null;
		this.awaitingOutputs.clear();
		this.callToResponse.clear();
		this.collectedCalls.clear();
		this.clientDelegations.clear();
		this.backendBusy = 0;
		this.pendingWhenIdle = [];
		this.suppressOutput = this.quiesced;
	}

	// --- Audio ---

	sendAudio(base64Data: string): void {
		if (!this._connected) return;
		this.send({ type: 'session.input_audio.append', audio: base64Data });
	}

	/** Audio appends have no commit: the model listens continuously. */
	commitAudio(): void {}

	/** No server-side input buffer to clear. */
	clearAudio(): void {}

	/** Barge-in is the model's own; there is no response to cancel on the wire. */
	async cancelResponse(_opts?: CancelResponseOptions): Promise<void> {}

	// --- Quiesce: mute the microphone upstream and hold the model's audio ---

	async quiesce(): Promise<void> {
		this.quiesced = true;
		this.suppressOutput = true;
		if (!this._connected) return;
		await this.sendAndWaitAck(
			{ type: 'session.input_audio.mute' },
			'session.input_audio.muted',
		).catch((e) => this.log(`mute failed: ${(e as Error).message}`));
	}

	async unquiesce(): Promise<void> {
		this.quiesced = false;
		this.suppressOutput = false;
		if (!this._connected) return;
		await this.sendAndWaitAck(
			{ type: 'session.input_audio.unmute' },
			'session.input_audio.unmuted',
		).catch((e) => this.log(`unmute failed: ${(e as Error).message}`));
		this.flushPendingWhenIdle();
	}

	// --- Session configuration ---

	/** Pre-connect: folded into `session.start`. Post-connect: new instructions
	 *  are appended (the startup prompt is immutable), new tools are sent to the
	 *  Responses backend with `session.update`. */
	async updateSession(config: SessionUpdate): Promise<void> {
		const instructionsChanged =
			config.instructions !== undefined && config.instructions !== this.config.instructions;
		const toolsChanged = config.tools !== undefined && config.tools !== this.config.tools;
		if (config.instructions !== undefined) this.config.instructions = config.instructions;
		if (config.tools !== undefined) this.config.tools = config.tools;
		const live = (config.providerOptions as { live?: Record<string, unknown> } | undefined)?.live;
		if (live)
			this.config.providerOptions = { live: { ...this.config.providerOptions?.live, ...live } };
		if (!this._connected) return;

		const run = this.sessionUpdateQueue.then(async () => {
			if (instructionsChanged && config.instructions) {
				for (const content of chunkForAppend(config.instructions)) {
					await this.sendAndWaitAck(
						{ type: 'session.instructions.append', delegation_id: null, content },
						'session.instructions.appended',
					);
				}
			}
			if (toolsChanged && this.delegation.type === 'responses') {
				await this.sendAndWaitAck(
					{
						type: 'session.update',
						session: {
							delegation: {
								type: 'responses',
								responses: { tools: this.buildResponsesTools(this.delegation) },
							},
						},
					},
					'session.updated',
				);
			}
		});
		this.sessionUpdateQueue = run.catch(() => undefined);
		return run;
	}

	async transferSession(config: SessionUpdate, _state?: ReconnectState): Promise<void> {
		return this.updateSession(config);
	}

	// --- Content injection ---

	/** User text goes to the backend (Responses: a typed message + continuation;
	 *  client: the model hears it as context to delegate on). Assistant text is
	 *  commentary the model paraphrases aloud. */
	sendContent(turns: ContentTurn[], turnComplete = true): void {
		if (!this._connected) return;
		for (const turn of turns) {
			if (!turn.text.trim()) continue;
			if (turn.role === 'assistant') {
				this.appendChunks('session.commentary.append', turn.text, null);
			} else if (this.delegation.type === 'responses') {
				this.send({
					type: 'response.item.create',
					event_id: this.nextEventId(),
					item: {
						type: 'message',
						role: 'user',
						content: [{ type: 'input_text', text: turn.text }],
					},
				});
			} else {
				this.appendChunks(
					'session.instructions.append',
					`The user typed: ${JSON.stringify(turn.text)}. Treat it as what they said and respond.`,
					null,
				);
			}
		}
		if (
			turnComplete &&
			this.delegation.type === 'responses' &&
			turns.some((t) => t.role === 'user')
		) {
			this.send({ type: 'response.create', event_id: this.nextEventId() });
		}
	}

	sendLiveText(turns: ContentTurn[]): boolean {
		if (!this._connected || !turns.some((t) => t.text.trim())) return false;
		this.sendContent(turns, true);
		return true;
	}

	/** Images reach a vision-capable Responses backend only. */
	sendFile(base64Data: string, mimeType: string): void {
		if (!this._connected) return;
		if (this.delegation.type !== 'responses' || !mimeType.startsWith('image/')) {
			this.onError?.({
				error: new ValidationError(
					`OpenAILiveTransport: ${mimeType} input needs Responses delegation with a vision-capable backend`,
				),
				recoverable: true,
			});
			return;
		}
		this.send({
			type: 'response.item.create',
			event_id: this.nextEventId(),
			item: {
				type: 'message',
				role: 'user',
				content: [{ type: 'input_image', image_url: `data:${mimeType};base64,${base64Data}` }],
			},
		});
		this.send({ type: 'response.create', event_id: this.nextEventId() });
	}

	// --- Tool interaction ---

	sendToolResult(result: TransportToolResult): void {
		if (!this._connected) return;
		const scheduling = result.scheduling ?? 'immediate';

		// Responses delegation: a function call the backend is waiting on.
		const responseId = this.callToResponse.get(result.id);
		if (responseId !== undefined) {
			this.callToResponse.delete(result.id);
			const output =
				typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
			this.send({
				type: 'response.item.create',
				event_id: this.nextEventId(),
				item: { type: 'function_call_output', call_id: result.id, output },
			});
			const waiting = this.awaitingOutputs.get(responseId);
			waiting?.delete(result.id);
			if (!waiting || waiting.size === 0) {
				this.awaitingOutputs.delete(responseId);
				// The backend cannot continue without this, whatever the scheduling.
				this.send({ type: 'response.create', event_id: this.nextEventId() });
			}
			return;
		}

		// Everything else is said (or quietly noted) by the Live model: a client
		// delegation's result, or a background tool's final answer.
		if (scheduling === 'when_idle' && (this.speaking || this.quiesced)) {
			this.pendingWhenIdle.push(result);
			return;
		}
		this.speakResult(result);
	}

	private speakResult(result: TransportToolResult): void {
		const scheduling = result.scheduling ?? 'immediate';
		const text = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
		const delegationId =
			this.delegation.type === 'client' && this.clientDelegations.has(result.id) ? result.id : null;
		if (scheduling === 'silent') {
			this.appendChunks('session.thinking.append', text, delegationId);
		} else if (scheduling === 'interrupt') {
			this.appendChunks(
				'session.instructions.append',
				`Stop what you are saying and tell the user this now: ${text}`,
				delegationId,
			);
		} else {
			this.appendChunks('session.commentary.append', text, delegationId);
		}
	}

	private flushPendingWhenIdle(): void {
		if (this.pendingWhenIdle.length === 0 || this.speaking || this.quiesced) return;
		const queued = this.pendingWhenIdle;
		this.pendingWhenIdle = [];
		for (const result of queued) this.speakResult(result);
	}

	// --- Generation control ---

	/** A one-off instruction is appended; without one, a Responses backend is
	 *  asked to continue. The Live model itself cannot be told to speak. */
	triggerGeneration(instructions?: string): void {
		if (!this._connected) return;
		if (instructions) {
			this.appendChunks('session.instructions.append', instructions, null);
		} else if (this.delegation.type === 'responses') {
			this.send({ type: 'response.create', event_id: this.nextEventId() });
		}
	}

	/** After `session.started` the only way in is as quiet context. Before it
	 *  (`reconnect`) the conversation rides `session.input` instead. */
	replayHistory(items: readonly ReplayItem[]): void {
		if (!this._connected) return;
		const lines: string[] = [];
		for (const item of items) {
			if (item.type === 'text') lines.push(`${item.role}: ${item.text}`);
			else if (item.type === 'tool_result') {
				const r = typeof item.result === 'string' ? item.result : JSON.stringify(item.result);
				lines.push(`result of ${item.name}: ${r}`);
			}
		}
		if (lines.length === 0) return;
		this.appendChunks(
			'session.thinking.append',
			`Earlier in this conversation:\n${lines.join('\n')}`,
			null,
		);
	}

	// --- Internal: wire helpers ---

	private nextEventId(): string {
		this.eventSeq += 1;
		return `live_${this.eventSeq}`;
	}

	private send(msg: Record<string, unknown>): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
	}

	private sendAndWaitAck(msg: Record<string, unknown>, ackType: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const eventId = this.nextEventId();
			const timer = setTimeout(() => {
				if (this.pendingAcks.delete(eventId)) {
					reject(new TransportError(`GPT-Live ${ackType} ack timed out`));
				}
			}, ACK_TIMEOUT_MS);
			this.pendingAcks.set(eventId, { resolve, reject, timer });
			this.send({ ...msg, event_id: eventId });
		});
	}

	private appendChunks(
		type: 'session.commentary.append' | 'session.thinking.append' | 'session.instructions.append',
		text: string,
		delegationId: string | null,
	): void {
		for (const content of chunkForAppend(text)) {
			this.send({ type, event_id: this.nextEventId(), delegation_id: delegationId, content });
		}
	}

	private applyTransportConfig(tc: LLMTransportConfig): void {
		if (tc.auth) {
			if (tc.auth.type !== 'api_key') {
				throw new ValidationError(`OpenAILiveTransport requires api_key auth, got ${tc.auth.type}`);
			}
			this.config.apiKey = tc.auth.apiKey;
		}
		if (tc.model) this.config.model = tc.model;
		if (tc.instructions !== undefined) this.config.instructions = tc.instructions;
		if (tc.tools !== undefined) this.config.tools = tc.tools;
		if (tc.voice !== undefined) this.config.voice = tc.voice;
		if (tc.responseModality === 'text') {
			throw new ValidationError('OpenAILiveTransport: GPT-Live speaks; it has no text-only mode');
		}
		const live = (tc.providerOptions as { live?: Record<string, unknown> } | undefined)?.live;
		if (live)
			this.config.providerOptions = { live: { ...this.config.providerOptions?.live, ...live } };
	}

	/** A background tool without a pendingMessage: nothing answers its call until the task ends. */
	private answeredWhenStarted(toolName: string): boolean {
		const tool = (this.config.tools ?? []).find((t) => t.name === toolName);
		return tool?.execution === 'background' && !tool.pendingMessage;
	}

	private buildResponsesTools(
		d: Extract<OpenAILiveDelegation, { type: 'responses' }>,
	): Array<Record<string, unknown>> {
		const fns = (this.config.tools ?? []).map((t) => ({
			type: 'function',
			name: t.name,
			description: t.description,
			parameters: zodToJsonSchema(t.parameters, 'standard'),
		}));
		return [...fns, ...(d.hostedTools ?? [])];
	}

	private buildSessionConfig(
		input: Array<Record<string, unknown>> | undefined,
	): Record<string, unknown> {
		const fmt = this._audioFormat;
		const session: Record<string, unknown> = {
			model: this.config.model ?? DEFAULT_OPENAI_LIVE_MODEL,
			audio: {
				format:
					fmt.encoding === 'pcm'
						? { type: 'audio/pcm', rate: fmt.inputSampleRate }
						: { type: 'audio/pcmu', rate: 8000 },
				output: { voice: this.config.voice ?? DEFAULT_OPENAI_LIVE_VOICE },
			},
		};
		if (this.config.instructions !== undefined) session.instructions = this.config.instructions;
		if (this.config.store !== undefined) session.store = this.config.store;
		if (input?.length) session.input = input;

		const d = this.delegation;
		if (d.type === 'responses') {
			const responses: Record<string, unknown> = { model: d.model };
			if (d.instructions !== undefined) responses.instructions = d.instructions;
			const tools = this.buildResponsesTools(d);
			if (tools.length) {
				responses.tools = tools;
				responses.tool_choice = d.toolChoice ?? 'auto';
			}
			if (d.parallelToolCalls !== undefined) responses.parallel_tool_calls = d.parallelToolCalls;
			if (d.maxOutputTokens !== undefined) responses.max_output_tokens = d.maxOutputTokens;
			if (d.reasoning !== undefined) responses.reasoning = d.reasoning;
			if (d.serviceTier !== undefined) responses.service_tier = d.serviceTier;
			session.delegation = { type: 'responses', responses };
		} else {
			session.delegation = { type: 'client' };
		}

		for (const [k, v] of Object.entries(this.config.providerOptions?.live ?? {})) {
			if (!LIVE_SESSION_KEYS.has(k) || k === 'client' || k === 'triggers') session[k] = v;
		}
		return session;
	}

	private historyToInput(history: readonly ReplayItem[]): Array<Record<string, unknown>> {
		const items: Array<Record<string, unknown>> = [];
		for (const item of history) {
			if (item.type !== 'text' || !item.text.trim()) continue;
			items.push({
				type: 'message',
				role: item.role,
				content: [{ type: item.role === 'user' ? 'input_text' : 'output_text', text: item.text }],
			});
		}
		// Keep the most recent items within the startup limits.
		let kept = items.slice(-INPUT_MAX_ITEMS);
		const chars = (xs: Array<Record<string, unknown>>) =>
			xs.reduce((n, it) => n + ((it.content as Array<{ text: string }>)[0]?.text.length ?? 0), 0);
		while (kept.length > 1 && chars(kept) > INPUT_MAX_CHARS) kept = kept.slice(1);
		return kept;
	}

	// --- Internal: server events ---

	private handleEvent(e: Ev): void {
		const clientEventId = (e as { client_event_id?: string }).client_event_id;
		if (clientEventId && e.type !== 'error') {
			const ack = this.pendingAcks.get(clientEventId);
			if (ack) {
				this.pendingAcks.delete(clientEventId);
				clearTimeout(ack.timer);
				ack.resolve();
			}
		}
		switch (e.type) {
			case 'session.output_audio.delta':
				this.handleOutputAudio((e as { delta?: string }).delta);
				break;
			case 'session.output_transcript.delta': {
				const ev = e as { delta?: string; start_ms?: number; end_ms?: number };
				if (typeof ev.delta !== 'string') break;
				this.recordFragment('assistant', ev.delta, ev.start_ms, ev.end_ms);
				// Transcript is speech evidence too (the only kind on G.711).
				this.noteModelSpeech();
				this.onOutputTranscription?.(ev.delta);
				break;
			}
			case 'session.input_transcript.delta': {
				const ev = e as { delta?: string; start_ms?: number; end_ms?: number };
				if (typeof ev.delta !== 'string') break;
				this.recordFragment('user', ev.delta, ev.start_ms, ev.end_ms);
				const now = Date.now();
				if (now - this.lastInputTranscriptAt > USER_UTTERANCE_GAP_MS) {
					this.userResumedAt = now;
					this.onSpeechStarted?.();
				}
				this.lastInputTranscriptAt = now;
				this.onInputTranscription?.(ev.delta);
				break;
			}
			case 'session.delegation.created':
				this.handleDelegationCreated(e);
				break;
			case 'response.event':
				this.handleResponseEvent(e);
				break;
			case 'session.usage.updated': {
				const seconds = (e as { usage?: { seconds?: number } }).usage?.seconds;
				if (typeof seconds === 'number') this.emitSessionUsage(seconds, 'update', e);
				break;
			}
			case 'session.closed': {
				const ev = e as { reason?: string; usage?: { seconds?: number } };
				this.closedReason = ev.reason ?? 'closed';
				if (typeof ev.usage?.seconds === 'number') {
					this.emitSessionUsage(ev.usage.seconds, 'final', e);
				}
				this.resolveClosed?.();
				this.resolveClosed = null;
				break;
			}
			case 'error': {
				const err = (e as { error?: Record<string, unknown> }).error ?? {};
				const code = typeof err.code === 'string' ? err.code : '';
				const type = typeof err.type === 'string' ? err.type : '';
				const message = typeof err.message === 'string' ? err.message : '';
				if (clientEventId) {
					const ack = this.pendingAcks.get(clientEventId);
					if (ack) {
						this.pendingAcks.delete(clientEventId);
						clearTimeout(ack.timer);
						ack.reject(new TransportError(`GPT-Live rejected: ${code}: ${message}`));
					}
				}
				this.onError?.({
					error: new TransportError(`GPT-Live error ${type}/${code}: ${message}`),
					recoverable: type !== 'authentication_error' && code !== 'session_finalization_failed',
				});
				break;
			}
			default:
				break;
		}
	}

	private handleOutputAudio(delta: string | undefined): void {
		if (typeof delta !== 'string' || delta.length === 0) return;
		let voiced = true;
		if (this._audioFormat.encoding === 'pcm') {
			analyzeFrameInto(Buffer.from(delta, 'base64'), this.energy);
			voiced =
				this.energy.samples > 0 && this.energy.avgAbs >= (this.config.silenceThreshold ?? 24);
		} else {
			// G.711: no energy read here; the transcript marks speech.
			voiced = false;
		}
		if (voiced) this.noteModelSpeech();
		if (this.suppressOutput) return;
		const withinHangover = this.speaking && Date.now() - this.lastVoicedAt <= SILENCE_HANGOVER_MS;
		if (!voiced && !this.forwardSilence && !withinHangover) return;
		if (!this.firstAudioFired && (voiced || this.forwardSilence)) {
			this.firstAudioFired = true;
			this.onFirstAudioChunk?.();
		}
		this.onAudioOutput?.(delta);
	}

	/** Speech evidence (a voiced frame or a transcript fragment): open a model
	 *  turn if none is open, and push the end-of-turn timer out. */
	private noteModelSpeech(): void {
		this.lastVoicedAt = Date.now();
		if (!this.speaking) {
			this.speaking = true;
			if (!this.openGenerationId) this.openGeneration();
		}
		if (this.gapTimer) clearTimeout(this.gapTimer);
		this.gapTimer = setTimeout(() => this.onSpeechGap(), this.config.speechGapMs ?? 700);
	}

	private onSpeechGap(): void {
		this.gapTimer = null;
		this.speaking = false;
		// The backend is still working: the model will speak again when it has
		// the result. Keep the turn open; it closes when the backend is done.
		if (this.backendBusy > 0 || this.awaitingOutputs.size > 0) return;
		this.closeTurn();
	}

	private closeTurn(): void {
		const id = this.openGenerationId;
		if (!id) return;
		this.openGenerationId = null;
		const window = this.config.interruptWindowMs ?? 1500;
		const interrupted =
			window > 0 &&
			this.userResumedAt > 0 &&
			this.lastInputTranscriptAt >= this.lastVoicedAt - window &&
			Date.now() - this.userResumedAt <= window + (this.config.speechGapMs ?? 700);
		this.onGenerationEnd?.(id, interrupted ? 'interrupted' : 'generationComplete');
		if (interrupted) this.onInterrupted?.();
		else this.onTurnComplete?.();
		this.flushPendingWhenIdle();
	}

	private recordFragment(
		role: 'user' | 'assistant',
		text: string,
		startMs: number | undefined,
		endMs: number | undefined,
	): void {
		if (!text) return;
		const start = typeof startMs === 'number' ? startMs : Date.now();
		this.fragments.push({
			role,
			text,
			startMs: start,
			endMs: typeof endMs === 'number' ? endMs : start,
		});
		if (this.fragments.length > 2_000) this.fragments.splice(0, this.fragments.length - 2_000);
	}

	/** The conversation as the client delegation's request text: fragments of
	 *  the last `contextMs`, grouped by speaker run, oldest first. */
	private transcriptContext(uptoMs: number | undefined): string {
		const horizon = this.clientTool.contextMs ?? 90_000;
		const end = typeof uptoMs === 'number' ? uptoMs : Number.POSITIVE_INFINITY;
		const recent = this.fragments
			.filter((f) => f.startMs <= end + horizon && f.endMs >= end - horizon)
			.sort((a, b) => a.startMs - b.startMs);
		const lines: string[] = [];
		for (const f of recent) {
			const last = lines.length ? lines[lines.length - 1] : undefined;
			const prefix = f.role === 'user' ? 'User: ' : 'Assistant: ';
			if (last?.startsWith(prefix)) lines[lines.length - 1] = `${last}${f.text}`;
			else lines.push(`${prefix}${f.text}`);
		}
		return lines.join('\n');
	}

	private handleDelegationCreated(e: Ev): void {
		const d = (e as { delegation?: { id?: string; target?: string } }).delegation;
		if (!d?.id) return;
		if (d.target === 'client') {
			if (this.clientDelegations.has(d.id)) return;
			this.clientDelegations.add(d.id);
			const offset = (e as { offset_ms?: number }).offset_ms;
			const tool = this.clientTool;
			const context = this.transcriptContext(offset);
			this.log(`client delegation ${d.id} → ${tool.name} (${context.length} chars of context)`);
			this.openTurnForWork();
			this.onToolCall?.([
				{
					id: d.id,
					name: tool.name,
					args: {
						[tool.argument]: `The user is speaking with a voice assistant, which asked for help with their latest request. Recent conversation (transcript, may contain errors):\n${context || '(no transcript yet)'}`,
					},
				},
			]);
		} else if (d.target === 'responses') {
			this.backendBusy += 1;
			this.openTurnForWork();
		}
	}

	/** Delegated work is model activity: a turn is born for it so the framework
	 *  stops waiting for the model, and closes when the model finishes speaking. */
	private openTurnForWork(): void {
		if (this.openGenerationId) return;
		this.openGeneration();
	}

	/** One generation = one answer: a preamble ("let me check"), the backend
	 *  wait and the spoken result share it, so `onFirstAudioChunk` fires once. */
	private openGeneration(): void {
		this.generationSeq += 1;
		this.openGenerationId = `live_gen_${this.generationSeq}`;
		this.firstAudioFired = false;
		this.onGenerationStart?.(this.openGenerationId);
		this.onModelTurnStart?.(this.openGenerationId);
	}

	private handleResponseEvent(e: Ev): void {
		const inner = (e as { event?: Record<string, unknown> }).event;
		if (!inner || typeof inner.type !== 'string') return;
		const delegationId = (e as { delegation_id?: string | null }).delegation_id ?? null;
		const response = (inner.response ?? {}) as Record<string, unknown>;
		// The outer delegation id is on every nested event; the backend response id
		// is only on the lifecycle snapshots, so the delegation is the correlation key.
		const responseId = delegationId ?? 'response';
		const backendResponseId =
			(typeof response.id === 'string' ? response.id : undefined) ??
			(typeof inner.response_id === 'string' ? inner.response_id : undefined) ??
			responseId;
		switch (inner.type) {
			case 'response.created':
				if (!this.collectedCalls.has(responseId)) this.collectedCalls.set(responseId, []);
				break;
			case 'response.output_item.done': {
				const item = inner.item as
					| { type?: string; call_id?: string; name?: string; arguments?: string }
					| undefined;
				if (item?.type === 'function_call' && item.call_id && item.name) {
					let args: Record<string, unknown> = {};
					if (item.arguments) {
						try {
							args = JSON.parse(item.arguments) as Record<string, unknown>;
						} catch {
							args = { _raw: item.arguments };
						}
					}
					const list = this.collectedCalls.get(responseId) ?? [];
					list.push({ id: item.call_id, name: item.name, args });
					this.collectedCalls.set(responseId, list);
				}
				break;
			}
			case 'response.output_text.done': {
				const text = inner.text;
				if (typeof text === 'string') this.onBackendText?.(text, delegationId);
				break;
			}
			case 'response.completed':
			case 'response.done':
			case 'response.incomplete':
			case 'response.failed': {
				this.emitBackendUsage(response, backendResponseId);
				const calls = this.collectedCalls.get(responseId) ?? [];
				this.collectedCalls.delete(responseId);
				if (calls.length > 0 && inner.type !== 'response.failed') {
					// A background tool with no pendingMessage keeps its call open until the task ends
					// (minutes, with a WHEN_IDLE result). The backend cannot finish its response without
					// an output for every call, and the Live model waits for the backend, so such a call
					// is answered now with a "started" output; the real result arrives later as commentary
					// (see sendToolResult). A pendingMessage tool is answered by the framework at once.
					const waiting = new Set<string>();
					for (const c of calls) {
						if (this.answeredWhenStarted(c.name)) {
							this.send({
								type: 'response.item.create',
								event_id: this.nextEventId(),
								item: {
									type: 'function_call_output',
									call_id: c.id,
									output: BACKGROUND_STARTED_OUTPUT,
								},
							});
							continue;
						}
						waiting.add(c.id);
						this.callToResponse.set(c.id, responseId);
					}
					if (waiting.size > 0) this.awaitingOutputs.set(responseId, waiting);
					else this.send({ type: 'response.create', event_id: this.nextEventId() });
					this.onToolCall?.(calls);
				} else {
					this.backendBusy = Math.max(0, this.backendBusy - 1);
					if (this.backendBusy === 0 && !this.speaking && !this.gapTimer) {
						// Nothing left to wait for and the model is quiet: give it a
						// moment to start the spoken answer before the turn closes.
						this.gapTimer = setTimeout(() => this.onSpeechGap(), this.config.speechGapMs ?? 700);
					}
				}
				if (inner.type === 'response.failed') {
					const err = (response.error ?? inner.error) as { message?: string } | undefined;
					this.onError?.({
						error: new TransportError(
							`GPT-Live backend response failed: ${err?.message ?? 'unknown'}`,
						),
						recoverable: true,
					});
				}
				break;
			}
			default:
				break;
		}
	}

	private emitBackendUsage(response: Record<string, unknown>, responseId: string): void {
		const usage = response.usage as Record<string, unknown> | undefined;
		if (!usage || !this.onRealtimeLLMUsage) return;
		const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
		const inDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
		const outDetails = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
		this.onRealtimeLLMUsage({
			provider: 'openai_live',
			kind: 'response',
			phase: 'final',
			unit: 'tokens',
			inputTokens: num(usage.input_tokens),
			outputTokens: num(usage.output_tokens),
			totalTokens: num(usage.total_tokens),
			modalityBreakdown: {
				cachedTokens: num(inDetails.cached_tokens),
				reasoningTokens: num(outDetails.reasoning_tokens),
			},
			providerResponseId: responseId,
			providerRaw: usage,
		});
	}

	private emitSessionUsage(seconds: number, phase: 'update' | 'final', raw: unknown): void {
		this.onRealtimeLLMUsage?.({
			provider: 'openai_live',
			kind: 'response',
			phase,
			unit: 'duration_seconds',
			durationSeconds: seconds,
			providerItemId: this.sessionId ?? undefined,
			providerRaw: raw,
		});
	}
}
