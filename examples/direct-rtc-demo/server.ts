/**
 * Voice agent over direct RTC — end-to-end Gemini Live conversation.
 *
 * Audio transport: browser ←→ server via Opus RTP (WebRTC).
 * Control / transcripts: WebSocket JSON (same contract as all other examples).
 * Agent ←→ Gemini Live: the normal VoiceSession WebSocket path — unchanged.
 *
 * Usage:
 *   1. Set GEMINI_API_KEY (or GOOGLE_API_KEY) in .env or environment.
 *   2. pnpm demo:direct-rtc
 *   3. Open http://127.0.0.1:8788 — click Connect, allow mic, talk.
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
	console.error('Set GEMINI_API_KEY or GOOGLE_API_KEY to run this demo.');
	process.exit(1);
}

const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL ?? 'gemini-2.5-flash-native-audio-preview-12-2025';
const TEXT_MODEL = process.env.DIRECT_RTC_DEMO_TEXT_MODEL ?? 'gemini-2.5-flash';
const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

const agent: MainAgent = {
	name: 'assistant',
	instructions: 'You are a friendly voice companion. Keep replies short and conversational.',
	tools: [],
	greeting: 'Say hi briefly and ask what the user wants to talk about.',
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
		sessionId: `rtc_voice_${Date.now()}`,
		userId: 'rtc_demo_user',
		apiKey: GEMINI_API_KEY,
		agents: [agent],
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

	let lastLoggedIndex = 0;
	session.eventBus.subscribe('turn.end', (payload) => {
		const items = session.conversationContext.items;
		for (const item of items.slice(lastLoggedIndex)) {
			if (item.role === 'user' || item.role === 'assistant') {
				console.log(`${ts()} [${item.role}] ${item.content}`);
			}
		}
		lastLoggedIndex = items.length;
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
			activeWs.close(4000, 'replaced');
		}
		activeWs = ws;

		ws.on('message', (data: RawData, isBinary: boolean) => {
			try {
				if (isBinary) {
					session.feedAudioFromClient(toBuffer(data));
					return;
				}
				session.feedJsonFromClient(
					JSON.parse(toBuffer(data).toString('utf8')) as Record<string, unknown>,
				);
			} catch (err) {
				console.error(`${ts()} [ws] message error:`, err);
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
			wss.handleUpgrade(req, socket, head, (client) => wss.emit('connection', client, req));
		} else {
			socket.destroy();
		}
	});

	await new Promise<void>((r) => httpServer.listen(PORT, r));

	const shutdown = async () => {
		activeWs?.close();
		await session.close('shutdown');
		httpServer.close();
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown());
	process.on('SIGTERM', () => void shutdown());

	console.log('============================================================');
	console.log('Voice Agent — Direct RTC (Gemini Live)');
	console.log('============================================================');
	console.log(`  Page:       http://127.0.0.1:${PORT}/`);
	console.log(`  WebSocket:  ws://127.0.0.1:${PORT}/ws`);
	console.log(`  Live model: ${LIVE_MODEL}`);
	console.log(`  Voice:      ${process.env.GEMINI_VOICE ?? 'Puck'}`);
	console.log('  Click Connect, allow mic, then talk.');
}

void main().catch((err) => {
	console.error(err);
	process.exit(1);
});
