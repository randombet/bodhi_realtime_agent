// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { DeviceIdentity } from './openclaw-device-identity.js';
import { signChallengePayload } from './openclaw-device-identity.js';

// ---------------------------------------------------------------------------
// Types — Wire Protocol
// ---------------------------------------------------------------------------

/** Binary attachment for chat.send requests. */
export interface ChatAttachment {
	type: 'image';
	mimeType: string;
	fileName?: string;
	content: string; // base64
}

/** Options for chatSend(). */
export interface ChatSendOptions {
	idempotencyKey?: string;
	attachments?: ChatAttachment[];
}

/** Raw chat event from OpenClaw Gateway (wire format). */
export interface GatewayChatEventRaw {
	runId: string;
	sessionKey: string;
	seq: number;
	state: 'delta' | 'final' | 'aborted' | 'error';
	message?: { role: 'assistant'; content: string };
	errorMessage?: string;
	usage?: unknown;
	stopReason?: string;
}

/** A content block from a multimodal response (text, image, or document). */
export interface ContentBlock {
	type: 'text' | 'image' | 'document';
	text?: string;
	base64?: string;
	mimeType?: string;
	fileName?: string;
}

/** Normalized chat event for framework orchestration. */
export interface ChatEvent {
	source: 'chat';
	runId: string;
	state: 'delta' | 'final' | 'aborted' | 'error';
	text?: string;
	error?: string;
	stopReason?: string;
	/** Present only when state === 'final'. */
	finalDisposition?: 'completed' | 'needs_input' | 'protocol_error';
	/** Non-text content blocks (images, documents) from the response. */
	contentBlocks?: ContentBlock[];
}

/** Gateway JSON-RPC frame types. */
interface GatewayRequest {
	type: 'req';
	id: string;
	method: string;
	params: Record<string, unknown>;
}

interface GatewayResponse {
	type: 'res';
	id: string;
	ok: boolean;
	payload?: Record<string, unknown>;
	error?: unknown;
}

/** Safely stringify a gateway error (may be string, object, or undefined). */
function stringifyError(err: unknown, fallback: string): string {
	if (typeof err === 'string') return err;
	if (err && typeof err === 'object') {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === 'string') return obj.message;
		return JSON.stringify(err);
	}
	return fallback;
}

interface GatewayEvent {
	type: 'event';
	event: string;
	payload: Record<string, unknown>;
	seq?: number;
}

type GatewayFrame = GatewayResponse | GatewayEvent;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Extract text from a message content field (may be string or object). */
function extractText(content: unknown): string | undefined {
	if (typeof content === 'string') return content;

	if (Array.isArray(content)) {
		for (const item of content) {
			const nested = extractText(item);
			if (nested) return nested;
		}
		return undefined;
	}

	if (content && typeof content === 'object') {
		const obj = content as Record<string, unknown>;
		if (typeof obj.text === 'string' && obj.text.trim().length > 0) return obj.text;
		if (typeof obj.content === 'string' && obj.content.trim().length > 0) return obj.content;
		if (Array.isArray(obj.content)) return extractText(obj.content);
		if (obj.content && typeof obj.content === 'object') {
			const nested = extractText(obj.content);
			if (nested) return nested;
		}

		// Common wrappers used by gateway/tool payloads.
		const nestedKeys = ['message', 'result', 'output', 'value'] as const;
		for (const key of nestedKeys) {
			const nested = extractText(obj[key]);
			if (nested) return nested;
		}

		return undefined;
	}

	return undefined;
}

/** Merge streamed text safely — never overwrite prior text with empty/blank chunks. */
export function mergeText(previous: string, incoming?: string): string {
	if (incoming == null) return previous;
	if (incoming.trim().length === 0) return previous;
	return incoming;
}

/**
 * Extract structured content blocks from a multimodal response.
 * Handles Claude API format: text blocks, image blocks (base64 source), document blocks.
 * String content is returned as a single text block.
 * Unknown block types are skipped (don't stringify large objects).
 */
