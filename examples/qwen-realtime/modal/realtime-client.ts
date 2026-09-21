/**
 * Speech-to-speech client for the self-hosted Qwen3-Omni `/v1/realtime` endpoint
 * (vLLM-Omni on Modal — see deploy.py / smoke.ts in this folder).
 *
 *   pnpm tsx examples/qwen-realtime/modal/realtime-client.ts --input-wav speech.wav
 *
 * This is a TypeScript port of vLLM-Omni's official Qwen3-Omni realtime client
 * (vllm-project/vllm-omni examples/online_serving/qwen3_omni). It streams a WAV
 * file in and saves the model's synthesized speech + transcription out.
 *
 * IMPORTANT — this endpoint is NOT the same protocol as `examples/qwen-realtime/
 * tools.ts`. That example drives Alibaba DashScope's conversational realtime API
 * (function calling, agent transfer, `session.updated` ack) through
 * `QwenRealtimeTransport`. The self-hosted vLLM-Omni endpoint is a turn-based
 * speech-to-speech API with a different event vocabulary and NO function calling,
 * so it cannot be driven by `VoiceSession`/`QwenRealtimeTransport` as-is. This
 * standalone client speaks the vLLM-Omni protocol directly:
 *
 *   client → session.update {model}                  (model is TOP-LEVEL)
 *          → input_audio_buffer.commit {final:false}  (start generation)
 *          → input_audio_buffer.append {audio}        (mono PCM16 @ 16kHz, base64)
 *          → input_audio_buffer.commit {final:true}   (close input)
 *   server → session.created
 *          → response.audio.delta {audio, sample_rate_hz}   (incremental PCM out)
 *          → transcription.delta {delta} / transcription.done {text, usage}
 *          → response.audio.done                      (turn complete)
 *
 * Input WAV must be mono, 16-bit PCM, 16 kHz. On macOS you can make one with:
 *   say -o /tmp/q.aiff "What is the capital of France?"
 *   ffmpeg -i /tmp/q.aiff -ar 16000 -ac 1 -sample_fmt s16 /tmp/q.wav
 * Then: pnpm tsx examples/qwen-realtime/modal/realtime-client.ts --input-wav /tmp/q.wav
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Args / config
// ---------------------------------------------------------------------------

function arg(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const INPUT_WAV = arg('input-wav');
const OUTPUT_WAV = arg('output-wav', 'realtime_output.wav') as string;
const OUTPUT_TEXT = arg('output-text'); // optional
const WS_URL =
	arg('url') ??
	process.env.VLLM_WS_URL ??
	'wss://yxz-ucd--qwen3-omni-realtime-serve.modal.run/v1/realtime';
const MODEL = arg('model') ?? process.env.VLLM_MODEL ?? 'Qwen/Qwen3-Omni-30B-A3B-Instruct';
const CHUNK_MS = Number(arg('chunk-ms', '200'));
const SEND_DELAY_MS = Number(arg('send-delay-ms', '0'));
// Cold start on H100 with cached weights is ~5 min; allow generous headroom.
const TIMEOUT_MS = Number(process.env.VLLM_TIMEOUT_MS ?? 25 * 60 * 1000);

if (!INPUT_WAV) {
	console.error('Error: --input-wav <path> is required (mono, 16-bit PCM, 16 kHz WAV).');
	console.error('Make one on macOS:');
	console.error('  say -o /tmp/q.aiff "What is the capital of France?"');
	console.error('  ffmpeg -i /tmp/q.aiff -ar 16000 -ac 1 -sample_fmt s16 /tmp/q.wav');
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Minimal WAV read/write (PCM16)
// ---------------------------------------------------------------------------

/** Parse a PCM16 WAV, validate mono/16-bit/16kHz, return the raw sample bytes. */
function readWavPcm16(path: string): Buffer {
	const buf = readFileSync(path);
	if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
		throw new Error(`${path}: not a RIFF/WAVE file`);
	}
	let channels = 0;
	let sampleRate = 0;
	let bits = 0;
	let format = 0;
	let data: Buffer | null = null;

	let off = 12;
	while (off + 8 <= buf.length) {
		const id = buf.toString('ascii', off, off + 4);
		const size = buf.readUInt32LE(off + 4);
		const body = off + 8;
		if (id === 'fmt ') {
			format = buf.readUInt16LE(body);
			channels = buf.readUInt16LE(body + 2);
			sampleRate = buf.readUInt32LE(body + 4);
			bits = buf.readUInt16LE(body + 14);
		} else if (id === 'data') {
			data = buf.subarray(body, body + size);
		}
		off = body + size + (size % 2); // chunks are word-aligned
	}

	if (!data) throw new Error(`${path}: no data chunk`);
	if (format !== 1) throw new Error(`${path}: must be uncompressed PCM (got format ${format})`);
	if (channels !== 1) throw new Error(`${path}: must be mono (got ${channels} channels)`);
	if (bits !== 16) throw new Error(`${path}: must be 16-bit PCM (got ${bits}-bit)`);
	if (sampleRate !== 16000) throw new Error(`${path}: must be 16 kHz (got ${sampleRate} Hz)`);
	if (data.length === 0) throw new Error(`${path}: no audio frames`);
	return data;
}

