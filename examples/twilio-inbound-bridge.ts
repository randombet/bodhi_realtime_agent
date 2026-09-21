/**
 * Twilio Inbound Call Bridge
 *
 * Standalone protocol translator that connects inbound phone calls to any
 * VoiceSession-based agent. The bridge makes a phone caller appear as a
 * regular WebSocket client to VoiceSession.
 *
 * Phone (PSTN) → Twilio → Bridge (:8766) → VoiceSession (:9900) → Gemini
 *
 * Usage:
 *   1. Start the server (pnpm start) or any demo agent
 *   2. Start ngrok: ngrok http 8766
 *   3. Set TWILIO_WEBHOOK_URL to the ngrok URL
 *   4. Configure your Twilio phone number's webhook to https://…/voice
 *   5. Run: pnpm tsx examples/twilio-inbound-bridge.ts
 *   6. Call your Twilio number from any phone
 *
 * Environment Variables:
 *   TWILIO_WEBHOOK_URL   - Required: public ngrok URL
 *   TWILIO_WEBHOOK_PORT  - Bridge port (default: 8766)
 *   AGENT_WS_URL         - VoiceSession WebSocket URL (default: ws://localhost:9900)
 */

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { frameworkToTwilio, twilioToFramework } from '../src/telephony/audio-codec.js';

// =============================================================================
// Configuration
// =============================================================================

const WEBHOOK_URL = process.env.TWILIO_WEBHOOK_URL ?? '';
if (!WEBHOOK_URL) {
	console.error('Error: TWILIO_WEBHOOK_URL environment variable is required');
	process.exit(1);
}

const WEBHOOK_PORT = Number(process.env.TWILIO_WEBHOOK_PORT) || 8766;
const AGENT_WS_URL = process.env.AGENT_WS_URL || 'ws://localhost:9900';
const MIN_OUTPUT_SAMPLE_RATE = 8000;
const MAX_OUTPUT_SAMPLE_RATE = 96000;

// Terminal call statuses that end a call (matches TwilioBridge terminal set)
const TERMINAL_STATUSES = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);

// =============================================================================
// State
// =============================================================================

let activeCallNonce: string | null = null;
let activeCallSid: string | null = null;
let streamSid: string | null = null;
let outputSampleRate = 24000;
let twilioWs: WebSocket | null = null;
let agentWs: WebSocket | null = null;
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

function resetCallState(): void {
	activeCallNonce = null;
	activeCallSid = null;
	streamSid = null;
	outputSampleRate = 24000;
	if (cleanupTimer) {
		clearTimeout(cleanupTimer);
		cleanupTimer = null;
	}
	if (
		agentWs &&
		(agentWs.readyState === WebSocket.OPEN || agentWs.readyState === WebSocket.CONNECTING)
	) {
		agentWs.close(1000, 'Call ended');
	}
	agentWs = null;
	twilioWs = null;
}

function sendTwilioClear(reason: string): void {
	if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN || !streamSid) return;

	twilioWs.send(
		JSON.stringify({
			event: 'clear',
			streamSid,
		}),
	);
	console.log(`${ts()} [Twilio] Sent clear (${reason})`);
}

// =============================================================================
// HTTP Server (Twilio-facing)
// =============================================================================

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
	const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

	const path = url.pathname.replace(/\/+$/, ''); // strip trailing slash

	if (req.method === 'POST' && path === '/voice') {
		handleVoice(res);
		return;
	}

	if (req.method === 'POST' && path === '/status') {
		handleStatus(req, res);
		return;
	}

	res.writeHead(404);
	res.end('Not Found');
});

