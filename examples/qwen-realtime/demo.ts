/**
 * Qwen Omni Realtime — connectivity smoke test (Alibaba DashScope, Singapore)
 *
 * Standalone protocol probe (no framework deps) that verifies the
 * qwen3.5-omni-plus-realtime model is reachable and behaves as documented:
 *   https://www.alibabacloud.com/help/en/model-studio/realtime
 *
 * It does two things:
 *   1. Connects to the Singapore WSS endpoint, authenticates, and sends
 *      `session.update` — confirming endpoint + API key + model name are valid.
 *   2. Runs ONE manual-mode turn: generates a spoken prompt with macOS `say`
 *      + `ffmpeg` (16 kHz mono PCM), streams it via `input_audio_buffer.append`,
 *      commits, requests a response, then collects the audio + transcript and
 *      writes the reply to a WAV file you can play with `afplay`.
 *
 * If `say`/`ffmpeg` are unavailable, step 2 is skipped (step 1 still validates
 * the connection).
 *
 * Usage:
 *   QWEN_API_KEY must be set (it's in ~/.zshrc). Then:
 *     pnpm tsx examples/qwen-realtime/demo.ts
 *     pnpm tsx examples/qwen-realtime/demo.ts "What is the capital of France?"
 *
 * Env overrides:
 *   QWEN_API_KEY        (required)  DashScope API key (or DASHSCOPE_API_KEY)
 *   QWEN_REALTIME_URL   default wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
 *   QWEN_REALTIME_MODEL default qwen3.5-omni-plus-realtime
 *   QWEN_VOICE          default: omit → server picks its default voice
 *                       (the documented "Cherry" is rejected by this model)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const API_KEY = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
if (!API_KEY) {
	console.error(
		'Error: QWEN_API_KEY (or DASHSCOPE_API_KEY) is required (it lives in ~/.zshrc — run this from your shell).',
	);
	process.exit(1);
}

const BASE_URL =
	process.env.QWEN_REALTIME_URL ?? 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime';
const MODEL = process.env.QWEN_REALTIME_MODEL ?? 'qwen3.5-omni-plus-realtime';
const VOICE = process.env.QWEN_VOICE ?? ''; // empty → let the server pick its default voice
const PROMPT =
	process.argv[2] ?? 'Hello! In one short sentence, what model are you and what can you do?';

const IN_RATE = 16_000; // Qwen input: 16-bit mono PCM @ 16 kHz
const OUT_RATE = 24_000; // Qwen output: 16-bit mono PCM @ 24 kHz
const CHUNK_BYTES = 3_200; // 100 ms @ 16 kHz / 16-bit / mono
const TIMEOUT_MS = 45_000;

/** Generate 16 kHz mono s16le PCM from text via macOS `say` + `ffmpeg`. Returns null if tools are missing. */
function synthPromptPcm(text: string): Buffer | null {
	const aiff = join(tmpdir(), 'qwen_in.aiff');
	const pcm = join(tmpdir(), 'qwen_in.pcm');
	try {
		execFileSync('say', ['-o', aiff, text], { stdio: 'ignore' });
		execFileSync(
			'ffmpeg',
			['-y', '-i', aiff, '-ar', String(IN_RATE), '-ac', '1', '-f', 's16le', pcm],
			{
				stdio: 'ignore',
			},
		);
		return readFileSync(pcm);
	} catch {
		return null;
	}
}

