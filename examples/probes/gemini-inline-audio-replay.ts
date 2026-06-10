// SPDX-License-Identifier: MIT

/**
 * Phase 0 probe — design-retained-user-content-recovery.md (Step R0).
 *
 * Question under test: does Gemini Live respond to a user turn delivered as
 * `clientContent` inline audio with `turnComplete: true` (the retained-replay
 * shape), and does it emit an input transcription for it?
 *
 * Self-contained speech source: ask the model to SAY a question, capture its
 * 24 kHz output audio, resample to 16 kHz, and replay that as the "user" turn.
 *
 * States probed (per the design doc):
 *   1. clean         — replay after a completed, quiet exchange
 *   2. post-barge-in — replay right after interrupting a long response via
 *                      realtime-audio barge-in followed by silence (the stall shape)
 *
 * For each state records: (a) model response arrived? (b) input transcription arrived?
 * Falls back to a WAV-wrapped payload if raw PCM gets no response in the clean state.
 *
 * Run: pnpm tsx examples/probes/gemini-inline-audio-replay.ts
 * Env: GEMINI_API_KEY (or GOOGLE_API_KEY)
 */

import 'dotenv/config';
import { GoogleGenAI, Modality } from '@google/genai';
import { resamplePcm } from '../../src/audio/resample.js';

const API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
if (!API_KEY) {
	console.error('GEMINI_API_KEY required');
	process.exit(1);
}
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}
function log(msg: string): void {
	console.log(`${ts()} ${msg}`);
}