/** Write mono PCM16 samples as a WAV file. */
function writeWavPcm16(path: string, pcm: Buffer, sampleRate: number): void {
	const header = Buffer.alloc(44);
	const byteRate = sampleRate * 2; // mono * 16-bit
	header.write('RIFF', 0, 'ascii');
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write('WAVE', 8, 'ascii');
	header.write('fmt ', 12, 'ascii');
	header.writeUInt32LE(16, 16); // fmt chunk size
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(2, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write('data', 36, 'ascii');
	header.writeUInt32LE(pcm.length, 40);
	writeFileSync(path, Buffer.concat([header, pcm]));
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const pcm16 = readWavPcm16(INPUT_WAV);
const bytesPerMs = (16000 * 2) / 1000; // mono PCM16 @ 16kHz
const chunkBytes = Math.max(Math.floor(bytesPerMs * CHUNK_MS), 2);

const url = `${WS_URL}?model=${encodeURIComponent(MODEL)}`;
console.log(`connecting: ${url}`);
console.log(`input: ${INPUT_WAV} (${pcm16.length} PCM bytes, ${chunkBytes}-byte chunks)`);
console.log(`timeout: ${(TIMEOUT_MS / 60_000).toFixed(0)} min (allow time for cold start)`);

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const ws = new WebSocket(url, { headers: { Authorization: 'Bearer test' } });

const audioParts: Buffer[] = [];
const textChunks: string[] = [];
let outputSampleRate = 24000; // Qwen3-Omni emits 24kHz; overridden by sample_rate_hz
let finalText = '';
let done = false;

const timer = setTimeout(() => {
	console.error(`✗ timed out after ${elapsed()}`);
	try {
		ws.close();
	} catch {
		/* noop */
	}
	process.exit(1);
}, TIMEOUT_MS);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

ws.on('open', async () => {
	console.log(`[${elapsed()}] ✓ socket open — sending session.update + streaming audio`);
	// 1) Validate model (top-level field).
	ws.send(JSON.stringify({ type: 'session.update', model: MODEL }));
	// 2) Start generation.
	ws.send(JSON.stringify({ type: 'input_audio_buffer.commit', final: false }));
	// 3) Stream PCM16 chunks as base64.
	for (let i = 0; i < pcm16.length; i += chunkBytes) {
		const chunk = pcm16.subarray(i, i + chunkBytes);
		ws.send(
			JSON.stringify({
				type: 'input_audio_buffer.append',
				audio: chunk.toString('base64'),
			}),
		);
		if (SEND_DELAY_MS > 0) await sleep(SEND_DELAY_MS);
	}
	// 4) Close the input stream.
	ws.send(JSON.stringify({ type: 'input_audio_buffer.commit', final: true }));
	console.log(`[${elapsed()}] → audio sent; awaiting response…`);
});

ws.on('message', (raw) => {
	const text = raw.toString();
	let e: {
		type?: string;
		audio?: string;
		sample_rate_hz?: number;
		delta?: string;
		text?: string;
		usage?: unknown;
		error?: unknown;
	};
	try {
		e = JSON.parse(text);
	} catch {
		return; // only JSON text frames are expected
	}
	switch (e.type) {
		case 'session.created':
			console.log(`[${elapsed()}] ✓ session.created`);
			break;
		case 'response.audio.delta': {
			if (typeof e.sample_rate_hz === 'number' && e.sample_rate_hz > 0) {
				outputSampleRate = e.sample_rate_hz;
			}
			if (e.audio) audioParts.push(Buffer.from(e.audio, 'base64'));
			break;
		}
		case 'transcription.delta':
			if (e.delta) {
				textChunks.push(e.delta);
				process.stdout.write(e.delta);
			}
			break;
		case 'transcription.done':
			finalText = e.text || textChunks.join('');
			if (textChunks.length) process.stdout.write('\n');
			console.log(`[${elapsed()}] ✓ transcription.done: ${finalText}`);
			if (e.usage) console.log(`[${elapsed()}]   usage: ${JSON.stringify(e.usage)}`);
			break;
		case 'response.audio.done':
			done = true;
			clearTimeout(timer);
			ws.close();
			break;
		case 'error':
			console.error(`[${elapsed()}] ✗ error: ${JSON.stringify(e.error ?? e)}`);
			clearTimeout(timer);
			ws.close();
			break;
		default:
			console.log(`[${elapsed()}]   · ${e.type ?? '?'}`);
	}
});

ws.on('error', (err) => console.error(`[${elapsed()}] ws error: ${err.message}`));

ws.on('close', (code) => {
	clearTimeout(timer);
	const pcm = Buffer.concat(audioParts);
	if (done && pcm.length > 0) {
		writeWavPcm16(OUTPUT_WAV, pcm, outputSampleRate);
		console.log(
			`[${elapsed()}] ✅ saved ${pcm.length} PCM bytes → ${OUTPUT_WAV} (${outputSampleRate} Hz)`,
		);
		if (OUTPUT_TEXT) {
			writeFileSync(OUTPUT_TEXT, finalText || textChunks.join(''));
			console.log(`[${elapsed()}]    saved transcription → ${OUTPUT_TEXT}`);
		}
		process.exit(0);
	}
	console.error(`[${elapsed()}] ❌ no audio received (socket closed ${code})`);
	process.exit(1);
});
