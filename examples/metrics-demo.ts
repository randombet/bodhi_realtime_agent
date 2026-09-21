/**
 * Metrics Demo — a minimal Gemini voice agent that exposes Prometheus metrics.
 *
 * Wires a MetricsCollector into the session hooks and serves `/metrics` on its
 * own HTTP port (the voice WebSocket owns PORT). This is the server used by the
 * "Run it locally" walkthrough in docs/guide/observability.md.
 *
 * Usage:
 *   1. GEMINI_API_KEY=your_key pnpm tsx examples/metrics-demo.ts
 *   2. In another terminal: pnpm web-client   (open http://localhost:8080)
 *   3. curl -s http://localhost:9464/metrics
 *
 * Environment:
 *   GEMINI_API_KEY  - Required
 *   PORT            - Voice WebSocket port (default: 9900)
 *   METRICS_PORT    - /metrics HTTP port (default: 9464)
 */

import { createServer } from 'node:http';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { VoiceSession } from '../src/index.js';
import type { MainAgent, ToolDefinition } from '../src/index.js';
import { MetricsCollector, createMetricsHandler } from '../src/observability/index.js';

const API_KEY = process.env.GEMINI_API_KEY ?? '';
if (!API_KEY) {
	console.error('Error: set GEMINI_API_KEY');
	process.exit(1);
}
const PORT = Number(process.env.PORT) || 9900;
const HOST = process.env.HOST || '0.0.0.0';
const METRICS_PORT = Number(process.env.METRICS_PORT) || 9464;

/** One inline tool so tool metrics (voice_tool_total) move too — ask "what time is it?". */
const getCurrentTime: ToolDefinition = {
	name: 'get_current_time',
	description: 'Get the current date and time.',
	parameters: z.object({}),
	execution: 'inline',
	execute: async () => ({ now: new Date().toString() }),
};

const assistant: MainAgent = {
	name: 'main',
	greeting: '[System: Greet the user briefly and offer to chat. Keep it short.]',
	instructions:
		'You are a friendly voice assistant. Keep responses concise — this is voice. ' +
		'When asked for the time or date, call get_current_time.',
	tools: [getCurrentTime],
};

async function main() {
	const collector = new MetricsCollector();

	const session = new VoiceSession({
		sessionId: `metrics_demo_${Date.now()}`,
		userId: 'demo_user',
		apiKey: API_KEY,
		agents: [assistant],
		initialAgent: 'main',
		port: PORT,
		host: HOST,
		model: createGoogleGenerativeAI({ apiKey: API_KEY })('gemini-2.5-flash'),
		hooks: collector.hooks, // every metric event flows into the collector
	});

	// The framework owns no HTTP server — mount the handler on our own.
	const metrics = createMetricsHandler(collector);
	const metricsServer = createServer((req, res) => {
		if (req.url === '/metrics') return metrics(req, res);
		res.statusCode = 404;
		res.end('Not found');
	});
	metricsServer.listen(METRICS_PORT, HOST);

	process.on('SIGINT', async () => {
		await session.close('user_hangup');
		metricsServer.close();
		process.exit(0);
	});

	await session.start();

	console.log('\n  Bodhi — Metrics Demo');
	console.log(`  Voice WebSocket:  ws://localhost:${PORT}`);
	console.log(`  Metrics:          http://localhost:${METRICS_PORT}/metrics`);
	console.log('\n  Talk to it with `pnpm web-client`, then watch the metrics move.');
	console.log('  Press Ctrl+C to stop.\n');
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
