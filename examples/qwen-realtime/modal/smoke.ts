/**
 * Smoke-test the Modal-hosted vLLM-Omni /v1/realtime WebSocket.
 *
 *   pnpm tsx examples/qwen-realtime/modal/smoke.ts
 *
 * First connection triggers a Modal cold start (~15 min: model download + load).
 * Subsequent connections within the scaledown window are instant.
 */
import { WebSocket } from 'ws';

const WS_URL =
	process.env.VLLM_WS_URL ??
	'wss://yxz-ucd--qwen3-omni-realtime-serve.modal.run/v1/realtime';
const MODEL = process.env.VLLM_MODEL ?? 'Qwen/Qwen3-Omni-30B-A3B-Instruct';
const TIMEOUT_MS = Number(process.env.VLLM_TIMEOUT_MS ?? 25 * 60 * 1000); // 25 min

const url = `${WS_URL}?model=${encodeURIComponent(MODEL)}`;
console.log(`connecting: ${url}`);
console.log(`timeout: ${(TIMEOUT_MS / 60_000).toFixed(0)} min (allow time for cold start)`);

const t0 = Date.now();
const ws = new WebSocket(url, {
	// vLLM by default has no auth; a dummy bearer is harmless.
	headers: { Authorization: 'Bearer test' },
});

const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let sessionCreated = false;
let sessionUpdated = false;

const timer = setTimeout(() => {
	console.error(`✗ timed out after ${elapsed()}`);
	try {
		ws.close();
	} catch {
		/* noop */
	}
	process.exit(1);
}, TIMEOUT_MS);

ws.on('open', () => {
	console.log(`[${elapsed()}] ✓ socket open — sending session.update`);
	ws.send(
		JSON.stringify({
			type: 'session.update',
			session: {
				modalities: ['text', 'audio'],
				voice: 'default',
				input_audio_format: 'pcm',
				output_audio_format: 'pcm',
				turn_detection: { type: 'server_vad' },
			},
		}),
	);
});

ws.on('message', (raw) => {
	let e: { type?: string; error?: unknown };
	try {
		e = JSON.parse(raw.toString());
	} catch {
		console.log(`[${elapsed()}]   (non-JSON frame, ${raw.length}B)`);
		return;
	}
	const tag = e.type ?? '?';
	if (tag === 'session.created') {
		sessionCreated = true;
		console.log(`[${elapsed()}] ✓ session.created`);
	} else if (tag === 'session.updated') {
		sessionUpdated = true;
		console.log(`[${elapsed()}] ✓ session.updated — vLLM realtime endpoint is live`);
		clearTimeout(timer);
		ws.close();
	} else if (tag === 'error') {
		console.error(`[${elapsed()}] ✗ error: ${JSON.stringify(e.error ?? e)}`);
	} else {
		console.log(`[${elapsed()}]   · ${tag}`);
	}
});

ws.on('error', (err) => {
	console.error(`[${elapsed()}] ws error: ${err.message}`);
});

ws.on('close', (code, reasonBuf) => {
	const reason = reasonBuf?.toString() || '';
	console.log(`[${elapsed()}] socket closed (${code}) ${reason}`.trim());
	clearTimeout(timer);
	const ok = sessionCreated && sessionUpdated;
	console.log(
		`\n${ok ? '✅ PASS' : '❌ FAIL'} — sessionCreated=${sessionCreated} sessionUpdated=${sessionUpdated}`,
	);
	process.exit(ok ? 0 : 1);
});
