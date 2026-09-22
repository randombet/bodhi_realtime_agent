// SPDX-License-Identifier: MIT

/**
 * A text-only `LLMTransport` backed by a Vercel AI SDK chat model (`streamText`).
 *
 * Unlike the realtime transports (Gemini Live / OpenAI Realtime), this one speaks to an
 * ordinary text/chat model — no audio, no socket. It implements the `LLMTransport`
 * contract by stubbing the audio surface and driving turns with `streamText`:
 *   - `sendContent(turns, turnComplete=true)` appends the user turn and runs a generation;
 *   - streamed text deltas are emitted via `onTextOutput`, and `onTextDone` +
 *     `onTurnComplete` fire when the model finishes a turn with no tool call;
 *   - tool calls are surfaced via `onToolCall`; the framework executes them and feeds
 *     results back through `sendToolResult`, which resumes the turn.
 *
 * This lets a `VoiceSession` (in `responseModality: 'text'`) host a MainAgent on a plain
 * text model — e.g. the Agent Composer running on GPT-5.5.
 */

import { type CoreMessage, type LanguageModelV1, NoSuchToolError, streamText, tool } from 'ai';
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

/** Dummy audio format — never used (no audio in text mode), but the contract requires it. */
const TEXT_AUDIO_FORMAT: AudioFormatSpec = {
	inputSampleRate: 24000,
	outputSampleRate: 24000,
	channels: 1,
	bitDepth: 16,
	encoding: 'pcm',
};

export interface TextLLMTransportOptions {
	/** Vercel AI SDK chat model (e.g. `createOpenAI({apiKey})('gpt-5.5')`). */
	model: LanguageModelV1;
	/** Initial system prompt (also settable via connect/updateSession). */
	instructions?: string;
	/** Initial tools (also settable via connect/updateSession). */
	tools?: ToolDefinition[];
	/** Safety cap on tool-call rounds within a single user turn (default 4). */
	maxToolRoundsPerTurn?: number;
	/** Prior conversation to replay before the first turn (standalone/transport-only resume).
	 *  Provider-neutral rich items; snapshot-copied so post-construction mutation cannot perturb
	 *  replay. Seeded once on the first `connect()`. `VoiceSession` hosts use the public
	 *  `replayHistory()` method instead; both route through the same guarded path. */
	initialHistory?: readonly ReplayItem[];
	log?: (msg: string) => void;
}

export class TextLLMTransport implements LLMTransport {
	readonly capabilities: TransportCapabilities = {
		...DEFAULT_TRANSPORT_CAPABILITIES,
		textResponseModality: true,
		inPlaceSessionUpdate: true,
	};
	readonly audioFormat = TEXT_AUDIO_FORMAT;
	isConnected = false;

	private readonly model: LanguageModelV1;
	private system?: string;
	private toolDefs: ToolDefinition[];
	private readonly maxToolRounds: number;
	private readonly log: (msg: string) => void;

	/** Snapshot of the constructor-supplied resume history (see TextLLMTransportOptions). */
	private readonly initialHistory?: readonly ReplayItem[];
	/** Set the first time replay is attempted (constructor path or public replayHistory()), so a
	 *  fresh resume seeds the model exactly once even when replay yields zero messages. */
	private initialHistoryReplayAttempted = false;

	private history: CoreMessage[] = [];
	private readonly pendingToolCalls = new Map<string, string>(); // id -> name
	private pendingToolResults: { message: CoreMessage; silent: boolean }[] = [];
	/** User content that arrived while a turn was active — flushed to history (in order)
	 *  when the active turn completes, so it never interleaves with the in-flight
	 *  assistant/tool messages appended at the end of that turn. */
	private pendingUserContent: CoreMessage[] = [];
	private generating = false;
	private modelTurnStarted = false;
	private toolRoundsThisTurn = 0;
	/** Monotonic id per generation; callbacks from a superseded id are suppressed. */
	private genId = 0;
	private currentAbort?: AbortController;
	/** Resolves when the in-flight generation's `runGeneration` settles (for waitForDone). */
	private currentGenPromise?: Promise<void>;
	/** A generation requested while one was in flight; run it when the current finishes. */
	private pendingGeneration = false;
	private closing = false;

	// --- Core callbacks ---
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

