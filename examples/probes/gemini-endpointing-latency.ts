/**
 * End-pointing latency probe — investigation-sutando-voice-latency.md.
 *
 * Question under test: how long after the user stops speaking does a Gemini
 * Live model (a) begin emitting input transcription, (b) start its model turn,
 * (c) emit first reply audio — per model family and per
 * `realtimeInputConfig.automaticActivityDetection` setting?
 *
 * Bypasses VoiceSession entirely: constructs `GeminiLiveTransport` directly,
 * streams a synthesized utterance at real-time pacing (40 ms frames), follows
 * it with digital-silence frames, and timestamps the three events against the
 * end of speech audio. One cell (model × AAD config) per process run; run
 * cells sequentially — rapid same-model connects can trip the free tier's
 * session-rate limit (1011 "quota exceeded").
 *
 * Speech source (macOS):
 *   say -v Samantha -o /tmp/probe.aiff "What's the weather in San Francisco today?"
 *   afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/probe.aiff /tmp/probe.wav
 *
 * Run: PROBE_WAV=/tmp/probe.wav pnpm tsx examples/probes/gemini-endpointing-latency.ts \
 *        <model> <framework|stock|sens|silence|silence100> [search]
 * Env: GEMINI_API_KEY (or GOOGLE_API_KEY), PROBE_WAV (16 kHz PCM16 mono WAV)
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import {
	DEFAULT_GEMINI_REALTIME_INPUT_CONFIG,
	GeminiLiveTransport,
} from '../../src/transport/gemini-live-transport.js';

const API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
const [, , MODEL, AAD, SEARCH] = process.argv;
if (!API_KEY || !MODEL || !AAD) {
	console.error(
		'usage: PROBE_WAV=<16kHz mono wav> pnpm tsx examples/probes/gemini-endpointing-latency.ts <model> <framework|stock|sens|silence|silence100> [search]',
	);
	process.exit(1);
}

const WAV = process.env.PROBE_WAV ?? '';
const raw = readFileSync(WAV);

/** Walk RIFF chunks, validating the format and returning exactly the declared
 *  `data` payload. Guards against 'data' byte sequences inside metadata and
 *  against fixtures that are not 16 kHz mono PCM16 (which would silently
 *  invalidate every measurement). */
function extractPcm(buf: Buffer): Buffer {
	if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
		throw new Error('PROBE_WAV is not a RIFF/WAVE file');
	}
	let off = 12;
	let pcmOut: Buffer | undefined;
	while (off + 8 <= buf.length) {
		const id = buf.toString('ascii', off, off + 4);
		const size = buf.readUInt32LE(off + 4);
		if (id === 'fmt ') {
			const audioFormat = buf.readUInt16LE(off + 8);
			const channels = buf.readUInt16LE(off + 10);
			const sampleRate = buf.readUInt32LE(off + 12);
			const bits = buf.readUInt16LE(off + 22);
			if (audioFormat !== 1 || channels !== 1 || sampleRate !== 16000 || bits !== 16) {
				throw new Error(
					`PROBE_WAV must be 16 kHz mono PCM16 (got format=${audioFormat} ch=${channels} rate=${sampleRate} bits=${bits})`,
				);
			}
		} else if (id === 'data') {
			pcmOut = buf.subarray(off + 8, off + 8 + size);
		}
		off += 8 + size + (size % 2); // chunks are word-aligned
	}
	if (!pcmOut) throw new Error('PROBE_WAV has no data chunk');
	return pcmOut;
}

const pcm = extractPcm(raw);
console.log(`fixture: ${pcm.length} bytes = ${(pcm.length / 32000).toFixed(3)}s @16kHz PCM16 mono`);

const FRAME_MS = 40;
const FRAME_BYTES = (16000 * 2 * FRAME_MS) / 1000; // 1280
const silence = Buffer.alloc(FRAME_BYTES);

/** AAD variants under test. `framework` is the VoiceSession built-in-path
 *  default; `sens`/`silence`/`silence100` isolate its individual knobs. */
