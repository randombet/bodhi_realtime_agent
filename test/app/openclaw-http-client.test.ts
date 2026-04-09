// SPDX-License-Identifier: MIT

import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenClawHttpClient } from '../../app/lib/openclaw-http-client.js';

// ---------------------------------------------------------------------------
// Helpers — tiny SSE mock server
// ---------------------------------------------------------------------------

type SSEHandler = (req: IncomingMessage, res: ServerResponse) => void;

function createMockServer(
	handler: SSEHandler,
): Promise<{ port: number; close: () => Promise<void> }> {
	return new Promise((resolve) => {
		const server = createServer(handler);
		// Track connections for force-close on shutdown
		const sockets = new Set<import('node:net').Socket>();
		server.on('connection', (socket) => {
			sockets.add(socket);
			socket.on('close', () => sockets.delete(socket));
		});
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			resolve({
				port,
				close: () => {
					for (const s of sockets) s.destroy();
					return new Promise<void>((r) => server.close(() => r()));
				},
			});
		});
	});
}

function sseEvent(eventType: string, data: Record<string, unknown>): string {
	return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenClawHttpClient', () => {
	let mockPort: number;
	let closeMock: () => Promise<void>;
	let lastRequestBody: Record<string, unknown> | null = null;
	let lastRequestHeaders: Record<string, string | string[] | undefined> = {};
	let customHandler: SSEHandler | null = null;

	const defaultHandler: SSEHandler = (req, res) => {
		let body = '';
		req.on('data', (chunk) => {
			body += chunk;
		});
		req.on('end', () => {
			lastRequestBody = JSON.parse(body);
			lastRequestHeaders = req.headers;

			// Default: return a simple streaming response
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			});

			res.write(
				sseEvent('response.output_text.delta', {
					type: 'response.output_text.delta',
					delta: 'Hello',
					item_id: 'msg_1',
					output_index: 0,
					content_index: 0,
				}),
			);

			res.write(
				sseEvent('response.output_text.delta', {
					type: 'response.output_text.delta',
					delta: ' world',
					item_id: 'msg_1',
					output_index: 0,
					content_index: 0,
				}),
			);

			res.write(
				sseEvent('response.completed', {
					type: 'response.completed',
					response: {
						id: 'resp_test_001',
						object: 'response',
						status: 'completed',
						output: [
							{
								type: 'message',
								id: 'msg_1',
								role: 'assistant',
								content: [{ type: 'output_text', text: 'Hello world' }],
							},
						],
					},
				}),
			);

			res.write('data: [DONE]\n\n');
			res.end();
		});
	};

	beforeAll(async () => {
		const mock = await createMockServer((req, res) => {
			// If customHandler is set, route directly to it (bypasses body parsing)
			if (customHandler) {
				customHandler(req, res);
				return;
			}
			defaultHandler(req, res);
		});
		mockPort = mock.port;
		closeMock = mock.close;
	});

	afterAll(async () => {
		await closeMock();
	});

	function createClient(opts?: Partial<{ model: string }>): OpenClawHttpClient {
		return new OpenClawHttpClient({
			url: `http://127.0.0.1:${mockPort}`,
			token: 'test-token',
			model: opts?.model ?? 'test-model',
		});
	}

	it('streams delta events and produces a final event', async () => {
		customHandler = null;
		const client = createClient();
		const { runId } = await client.chatSend('sess:1', 'Hello');

		const ev1 = await client.nextChatEvent(runId);
		expect(ev1.state).toBe('delta');
		expect(ev1.text).toBe('Hello');
		expect(ev1.source).toBe('chat');
		expect(ev1.runId).toBe(runId);

		const ev2 = await client.nextChatEvent(runId);
		expect(ev2.state).toBe('delta');
		expect(ev2.text).toBe(' world');

		const ev3 = await client.nextChatEvent(runId);
		expect(ev3.state).toBe('final');
		expect(ev3.text).toBe('Hello world');
		expect(ev3.finalDisposition).toBe('completed');

		await client.close();
	});

	it('previous_response_id chains across calls for same session key', async () => {
		customHandler = null;
		const client = createClient();
		const sk = client.sessionKey('chain_test');

		// First call — no previous_response_id
		const { runId: r1 } = await client.chatSend(sk, 'First');
		while ((await client.nextChatEvent(r1)).state !== 'final') {}
		expect(lastRequestBody?.previous_response_id).toBeUndefined();

		// Second call — should include previous_response_id from first response
		const { runId: r2 } = await client.chatSend(sk, 'Second');
		while ((await client.nextChatEvent(r2)).state !== 'final') {}
		expect(lastRequestBody?.previous_response_id).toBe('resp_test_001');

		await client.close();
	});

	it('model precedence: per-session override > constructor default', async () => {
		customHandler = null;

		const client = createClient({ model: 'default-model' });

		// Default model from constructor
		const { runId: r1 } = await client.chatSend('sess:a', 'test');
		while ((await client.nextChatEvent(r1)).state !== 'final') {}
		expect(lastRequestBody?.model).toBe('default-model');

		// Per-session override
		await client.setModel('sess:b', 'override-model');
		const { runId: r2 } = await client.chatSend('sess:b', 'test');
		while ((await client.nextChatEvent(r2)).state !== 'final') {}
		expect(lastRequestBody?.model).toBe('override-model');

		// Original session still uses constructor default
		const { runId: r3 } = await client.chatSend('sess:a', 'test again');
		while ((await client.nextChatEvent(r3)).state !== 'final') {}
		expect(lastRequestBody?.model).toBe('default-model');

		await client.close();
	});

	it('abort emits aborted event and cleans up', async () => {
		// Use a slow handler that never ends
		customHandler = (_req, res) => {
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
			});
			res.write(
				sseEvent('response.output_text.delta', {
					type: 'response.output_text.delta',
					delta: 'Partial',
				}),
			);
			// Don't end — simulate long-running task
		};

		const client = createClient();
		const { runId } = await client.chatSend('sess:abort', 'Long task');

		// Read the first delta
		const ev1 = await client.nextChatEvent(runId);
		expect(ev1.state).toBe('delta');

		// Abort
		await client.chatAbort(runId);
		const ev2 = await client.nextChatEvent(runId);
		expect(ev2.state).toBe('aborted');

		await client.close();
		customHandler = null;
	});

	it('maps HTTP errors to error events', async () => {
		customHandler = (_req, res) => {
			res.writeHead(429, { 'Content-Type': 'text/plain' });
			res.end('Rate limited');
		};

		const client = createClient();
		const { runId } = await client.chatSend('sess:err', 'test');
		const ev = await client.nextChatEvent(runId);
		expect(ev.state).toBe('error');
		expect(ev.error).toContain('rate limited');

		await client.close();
		customHandler = null;
	});

	it('maps HTTP 401 to auth error', async () => {
		customHandler = (_req, res) => {
			res.writeHead(401, { 'Content-Type': 'text/plain' });
			res.end('Unauthorized');
		};

		const client = createClient();
		const { runId } = await client.chatSend('sess:auth', 'test');
		const ev = await client.nextChatEvent(runId);
		expect(ev.state).toBe('error');
		expect(ev.error).toContain('auth failed');

		await client.close();
		customHandler = null;
	});

	it('sends Authorization header and Idempotency-Key', async () => {
		customHandler = null;
		const client = createClient();
		const { runId } = await client.chatSend('sess:headers', 'test', {
			idempotencyKey: 'idem-123',
		});
		while ((await client.nextChatEvent(runId)).state !== 'final') {}
		expect(lastRequestHeaders.authorization).toBe('Bearer test-token');
		expect(lastRequestHeaders['idempotency-key']).toBe('idem-123');
		await client.close();
	});

	it('sessionKey builds correct format', () => {
		const client = createClient();
		expect(client.sessionKey('my_session')).toBe('bodhi:my_session');
	});

	it('close rejects pending waiters', async () => {
		customHandler = (_req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			// Don't send anything — leave the client waiting
		};

		const client = createClient();
		const { runId } = await client.chatSend('sess:close', 'test');

		// Start waiting for an event (will block)
		const eventPromise = client.nextChatEvent(runId).catch((e: Error) => e);

		// Give the SSE request time to start
		await new Promise((r) => setTimeout(r, 50));

		// Close should reject the waiter
		await client.close();
		const result = await eventPromise;
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain('closed');

		customHandler = null;
	});

	it('parses CRLF-delimited SSE frames', async () => {
		customHandler = (_req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			// Send CRLF-delimited SSE
			res.write(
				'event: response.created\r\n' +
					'data: {"type":"response.created","response":{"id":"resp_crlf"}}\r\n\r\n' +
					'event: response.output_text.delta\r\n' +
					'data: {"type":"response.output_text.delta","delta":"CRLF works"}\r\n\r\n' +
					'event: response.completed\r\n' +
					'data: {"type":"response.completed","response":{"id":"resp_crlf","output":[{"type":"message","content":[{"type":"output_text","text":"CRLF works"}]}]}}\r\n\r\n' +
					'data: [DONE]\r\n\r\n',
			);
			res.end();
		};

		const client = createClient();
		const { runId } = await client.chatSend('sess:crlf', 'test');
		const ev1 = await client.nextChatEvent(runId);
		expect(ev1.state).toBe('delta');
		expect(ev1.text).toBe('CRLF works');
		const ev2 = await client.nextChatEvent(runId);
		expect(ev2.state).toBe('final');
		expect(ev2.text).toBe('CRLF works');
		await client.close();
		customHandler = null;
	});

	it('handles bare data: line (empty data field per SSE spec)', async () => {
		customHandler = (_req, res) => {
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			// Standard single-line data with extra event fields the parser should skip
			res.write(
				'event: response.output_text.delta\nid: 123\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n',
			);
			res.write(
				sseEvent('response.completed', {
					type: 'response.completed',
					response: {
						id: 'resp_bare',
						output: [
							{
								type: 'message',
								content: [{ type: 'output_text', text: 'OK' }],
							},
						],
					},
				}),
			);
			res.write('data: [DONE]\n\n');
			res.end();
		};

		const client = createClient();
		const { runId } = await client.chatSend('sess:bare', 'test');
		const ev1 = await client.nextChatEvent(runId);
		expect(ev1.state).toBe('delta');
		expect(ev1.text).toBe('OK');
		const ev2 = await client.nextChatEvent(runId);
		expect(ev2.state).toBe('final');
		expect(ev2.text).toBe('OK');
		await client.close();
		customHandler = null;
	});

	it('abort attempts server-cancel when response.id is captured early', async () => {
		let cancelRequested = false;
		let cancelPath = '';

		customHandler = (req, res) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');

			// Handle cancel endpoint
			if (req.method === 'POST' && url.pathname.includes('/cancel')) {
				cancelRequested = true;
				cancelPath = url.pathname;
				res.writeHead(200);
				res.end();
				return;
			}

			// Handle /v1/responses — send response.created then hang
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.write(
				sseEvent('response.created', {
					type: 'response.created',
					response: { id: 'resp_cancel_me' },
				}),
			);
			res.write(
				sseEvent('response.output_text.delta', {
					type: 'response.output_text.delta',
					delta: 'Working...',
				}),
			);
			// Don't end — simulate long-running task
		};

		const client = createClient();
		const { runId } = await client.chatSend('sess:cancel', 'Long task');

		// Read delta — response.created was processed before this (same SSE stream)
		const ev = await client.nextChatEvent(runId);
		expect(ev.state).toBe('delta');

		// Small delay to ensure _responseIds is populated from response.created
		await new Promise((r) => setTimeout(r, 50));

		// Abort — should attempt server cancel
		await client.chatAbort(runId);
		const abortEv = await client.nextChatEvent(runId);
		expect(abortEv.state).toBe('aborted');

		// Give the fire-and-forget cancel request time to arrive
		await new Promise((r) => setTimeout(r, 500));
		expect(cancelRequested).toBe(true);
		expect(cancelPath).toBe('/v1/responses/resp_cancel_me/cancel');

		await client.close();
		customHandler = null;
	});

	it('abort works client-side only when no response.id captured', async () => {
		customHandler = (req, res) => {
			// Ignore cancel requests
			if (req.url?.includes('/cancel')) {
				res.writeHead(404);
				res.end();
				return;
			}
			// Send SSE without response.created (no early ID)
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.write(
				sseEvent('response.output_text.delta', {
					type: 'response.output_text.delta',
					delta: 'No ID',
				}),
			);
			// Don't end — simulate long-running task
		};

		const client = createClient();
		const { runId } = await client.chatSend('sess:no-id', 'test');
		const ev = await client.nextChatEvent(runId);
		expect(ev.state).toBe('delta');

		// Abort without server cancel (no response.id captured)
		await client.chatAbort(runId);
		const abortEv = await client.nextChatEvent(runId);
		expect(abortEv.state).toBe('aborted');

		await client.close();
		customHandler = null;
	});
});