function handleVoice(res: ServerResponse): void {
	// Single-call gating
	if (activeCallNonce) {
		console.log(`${ts()} [Bridge] Rejecting call — another call is active`);
		res.writeHead(200, { 'Content-Type': 'text/xml' });
		res.end('<?xml version="1.0" encoding="UTF-8"?>\n<Response><Reject reason="busy"/></Response>');
		return;
	}

	// Generate per-call nonce for WS auth
	activeCallNonce = randomBytes(16).toString('hex');
	const wsUrl = `${WEBHOOK_URL.replace(/^http/, 'ws')}/twilio/media`;

	const twiml = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<Response>',
		'  <Connect>',
		`    <Stream url="${wsUrl}">`,
		`      <Parameter name="auth" value="${activeCallNonce}" />`,
		'    </Stream>',
		'  </Connect>',
		'</Response>',
	].join('\n');

	console.log(`${ts()} [Bridge] Incoming call → returning TwiML with stream URL`);
	res.writeHead(200, { 'Content-Type': 'text/xml' });
	res.end(twiml);
}

function handleStatus(req: IncomingMessage, res: ServerResponse): void {
	let body = '';
	req.on('data', (chunk) => {
		body += chunk;
	});
	req.on('end', () => {
		const params = new URLSearchParams(body);
		const callSid = params.get('CallSid') ?? '';
		const callStatus = params.get('CallStatus') ?? '';

		console.log(`${ts()} [Bridge] Status: ${callStatus} (CallSid=${callSid})`);

		// Track CallSid on first status
		if (callStatus === 'initiated' && !activeCallSid) {
			activeCallSid = callSid;
		}

		// Clear state on terminal status (only if it matches our active call)
		if (TERMINAL_STATUSES.has(callStatus) && (!activeCallSid || callSid === activeCallSid)) {
			console.log(`${ts()} [Bridge] Call ended (status=${callStatus})`);
			resetCallState();
		}

		res.writeHead(200);
		res.end();
	});
}

// =============================================================================
// WebSocket Server (Twilio Media Streams)
// =============================================================================

const wss = new WebSocketServer({ server: httpServer, path: '/twilio/media' });

wss.on('connection', (ws: WebSocket) => {
	let authenticated = false;

	ws.on('message', (data) => {
		try {
			const msg = JSON.parse(data.toString());

			switch (msg.event) {
				case 'connected':
					console.log(`${ts()} [Twilio] Media Stream connected`);
					break;

				case 'start': {
					const startMsg = msg.start as Record<string, unknown> | undefined;
					const customParams = startMsg?.customParameters as Record<string, string> | undefined;
					const authToken = customParams?.auth;

					// Validate nonce
					if (!activeCallNonce || authToken !== activeCallNonce) {
						console.log(`${ts()} [Twilio] Auth failed — closing stream`);
						ws.close(4001, 'Unauthorized');
						return;
					}

					authenticated = true;
					twilioWs = ws;
					streamSid = (startMsg?.streamSid as string) ?? null;
					console.log(`${ts()} [Twilio] Stream started (streamSid=${streamSid})`);

					// Connect to VoiceSession
					connectToAgent();
					break;
				}

				case 'media': {
					if (!authenticated || !agentWs || agentWs.readyState !== WebSocket.OPEN) return;
					const media = msg.media as Record<string, unknown> | undefined;
					const payload = media?.payload;
					if (typeof payload === 'string') {
						// mulaw 8kHz → PCM 16kHz → binary frame to VoiceSession
						const pcm = twilioToFramework(payload);
						agentWs.send(pcm);
					}
					break;
				}

				case 'stop':
					console.log(`${ts()} [Twilio] Stream stopped`);
					resetCallState();
					break;

				case 'mark':
					// Acknowledged and ignored
					break;
			}
		} catch {
			// Ignore malformed messages
		}
	});

	ws.on('close', () => {
		if (ws === twilioWs) {
			console.log(`${ts()} [Twilio] Media Stream WebSocket closed`);
			resetCallState();
		}
	});
});

// =============================================================================
// WebSocket Client (VoiceSession-facing)
// =============================================================================