export function extractContentBlocks(content: unknown): ContentBlock[] {
	if (typeof content === 'string') {
		return content.length > 0 ? [{ type: 'text', text: content }] : [];
	}

	if (!Array.isArray(content)) {
		const text = extractText(content);
		return text ? [{ type: 'text', text }] : [];
	}

	const blocks: ContentBlock[] = [];
	for (const part of content) {
		if (typeof part === 'string') {
			if (part.length > 0) blocks.push({ type: 'text', text: part });
			continue;
		}
		if (!part || typeof part !== 'object') continue;

		const obj = part as Record<string, unknown>;

		// Text block
		if (obj.type === 'text' && typeof obj.text === 'string') {
			blocks.push({ type: 'text', text: obj.text });
			continue;
		}

		// Image block (Claude API format)
		if (obj.type === 'image' && obj.source && typeof obj.source === 'object') {
			const source = obj.source as Record<string, unknown>;
			if (source.type === 'base64' && typeof source.data === 'string') {
				blocks.push({
					type: 'image',
					base64: source.data,
					mimeType:
						typeof source.media_type === 'string' ? source.media_type : 'image/png',
				});
			}
			continue;
		}

		// Document block (Claude API format)
		if (obj.type === 'document' && obj.source && typeof obj.source === 'object') {
			const source = obj.source as Record<string, unknown>;
			if (source.type === 'base64' && typeof source.data === 'string') {
				blocks.push({
					type: 'document',
					base64: source.data,
					mimeType:
						typeof source.media_type === 'string'
							? source.media_type
							: 'application/octet-stream',
					fileName: typeof obj.name === 'string' ? obj.name : undefined,
				});
			}
			continue;
		}

		// Unknown block types — skip to avoid stringifying large objects
	}

	return blocks;
}

/** Normalize a raw gateway chat event into a framework ChatEvent. */
export function normalizeEvent(raw: GatewayChatEventRaw): ChatEvent {
	const blocks = extractContentBlocks(raw.message?.content);
	const textBlocks = blocks.filter((b) => b.type === 'text');
	const nonTextBlocks = blocks.filter((b) => b.type !== 'text');

	// Use structured text blocks when available. Otherwise, fall back to permissive
	// extraction so non-standard gateway wrappers (e.g. tool_result) still surface text.
	const text =
		textBlocks.length > 0
			? textBlocks.map((b) => b.text).join('')
			: extractText(raw.message?.content);

	const event: ChatEvent = {
		source: 'chat',
		runId: raw.runId,
		state: raw.state,
		text: text || undefined,
		contentBlocks: nonTextBlocks.length > 0 ? nonTextBlocks : undefined,
		error: raw.errorMessage,
		stopReason: raw.stopReason,
	};
	if (raw.state === 'final') {
		if (raw.stopReason === 'needs_input') {
			event.finalDisposition = 'needs_input';
		} else {
			// Treat stop, max_tokens, end_turn, and missing stopReason as completed
			event.finalDisposition = 'completed';
		}
	}
	return event;
}

// ---------------------------------------------------------------------------
// OpenClawClient
// ---------------------------------------------------------------------------

export interface OpenClawClientOptions {
	/** Gateway WebSocket URL (default: ws://127.0.0.1:18789). */
	url: string;
	/** Authentication token. */
	token: string;
	/** Ed25519 device identity for gateway authentication. */
	device: DeviceIdentity;
	/** Session key prefix (default: 'bodhi'). */
	sessionKeyPrefix?: string;
	/** Client ID in connect request (default: 'gateway-client'). */
	clientId?: string;
	/** Client mode in connect request (default: 'backend'). */
	clientMode?: string;
}

interface PendingRequest {
	resolve: (payload: Record<string, unknown>) => void;
	reject: (err: Error) => void;
}

interface PendingEvent {
	resolve: (event: ChatEvent) => void;
	reject: (err: Error) => void;
}

/**
 * WebSocket client for the OpenClaw Gateway JSON-RPC protocol.
 *
 * Provides both low-level primitives (chatSend, chatAbort, nextChatEvent)
 * for interactive relay loops, and a high-level chat() method for
 * fire-and-forget tool calls.
 */
