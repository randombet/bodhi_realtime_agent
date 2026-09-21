/**
 * HTTP client for OpenClaw gateway using the OpenAI Responses API format.
 *
 * Connects to a remote OpenClaw gateway via POST /v1/responses with SSE streaming.
 * Implements the same OpenClawTransport interface as the WebSocket client,
 * allowing transparent swapping between local (WebSocket) and remote (HTTP) modes.
 */

import { randomUUID } from 'node:crypto';
import type { ChatAttachment, ChatEvent, ChatSendOptions } from './openclaw-client.js';
import type { OpenClawTransport } from './openclaw-transport.js';

export interface OpenClawHttpClientOptions {
	/** Base URL of the gateway (e.g., "https://ubuntu-xxx.taild1b3ce.ts.net"). */
	url: string;
	/** Bearer token for authorization. */
	token: string;
	/** Default model (e.g., "openclaw/default"). */
	model?: string;
	/** Session key prefix (default: "bodhi"). */
	sessionKeyPrefix?: string;
}

interface PendingEvent {
	resolve: (event: ChatEvent) => void;
	reject: (err: Error) => void;
}

export class OpenClawHttpClient implements OpenClawTransport {
	private readonly _baseUrl: string;
	private readonly _token: string;
	private readonly _defaultModel: string;
	private readonly _sessionKeyPrefix: string;

	// Per-session model overrides
	private readonly _models = new Map<string, string>();
	// Per-session last response ID for conversation chaining
	private readonly _lastResponseIds = new Map<string, string>();
	// Per-runId event queues
	private readonly _eventQueues = new Map<string, ChatEvent[]>();
	private readonly _eventWaiters = new Map<string, PendingEvent>();
	// Per-runId abort controllers
	private readonly _controllers = new Map<string, AbortController>();
	// Per-runId response IDs (captured early from response.created for cancel support)
	private readonly _responseIds = new Map<string, string>();

	constructor(opts: OpenClawHttpClientOptions) {
		this._baseUrl = opts.url.replace(/\/+$/, '');
		this._token = opts.token;
		this._defaultModel = opts.model ?? 'openclaw/default';
		this._sessionKeyPrefix = opts.sessionKeyPrefix ?? 'bodhi';
	}

	// --- OpenClawTransport interface ---

	async connect(): Promise<void> {
		// No-op — HTTP is stateless
	}

	async chatSend(
		sessionKey: string,
		message: string,
		optionsOrKey?: ChatSendOptions | string,
	): Promise<{ runId: string }> {
		const options =
			typeof optionsOrKey === 'string' ? { idempotencyKey: optionsOrKey } : optionsOrKey;

		const runId = randomUUID();
		const model = this._models.get(sessionKey) ?? this._defaultModel;
		const previousResponseId = this._lastResponseIds.get(sessionKey);
		const headersBase: Record<string, string> = {
			Authorization: `Bearer ${this._token}`,
			'Content-Type': 'application/json',
		};
		const finalHeaders: Record<string, string> = { ...headersBase };
		if (options?.idempotencyKey) {
			finalHeaders['Idempotency-Key'] = options.idempotencyKey;
		}

		const attachmentCount = options?.attachments?.length ?? 0;
		const previousResponseState = previousResponseId ? 'set' : 'none';
		const sendMode = attachmentCount > 0 ? 'chained_single_content' : 'single_request';
		console.log(
			`[OpenClaw][HTTP] chatSend runId=${runId} sessionKey=${sessionKey} model=${model} mode=${sendMode} attachments=${attachmentCount} previousResponseId=${previousResponseState}`,
		);
		if (attachmentCount > 0) {
			console.log(
				`[OpenClaw][HTTP] attachment metadata runId=${runId}: ${this.describeAttachments(options?.attachments ?? [])}`,
			);
		}
		if (options?.idempotencyKey) {
			console.log(
				`[OpenClaw][HTTP] idempotency key present runId=${runId} key=${options.idempotencyKey}`,
			);
		}

		const controller = new AbortController();
		this._controllers.set(runId, controller);
		this._eventQueues.set(runId, []);

		// Start request pipeline in background
		void this._startRequestPipeline(
			runId,
			sessionKey,
			model,
			message,
			options,
			previousResponseId,
			headersBase,
			finalHeaders,
			controller.signal,
		);

		return { runId };
	}

