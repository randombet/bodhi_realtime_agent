// SPDX-License-Identifier: MIT

/**
 * Phone-call path: POST /twilio/voice (TwiML) + WSS /twilio/media (Twilio protocol)
 * → session factory + feedAudioFromClient. No web client, no Gemini (stub session).
 */

import { createServer, request as httpRequest } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { TwilioInboundBridge } from '../../app/server/twilio-inbound-bridge.js';
import type { VoiceSession } from '../../src/core/voice-session.js';
import { MultiClientTransport } from '../../src/transport/multi-client-transport.js';

function parseAuthNonce(twiml: string): string {
	const m = twiml.match(/name="auth"\s+value="([^"]+)"/);
	if (!m?.[1]) throw new Error('auth nonce not found in TwiML');
	return m[1];
}

function postVoice(port: number, callSid: string, from: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const body = new URLSearchParams({ CallSid: callSid, From: from }).toString();
		const req = httpRequest(
			{
				hostname: '127.0.0.1',
				port,
				path: '/twilio/voice',
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Content-Length': Buffer.byteLength(body),
				},
			},
			(res) => {
				let data = '';
				res.on('data', (c: Buffer) => {
					data += c;
				});
				res.on('end', () => resolve(data));
			},
		);
		req.on('error', reject);
		req.write(body);
		req.end();
	});
}

