#!/usr/bin/env node
/**
 * Local dev: ensure ngrok -> :PORT, read public HTTPS URL from ngrok's local API,
 * then start the production server with TWILIO_WEBHOOK_URL set.
 *
 * If ngrok is already running and tunneling to this PORT, reuses it (no second ngrok).
 * Ctrl+C stops the server; ngrok is only stopped if this script started it.
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = process.env.PORT || '9900';
const NGROK_API = 'http://127.0.0.1:4040/api/tunnels';

function tunnelUrlForPort(tunnels, port) {
	for (const t of tunnels ?? []) {
		if (t.proto !== 'https' || !t.public_url) continue;
		const addr = String(t.config?.addr ?? '');
		if (addr.includes(`:${port}`) || addr.endsWith(port)) {
			return t.public_url;
		}
	}
	return null;
}

async function fetchTunnelUrlForPort() {
	try {
		const res = await fetch(NGROK_API);
		if (!res.ok) return null;
		const data = await res.json();
		return tunnelUrlForPort(data.tunnels, PORT);
	} catch {
		return null;
	}
}

async function waitForTunnelAfterSpawn(maxAttempts = 60) {
	for (let i = 0; i < maxAttempts; i++) {
		const url = await fetchTunnelUrlForPort();
		if (url) return url;
		await delay(250);
	}
	return null;
}

let ngrokProc = null;
let weStartedNgrok = false;
let server = null;

function shutdown(code = 0) {
	if (server && !server.killed) server.kill('SIGTERM');
	if (weStartedNgrok && ngrokProc && !ngrokProc.killed) ngrokProc.kill('SIGTERM');
	setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(0));

let publicUrl = await fetchTunnelUrlForPort();

if (publicUrl) {
	console.log('[start-with-ngrok] Reusing existing ngrok tunnel ->', `localhost:${PORT}`);
} else {
	ngrokProc = spawn('ngrok', ['http', PORT], {
		stdio: ['ignore', 'inherit', 'inherit'],
	});

	ngrokProc.on('error', (err) => {
		console.error('[start-with-ngrok] Failed to start ngrok:', err.message);
		console.error('Install ngrok: https://ngrok.com/download');
		process.exit(1);
	});

	ngrokProc.on('exit', (code, signal) => {
		if (!weStartedNgrok) return;
		if (signal === 'SIGTERM' || code === 0) return;
		console.error('[start-with-ngrok] ngrok exited', code, signal);
		if (server && !server.killed) server.kill('SIGTERM');
		process.exit(code ?? 1);
	});

	weStartedNgrok = true;
	publicUrl = await waitForTunnelAfterSpawn();
	if (!publicUrl) {
		console.error('[start-with-ngrok] Could not read ngrok URL from', NGROK_API);
		console.error('After ngrok starts, it should tunnel to port', PORT);
		if (ngrokProc && !ngrokProc.killed) ngrokProc.kill('SIGTERM');
		process.exit(1);
	}
}

console.log('');
console.log('══════════════════════════════════════════════════════════════════════════════');
console.log('  PHONE LOCAL TEST — Point Twilio at this ngrok URL (Active Number → Voice):');
console.log('  A call comes in     → POST', `${publicUrl}/twilio/voice`);
console.log('  Call status changes → POST', `${publicUrl}/twilio/status`);
console.log('');
console.log('  Then call your Twilio number from your phone.');
console.log('  Watch for events: twilio.call.incoming → twilio.media.* → twilio.session.ready');
console.log('  First speech path: twilio.media.first_inbound / twilio.media.first_outbound');
console.log('══════════════════════════════════════════════════════════════════════════════');
console.log('');

server = spawn('pnpm', ['exec', 'tsx', 'app/server/index.ts'], {
	stdio: 'inherit',
	cwd: process.cwd(),
	env: {
		...process.env,
		TWILIO_WEBHOOK_URL: publicUrl,
		TWILIO_INBOUND_ENABLED: process.env.TWILIO_INBOUND_ENABLED || 'true',
		LOG_LEVEL: process.env.LOG_LEVEL || 'debug',
	},
});

server.on('exit', (code) => {
	if (weStartedNgrok && ngrokProc && !ngrokProc.killed) ngrokProc.kill('SIGTERM');
	process.exit(code ?? 0);
});
