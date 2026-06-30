#!/usr/bin/env node
/**
 * Starts ngrok for the app HTTP port, reads the public HTTPS URL from the local
 * ngrok API, then runs the production server with Twilio env set.
 *
 * Requires: ngrok on PATH, GEMINI_API_KEY in env (e.g. from .env via shell).
 *
 * Usage: pnpm start:twilio-local
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

const PORT = Number(process.env.PORT) || 9900;
const NGROK_API = 'http://127.0.0.1:4040/api/tunnels';
const MAX_WAIT_MS = 30_000;
const POLL_MS = 400;

function pickHttpsUrl(tunnels) {
	if (!Array.isArray(tunnels)) return null;
	const https = tunnels.find((t) => t.proto === 'https');
	if (https?.public_url) return https.public_url.replace(/\/$/, '');
	const http = tunnels.find((t) => t.proto === 'http');
	if (http?.public_url) return http.public_url.replace(/\/$/, '');
	return null;
}

async function fetchPublicUrl() {
	const res = await fetch(NGROK_API);
	if (!res.ok) throw new Error(`ngrok API ${res.status}`);
	const data = await res.json();
	return pickHttpsUrl(data.tunnels);
}

async function waitForNgrokUrl() {
	const start = Date.now();
	while (Date.now() - start < MAX_WAIT_MS) {
		try {
			const url = await fetchPublicUrl();
			if (url) return url;
		} catch {
			// ngrok not ready yet
		}
		await delay(POLL_MS);
	}
	throw new Error('Timed out waiting for ngrok tunnel URL (is ngrok running?)');
}

console.log(`[start-with-ngrok] Tunneling port ${PORT}…`);

const ngrok = spawn('ngrok', ['http', String(PORT)], {
	stdio: ['ignore', 'pipe', 'pipe'],
	env: process.env,
});

ngrok.stderr?.on('data', (chunk) => process.stderr.write(chunk));
ngrok.stdout?.on('data', (chunk) => process.stdout.write(chunk));

ngrok.on('error', (err) => {
	console.error('[start-with-ngrok] Failed to start ngrok:', err.message);
	console.error('Install ngrok: https://ngrok.com/download');
	process.exit(1);
});

let publicUrl;
try {
	publicUrl = await waitForNgrokUrl();
} catch (e) {
	console.error('[start-with-ngrok]', e.message);
	ngrok.kill('SIGTERM');
	process.exit(1);
}

const base = publicUrl.replace(/\/$/, '');
process.env.TWILIO_INBOUND_ENABLED = 'true';
process.env.TWILIO_WEBHOOK_URL = base;

console.log('\n[start-with-ngrok] Public base URL:', base);
console.log('\nTwilio Console → your number → Voice configuration:');
console.log('  A call comes in:     Webhook  POST  ', `${base}/twilio/voice`);
console.log('  Call status changes: Webhook  POST  ', `${base}/twilio/status`);
console.log('\n[start-with-ngrok] Starting app server…\n');

const server = spawn('pnpm', ['exec', 'tsx', 'app/server/index.ts'], {
	stdio: 'inherit',
	env: process.env,
	cwd: rootDir,
});

function shutdown() {
	server.kill('SIGTERM');
	ngrok.kill('SIGTERM');
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('exit', (code) => {
	ngrok.kill('SIGTERM');
	process.exit(code ?? 0);
});
