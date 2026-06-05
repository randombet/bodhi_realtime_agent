/**
 * Smoke-test the Modal-hosted vLLM-Omni /v1/realtime WebSocket.
 *
 *   pnpm tsx examples/qwen-realtime/modal/smoke.ts
 *
 * First connection triggers a Modal cold start (~5 min on H100 with weights
 * cached in the hf-cache volume). Subsequent connects within the scaledown
 * window are instant.
 *
 * Protocol (vLLM realtime, per vllm/entrypoints/speech_to_text/realtime/):
 *   1. Server sends `session.created` on connect.
 *   2. Client sends `{type: "session.update", model: <id>}` — `model` is a
 *      TOP-LEVEL field (NOT nested in a `session` object), and it is the only
 *      field the server reads. This is where vLLM diverges from DashScope,
 *      which takes `model` only in the URL.
 *   3. The server does NOT emit a `session.updated` ack — on success it just
 *      marks the model validated and waits for audio. So "the endpoint is live
 *      and accepted our model" is proven by: session.created received +
 *      session.update sent + no `error` within a short grace window.
 *
 * Driving actual transcription/speech-out (input_audio_buffer.append/commit →
 * transcription.delta/done) is beyond this smoke check.
 */
import { WebSocket } from 'ws';

const WS_URL =
	process.env.VLLM_WS_URL ?? 'wss://yxz-ucd--qwen3-omni-realtime-serve.modal.run/v1/realtime';
const MODEL = process.env.VLLM_MODEL ?? 'Qwen/Qwen3-Omni-30B-A3B-Instruct';
const TIMEOUT_MS = Number(process.env.VLLM_TIMEOUT_MS ?? 25 * 60 * 1000); // 25 min
// No session.updated ack exists; treat "no error N ms after session.update" as success.
const GRACE_MS = Number(process.env.VLLM_GRACE_MS ?? 8_000);

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
let sessionUpdateSent = false;
let updateAccepted = false;
let errored = false;
let graceTimer: ReturnType<typeof setTimeout> | undefined;

const timer = setTimeout(() => {
	console.error(`✗ timed out after ${elapsed()}`);
	try {
		ws.close();
	} catch {
		/* noop */
	}
	process.exit(1);
}, TIMEOUT_MS);

function sendSessionUpdate() {
	if (sessionUpdateSent) return;
	sessionUpdateSent = true;
	console.log(`[${elapsed()}] → session.update (model only)`);
	// model is the only field the server reads; top-level, not nested.
	ws.send(JSON.stringify({ type: 'session.update', model: MODEL }));
	// No ack event: if no error arrives within the grace window, the model was
	// accepted and the endpoint is live.
	graceTimer = setTimeout(() => {
		if (errored) return;
		updateAccepted = true;
		console.log(
			`[${elapsed()}] ✓ session.update accepted (no error in ${GRACE_MS} ms) — endpoint live`,
		);
		clearTimeout(timer);
		ws.close();
	}, GRACE_MS);
}

ws.on('open', () => {
	console.log(`[${elapsed()}] ✓ socket open — waiting for session.created`);
});

ws.on('message', (raw) => {
	let e: { type?: string; error?: unknown };
	const text = raw.toString();
	try {
		e = JSON.parse(text);
	} catch {
		console.log(`[${elapsed()}]   (non-JSON frame, ${text.length}B)`);
		return;
	}
	const tag = e.type ?? '?';
	if (tag === 'session.created') {
		sessionCreated = true;
		console.log(`[${elapsed()}] ✓ session.created`);
		sendSessionUpdate();
	} else if (tag === 'session.updated') {
		// Not part of the documented flow, but accept it as an explicit ack.
		updateAccepted = true;
		console.log(`[${elapsed()}] ✓ session.updated (explicit ack)`);
		clearTimeout(graceTimer);
		clearTimeout(timer);
		ws.close();
	} else if (tag === 'error') {
		errored = true;
		clearTimeout(graceTimer);
		console.error(`[${elapsed()}] ✗ error: ${JSON.stringify(e.error ?? e)}`);
		clearTimeout(timer);
		ws.close();
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
	clearTimeout(graceTimer);
	const ok = sessionCreated && updateAccepted && !errored;
	console.log(
		`\n${ok ? '✅ PASS' : '❌ FAIL'} — sessionCreated=${sessionCreated} updateAccepted=${updateAccepted} errored=${errored}`,
	);
	process.exit(ok ? 0 : 1);
});