describe('TwilioInboundBridge phone path', () => {
	it('POST /twilio/voice returns TwiML with Stream and auth nonce', async () => {
		const feedAudioFromClient = vi.fn();
		const cleanup = vi.fn();
		const createSession = vi.fn(
			async (_userId: string, _callSid: string, _caller: string, _called: string) => ({
				session: { feedAudioFromClient } as unknown as VoiceSession,
				sessionId: 'sess_phone_test',
				cleanup,
			}),
		);

		const bridge = new TwilioInboundBridge({
			webhookUrl: 'https://bodhiagent.live',
			sessionFactory: { createSession },
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			},
		});

		const server = createServer((req, res) => {
			const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '');
			if (path.startsWith('/twilio/')) {
				bridge.handleRequest(req, res);
			} else {
				res.writeHead(404);
				res.end();
			}
		});

		bridge.attach(server);
		const port = await new Promise<number>((resolve, reject) => {
			server.listen(0, '127.0.0.1', () => {
				const a = server.address();
				if (a && typeof a === 'object') resolve(a.port);
				else reject(new Error('no port'));
			});
			server.on('error', reject);
		});

		try {
			const callSid = 'CA_test_inbound_001';
			const from = '+15551234567';
			const twiml = await postVoice(port, callSid, from);
			expect(twiml).toContain('<Response>');
			expect(twiml).toContain('url="wss://bodhiagent.live/twilio/media"');
			expect(twiml).toContain('statusCallback="https://bodhiagent.live/twilio/status"');
			const nonce = parseAuthNonce(twiml);
			expect(nonce.length).toBeGreaterThan(16);

			await new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/media`);
				const t = setTimeout(() => reject(new Error('phone path timeout')), 12000);

				ws.on('error', reject);

				ws.on('open', () => {
					ws.send(
						JSON.stringify({
							event: 'connected',
							protocol: 'Call',
							version: '1.0.0',
						}),
					);
					ws.send(
						JSON.stringify({
							event: 'start',
							sequenceNumber: '1',
							start: {
								accountSid: 'ACxxxxxxxx',
								streamSid: 'MZ_test_stream',
								callSid,
								tracks: ['inbound'],
								mediaFormat: {
									encoding: 'audio/x-mulaw',
									sampleRate: 8000,
									channels: 1,
								},
								customParameters: { auth: nonce },
							},
							streamSid: 'MZ_test_stream',
						}),
					);
				});

				const interval = setInterval(async () => {
					if (createSession.mock.calls.length === 0) return;
					clearInterval(interval);
					expect(createSession).toHaveBeenCalledWith(
						'phone_15551234567',
						callSid,
						from,
						'unknown',
						undefined,
						undefined,
						false,
						undefined,
						undefined,
						undefined,
					);
					// Let createSessionForCall() finish assigning call.session before media.
					await new Promise((r) => setTimeout(r, 100));

					const mulawB64 = Buffer.from([0x7f]).toString('base64');
					ws.send(
						JSON.stringify({
							event: 'media',
							sequenceNumber: '2',
							media: {
								track: 'inbound',
								chunk: '1',
								timestamp: '0',
								payload: mulawB64,
							},
							streamSid: 'MZ_test_stream',
						}),
					);

					await new Promise((r) => setImmediate(r));
					expect(feedAudioFromClient).toHaveBeenCalled();
					const buf = feedAudioFromClient.mock.calls[0][0] as Buffer;
					expect(Buffer.isBuffer(buf)).toBe(true);
					expect(buf.length).toBeGreaterThan(0);

					ws.send(
						JSON.stringify({
							event: 'stop',
							sequenceNumber: '3',
							stop: { accountSid: 'ACx', callSid },
							streamSid: 'MZ_test_stream',
						}),
					);
					await new Promise((r) => setTimeout(r, 50));
					expect(cleanup).toHaveBeenCalled();
					clearTimeout(t);
					ws.close(1000);
					resolve();
				}, 10);
			});
		} finally {
			bridge.dispose();
			await new Promise<void>((r) => server.close(() => r()));
		}
	}, 15_000);

	it('rejects WebSocket when auth nonce does not match', async () => {
		const createSession = vi.fn();
		const bridge = new TwilioInboundBridge({
			webhookUrl: 'https://bodhiagent.live',
			sessionFactory: { createSession },
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			},
		});

		const server = createServer((req, res) => {
			const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '');
			if (path.startsWith('/twilio/')) bridge.handleRequest(req, res);
			else {
				res.writeHead(404);
				res.end();
			}
		});
		bridge.attach(server);

		const port = await new Promise<number>((resolve, reject) => {
			server.listen(0, '127.0.0.1', () => {
				const a = server.address();
				if (a && typeof a === 'object') resolve(a.port);
				else reject(new Error('no port'));
			});
		});

		try {
			const twiml = await postVoice(port, 'CA_bad_auth', '+15550001111');
			const nonce = parseAuthNonce(twiml);

			await new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/media`);
				ws.on('open', () => {
					ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
					ws.send(
						JSON.stringify({
							event: 'start',
							start: {
								streamSid: 'MZx',
								callSid: 'CA_bad_auth',
								customParameters: { auth: `${nonce}wrong` },
							},
							streamSid: 'MZx',
						}),
					);
				});
				ws.on('close', (code) => {
					if (code === 4001) resolve();
					else reject(new Error(`expected 4001, got ${code}`));
				});
				ws.on('error', () => {});
				setTimeout(() => reject(new Error('close timeout')), 5000);
			});

			expect(createSession).not.toHaveBeenCalled();
		} finally {
			bridge.dispose();
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	it('works when MultiClientTransport is attached on same server (no socket destroy)', async () => {
		const createSession = vi.fn(
			async (_userId: string, _callSid: string, _caller: string, _called: string) => ({
				session: { feedAudioFromClient: vi.fn() } as unknown as VoiceSession,
				sessionId: 'sess_coexist',
				cleanup: vi.fn(),
			}),
		);
		const bridge = new TwilioInboundBridge({
			webhookUrl: 'https://bodhiagent.live',
			sessionFactory: { createSession },
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		});
		const server = createServer((req, res) => {
			const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '');
			if (path.startsWith('/twilio/')) bridge.handleRequest(req, res);
			else {
				res.writeHead(404);
				res.end();
			}
		});
		// Match production attach order: web transport first, then Twilio bridge.
		const mct = new MultiClientTransport(9900, {});
		mct.attachToHttpServer(server, ['/', '/ws']);
		bridge.attach(server);

		const port = await new Promise<number>((resolve, reject) => {
			server.listen(0, '127.0.0.1', () => {
				const a = server.address();
				if (a && typeof a === 'object') resolve(a.port);
				else reject(new Error('no port'));
			});
		});

		try {
			const callSid = 'CA_coexist_001';
			const twiml = await postVoice(port, callSid, '+15557778888');
			const nonce = parseAuthNonce(twiml);
			await new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/media`);
				const t = setTimeout(() => reject(new Error('coexist timeout')), 8000);
				ws.on('error', reject);
				ws.on('open', () => {
					ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
					ws.send(
						JSON.stringify({
							event: 'start',
							start: {
								streamSid: 'MZ_coexist',
								callSid,
								customParameters: { auth: nonce },
							},
							streamSid: 'MZ_coexist',
						}),
					);
				});
				const interval = setInterval(() => {
					if (createSession.mock.calls.length > 0) {
						clearInterval(interval);
						clearTimeout(t);
						ws.close(1000);
						resolve();
					}
				}, 20);
			});
			expect(createSession).toHaveBeenCalledWith(
				'phone_15557778888',
				callSid,
				'+15557778888',
				'unknown',
				undefined,
				undefined,
				false,
				undefined,
				undefined,
				undefined,
			);
		} finally {
			bridge.dispose();
			await mct.stop();
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	it('streams hold audio while session is being created and clears on handoff', async () => {
		const feedAudioFromClient = vi.fn();
		const cleanup = vi.fn();

		let resolveSession: (() => void) | null = null;
		const createSession = vi.fn(
			() =>
				new Promise<{
					session: VoiceSession;
					sessionId: string;
					cleanup: () => void;
				}>((resolve) => {
					resolveSession = () =>
						resolve({
							session: { feedAudioFromClient } as unknown as VoiceSession,
							sessionId: 'sess_hold_music',
							cleanup,
						});
				}),
		);

		const bridge = new TwilioInboundBridge({
			webhookUrl: 'https://bodhiagent.live',
			sessionFactory: { createSession },
			logger: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
			},
		});

		const server = createServer((req, res) => {
			const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '');
			if (path.startsWith('/twilio/')) bridge.handleRequest(req, res);
			else {
				res.writeHead(404);
				res.end();
			}
		});
		bridge.attach(server);

		const port = await new Promise<number>((resolve, reject) => {
			server.listen(0, '127.0.0.1', () => {
				const a = server.address();
				if (a && typeof a === 'object') resolve(a.port);
				else reject(new Error('no port'));
			});
		});

		try {
			const callSid = 'CA_hold_001';
			const twiml = await postVoice(port, callSid, '+15558889999');
			const nonce = parseAuthNonce(twiml);

			await new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/media`);
				const timeout = setTimeout(() => reject(new Error('hold audio timeout')), 12000);

				let holdMediaCount = 0;
				let sawClear = false;
				let resolved = false;
				let outboundTriggered = false;

				const maybeResolve = () => {
					if (!resolved && holdMediaCount > 0 && sawClear) {
						resolved = true;
						clearTimeout(timeout);
						ws.send(
							JSON.stringify({
								event: 'stop',
								stop: { callSid },
								streamSid: 'MZ_hold_stream',
							}),
						);
						setTimeout(() => {
							ws.close(1000);
							resolve();
						}, 25);
					}
				};

				ws.on('error', reject);

				ws.on('open', () => {
					ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
					ws.send(
						JSON.stringify({
							event: 'start',
							start: {
								streamSid: 'MZ_hold_stream',
								callSid,
								customParameters: { auth: nonce },
							},
							streamSid: 'MZ_hold_stream',
						}),
					);
				});

				ws.on('message', (raw) => {
					try {
						const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
						const event = msg.event;
						if (event === 'media') {
							holdMediaCount += 1;
							if (holdMediaCount >= 2 && resolveSession) {
								const done = resolveSession;
								resolveSession = null;
								done();
							}
							if (!outboundTriggered && holdMediaCount >= 2 && !resolveSession) {
								outboundTriggered = true;
								setTimeout(() => {
									const sender = bridge.createClientSenderForCallSid(callSid);
									if (!sender) {
										reject(new Error('client sender missing after session create'));
										return;
									}
									// Trigger first outbound assistant audio to verify hold-music handoff.
									sender.sendAudio(Buffer.alloc(1920));
								}, 25);
							}
						} else if (event === 'clear') {
							sawClear = true;
							maybeResolve();
						}
						maybeResolve();
					} catch {
						// ignore malformed
					}
				});
			});

			expect(createSession).toHaveBeenCalledWith(
				'phone_15558889999',
				callSid,
				'+15558889999',
				'unknown',
				undefined,
				undefined,
				false,
				undefined,
				undefined,
				undefined,
			);
			expect(cleanup).toHaveBeenCalled();
			expect(feedAudioFromClient).toHaveBeenCalledTimes(0);
		} finally {
			bridge.dispose();
			await new Promise<void>((r) => server.close(() => r()));
		}
	}, 20_000);
});