/** Minimal RIFF/WAV header for 16-bit mono PCM. */
function wavWrap(pcm: Buffer, rate: number): Buffer {
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

interface TurnObservation {
	modelAudioBytes: number;
	modelText: string;
	inputTranscription: string;
	interrupted: boolean;
	turnComplete: boolean;
}

function freshObs(): TurnObservation {
	return {
		modelAudioBytes: 0,
		modelText: '',
		inputTranscription: '',
		interrupted: false,
		turnComplete: false,
	};
}

async function main() {
	const ai = new GoogleGenAI({ apiKey: API_KEY });
	let obs = freshObs();
	const audioChunks: Buffer[] = [];
	let captureAudio = false;

	const session = await ai.live.connect({
		model: MODEL,
		config: {
			responseModalities: [Modality.AUDIO],
			inputAudioTranscription: {},
			systemInstruction:
				'You are a concise voice assistant. Answer questions in one short sentence.',
		},
		callbacks: {
			onopen: () => log('connected'),
			onmessage: (msg: Record<string, unknown>) => {
				const sc = msg.serverContent as
					| {
							modelTurn?: { parts?: Array<{ inlineData?: { data?: string }; text?: string }> };
							inputTranscription?: { text?: string };
							interrupted?: boolean;
							turnComplete?: boolean;
					  }
					| undefined;
				if (!sc) return;
				for (const part of sc.modelTurn?.parts ?? []) {
					if (part.inlineData?.data) {
						const buf = Buffer.from(part.inlineData.data, 'base64');
						obs.modelAudioBytes += buf.length;
						if (captureAudio) audioChunks.push(buf);
					}
					if (part.text) obs.modelText += part.text;
				}
				if (sc.inputTranscription?.text) obs.inputTranscription += sc.inputTranscription.text;
				if (sc.interrupted) {
					obs.interrupted = true;
					log('serverContent.interrupted');
				}
				if (sc.turnComplete) {
					obs.turnComplete = true;
					log(`turnComplete (audio=${obs.modelAudioBytes}B)`);
				}
			},
			onerror: (e: ErrorEvent) => log(`ERROR ${e.message}`),
			onclose: (e: CloseEvent) => log(`closed (${e.code} ${e.reason})`),
		},
	});

	const waitFor = async (pred: () => boolean, timeoutMs: number): Promise<boolean> => {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (pred()) return true;
			await new Promise((r) => setTimeout(r, 100));
		}
		return pred();
	};

	// ── Phase A: capture real speech (model says a question) ──────────────────
	log('Phase A: capturing spoken question from the model...');
	captureAudio = true;
	session.sendClientContent({
		turns: [
			{
				role: 'user',
				parts: [{ text: 'Say exactly: "What is the capital of France?" and nothing else.' }],
			},
		],
		turnComplete: true,
	});
	await waitFor(() => obs.turnComplete, 15_000);
	captureAudio = false;
	const speech24k = Buffer.concat(audioChunks);
	if (speech24k.length < 24_000) {
		log(`FATAL: captured only ${speech24k.length}B of speech — aborting`);
		session.close();
		return;
	}
	const speech16k = resamplePcm(speech24k, 24_000, 16_000, 16);
	log(`Phase A done: captured ${speech24k.length}B @24k → ${speech16k.length}B @16k`);
	await new Promise((r) => setTimeout(r, 1_000));

	const replay = (payload: Buffer, mime: string) => {
		session.sendClientContent({
			turns: [{ role: 'user', parts: [{ inlineData: { data: payload.toString('base64'), mimeType: mime } }] as never[] }],
			turnComplete: true,
		});
	};

	const report = (state: string, shape: string) => {
		const a = obs.modelAudioBytes > 0 || obs.modelText.length > 0 ? 'YES' : 'NO';
		const b = obs.inputTranscription.trim().length > 0 ? 'YES' : 'NO';
		console.log(
			`RESULT state=${state} shape=${shape} (a)response=${a} (b)inputTranscription=${b}` +
				` [audio=${obs.modelAudioBytes}B text="${obs.modelText.slice(0, 80)}" transcription="${obs.inputTranscription.slice(0, 80)}"]`,
		);
	};

	// ── Phase B: clean-state replay, raw PCM ──────────────────────────────────
	log('Phase B: clean-state replay (audio/pcm;rate=16000)...');
	obs = freshObs();
	replay(speech16k, 'audio/pcm;rate=16000');
	await waitFor(() => obs.turnComplete, 15_000);
	report('clean', 'pcm');
	const cleanPcmWorked = obs.modelAudioBytes > 0 || obs.modelText.length > 0;

	// WAV fallback if raw PCM got nothing.
	if (!cleanPcmWorked) {
		log('Phase B2: clean-state replay (audio/wav fallback)...');
		obs = freshObs();
		replay(wavWrap(speech16k, 16_000), 'audio/wav');
		await waitFor(() => obs.turnComplete, 15_000);
		report('clean', 'wav');
	}
	await new Promise((r) => setTimeout(r, 1_000));

	// ── Phase C: post-barge-in replay ─────────────────────────────────────────
	log('Phase C: provoking a barge-in-then-stop, then replaying...');
	obs = freshObs();
	session.sendClientContent({
		turns: [{ role: 'user', parts: [{ text: 'Count slowly from one to thirty, one number at a time.' }] }],
		turnComplete: true,
	});
	// Let the long response start streaming.
	await waitFor(() => obs.modelAudioBytes > 50_000, 10_000);
	log(`counting response streaming (${obs.modelAudioBytes}B) — barging in with realtime speech audio`);
	// Barge-in: stream the captured question as realtime mic audio (server VAD
	// should fire), then go silent — the stall trigger shape.
	const frame = 3_200; // 100 ms @ 16 kHz 16-bit
	for (let off = 0; off < speech16k.length; off += frame) {
		session.sendRealtimeInput({
			audio: {
				data: speech16k.subarray(off, off + frame).toString('base64'),
				mimeType: 'audio/pcm;rate=16000',
			},
		});
		await new Promise((r) => setTimeout(r, 90));
	}
	log('barge-in audio sent; observing 4 s of silence (interrupted=' + obs.interrupted + ')');
	await new Promise((r) => setTimeout(r, 4_000));

	// Now the recovery-relevant moment: replay via clientContent inline audio.
	log('Phase C replay: post-barge-in clientContent inline audio...');
	obs = freshObs();
	replay(speech16k, cleanPcmWorked ? 'audio/pcm;rate=16000' : 'audio/wav');
	await waitFor(() => obs.turnComplete, 15_000);
	report('post-barge-in', cleanPcmWorked ? 'pcm' : 'wav');

	session.close();
	log('probe complete');
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