	async nextChatEvent(runId: string): Promise<ChatEvent> {
		const queue = this._eventQueues.get(runId);
		if (queue && queue.length > 0) {
			const event = queue.shift()!;
			if (event.state !== 'delta') {
				this._cleanupRun(runId);
			}
			return event;
		}

		// Wait for next event
		return new Promise<ChatEvent>((resolve, reject) => {
			this._eventWaiters.set(runId, { resolve, reject });
		});
	}

	async chatAbort(runId: string): Promise<void> {
		// 1. Cancel local stream
		const controller = this._controllers.get(runId);
		if (controller) {
			controller.abort();
		}

		// 2. Attempt server-side cancel if response ID was captured early
		const responseId = this._responseIds.get(runId);
		if (responseId) {
			// Best-effort — don't await or throw on failure
			fetch(`${this._baseUrl}/v1/responses/${responseId}/cancel`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${this._token}` },
			}).catch(() => {});
		}

		this._responseIds.delete(runId);
		this._enqueueEvent(runId, {
			source: 'chat',
			runId,
			state: 'aborted',
		});
	}

	async setModel(sessionKey: string, model: string): Promise<void> {
		this._models.set(sessionKey, model);
	}

	sessionKey(sessionId: string): string {
		return `${this._sessionKeyPrefix}:${sessionId}`;
	}

	async close(): Promise<void> {
		for (const controller of this._controllers.values()) {
			controller.abort();
		}
		for (const waiter of this._eventWaiters.values()) {
			waiter.reject(new Error('Client closed'));
		}
		this._controllers.clear();
		this._eventQueues.clear();
		this._eventWaiters.clear();
		this._responseIds.clear();
		this._lastResponseIds.clear();
		this._models.clear();
	}

	// --- Private ---

	private async _startRequestPipeline(
		runId: string,
		sessionKey: string,
		model: string,
		message: string,
		options: ChatSendOptions | undefined,
		previousResponseId: string | undefined,
		headersBase: Record<string, string>,
		finalHeaders: Record<string, string>,
		signal: AbortSignal,
	): Promise<void> {
		try {
			const contentParts = this.buildChainedContentParts(message, options?.attachments ?? []);
			let chainedPreviousResponseId = previousResponseId;

			for (let index = 0; index < contentParts.length; index++) {
				const isFinalPart = index === contentParts.length - 1;
				const input = this.buildInputForContentPart(contentParts[index], message);
				const body: Record<string, unknown> = {
					model,
					input,
					stream: isFinalPart,
				};
				if (chainedPreviousResponseId) {
					body.previous_response_id = chainedPreviousResponseId;
				}

				if (isFinalPart) {
					await this._consumeSSE(runId, sessionKey, body, finalHeaders, signal);
					continue;
				}

				const partHeaders: Record<string, string> = { ...headersBase };
				if (options?.idempotencyKey) {
					partHeaders['Idempotency-Key'] = `${options.idempotencyKey}:part:${index + 1}`;
				}

				console.log(
					`[OpenClaw][HTTP] preflight content runId=${runId} part=${index + 1}/${contentParts.length} input=${this.describeInputShape(input)} previousResponseId=${chainedPreviousResponseId ? 'set' : 'none'}`,
				);
				chainedPreviousResponseId = await this._postNonStreamingAndGetResponseId(
					runId,
					body,
					partHeaders,
					signal,
				);
				console.log(
					`[OpenClaw][HTTP] preflight content acknowledged runId=${runId} part=${index + 1}/${contentParts.length} responseId=${chainedPreviousResponseId}`,
				);
			}
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') {
				return;
			}
			console.error(
				`[OpenClaw][HTTP] request pipeline error runId=${runId}: ${err instanceof Error ? err.message : String(err)}`,
			);
			this._enqueueEvent(runId, {
				source: 'chat',
				runId,
				state: 'error',
				error: err instanceof Error ? err.message : String(err),
			});
			this._controllers.delete(runId);
		}
	}

	private buildSingleContentInput(content: Record<string, unknown>): Record<string, unknown>[] {
		return [
			{
				type: 'message',
				role: 'user',
				content: [content],
			},
		];
	}

	private buildInputForContentPart(
		content: Record<string, unknown>,
		originalMessage: string,
	): Record<string, unknown>[] {
		const partType = typeof content.type === 'string' ? content.type : '';
		if (partType !== 'input_image') {
			return this.buildSingleContentInput(content);
		}

		const contextText =
			originalMessage.trim().length > 0 ? originalMessage : 'Please process the attached image.';

		return [
			{
				type: 'message',
				role: 'user',
				content: [
					{
						type: 'input_text',
						text: contextText,
					},
					content,
				],
			},
		];
	}

	private buildChainedContentParts(
		message: string,
		attachments: ChatAttachment[],
	): Record<string, unknown>[] {
		const normalizedMessage =
			message.trim().length > 0 ? message : 'Please process the provided image attachment.';
		const parts: Record<string, unknown>[] = [{ type: 'input_text', text: normalizedMessage }];

		for (const attachment of attachments) {
			parts.push({
				type: 'input_image',
				source: {
					type: 'base64',
					media_type: attachment.mimeType,
					data: attachment.content,
					...(attachment.fileName ? { filename: attachment.fileName } : {}),
				},
			});
		}

		return parts;
	}

	private async _postNonStreamingAndGetResponseId(
		runId: string,
		body: Record<string, unknown>,
		headers: Record<string, string>,
		signal: AbortSignal,
	): Promise<string> {
		const response = await fetch(`${this._baseUrl}/v1/responses`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal,
		});

		if (!response.ok) {
			const status = response.status;
			const text = await response.text().catch(() => '');
			const trimmedBody = text.trim();
			const errorMsg = this.buildErrorMessage(status, response, trimmedBody);
			throw new Error(errorMsg);
		}

		const text = await response.text().catch(() => '');
		let parsed: Record<string, unknown> | undefined;
		if (text) {
			try {
				const value = JSON.parse(text);
				if (value && typeof value === 'object') {
					parsed = value as Record<string, unknown>;
				}
			} catch {
				throw new Error(`OpenClaw non-streaming response was not valid JSON (runId=${runId})`);
			}
		}

		const responseId =
			(typeof parsed?.id === 'string' && parsed.id) ||
			(typeof (parsed?.response as Record<string, unknown> | undefined)?.id === 'string'
				? ((parsed?.response as Record<string, unknown>).id as string)
				: undefined);

		if (!responseId) {
			throw new Error(`OpenClaw non-streaming response missing id (runId=${runId})`);
		}

		return responseId;
	}

	private async _consumeSSE(
		runId: string,
		sessionKey: string,
		body: Record<string, unknown>,
		headers: Record<string, string>,
		signal: AbortSignal,
	): Promise<void> {
		try {
			console.log(
				`[OpenClaw][HTTP] POST /v1/responses runId=${runId} model=${String(body.model ?? '')} stream=${String(body.stream ?? '')} input=${this.describeInputShape(body.input)}`,
			);

			const response = await fetch(`${this._baseUrl}/v1/responses`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal,
			});

			if (!response.ok) {
				const status = response.status;
				const text = await response.text().catch(() => '');
				const trimmedBody = text.trim();
				const errorMsg = this.buildErrorMessage(status, response, trimmedBody);

				console.error(
					`[OpenClaw][HTTP] /v1/responses failed runId=${runId} status=${status} body=${trimmedBody.slice(0, 1200)}`,
				);
				if (status === 400 && this.inputContainsImage(body.input)) {
					console.error(
						`[OpenClaw][HTTP] 400 invalid input for attachment request runId=${runId}. Verify input message envelope and input_image.source fields (type/media_type/data/filename).`,
					);
				}

				this._enqueueEvent(runId, {
					source: 'chat',
					runId,
					state: 'error',
					error: errorMsg,
				});
				return;
			}

			const reader = response.body?.getReader();
			if (!reader) {
				this._enqueueEvent(runId, {
					source: 'chat',
					runId,
					state: 'error',
					error: 'No response body',
				});
				return;
			}

			const decoder = new TextDecoder();
			let buffer = '';
			let accumulatedText = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// Normalize CRLF to LF, then split on double newline (SSE event boundary)
				buffer = buffer.replace(/\r\n/g, '\n');
				const parts = buffer.split('\n\n');
				buffer = parts.pop() ?? '';

				for (const part of parts) {
					if (!part.trim()) continue;

					// Parse SSE event — accumulate multiline data: fields per SSE spec
					const dataLines: string[] = [];
					for (const line of part.split('\n')) {
						if (line.startsWith('data: ')) {
							dataLines.push(line.slice(6));
						} else if (line === 'data:') {
							dataLines.push('');
						}
					}
					const dataPayload = dataLines.join('\n');

					if (!dataPayload) continue;
					if (dataPayload === '[DONE]') continue;

					let parsed: Record<string, unknown>;
					try {
						parsed = JSON.parse(dataPayload);
					} catch {
						continue; // Skip malformed JSON
					}

					const eventType = parsed.type as string;

					// Capture response.id early for server-cancel support
					if (eventType === 'response.created') {
						const resp = parsed.response as Record<string, unknown>;
						const responseId = resp?.id as string;
						if (responseId) {
							this._responseIds.set(runId, responseId);
							console.log(
								`[OpenClaw][HTTP] response.created runId=${runId} responseId=${responseId}`,
							);
						}
					}

					if (eventType === 'response.output_text.delta') {
						const delta = parsed.delta as string;
						if (delta) {
							accumulatedText += delta;
							this._enqueueEvent(runId, {
								source: 'chat',
								runId,
								state: 'delta',
								text: delta,
							});
						}
					} else if (eventType === 'response.completed') {
						const resp = parsed.response as Record<string, unknown>;
						const responseId = resp?.id as string;
						if (responseId) {
							this._lastResponseIds.set(sessionKey, responseId);
							console.log(
								`[OpenClaw][HTTP] response.completed runId=${runId} responseId=${responseId}`,
							);
						}

						// Extract full text from response output
						const output = resp?.output as Record<string, unknown>[];
						let fullText = accumulatedText;
						if (output?.length) {
							const msg = output[0] as Record<string, unknown>;
							const content = msg?.content as Record<string, unknown>[];
							if (content?.length) {
								const textPart = content.find((c) => c.type === 'output_text') as
									| Record<string, unknown>
									| undefined;
								if (textPart?.text) {
									fullText = textPart.text as string;
								}
							}
						}

						this._enqueueEvent(runId, {
							source: 'chat',
							runId,
							state: 'final',
							text: fullText,
							finalDisposition: 'completed',
						});
					} else if (eventType === 'response.failed') {
						const resp = parsed.response as Record<string, unknown>;
						const error = (resp?.error as Record<string, unknown>)?.message ?? 'Unknown error';
						console.error(`[OpenClaw][HTTP] response.failed runId=${runId} error=${String(error)}`);
						this._enqueueEvent(runId, {
							source: 'chat',
							runId,
							state: 'error',
							error: error as string,
						});
					} else if (eventType === 'response.cancelled') {
						console.warn(`[OpenClaw][HTTP] response.cancelled runId=${runId}`);
						this._enqueueEvent(runId, {
							source: 'chat',
							runId,
							state: 'aborted',
						});
					}
					// All other event types (response.created, response.in_progress,
					// response.output_item.added, etc.) are ignored — they're
					// intermediate lifecycle events not needed by consumers.
				}
			}
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') {
				// Already handled by chatAbort()
				return;
			}
			console.error(
				`[OpenClaw][HTTP] stream error runId=${runId}: ${err instanceof Error ? err.message : String(err)}`,
			);
			this._enqueueEvent(runId, {
				source: 'chat',
				runId,
				state: 'error',
				error: err instanceof Error ? err.message : String(err),
			});
		} finally {
			this._controllers.delete(runId);
		}
	}

	private _enqueueEvent(runId: string, event: ChatEvent): void {
		const waiter = this._eventWaiters.get(runId);
		if (waiter) {
			this._eventWaiters.delete(runId);
			if (event.state !== 'delta') {
				this._cleanupRun(runId);
			}
			waiter.resolve(event);
			return;
		}

		let queue = this._eventQueues.get(runId);
		if (!queue) {
			queue = [];
			this._eventQueues.set(runId, queue);
		}

		// Backpressure: max 1000 buffered events per runId
		if (queue.length >= 1000 && event.state === 'delta') {
			queue.shift(); // Drop oldest delta
		}

		queue.push(event);
	}

	private _cleanupRun(runId: string): void {
		this._eventQueues.delete(runId);
		this._eventWaiters.delete(runId);
		this._responseIds.delete(runId);
		// Controller already deleted in _consumeSSE finally block
	}

	private describeInputShape(input: unknown): string {
		if (typeof input === 'string') {
			return `string(len=${input.length})`;
		}
		if (!Array.isArray(input)) {
			return typeof input;
		}

		let imageCount = 0;
		let textCount = 0;
		let messageCount = 0;
		const types: string[] = [];
		for (const item of input) {
			const type =
				typeof item === 'object' && item
					? String((item as { type?: unknown }).type ?? 'unknown')
					: 'non_object';
			types.push(type);
			if (type === 'message') {
				messageCount++;
				const content =
					typeof item === 'object' && item
						? ((item as { content?: unknown }).content as unknown)
						: undefined;
				if (Array.isArray(content)) {
					for (const part of content) {
						const partType =
							typeof part === 'object' && part
								? String((part as { type?: unknown }).type ?? 'unknown')
								: 'non_object';
						if (partType === 'input_image') imageCount++;
						if (partType === 'input_text') textCount++;
					}
				}
				continue;
			}
			if (type === 'input_image') imageCount++;
			if (type === 'input_text') textCount++;
		}
		return `array(len=${input.length},messages=${messageCount},images=${imageCount},texts=${textCount},types=${types.join('|')})`;
	}

	private describeAttachments(attachments: ChatAttachment[]): string {
		if (attachments.length === 0) return 'none';
		return attachments
			.map((attachment, index) => {
				const bytes = Math.ceil((attachment.content.length * 3) / 4);
				return `#${index + 1}{mime=${attachment.mimeType},name=${attachment.fileName ?? 'unnamed'},base64Len=${attachment.content.length},bytes~=${bytes}}`;
			})
			.join(' ');
	}