	constructor(opts: TextLLMTransportOptions) {
		this.model = opts.model;
		this.system = opts.instructions;
		this.toolDefs = opts.tools ?? [];
		this.maxToolRounds = opts.maxToolRoundsPerTurn ?? 4;
		// Snapshot so a caller mutating the array after construction cannot perturb replay.
		this.initialHistory = opts.initialHistory ? [...opts.initialHistory] : undefined;
		this.log = opts.log ?? (() => {});
	}

	// --- Lifecycle ---
	async connect(config?: LLMTransportConfig): Promise<void> {
		if (config?.instructions !== undefined) this.system = config.instructions;
		if (config?.tools) this.toolDefs = config.tools;
		this.isConnected = true;
		// Standalone/transport-only resume: seed from the constructor-supplied history on the first
		// connect. Routes through the same guarded `replayHistory` a VoiceSession host would call,
		// so seeding happens exactly once. (Reconnect retains `this.history`, so this is a no-op.)
		if (this.initialHistory) this.replayHistory(this.initialHistory);
		this.onSessionReady?.('text-llm-session');
	}
	async disconnect(): Promise<void> {
		// Normal shutdown: abort any in-flight stream and drop pending state. Do NOT call
		// onClose — VoiceSession treats onClose as an UNEXPECTED close and routes it through
		// reconnect/close handling. (onClose is reserved for real provider failures.)
		this.closing = true;
		// Supersede any in-flight generation: bumping genId (not just `closing`) keeps the old
		// stream stale even if reconnect() later clears `closing` before it settles.
		this.genId += 1;
		this.currentAbort?.abort();
		this.pendingGeneration = false;
		this.pendingToolCalls.clear();
		this.pendingToolResults = [];
		this.pendingUserContent = [];
		this.isConnected = false;
	}
	async reconnect(_state?: ReconnectState): Promise<void> {
		this.closing = false;
		this.isConnected = true;
	}

	// --- History replay (resume) ---
	/**
	 * Prefill prior turns before the first turn (implements the optional `LLMTransport.replayHistory`).
	 * Guarded: seeds at most once per transport instance — both the constructor path and a
	 * `VoiceSession` post-connect call route through here, so a fresh resume seeds exactly once even
	 * when replay yields zero messages (all items skipped/malformed). Call after `connect()`, before
	 * the first send. Not used for reconnect (this transport retains `this.history` across reconnect).
	 */
	replayHistory(items: readonly ReplayItem[]): void {
		if (this.initialHistoryReplayAttempted) return;
		this.initialHistoryReplayAttempted = true;
		if (items.length) this.applyReplay(items);
	}

	/**
	 * Cancel the in-flight generation (wire-only; the caller owns turn finalization).
	 * Bumping `genId` makes the active generation stale so it emits no further callbacks
	 * and writes no history. Any pending tool calls/results for the cancelled turn are voided
	 * — late `sendToolResult`s for them are ignored. With `waitForDone`, awaits settle (≤2s).
	 */
	async cancelResponse(opts?: CancelResponseOptions): Promise<void> {
		this.genId += 1;
		this.currentAbort?.abort();
		this.pendingGeneration = false;
		this.pendingToolCalls.clear();
		this.pendingToolResults = [];
		this.pendingUserContent = [];
		if (opts?.waitForDone && this.currentGenPromise) {
			await Promise.race([
				this.currentGenPromise.catch(() => {}),
				new Promise<void>((resolve) => setTimeout(resolve, 2000)),
			]);
		}
	}

	// --- Audio (no-ops) ---
	sendAudio(): void {}
	commitAudio(): void {}
	clearAudio(): void {}
	sendFile(): void {}

	// --- Session config ---
	async updateSession(config: SessionUpdate): Promise<void> {
		if (config.instructions !== undefined) this.system = config.instructions;
		if (config.tools) this.toolDefs = config.tools;
	}
	async transferSession(config: SessionUpdate): Promise<void> {
		await this.updateSession(config);
	}

