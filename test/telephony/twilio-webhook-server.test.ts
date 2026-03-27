// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TwilioWebhookServer } from '../../src/telephony/twilio-webhook-server.js';

const TEST_PORT = 18900;
const WS_AUTH_TOKEN = 'test-nonce-token-abc123';

describe('TwilioWebhookServer', () => {
	let server: TwilioWebhookServer;

	afterEach(async () => {
		await server?.stop();
	});

	it('starts and stops cleanly', async () => {
		server = new TwilioWebhookServer({
			port: TEST_PORT,
			authToken: 'auth',
			wsAuthToken: WS_AUTH_TOKEN,
			onMediaReceived: vi.fn(),
			onStreamStarted: vi.fn(),
			onStreamStopped: vi.fn(),
		});
		await server.start();
		await server.stop();
	});

	it('start is idempotent', async () => {
		server = new TwilioWebhookServer({
			port: TEST_PORT,
			authToken: 'auth',
			wsAuthToken: WS_AUTH_TOKEN,
			onMediaReceived: vi.fn(),
			onStreamStarted: vi.fn(),
			onStreamStopped: vi.fn(),
		});
		await server.start();
		await server.start(); // Should not throw
	});

	it('POST /twilio/voice returns TwiML with Stream element', async () => {
		server = new TwilioWebhookServer({
			port: TEST_PORT,
			authToken: 'auth',
			wsAuthToken: WS_AUTH_TOKEN,
			onMediaReceived: vi.fn(),
			onStreamStarted: vi.fn(),
			onStreamStopped: vi.fn(),
		});
		await server.start();

		const res = await fetch(`http://localhost:${TEST_PORT}/twilio/voice?auth=mytoken`, {
			method: 'POST',
		});
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/xml');
		expect(body).toContain('<Response>');
		expect(body).toContain('<Stream');
		expect(body).toContain('<Parameter name="auth" value="mytoken"');
	});

	it('POST /twilio/status calls onStatusCallback', async () => {
		const onStatus = vi.fn();
		server = new TwilioWebhookServer({
			port: TEST_PORT + 1,
			authToken: 'auth',
			wsAuthToken: WS_AUTH_TOKEN,
			onMediaReceived: vi.fn(),
			onStreamStarted: vi.fn(),
			onStreamStopped: vi.fn(),
			onStatusCallback: onStatus,
		});
		await server.start();

		const params = new URLSearchParams({
			CallSid: 'CA_test_123',
			CallStatus: 'completed',
			AnsweredBy: 'machine_start',
		});

		await fetch(`http://localhost:${TEST_PORT + 1}/twilio/status`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: params.toString(),
		});

		expect(onStatus).toHaveBeenCalledWith('CA_test_123', 'completed', 'machine_start');
	});

	it('GET /unknown returns 404', async () => {
		server = new TwilioWebhookServer({
			port: TEST_PORT + 2,
			authToken: 'auth',
			wsAuthToken: WS_AUTH_TOKEN,
			onMediaReceived: vi.fn(),
			onStreamStarted: vi.fn(),
			onStreamStopped: vi.fn(),
		});
		await server.start();

		const res = await fetch(`http://localhost:${TEST_PORT + 2}/unknown`);
		expect(res.status).toBe(404);
	});

	describe('Media Streams WebSocket', () => {
		it('rejects connection with invalid auth token', async () => {
			const onStreamStarted = vi.fn();
			server = new TwilioWebhookServer({
				port: TEST_PORT + 3,
				authToken: 'auth',
				wsAuthToken: WS_AUTH_TOKEN,
				onMediaReceived: vi.fn(),
				onStreamStarted,
				onStreamStopped: vi.fn(),
			});
			await server.start();

			const ws = new WebSocket(`ws://localhost:${TEST_PORT + 3}/twilio/media`);
			await new Promise<void>((r) => ws.on('open', r));

			// Send start with wrong auth
			ws.send(
				JSON.stringify({
					event: 'start',
					start: {
						streamSid: 'MZ_test',
						callSid: 'CA_test',
						customParameters: { auth: 'wrong_token' },
					},
				}),
			);

			// Should be closed by server
			await new Promise<void>((resolve) => {
				ws.on('close', (code) => {
					expect(code).toBe(4001);
					resolve();
				});
			});

			expect(onStreamStarted).not.toHaveBeenCalled();
		});

		it('accepts connection with valid auth and fires onStreamStarted', async () => {
			const onStreamStarted = vi.fn();
			server = new TwilioWebhookServer({
				port: TEST_PORT + 4,
				authToken: 'auth',
				wsAuthToken: WS_AUTH_TOKEN,
				onMediaReceived: vi.fn(),
				onStreamStarted,
				onStreamStopped: vi.fn(),
			});
			await server.start();

			const ws = new WebSocket(`ws://localhost:${TEST_PORT + 4}/twilio/media`);
			await new Promise<void>((r) => ws.on('open', r));

			ws.send(
				JSON.stringify({
					event: 'start',
					start: {
						streamSid: 'MZ_test_stream',
						callSid: 'CA_test_call',
						customParameters: { auth: WS_AUTH_TOKEN },
					},
				}),
			);

			await new Promise((r) => setTimeout(r, 50));
			expect(onStreamStarted).toHaveBeenCalledWith('MZ_test_stream', 'CA_test_call');

			ws.close();
		});

		it('forwards media payloads after authentication', async () => {
			const onMedia = vi.fn();
			server = new TwilioWebhookServer({
				port: TEST_PORT + 5,
				authToken: 'auth',
				wsAuthToken: WS_AUTH_TOKEN,
				onMediaReceived: onMedia,
				onStreamStarted: vi.fn(),
				onStreamStopped: vi.fn(),
			});
			await server.start();

			const ws = new WebSocket(`ws://localhost:${TEST_PORT + 5}/twilio/media`);
			await new Promise<void>((r) => ws.on('open', r));

			// Authenticate
			ws.send(
				JSON.stringify({
					event: 'start',
					start: {
						streamSid: 'MZ_1',
						callSid: 'CA_1',
						customParameters: { auth: WS_AUTH_TOKEN },
					},
				}),
			);
			await new Promise((r) => setTimeout(r, 50));

			// Send media
			ws.send(
				JSON.stringify({
					event: 'media',
					media: { payload: 'dGVzdGF1ZGlv' },
				}),
			);
			await new Promise((r) => setTimeout(r, 50));

			expect(onMedia).toHaveBeenCalledWith('dGVzdGF1ZGlv');
			ws.close();
		});

		it('ignores media before authentication', async () => {
			const onMedia = vi.fn();
			server = new TwilioWebhookServer({
				port: TEST_PORT + 6,
				authToken: 'auth',
				wsAuthToken: WS_AUTH_TOKEN,
				onMediaReceived: onMedia,
				onStreamStarted: vi.fn(),
				onStreamStopped: vi.fn(),
			});
			await server.start();

			const ws = new WebSocket(`ws://localhost:${TEST_PORT + 6}/twilio/media`);
			await new Promise<void>((r) => ws.on('open', r));

			// Send media without authenticating first
			ws.send(
				JSON.stringify({
					event: 'media',
					media: { payload: 'sneaky' },
				}),
			);
			await new Promise((r) => setTimeout(r, 50));

			expect(onMedia).not.toHaveBeenCalled();
			ws.close();
		});

		it('fires onStreamStopped on WS close', async () => {
			const onStopped = vi.fn();
			server = new TwilioWebhookServer({
				port: TEST_PORT + 7,
				authToken: 'auth',
				wsAuthToken: WS_AUTH_TOKEN,
				onMediaReceived: vi.fn(),
				onStreamStarted: vi.fn(),
				onStreamStopped: onStopped,
			});
			await server.start();

			const ws = new WebSocket(`ws://localhost:${TEST_PORT + 7}/twilio/media`);
			await new Promise<void>((r) => ws.on('open', r));

			// Authenticate
			ws.send(
				JSON.stringify({
					event: 'start',
					start: {
						streamSid: 'MZ_1',
						callSid: 'CA_1',
						customParameters: { auth: WS_AUTH_TOKEN },
					},
				}),
			);
			await new Promise((r) => setTimeout(r, 50));

			ws.close();
			await new Promise((r) => setTimeout(r, 50));

			expect(onStopped).toHaveBeenCalled();
		});
	});
});
