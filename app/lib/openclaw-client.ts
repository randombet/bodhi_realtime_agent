// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { DeviceIdentity } from './openclaw-device-identity.js';
import { signChallengePayload } from './openclaw-device-identity.js';

// ---------------------------------------------------------------------------
// Types — Wire Protocol
// ---------------------------------------------------------------------------

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
	if (content && typeof content === 'object') return JSON.stringify(content);
	return undefined;
}

/** Normalize a raw gateway chat event into a framework ChatEvent. */
export function normalizeEvent(raw: GatewayChatEventRaw): ChatEvent {
	const event: ChatEvent = {
		source: 'chat',
		runId: raw.runId,
		state: raw.state,
		text: extractText(raw.message?.content),
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
		idempotencyKey?: string,
	): Promise<{ runId: string }> {
		const payload = await this.request('chat.send', {
			sessionKey,
			message,
			idempotencyKey: idempotencyKey ?? randomUUID(),
		});
		return { runId: payload.runId as string };
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
					text = event.text ?? text;
				} else if (event.state === 'final') {
					text = event.text ?? text;
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
