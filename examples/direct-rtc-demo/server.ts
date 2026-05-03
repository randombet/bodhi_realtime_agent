// SPDX-License-Identifier: MIT
/**
 * End-to-end voice demo: Gemini Live + `clientMedia: { kind: 'direct_rtc', rtcAudio: 'werift_opus' }`.
 * Mic and assistant audio use Opus RTP (werift + @evan/opus); JSON/control stays on the WebSocket.
 *
 * Run: `pnpm demo:direct-rtc` — requires `GEMINI_API_KEY` or `GOOGLE_API_KEY`.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { SessionClientSender } from '../../src/types/session-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.DIRECT_RTC_DEMO_PORT) || 8788;
const STUN = process.env.DIRECT_RTC_STUN ?? 'stun:stun.l.google.com:19302';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
if (!GEMINI_API_KEY) {
	console.error('Error: set GEMINI_API_KEY or GOOGLE_API_KEY for Gemini Live.');
	process.exit(1);
}

const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL ?? 'gemini-2.5-flash-native-audio-preview-12-2025';
const TEXT_MODEL = process.env.DIRECT_RTC_DEMO_TEXT_MODEL ?? 'gemini-2.5-flash';

const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

const assistantAgent: MainAgent = {
	name: 'assistant',
	instructions:
		'You are a friendly, concise voice companion. Keep replies short and natural for spoken conversation. Do not use markdown or lists unless the user asks.',
	tools: [],
	greeting: 'Greet the user briefly and ask what they would like to talk about.',
};

function toBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(String(data));
}

async function main(): Promise<void> {
	let activeWs: WebSocket | null = null;

	const clientSender: SessionClientSender = {
		sendAudio(data: Buffer) {
			if (activeWs?.readyState === WebSocket.OPEN) {
				activeWs.send(data, { binary: true });
			}
		},
		sendJson(message: Record<string, unknown>) {
			if (activeWs?.readyState === WebSocket.OPEN) {
				activeWs.send(JSON.stringify(message));
			}
		},
	};

	const session = new VoiceSession({
		sessionId: `direct_rtc_voice_${Date.now()}`,
		userId: 'direct_rtc_demo_user',
		apiKey: GEMINI_API_KEY,
		agents: [assistantAgent],
		initialAgent: 'assistant',
		model: google(TEXT_MODEL),
		geminiModel: LIVE_MODEL,
		speechConfig: { voiceName: process.env.GEMINI_VOICE ?? 'Puck' },
		realtimeInputConfig: {
			automaticActivityDetection: {
				endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
				silenceDurationMs: 500,
			},
		},
		clientSender,
		clientMedia: {
			kind: 'direct_rtc',
			iceServers: [{ urls: STUN }],
			rtcAudio: 'werift_opus',
		},
		hooks: {
			onSessionStart: (e) =>
				console.log(`${ts()} [session] start ${e.sessionId} agent=${e.agentName}`),
			onSessionEnd: (e) => console.log(`${ts()} [session] end ${e.reason}`),
			onError: (e) => console.error(`${ts()} [error] ${e.component}: ${e.error.message}`),
		},
	});

	await session.start();

	const indexHtml = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8');

	const httpServer = createServer((req, res) => {
		if (req.url === '/' || req.url === '/index.html') {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			res.end(indexHtml);
			return;
		}
		res.writeHead(404);
		res.end();
	});

	const wss = new WebSocketServer({ noServer: true });

	wss.on('connection', (ws: WebSocket) => {
		if (activeWs && activeWs.readyState === WebSocket.OPEN && activeWs !== ws) {
			session.notifyClientDisconnected();
			activeWs.close(4000, 'replaced by new tab');
		}
		activeWs = ws;

		ws.on('message', (data: RawData, isBinary: boolean) => {
			try {
				if (isBinary) {
					session.feedAudioFromClient(toBuffer(data));
					return;
				}
				const parsed = JSON.parse(toBuffer(data).toString('utf8')) as Record<string, unknown>;
				session.feedJsonFromClient(parsed);
			} catch (err) {
				console.error('[direct-rtc-demo] message error:', err);
			}
		});

		ws.on('close', () => {
			if (activeWs === ws) {
				activeWs = null;
				session.notifyClientDisconnected();
			}
		});

		session.notifyClientConnected();
	});

	httpServer.on('upgrade', (req, socket, head) => {
		const host = req.headers.host ?? `127.0.0.1:${PORT}`;
		let pathname = '/';
		try {
			pathname = new URL(req.url ?? '/', `http://${host}`).pathname;
		} catch {
			socket.destroy();
			return;
		}
		if (pathname === '/ws') {
			wss.handleUpgrade(req, socket, head, (client) => {
				wss.emit('connection', client, req);
			});
		} else {
			socket.destroy();
		}
	});

	await new Promise<void>((resolve) => {
		httpServer.listen(PORT, () => resolve());
	});

	const shutdown = async () => {
		if (activeWs?.readyState === WebSocket.OPEN) {
			activeWs.close();
		}
		await session.close('shutdown');
		httpServer.close();
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown());
	process.on('SIGTERM', () => void shutdown());

	console.log('============================================================');
	console.log('Direct RTC + Gemini Live (Opus RTP)');
	console.log('============================================================');
	console.log(`  Page:        http://127.0.0.1:${PORT}/`);
	console.log(`  WebSocket:   ws://127.0.0.1:${PORT}/ws`);
	console.log(`  Live model:  ${LIVE_MODEL}`);
	console.log(`  Text model:  ${TEXT_MODEL}`);
	console.log(`  STUN:        ${STUN}`);
	console.log('  Allow mic → Connect WebSocket → Start WebRTC, then talk.');
}

void main().catch((err) => {
	console.error(err);
	process.exit(1);
});