	// --- Content / generation ---
	sendContent(turns: ContentTurn[], turnComplete = true): void {
		const msgs: CoreMessage[] = turns.map((t) => ({
			role: t.role === 'assistant' ? 'assistant' : 'user',
			content: t.text,
		}));
		// While a turn is active (generating, or awaiting tool results), buffer new user
		// content instead of pushing it onto `history`: the in-flight turn appends its
		// assistant/tool messages at the end when it settles, so a direct push here would
		// interleave (user1, user2, assistant-for-user1) and misattribute the turn.
		if (this.generating || this.pendingToolCalls.size > 0) {
			this.pendingUserContent.push(...msgs);
			if (turnComplete) this.pendingGeneration = true;
			return;
		}
		this.history.push(...msgs);
		if (turnComplete) {
			this.toolRoundsThisTurn = 0;
			this.schedule();
		}
	}

	triggerGeneration(): void {
		// Defer if a turn is active — the queued generation runs once it settles.
		if (this.generating || this.pendingToolCalls.size > 0) {
			this.pendingGeneration = true;
			return;
		}
		this.toolRoundsThisTurn = 0;
		this.schedule();
	}

	sendToolResult(result: TransportToolResult): void {
		// Ignore results for tool calls that were cancelled/superseded or never tracked —
		// `cancelResponse`/`disconnect` clear `pendingToolCalls`, so a late result for a
		// voided turn is dropped (it must not append to history or trigger a new turn).
		if (!this.pendingToolCalls.has(result.id)) return;
		this.pendingToolCalls.delete(result.id);

		this.pendingToolResults.push({
			message: {
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: result.id,
						toolName: result.name,
						result: result.result ?? null,
					},
				],
			},
			silent: result.scheduling === 'silent',
		});
		if (result.scheduling === 'interrupt') this.currentAbort?.abort();

		// Wait until every outstanding tool call has reported a result.
		if (this.pendingToolCalls.size > 0) return;

		const buffered = this.pendingToolResults;
		this.pendingToolResults = [];
		// Append all results (in arrival order) so the assistant tool-call message is followed
		// by its results before the next request.
		this.history.push(...buffered.map((r) => r.message));

		if (buffered.some((r) => !r.silent)) {
			this.schedule(); // at least one result needs a model continuation
		} else {
			// All silent → the turn is complete with no further response.
			// Known narrow limitation: an onTurnComplete handler that synchronously calls
			// sendContent() here (transport already idle) lands before settleIdle() flushes
			// content buffered during this turn. The V1 host (serial CLI, no silent-scheduled
			// tools, no reentrant sends) cannot reach this; a reentrancy-safe ordering is
			// deferred with the broader turn-finalization-on-VoiceSession work.
			this.onTextDone?.();
			this.onTurnComplete?.();
			this.settleIdle(); // flush any user content buffered during the turn
		}
	}

	/** Single-flight: run now if idle, else queue exactly one follow-up generation. */
	private schedule(): void {
		if (this.closing || !this.isConnected) return;
		// A turn awaiting tool results must resume via sendToolResult, not start a parallel
		// generation against an unanswered assistant tool-call message — queue instead.
		if (this.generating || this.pendingToolCalls.size > 0) {
			this.pendingGeneration = true;
			return;
		}
		this.currentGenPromise = this.runGeneration();
	}

	/**
	 * Idle turn boundary. Called whenever a turn settles. Two independent steps:
	 *   1. Commit any user content buffered DURING the just-finished turn into history, in
	 *      arrival order — unconditionally, even if no generation is queued, so partial
	 *      (`turnComplete:false`) content is never stranded or later reordered.
	 *   2. Start a queued generation (`pendingGeneration`) if one was requested.
	 * Both run only when fully idle (no in-flight generation, no outstanding tool calls).
	 */
	private settleIdle(): void {
		if (this.generating || this.pendingToolCalls.size > 0 || this.closing || !this.isConnected) {
			return;
		}
		if (this.pendingUserContent.length > 0) {
			this.history.push(...this.pendingUserContent);
			this.pendingUserContent = [];
		}
		if (!this.pendingGeneration) return;
		this.pendingGeneration = false;
		this.toolRoundsThisTurn = 0;
		this.currentGenPromise = this.runGeneration();
	}

	// --- Internals ---
	/**
	 * Runtime structural validation for a single replay item (items may arrive from JSON/DB, so the
	 * static `ReplayItem` type is not a runtime guarantee). Logs are **metadata-only** (reason +
	 * index + type/id/name — never `text`/`args`/`result`/`error`/`base64Data`) so replayed
	 * conversation content is never leaked to logs.
	 */
	private isValidReplayItem(item: ReplayItem, index: number): boolean {
		const isStr = (v: unknown): v is string => typeof v === 'string';
		const bad = (why: string): boolean => {
			this.log(`[TextLLMTransport] replay: dropped invalid item at index ${index} (${why})`);
			return false;
		};
		// App-supplied history may contain null/undefined/non-object entries (JSON/DB) — reject
		// before touching properties so a bad entry is dropped, never a thrown TypeError.
		if (item === null || typeof item !== 'object') return bad('not an object');
		const it = item as unknown as Record<string, unknown>;
		switch (it.type) {
			case 'text':
				return (it.role === 'user' || it.role === 'assistant') && isStr(it.text)
					? true
					: bad('text');
			case 'tool_call':
				return isStr(it.id) && isStr(it.name) && typeof it.args === 'object' && it.args !== null
					? true
					: bad('tool_call');
			case 'tool_result':
				return isStr(it.id) &&
					isStr(it.name) &&
					'result' in it &&
					(it.error === undefined || isStr(it.error))
					? true
					: bad('tool_result');
			case 'file':
				return it.role === 'user' && isStr(it.base64Data) && isStr(it.mimeType)
					? true
					: bad('file');
			case 'transfer':
				return isStr(it.fromAgent) && isStr(it.toAgent) ? true : bad('transfer');
			default:
				return bad(`unknown type ${String(it.type)}`);
		}
	}

	/**
	 * Unguarded worker: validate → multi-slot tool-call/result pairing → `ReplayItem → CoreMessage`
	 * → append to `history`. Emits SDK-valid messages only; unmatched calls, duplicate ids, orphan
	 * results, and `file`/`transfer` items are dropped/skipped (metadata-only logs). Grouped so a
	 * parallel-call turn becomes one assistant message + one tool message per result.
	 */
	private applyReplay(items: readonly ReplayItem[]): void {
		const out: CoreMessage[] = [];
		let openCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];
		let results = new Map<string, { name: string; result: unknown; error?: string }>();
		const seenIds = new Set<string>();

		const flushGroup = (): void => {
			const matched = openCalls.filter((c) => results.has(c.id));
			if (matched.length) {
				out.push({
					role: 'assistant',
					content: matched.map((c) => ({
						type: 'tool-call' as const,
						toolCallId: c.id,
						toolName: c.name,
						args: c.args,
					})),
				});
				for (const c of matched) {
					const r = results.get(c.id);
					if (!r) continue;
					if (r.name !== c.name) {
						this.log(
							`[TextLLMTransport] replay: tool_result name mismatch id=${c.id} (using call name)`,
						);
					}
					const resultPayload =
						r.error !== undefined
							? { error: r.error, result: r.result ?? null }
							: (r.result ?? null);
					out.push({
						role: 'tool',
						content: [
							{
								type: 'tool-result' as const,
								toolCallId: c.id,
								toolName: c.name,
								result: resultPayload,
								...(r.error !== undefined ? { isError: true } : {}),
							},
						],
					});
				}
			}
			for (const c of openCalls) {
				if (!results.has(c.id)) {
					this.log(`[TextLLMTransport] replay: dropped unanswered tool_call id=${c.id}`);
				}
			}
			openCalls = [];
			results = new Map();
		};

		items.forEach((item, index) => {
			if (!this.isValidReplayItem(item, index)) return;
			switch (item.type) {
				case 'text':
					flushGroup();
					out.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.text });
					break;
				case 'tool_call':
					if (results.size > 0) flushGroup(); // results already arriving → previous group closes
					if (seenIds.has(item.id)) {
						this.log(`[TextLLMTransport] replay: dropped duplicate tool_call id=${item.id}`);
					} else {
						seenIds.add(item.id);
						openCalls.push({ id: item.id, name: item.name, args: item.args });
					}
					break;
				case 'tool_result':
					if (openCalls.some((c) => c.id === item.id) && !results.has(item.id)) {
						results.set(item.id, { name: item.name, result: item.result, error: item.error });
					} else {
						this.log(
							`[TextLLMTransport] replay: dropped orphan/duplicate tool_result id=${item.id}`,
						);
					}
					break;
				case 'file':
				case 'transfer':
					flushGroup(); // a skipped item is still a turn boundary
					this.log(`[TextLLMTransport] replay: skipped ${item.type} item at index ${index}`);
					break;
			}
		});
		flushGroup(); // commit trailing matched group; drop any unanswered call

		if (out.length) this.history.push(...out);
	}

	private buildTools(): Record<string, ReturnType<typeof tool>> {
		const out: Record<string, ReturnType<typeof tool>> = {};
		for (const d of this.toolDefs) {
			// No `execute` → streamText surfaces the tool call and stops, so the framework's
			// own router runs the tool and feeds the result back via sendToolResult.
			out[d.name] = tool({
				description: d.description,
				parameters: d.parameters as Parameters<typeof tool>[0]['parameters'],
			});
		}
		return out;
	}

	private async runGeneration(): Promise<void> {
		if (this.generating || !this.isConnected || this.closing) return;
		this.generating = true;
		this.modelTurnStarted = false;
		const myId = ++this.genId;
		const abort = new AbortController();
		this.currentAbort = abort;
		// True once this generation has been superseded (cancelled or replaced) — its
		// callbacks/history writes must be suppressed so a stale stream cannot bleed into a
		// newer turn.
		const stale = () => myId !== this.genId || this.closing;
		const offerTools = this.toolRoundsThisTurn < this.maxToolRounds;
		try {
			const result = streamText({
				model: this.model,
				...(this.system ? { system: this.system } : {}),
				messages: this.history,
				...(offerTools && this.toolDefs.length ? { tools: this.buildTools() } : {}),
				abortSignal: abort.signal,
			});

			const toolCalls: TransportToolCall[] = [];
			for await (const part of result.fullStream) {
				if (stale()) break;
				if (part.type === 'text-delta') {
					if (!this.modelTurnStarted) {
						this.modelTurnStarted = true;
						this.onModelTurnStart?.();
					}
					this.onTextOutput?.(part.textDelta);
				} else if (part.type === 'tool-call') {
					toolCalls.push({
						id: part.toolCallId,
						name: part.toolName,
						args: (part.args ?? {}) as Record<string, unknown>,
					});
				} else if (part.type === 'error') {
					const e = part.error;
					if (!NoSuchToolError.isInstance(e)) {
						this.onError?.({
							error: e instanceof Error ? e : new Error(String(e)),
							recoverable: false,
						});
					}
				}
			}

			// A cancelled/superseded generation owns no turn — the caller (VoiceSession)
			// finalizes the interrupted turn itself, so do not append history or emit here.
			if (stale() || abort.signal.aborted) return;

			// Re-check after the await: a cancel/disconnect during `result.response` bumps genId
			// (or aborts), and a stale generation must not append history or emit callbacks.
			const resp = await result.response;
			if (stale() || abort.signal.aborted) return;
			// Append the model's assistant message(s) (including any tool calls) to history.
			this.history.push(...resp.messages);

			if (toolCalls.length > 0) {
				this.toolRoundsThisTurn += 1;
				for (const c of toolCalls) this.pendingToolCalls.set(c.id, c.name);
				if (!this.modelTurnStarted) {
					this.modelTurnStarted = true;
					this.onModelTurnStart?.();
				}
				this.onToolCall?.(toolCalls);
				// Turn continues after sendToolResult(s) resume generation.
			} else {
				this.onTextDone?.();
				this.onTurnComplete?.();
			}
		} catch (err) {
			if (stale() || abort.signal.aborted) return; // cancelled: no callbacks
			this.log(
				`[TextLLMTransport] generation error: ${err instanceof Error ? err.message : String(err)}`,
			);
			this.onError?.({
				error: err instanceof Error ? err : new Error(String(err)),
				recoverable: false,
			});
			this.onTextDone?.();
			this.onTurnComplete?.();
		} finally {
			this.generating = false;
			if (this.currentAbort === abort) this.currentAbort = undefined;
			// Run a generation queued while this one was in flight — but NOT while tool calls
			// are still outstanding (a request with an unanswered assistant tool-call message
			// would be malformed). The tool-result path resumes the turn once results arrive.
			this.settleIdle();
		}
	}
}