export class OpenClawClient {
	private ws: WebSocket | null = null;
	private connected = false;
	private pending = new Map<string, PendingRequest>();
	/** Per-runId event queues for nextChatEvent(). */
	private eventQueues = new Map<string, ChatEvent[]>();
	private eventWaiters = new Map<string, PendingEvent>();
	private connectResolve?: () => void;
	private connectReject?: (err: Error) => void;
	private challengeNonce?: string;
	private challengeTs?: number;

	constructor(private opts: OpenClawClientOptions) {}

	/** Connect to the Gateway and authenticate. */
	async connect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.connectResolve = resolve;
			this.connectReject = reject;

			this.ws = new WebSocket(this.opts.url);
			this.ws.on('open', () => {
				// Wait for connect.challenge event
			});
			this.ws.on('message', (data) => this.handleMessage(data.toString()));
			this.ws.on('error', (err) => {
				if (!this.connected) {
					reject(err);
				}
			});
			this.ws.on('close', () => {
				this.connected = false;
				// Reject all pending requests
				for (const [, req] of this.pending) {
					req.reject(new Error('WebSocket closed'));
				}
				this.pending.clear();
				// Reject all event waiters
				for (const [, waiter] of this.eventWaiters) {
					waiter.reject(new Error('WebSocket closed'));
				}
				this.eventWaiters.clear();
			});
		});
	}

	/** Send chat.send to start a new run. Returns { runId }. */
	async chatSend(
		sessionKey: string,
		message: string,
		optionsOrKey?: ChatSendOptions | string,
	): Promise<{ runId: string }> {
		const options =
			typeof optionsOrKey === 'string'
				? { idempotencyKey: optionsOrKey }
				: optionsOrKey;

		const params: Record<string, unknown> = {
			sessionKey,
			message,
			idempotencyKey: options?.idempotencyKey ?? randomUUID(),
		};

		if (options?.attachments?.length) {
			params.attachments = options.attachments;
		}

		const payload = await this.request('chat.send', params);
		return { runId: payload.runId as string };
	}

	/**
	 * Switch the model for a session by sending the `/model` slash command.
	 * The gateway processes this as a session-scoped model override.
	 * Format: `/model provider/model-id` (e.g., `/model anthropic/claude-opus-4-6`).
	 */
	async setModel(sessionKey: string, model: string): Promise<void> {
		const { runId } = await this.chatSend(sessionKey, `/model ${model}`);
		// Consume events until the command completes
		while (true) {
			const event = await this.nextChatEvent(runId);
			if (event.state === 'final' || event.state === 'error' || event.state === 'aborted') {
				if (event.state === 'error') {
					throw new Error(`Failed to set model: ${event.error}`);
				}
				console.log(`[OpenClaw] Model set to ${model} (session=${sessionKey})`);
				return;
			}
		}
	}

	/** Send chat.abort to cancel a running task. */
	async chatAbort(runId: string): Promise<void> {
		await this.request('chat.abort', { runId });
	}

	/**
	 * Returns a Promise that resolves with the next normalized ChatEvent for this runId.
	 * Enables Promise.race() patterns in interactive relay loops.
	 */
	nextChatEvent(runId: string): Promise<ChatEvent> {
		// Check buffered events first
		const queue = this.eventQueues.get(runId);
		if (queue && queue.length > 0) {
			return Promise.resolve(queue.shift()!);
		}

		// Wait for next event
		return new Promise<ChatEvent>((resolve, reject) => {
			this.eventWaiters.set(runId, { resolve, reject });
		});
	}

	/**
	 * High-level convenience: send a prompt and accumulate streaming response
	 * until final. For fire-and-forget tool calls.
	 */
	async chat(params: {
		sessionKey: string;
		message: string;
		signal?: AbortSignal;
	}): Promise<{ text: string; usage?: unknown }> {
		let currentRunId: string | null = null;

		const onAbort = () => {
			if (currentRunId) {
				this.request('chat.abort', { runId: currentRunId }).catch(() => {});
			}
		};
		params.signal?.addEventListener('abort', onAbort);

		try {
			const { runId } = await this.chatSend(params.sessionKey, params.message);
			currentRunId = runId;

			let text = '';
			let usage: unknown;

			while (true) {
				const event = await this.nextChatEvent(runId);

				if (event.state === 'delta') {
					text = mergeText(text, event.text);
				} else if (event.state === 'final') {
					text = mergeText(text, event.text);
					return { text, usage };
				} else if (event.state === 'error') {
					throw new Error(event.error ?? 'OpenClaw chat error');
				} else if (event.state === 'aborted') {
					throw new Error('OpenClaw chat aborted');
				}
			}
		} finally {
			params.signal?.removeEventListener('abort', onAbort);
		}
	}

	/** Graceful close. */
	async close(): Promise<void> {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
			this.connected = false;
		}
	}

	/** Build a session key from a Bodhi session ID. */
	sessionKey(sessionId: string): string {
		const prefix = this.opts.sessionKeyPrefix ?? 'bodhi';
		return `${prefix}:${sessionId}`;
	}

	// -- Internal ---------------------------------------------------------------

	private handleMessage(data: string): void {
		let frame: GatewayFrame;
		try {
			frame = JSON.parse(data);
		} catch {
			return; // Ignore malformed frames
		}

		if (frame.type === 'event') {
			this.handleEvent(frame);
		} else if (frame.type === 'res') {
			this.handleResponse(frame);
		}
	}

	private handleEvent(frame: GatewayEvent): void {
		if (frame.event === 'connect.challenge' && !this.connected) {
			// Respond to auth challenge
			this.challengeNonce = frame.payload.nonce as string;
			this.challengeTs = frame.payload.ts as number;
			this.sendAuthConnect();
			return;
		}

		if (frame.event === 'chat') {
			const raw = frame.payload as unknown as GatewayChatEventRaw;
			const event = normalizeEvent(raw);

			// Deliver to waiter or buffer
			const waiter = this.eventWaiters.get(event.runId);
			if (waiter) {
				this.eventWaiters.delete(event.runId);
				waiter.resolve(event);
			} else {
				let queue = this.eventQueues.get(event.runId);
				if (!queue) {
					queue = [];
					this.eventQueues.set(event.runId, queue);
				}
				queue.push(event);
			}
		}
	}

	private handleResponse(frame: GatewayResponse): void {
		// Check if this is the connect response
		if (frame.id === '__connect__') {
			if (frame.ok) {
				this.connected = true;
				this.connectResolve?.();
			} else {
				const msg = stringifyError(frame.error, 'Connection rejected');
				const detail =
					frame.error && typeof frame.error === 'object'
						? ` (full error: ${JSON.stringify(frame.error)})`
						: '';
				this.connectReject?.(new Error(msg + detail));
			}
			return;
		}

		const req = this.pending.get(frame.id);
		if (req) {
			this.pending.delete(frame.id);
			if (frame.ok) {
				req.resolve(frame.payload ?? {});
			} else {
				req.reject(new Error(stringifyError(frame.error, 'Request failed')));
			}
		}
	}

	private sendAuthConnect(): void {
		const clientId = this.opts.clientId ?? 'gateway-client';
		const clientMode = this.opts.clientMode ?? 'backend';
		const role = 'operator';
		const scopes = ['operator.read', 'operator.write'];
		const platform = 'node';

		const signature = signChallengePayload(this.opts.device, {
			clientId,
			clientMode,
			role,
			scopes,
			signedAtMs: this.challengeTs!,
			token: this.opts.token,
			nonce: this.challengeNonce!,
		});

		const msg: GatewayRequest = {
			type: 'req',
			id: '__connect__',
			method: 'connect',
			params: {
				minProtocol: 3,
				maxProtocol: 3,
				client: {
					id: clientId,
					version: '0.1.0',
					platform,
					mode: clientMode,
				},
				role,
				scopes,
				auth: { token: this.opts.token },
				device: {
					id: this.opts.device.deviceId,
					publicKey: this.opts.device.publicKeyBase64url,
					signature,
					signedAt: this.challengeTs,
					nonce: this.challengeNonce,
				},
			},
		};
		this.ws?.send(JSON.stringify(msg));
	}

	private async request(
		method: string,
		params: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		if (!this.connected || !this.ws) {
			throw new Error('Not connected to OpenClaw Gateway');
		}

		const id = randomUUID();
		const msg: GatewayRequest = { type: 'req', id, method, params };

		return new Promise<Record<string, unknown>>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws!.send(JSON.stringify(msg));
		});
	}
}