const AAD_CONFIGS: Record<string, object | undefined> = {
	framework: { realtimeInputConfig: DEFAULT_GEMINI_REALTIME_INPUT_CONFIG },
	stock: undefined,
	sens: {
		realtimeInputConfig: {
			automaticActivityDetection: { endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH' },
		},
	},
	silence: {
		realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 500 } },
	},
	silence100: {
		realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 100 } },
	},
};

async function main() {
	const t0 = Date.now();
	const log = (m: string) => console.log(`[+${String(Date.now() - t0).padStart(6)}ms] ${m}`);

	let endOfSpeechAt = 0;
	let firstInputTx = 0;
	let modelStart = 0;
	let firstAudio = 0;
	let done: (() => void) | undefined;
	const finished = new Promise<void>((r) => {
		done = r;
	});

	const transport = new GeminiLiveTransport(
		{
			apiKey: API_KEY,
			model: MODEL,
			systemInstruction: 'You are a concise voice assistant. Answer in one short sentence.',
			inputAudioTranscription: true,
			...(AAD_CONFIGS[AAD] ?? {}),
			...(SEARCH === 'search' ? { googleSearch: true } : {}),
		},
		{
			onSetupComplete: () => log('setup complete'),
			onInputTranscription: (text) => {
				// Record the FIRST transcription callback unconditionally — it can
				// arrive while speech is still being transmitted, in which case the
				// reported delta is negative. (An earlier revision discarded
				// pre-anchor callbacks, silently converting "onset" into "first
				// post-transmission delta".)
				if (!firstInputTx) {
					firstInputTx = Date.now();
					log(`FIRST inputTranscription: "${text}"`);
				}
			},
			onModelTurnStart: () => {
				if (!modelStart && endOfSpeechAt) {
					modelStart = Date.now();
					log(`modelTurnStart (+${modelStart - endOfSpeechAt}ms after speech end)`);
				}
			},
			onFirstAudioChunk: () => {
				if (!firstAudio && endOfSpeechAt) {
					firstAudio = Date.now();
					log(`firstAudioChunk (+${firstAudio - endOfSpeechAt}ms after speech end)`);
					done?.();
				}
			},
			onError: (e: unknown) => log(`ERROR: ${(e as Error).message ?? e}`),
			onClose: (code?: number, reason?: string) => log(`CLOSED code=${code} reason=${reason ?? ''}`),
		},
	);

	await transport.connect();
	log(`connected model=${MODEL} aad=${AAD} search=${SEARCH === 'search'}`);

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	// 500 ms leading silence, real-time paced.
	for (let i = 0; i < 500 / FRAME_MS; i++) {
		transport.sendAudio(silence.toString('base64'));
		await sleep(FRAME_MS);
	}
	log('speech start');
	for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
		transport.sendAudio(pcm.subarray(off, off + FRAME_BYTES).toString('base64'));
		// Anchor the reference clock at the LAST speech frame's send, not after
		// its pacing sleep — otherwise every reported latency is deflated by one
		// frame. Note the anchor is end of WAV *transmission*: any trailing
		// silence inside the fixture is counted as speech, a constant offset
		// shared by all cells (relative comparisons unaffected).
		if (off + FRAME_BYTES >= pcm.length) endOfSpeechAt = Date.now();
		await sleep(FRAME_MS);
	}
	log('speech end (end of WAV transmission) — streaming silence');
	// Trailing silence up to 15 s or until the reply's first audio arrives.
	for (let i = 0; i < 15000 / FRAME_MS && !firstAudio; i++) {
		transport.sendAudio(silence.toString('base64'));
		await sleep(FRAME_MS);
	}

	await Promise.race([finished, sleep(3000)]);
	console.log(
		`RESULT model=${MODEL} aad=${AAD} search=${SEARCH === 'search'} ` +
			`inputTx=${firstInputTx ? firstInputTx - endOfSpeechAt : 'NEVER'}ms ` +
			`modelStart=${modelStart ? modelStart - endOfSpeechAt : 'NEVER'}ms ` +
			`firstAudio=${firstAudio ? firstAudio - endOfSpeechAt : 'NEVER'}ms`,
	);
	await transport.disconnect();
	process.exit(0);
}

main().catch((e) => {
	console.error('probe failed:', e);
	process.exit(1);
});
