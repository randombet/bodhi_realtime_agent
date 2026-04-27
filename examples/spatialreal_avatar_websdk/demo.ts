import 'dotenv/config';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { VoiceSession } from '../../src/core/voice-session.js';
import { OpenAIRealtimeTransport } from '../../src/transport/openai-realtime-transport.js';
import type { MainAgent, ToolDefinition } from '../../src/types/index.js';
import { AvatarDrivingProxy } from './avatar-driving-proxy.js';

const HOST = process.env.HOST || '0.0.0.0';
const VOICE_PORT = Number(process.env.PORT) || 9900;
const TOKEN_PORT = Number(process.env.SPATIALREAL_TOKEN_PORT) || 9901;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const SPATIALREAL_API_KEY = process.env.SPATIALREAL_API_KEY ?? '';
const SPATIALREAL_APP_ID = process.env.SPATIALREAL_APP_ID ?? '';
const SPATIALREAL_AVATAR_ID = process.env.SPATIALREAL_AVATAR_ID ?? '';
const SPATIALREAL_REGION = process.env.SPATIALREAL_REGION ?? 'us-west';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultVenvPython = path.join(
	__dirname,
	'bridge',
	'.venv',
	process.platform === 'win32' ? 'Scripts' : 'bin',
	process.platform === 'win32' ? 'python.exe' : 'python3',
);
const SPATIALREAL_PYTHON = process.env.SPATIALREAL_PYTHON ?? defaultVenvPython;

if (!existsSync(SPATIALREAL_PYTHON)) {
	console.error(
		`Python for SpatialReal bridge not found at ${SPATIALREAL_PYTHON}.
Run:  cd examples/spatialreal_avatar_websdk/bridge && ./setup-venv.sh
Or set SPATIALREAL_PYTHON to your venv’s python3.`,
	);
	process.exit(1);
}

if (!GEMINI_API_KEY) {
	console.error('GEMINI_API_KEY is required');
	process.exit(1);
}
if (!OPENAI_API_KEY) {
	console.error('OPENAI_API_KEY is required');
	process.exit(1);
}
if (!SPATIALREAL_API_KEY) {
	console.error('SPATIALREAL_API_KEY is required');
	process.exit(1);
}
if (!SPATIALREAL_APP_ID || !SPATIALREAL_AVATAR_ID) {
	console.error('SPATIALREAL_APP_ID and SPATIALREAL_AVATAR_ID are required');
	process.exit(1);
}

const google = createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY });

const getCurrentTime: ToolDefinition = {
	name: 'get_current_time',
	description: 'Get current date and time.',
	parameters: z.object({}),
	execution: 'inline',
	execute: async () => ({
		time: new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' }),
	}),
};

const endSession: ToolDefinition = {
	name: 'end_session',
	description: 'End the voice session gracefully.',
	parameters: z.object({}),
	execution: 'inline',
	execute: async (_args, ctx) => {
		setTimeout(() => ctx.sendJsonToClient?.({ type: 'session_end' }), 1500);
		return { status: 'ending' };
	},
};

const mainAgent: MainAgent = {
	name: 'main',
	greeting:
		'Greet the user warmly. Introduce yourself as Bodhi. Say this SpatialReal demo is connected and ask how you can help today.',
	instructions: [
		'You are Bodhi, a concise and friendly realtime voice assistant.',
		'Keep responses under 3 short sentences.',
		'Use get_current_time for time/date questions.',
		'Call end_session when user says goodbye.',
	].join('\n'),
	tools: [getCurrentTime, endSession],
	googleSearch: true,
};

const CONSOLE_HOSTS: Record<string, string> = {
	'us-west': 'https://console.us-west.spatialwalk.cloud',
	'ap-northeast': 'https://console.ap-northeast.spatialwalk.cloud',
};

const consoleHost = CONSOLE_HOSTS[SPATIALREAL_REGION];
if (!consoleHost) {
	console.error(`Unsupported SPATIALREAL_REGION: ${SPATIALREAL_REGION}`);
	process.exit(1);
}

async function createSessionToken(): Promise<string> {
	const expireAt = Math.floor(Date.now() / 1000) + 60 * 60;
	const response = await fetch(`${consoleHost}/v1/console/session-tokens`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Api-Key': SPATIALREAL_API_KEY,
		},
		body: JSON.stringify({
			expireAt,
			modelVersion: '',
		}),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`SpatialReal token request failed (${response.status}): ${text}`);
	}

	const data = (await response.json()) as { sessionToken?: string };
	if (!data.sessionToken) {
		throw new Error('SpatialReal token response did not include sessionToken');
	}
	return data.sessionToken;
}

const tokenServer = createServer(async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

	if (req.method === 'OPTIONS') {
		res.writeHead(204);
		res.end();
		return;
	}

	if (req.url === '/health') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true, region: SPATIALREAL_REGION }));
		return;
	}

	if (req.url === '/api/token' && req.method === 'POST') {
		try {
			const sessionToken = await createSessionToken();
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ sessionToken }));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: message }));
		}
		return;
	}

	res.writeHead(404, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: 'Not found' }));
});

