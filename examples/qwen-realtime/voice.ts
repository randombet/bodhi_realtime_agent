/**
 * Bodhi — Voice assistant on Qwen Omni Realtime (Alibaba DashScope).
 *
 * Voice-in / voice-out demo using QwenRealtimeTransport + VoiceSession. No tools
 * (see examples/qwen-realtime/tools.ts for the tools/multi-agent demo). Phase 0
 * confirmed server_vad turn-taking and text-seeded greetings on
 * qwen3.5-omni-plus-realtime. Barge-in is framework-owned (nativePlaybackGating
 * arms it through the buffered-playback tail).
 *
 * Usage:
 *   1. Set QWEN_API_KEY (or DASHSCOPE_API_KEY). GEMINI_API_KEY is optional (only
 *      used for subagent text generation — this demo has none).
 *   2. Run: pnpm tsx examples/qwen-realtime/voice.ts
 *   3. Connect a WebSocket audio client to ws://localhost:9900
 *      (e.g. pnpm web-client:dev) and start talking.
 */

import 'dotenv/config';
import { google } from '@ai-sdk/google';
import { VoiceSession } from '../../src/core/voice-session.js';
import { QwenRealtimeTransport } from '../../src/transport/qwen-realtime-transport.js';
import type { MainAgent } from '../../src/types/agent.js';

const QWEN_API_KEY = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
if (!QWEN_API_KEY) {
	console.error('Error: QWEN_API_KEY (or DASHSCOPE_API_KEY) is required');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_ID = `qwen_voice_${Date.now()}`;
const ts = () => new Date().toISOString().slice(11, 23);

const transport = new QwenRealtimeTransport({
	apiKey: QWEN_API_KEY,
	model: 'qwen3.5-omni-plus-realtime',
	// voice omitted → server default (Tina). Set QWEN_VOICE to a validated voice.
	...(process.env.QWEN_VOICE ? { voice: process.env.QWEN_VOICE } : {}),
	turnDetection: { type: 'server_vad' },
});

const mainAgent: MainAgent = {
	name: 'main',
	tools: [],
	greeting:
		'[System: A user just connected. Greet them warmly in one or two short sentences, introduce yourself as Bodhi, a friendly voice assistant, and ask how you can help today.]',
	instructions: `You are Bodhi, a warm and concise voice assistant.
- Keep replies short — one or two sentences per turn.
- Speak plainly and at a measured pace.
- Answer the user's question directly, then ask one simple follow-up.`,
};

async function main() {
	const session = new VoiceSession({
		sessionId: SESSION_ID,
		userId: 'demo_user',
		// Only used for subagent text generation (none in this demo).
		apiKey: process.env.GEMINI_API_KEY ?? '',
		model: google('gemini-2.5-flash'),
		agents: [mainAgent],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		transport,
		// Qwen (like OpenAI) sends response.done at generation end, but the client
		// plays buffered audio after — keep barge-in armed through that tail.
		playbackStateProtocol: 'audio_done',
		nativePlaybackGating: true,
		hooks: {
			onSessionStart: (e) => console.log(`${ts()} [Session] started ${e.sessionId}`),
			onSessionEnd: (e) => console.log(`${ts()} [Session] ended (${e.reason})`),
			onError: (e) => console.error(`${ts()} [Error] ${e.component}: ${e.error.message}`),
		},
	});

	await session.start();
	console.log(`${ts()} Qwen voice session listening on ws://${HOST}:${PORT}`);
}

main().catch((e) => {
	console.error('Fatal:', e);
	process.exit(1);
});
