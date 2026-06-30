/**
 * Standard Agent — local demo
 *
 * A standalone, single-user demo that imports the production `standard` profile
 * agents (`standardMainAgent` / `mathExpertAgent`) and wires the hosted-only
 * helpers locally. It reuses the exact same agent objects, tools, and media
 * subagents the hosted server compiles, so the voice behavior matches the real
 * "Standard agent" contact card.
 *
 * Functionality (mirrors the standard profile):
 *   - Main agent "Bodhi": Google Search, calculator, current time, speech speed,
 *     image generation, video generation, image analysis (read uploaded image),
 *     end session, and hand-off to a math expert.
 *   - "math_expert" agent: calculator + transfer back to main.
 *   - Media subagents: generate_image (Gemini), generate_video (Veo),
 *     read_image (Gemini vision).
 *
 * Two things the hosted platform injects automatically are wired here by hand:
 *   - `set_speech_speed` — via the `speechSpeed()` behavior preset.
 *   - `list_artifacts`   — required so `read_image` can find uploaded images.
 *
 * Usage:
 *   export GEMINI_API_KEY="your-google-ai-studio-key"
 *   pnpm tsx examples/standard-agent/standard-agent-demo.ts
 *   # In another terminal (reuses the generic web client):
 *   pnpm tsx examples/openclaw/web-client.ts
 *   # Open http://localhost:8080 and click Connect.
 *
 * Environment Variables:
 *   GEMINI_API_KEY  - Required: Google AI Studio API key
 *   PORT            - Voice agent WebSocket port (default: 9900)
 *   HOST            - Voice agent bind address (default: 0.0.0.0)
 */

import 'dotenv/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import {
	createImageReaderSubagent,
	createImageSubagent,
	createVideoSubagent,
} from '../../app/agents/bodhi-subagents.js';
import { mathExpertAgent, standardMainAgent } from '../../app/agents/profiles/standard.js';
import { createListArtifactsTool } from '../../app/agents/tools/common-tools.js';
import { ArtifactRegistry } from '../../app/lib/media/artifact-registry.js';
import { speechSpeed } from '../../src/behaviors/presets.js';
import { VoiceSession } from '../../src/core/voice-session.js';
import { GeminiBatchSTTProvider } from '../../src/transport/gemini-batch-stt-provider.js';
import type { MainAgent } from '../../src/types/agent.js';

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

const API_KEY = process.env.GEMINI_API_KEY ?? '';
if (API_KEY.length === 0) {
	console.error('Error: GEMINI_API_KEY environment variable is required');
	process.exit(1);
}

const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_ID = `session_${Date.now()}`;
// Latency experiment: half-cascade live model instead of the production
// `standard` default (`gemini-2.5-flash-native-audio-preview-12-2025`).
// Everything else (STT provider, VAD default, googleSearch) is unchanged so
// the live model is the only variable.
const LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const google = createGoogleGenerativeAI({ apiKey: API_KEY });

async function main() {
	// Per-session binary store shared by generate_image / read_image / list_artifacts.
	const artifactRegistry = new ArtifactRegistry();

	// Mutable ref so the media subagents can publish gui.update events on the session.
	let sessionRef: VoiceSession | null = null;
	const getSessionRef = () => sessionRef;

	// Reuse the production standard profile agents verbatim. The only addition is
	// `list_artifacts`, which the hosted platform injects automatically and which
	// `read_image` depends on to resolve an uploaded image's artifact id.
	const mainAgent: MainAgent = {
		...standardMainAgent,
		tools: [...standardMainAgent.tools, createListArtifactsTool(artifactRegistry)],
	};

	const session = new VoiceSession({
		sessionId: SESSION_ID,
		userId: 'demo_user',
		apiKey: API_KEY,
		agents: [mainAgent, mathExpertAgent],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		model: google('gemini-2.5-flash'),
		orchestrationMode: 'actor',
		artifactRegistry,
		behaviors: [speechSpeed()],
		subagentConfigs: {
			generate_image: createImageSubagent(API_KEY, getSessionRef, artifactRegistry),
			generate_video: createVideoSubagent(API_KEY, getSessionRef),
			read_image: createImageReaderSubagent(API_KEY, artifactRegistry),
		},
		geminiModel: LIVE_MODEL,
		// Watchdog-stall recovery (R6 validation): retain the last utterance and
		// replay it on a stall — in-place first, reconnect+replay as escalation.
		// Dark by default framework-wide; this demo opts in for live validation.
		watchdogReplayRecovery: true,
		// Latency experiment #2: tighter endpointing (default is silenceDurationMs=500).
		// 200ms makes Gemini commit the user turn sooner after they stop speaking.
		realtimeInputConfig: {
			automaticActivityDetection: {
				endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
				silenceDurationMs: 200,
			},
		},
		sttProvider: new GeminiBatchSTTProvider({ apiKey: API_KEY, model: 'gemini-3-flash-preview' }),
		speechConfig: { voiceName: 'Puck' },
		hooks: {
			onSessionStart: (event) => console.log(`${ts()} [Session] Started: ${event.sessionId}`),
			onSessionEnd: (event) =>
				console.log(`${ts()} [Session] Ended: ${event.sessionId} (${event.reason})`),
			onToolCall: (event) =>
				console.log(`${ts()} [Hook] Tool called: ${event.toolName} (${event.execution})`),
			onError: (event) =>
				console.error(`${ts()} [Error] ${event.component}: ${event.error.message}`),
		},
	});

	sessionRef = session;

	const shutdown = async () => {
		console.log(`\n${ts()} Shutting down...`);
		await session.close('user_hangup');
		artifactRegistry.dispose();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	await session.start();

	console.log('============================================================');
	console.log('Bodhi Standard Agent — local demo');
	console.log('============================================================');
	console.log();
	console.log(`  Voice agent:  ws://localhost:${PORT}`);
	console.log(`  Session ID:   ${SESSION_ID}`);
	console.log();
	console.log('Start the web client in another terminal:');
	console.log('  pnpm tsx examples/openclaw/web-client.ts');
	console.log();
	console.log('Then open http://localhost:8080 and try saying:');
	console.log("  - 'What is the weather in San Francisco?'  (Google Search)");
	console.log("  - 'What is the square root of 1764?'        (calculator)");
	console.log("  - 'Please speak more slowly'                (set_speech_speed)");
	console.log("  - 'Draw me a picture of a sunset'           (generate_image)");
	console.log("  - 'Make a short video of ocean waves'       (generate_video)");
	console.log("  - upload a photo, then 'What is in this image?'  (read_image)");
	console.log("  - 'I have a hard math problem'              (transfer to math_expert)");
	console.log("  - 'Goodbye'                                 (end_session)");
	console.log();
	console.log('Press Ctrl+C to stop.');
	console.log('============================================================');
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