function connectToAgent(): void {
	console.log(`${ts()} [Agent] Connecting to ${AGENT_WS_URL}...`);

	const ws = new WebSocket(AGENT_WS_URL);
	agentWs = ws;

	ws.on('open', () => {
		console.log(`${ts()} [Agent] Connected to VoiceSession`);
	});

	ws.on('message', (data, isBinary) => {
		if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) return;

		if (isBinary) {
			// PCM audio from VoiceSession → mulaw → Twilio
			const pcmBuffer = data as Buffer;
			const mulawBase64 = frameworkToTwilio(pcmBuffer, outputSampleRate);
			twilioWs.send(
				JSON.stringify({
					event: 'media',
					streamSid: streamSid ?? '',
					media: { payload: mulawBase64 },
				}),
			);
		} else {
			// Text frame — parse for session.config, log transcripts
			try {
				const msg = JSON.parse(data.toString());
				if (msg.type === 'session.config' && msg.audioFormat?.outputSampleRate) {
					const candidateRate = Number(msg.audioFormat.outputSampleRate);
					const isValidRate =
						Number.isFinite(candidateRate) &&
						candidateRate >= MIN_OUTPUT_SAMPLE_RATE &&
						candidateRate <= MAX_OUTPUT_SAMPLE_RATE;
					if (!isValidRate) {
						console.warn(
							`${ts()} [Agent] Ignoring invalid outputSampleRate: ${msg.audioFormat.outputSampleRate}`,
						);
						return;
					}

					const newRate = Math.round(candidateRate);
					if (newRate !== outputSampleRate) {
						console.log(
							`${ts()} [Agent] Output sample rate updated: ${outputSampleRate} → ${newRate}`,
						);
						outputSampleRate = newRate;
					}
				} else if (msg.type === 'turn.interrupted') {
					// VoiceSession detected barge-in; flush any queued Twilio playback immediately.
					sendTwilioClear('voice-session interrupted');
				} else if (msg.type === 'transcript') {
					const role = msg.role ?? '?';
					const text = msg.text ?? '';
					const partial = msg.partial ? ' (partial)' : '';
					console.log(`${ts()} [Transcript] [${role}]${partial} ${text}`);
				}
			} catch {
				// Ignore non-JSON text frames
			}
		}
	});

	ws.on('close', (code, reason) => {
		console.log(
			`${ts()} [Agent] VoiceSession WebSocket closed (code=${code} reason="${reason.toString()}")`,
		);

		if (ws !== agentWs) return;
		agentWs = null;

		// Close Twilio stream if still open
		if (twilioWs && twilioWs.readyState === WebSocket.OPEN) {
			twilioWs.close(1000, 'Agent disconnected');
			// Check for terminal state within 5s
			cleanupTimer = setTimeout(() => {
				if (activeCallNonce) {
					console.warn(
						`${ts()} [Bridge] Warning: no terminal call state received within 5s after agent disconnect`,
					);
					resetCallState();
				}
			}, 5000);
		}
	});

	ws.on('error', (err: Error & { code?: string }) => {
		console.error(`${ts()} [Agent] WebSocket error: ${err.message || err.code || err}`);
		// Close Twilio stream — call will end
		if (twilioWs && twilioWs.readyState === WebSocket.OPEN) {
			twilioWs.close(1011, 'Agent unavailable');
		}
		resetCallState();
	});
}

// =============================================================================
// Start
// =============================================================================

httpServer.listen(WEBHOOK_PORT, '0.0.0.0', () => {
	console.log('============================================================');
	console.log('Twilio Inbound Call Bridge');
	console.log('============================================================');
	console.log();
	console.log(`  Webhook server:  http://localhost:${WEBHOOK_PORT}`);
	console.log(`  Public URL:      ${WEBHOOK_URL}`);
	console.log(`  Agent WS:        ${AGENT_WS_URL}`);
	console.log();
	console.log('Configure your Twilio phone number webhook:');
	console.log(`  URL: ${WEBHOOK_URL}/voice`);
	console.log('  Method: POST');
	console.log(`  Status Callback URL: ${WEBHOOK_URL}/status`);
	console.log('  Status Callback Events: initiated, ringing, answered, completed');
	console.log();
	console.log('Then call your Twilio number from any phone.');
	console.log('Press Ctrl+C to stop.');
	console.log('============================================================');
});

// Graceful shutdown
const shutdown = () => {
	console.log(`\n${ts()} Shutting down...`);
	resetCallState();
	wss.close();
	httpServer.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