tokenServer.listen(TOKEN_PORT, HOST, () => {
	console.log('============================================================');
	console.log('SpatialReal Avatar Token Backend');
	console.log('============================================================');
	console.log(`Token server: http://${HOST}:${TOKEN_PORT}/api/token`);
	console.log(`Health:       http://${HOST}:${TOKEN_PORT}/health`);
	console.log(`Region:       ${SPATIALREAL_REGION}`);
	console.log(`Bridge python: ${SPATIALREAL_PYTHON}`);
	console.log('============================================================');
});

const wss = new WebSocketServer({ host: HOST, port: VOICE_PORT });
const activeClosers = new Set<() => Promise<void>>();

wss.on('connection', (ws) => {
	const sessionId = `spatialreal_${Date.now()}`;
	console.log(`[Demo] Client connected (${sessionId})`);

	const avatarProxy = new AvatarDrivingProxy({
		apiKey: SPATIALREAL_API_KEY,
		appId: SPATIALREAL_APP_ID,
		avatarId: SPATIALREAL_AVATAR_ID,
		region: SPATIALREAL_REGION as 'us-west' | 'ap-northeast',
		sampleRate: 24000,
		pythonPath: SPATIALREAL_PYTHON,
	});

	let drivingEndTimer: ReturnType<typeof setTimeout> | null = null;
	let drivingEnded = false;

	const closeAll = async () => {
		if (drivingEndTimer) clearTimeout(drivingEndTimer);
		drivingEndTimer = null;
		await Promise.allSettled([session.close('client_disconnected'), avatarProxy.close()]);
		activeClosers.delete(closeAll);
	};
	activeClosers.add(closeAll);

	const session = new VoiceSession({
		sessionId,
		userId: 'spatialreal_demo_user',
		apiKey: GEMINI_API_KEY,
		agents: [mainAgent],
		initialAgent: 'main',
		model: google('gemini-2.5-flash'),
		transport: new OpenAIRealtimeTransport({
			apiKey: OPENAI_API_KEY,
			model: 'gpt-realtime',
			voice: 'coral',
			turnDetection: { type: 'semantic_vad', eagerness: 'medium' },
		}),
		clientSender: {
			sendAudio: (data) => {
				if (ws.readyState === ws.OPEN) ws.send(data);
				avatarProxy.sendAudio(data, false);

				if (drivingEndTimer) clearTimeout(drivingEndTimer);
				if (!drivingEnded) {
					drivingEndTimer = setTimeout(() => {
						drivingEndTimer = null;
						if (!drivingEnded) {
							drivingEnded = true;
							avatarProxy.sendAudio(Buffer.alloc(0), true);
						}
					}, 500);
				}
			},
			sendJson: (message) => {
				if (message.type === 'turn.end') {
					if (drivingEndTimer) clearTimeout(drivingEndTimer);
					drivingEndTimer = null;
					if (!drivingEnded) avatarProxy.sendAudio(Buffer.alloc(0), true);
					drivingEnded = false;
				} else if (message.type === 'turn.interrupted') {
					if (drivingEndTimer) clearTimeout(drivingEndTimer);
					drivingEndTimer = null;
					drivingEnded = false;
					avatarProxy.interrupt();
				}
				if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
			},
		},
	});

	avatarProxy.onFrame = (frameBase64, isLast) => {
		if (ws.readyState !== ws.OPEN) return;
		ws.send(
			JSON.stringify({
				type: 'avatar.keyframes',
				frames: [frameBase64],
				last: isLast,
			}),
		);
	};
	avatarProxy.onError = (message) => {
		console.warn(`[Avatar] ${message}`);
	};

	Promise.all([avatarProxy.start(), session.start()])
		.then(() => {
			session.notifyClientConnected();
			console.log(`[Demo] Session ready (${sessionId})`);
		})
		.catch(async (error) => {
			console.error(`[Demo] Startup failed (${sessionId}):`, error);
			await closeAll();
			if (ws.readyState === ws.OPEN) ws.close(1011, 'startup_failed');
		});

	ws.on('message', (data, isBinary) => {
		try {
			if (isBinary) {
				session.feedAudioFromClient(Buffer.from(data as Buffer));
				return;
			}
			const msg = JSON.parse(String(data)) as Record<string, unknown>;
			session.feedJsonFromClient(msg);
		} catch (error) {
			console.warn('[Demo] Dropped invalid client message', error);
		}
	});

	ws.on('close', async () => {
		console.log(`[Demo] Client disconnected (${sessionId})`);
		session.notifyClientDisconnected();
		await closeAll();
	});
});

console.log('============================================================');
console.log('Bodhi Voice Session + SpatialReal Host Sync');
console.log('============================================================');
console.log(`Voice websocket: ws://${HOST}:${VOICE_PORT}`);
console.log('============================================================');

const shutdown = async () => {
	console.log('\nShutting down SpatialReal demo...');
	wss.close();
	await Promise.allSettled([...activeClosers].map((close) => close()));
	tokenServer.close();
	process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