	private inputContainsImage(input: unknown): boolean {
		if (!Array.isArray(input)) return false;
		return input.some((item) => {
			if (typeof item !== 'object' || item === null) return false;
			const record = item as Record<string, unknown>;
			if (record.type === 'input_image') return true;
			if (record.type !== 'message' || !Array.isArray(record.content)) return false;
			return record.content.some(
				(part) =>
					typeof part === 'object' &&
					part !== null &&
					(part as Record<string, unknown>).type === 'input_image',
			);
		});
	}

	private buildErrorMessage(status: number, response: Response, bodyText: string): string {
		const requestId =
			response.headers.get('x-request-id') ??
			response.headers.get('request-id') ??
			response.headers.get('openai-request-id') ??
			undefined;

		let parsed: Record<string, unknown> | undefined;
		if (bodyText) {
			try {
				const value = JSON.parse(bodyText);
				if (value && typeof value === 'object') {
					parsed = value as Record<string, unknown>;
				}
			} catch {
				// Keep raw fallback.
			}
		}

		const envelope =
			parsed && parsed.error && typeof parsed.error === 'object'
				? (parsed.error as Record<string, unknown>)
				: parsed;
		const gatewayMessage = typeof envelope?.message === 'string' ? envelope.message : undefined;
		const gatewayType = typeof envelope?.type === 'string' ? envelope.type : undefined;
		const gatewayCode =
			typeof envelope?.code === 'string' || typeof envelope?.code === 'number'
				? String(envelope.code)
				: undefined;
		const gatewayParam = typeof envelope?.param === 'string' ? envelope.param : undefined;

		const detailParts: string[] = [];
		if (gatewayMessage) detailParts.push(gatewayMessage);
		if (gatewayType) detailParts.push(`type=${gatewayType}`);
		if (gatewayCode) detailParts.push(`code=${gatewayCode}`);
		if (gatewayParam) detailParts.push(`param=${gatewayParam}`);
		if (requestId) detailParts.push(`request_id=${requestId}`);
		if (!gatewayMessage && bodyText) {
			detailParts.push(`body=${bodyText.slice(0, 500)}`);
		}

		const detailText = detailParts.length > 0 ? ` (${detailParts.join(', ')})` : '';
		if (status === 401) return `OpenClaw auth failed: invalid token${detailText}`;
		if (status === 429) return `OpenClaw rate limited${detailText}`;
		return `OpenClaw request failed: HTTP ${status}${detailText}`;
	}
}