/** Wrap raw s16le mono PCM in a minimal WAV container. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
	const header = Buffer.alloc(44);
	const byteRate = sampleRate * 2; // mono, 16-bit
	header.write('RIFF', 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16); // PCM fmt chunk size
	header.writeUInt16LE(1, 20); // audio format = PCM
	header.writeUInt16LE(1, 22); // channels
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(2, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write('data', 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
	ws.send(JSON.stringify(msg));
}

const url = `${BASE_URL}?model=${encodeURIComponent(MODEL)}`;
console.log(`→ connecting: ${url}`);
console.log(`→ model: ${MODEL}  voice: ${VOICE || '(server default)'}`);

const ws = new WebSocket(url, {
	headers: { Authorization: `Bearer ${API_KEY}` },
});

const audioOut: Buffer[] = [];
let transcript = '';
let sessionReady = false;

const timeout = setTimeout(() => {
	console.error(`\n✗ timed out after ${TIMEOUT_MS / 1000}s with no response.done`);
	ws.close();
	process.exit(1);
}, TIMEOUT_MS);

function finish(code: number): void {
	clearTimeout(timeout);
	if (audioOut.length > 0) {
		const pcm = Buffer.concat(audioOut);
		const out = join(tmpdir(), 'qwen-realtime-output.wav');
		writeFileSync(out, pcmToWav(pcm, OUT_RATE));
		console.log(`\n♪ wrote ${(pcm.length / 1024).toFixed(1)} KiB of audio → ${out}`);
		console.log(`  play it:  afplay ${out}`);
	}
	if (transcript) console.log(`\n💬 model transcript: ${transcript.trim()}`);
	try {
		ws.close();
	} catch {
		/* noop */
	}
	process.exit(code);
}

ws.on('open', () => {
	console.log('✓ socket open — sending session.update');
	send(ws, {
		type: 'session.update',
		session: {
			modalities: ['text', 'audio'],
			...(VOICE ? { voice: VOICE } : {}),
			input_audio_format: 'pcm',
			output_audio_format: 'pcm',
			instructions: 'You are a concise, friendly assistant. Keep answers to one or two sentences.',
			turn_detection: null, // manual mode: we explicitly commit + request a response
		},
	});
});

ws.on('message', (raw) => {
	let evt: { type?: string; [k: string]: unknown };
	try {
		evt = JSON.parse(raw.toString());
	} catch {
		console.log('  (non-JSON frame)');
		return;
	}
	const type = evt.type ?? '(no type)';

	switch (type) {
		case 'session.created':
			console.log('✓ session.created');
			break;
		case 'session.updated': {
			if (sessionReady) break;
			sessionReady = true;
			console.log('✓ session.updated — connection + auth + model name all valid');
			const pcm = synthPromptPcm(PROMPT);
			if (!pcm) {
				console.log(
					'\nℹ `say`/`ffmpeg` unavailable — skipping audio turn. Connectivity is confirmed.',
				);
				finish(0);
				return;
			}
			console.log(`\n🎤 prompt: "${PROMPT}"`);
			console.log(
				`→ streaming ${(pcm.length / IN_RATE / 2).toFixed(2)}s of audio (${Math.ceil(pcm.length / CHUNK_BYTES)} chunks)`,
			);
			for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
				const chunk = pcm.subarray(i, i + CHUNK_BYTES);
				send(ws, { type: 'input_audio_buffer.append', audio: chunk.toString('base64') });
			}
			send(ws, { type: 'input_audio_buffer.commit' });
			send(ws, { type: 'response.create' });
			console.log('→ committed audio + requested response');
			break;
		}
		case 'response.audio.delta':
			if (typeof evt.delta === 'string') audioOut.push(Buffer.from(evt.delta, 'base64'));
			break;
		case 'response.audio_transcript.delta':
			if (typeof evt.delta === 'string') {
				transcript += evt.delta;
				process.stdout.write(evt.delta);
			}
			break;
		case 'response.audio_transcript.done':
			process.stdout.write('\n');
			break;
		case 'response.done':
			console.log('✓ response.done');
			finish(0);
			break;
		case 'error':
			console.error('\n✗ server error:', JSON.stringify(evt.error ?? evt, null, 2));
			finish(1);
			break;
		default:
			console.log(`  · ${type}`);
	}
});

ws.on('error', (err) => {
	console.error('\n✗ websocket error:', err.message);
	finish(1);
});

ws.on('close', (code, reason) => {
	console.log(`socket closed (${code}) ${reason?.toString() || ''}`.trim());
});
