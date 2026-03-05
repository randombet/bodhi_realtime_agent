// SPDX-License-Identifier: MIT

import { GoogleGenAI } from '@google/genai';
import type { STTAudioConfig, STTProvider } from '../types/transport.js';

/** Configuration for the Gemini batch STT provider. */
export interface GeminiBatchSTTConfig {
	/** Google API key for the Gemini API. */
	apiKey: string;
	/** Model name for STT (e.g. "gemini-3-flash-preview"). */
	model: string;
}

/** Maximum buffer size in bytes (~30s at 16kHz 16-bit mono = 32KB/s). */
const MAX_BUFFER_BYTES = 960_000;

/** Minimum audio duration in bytes before STT is attempted (0.3s at 32KB/s). */
const MIN_DURATION_BYTES = 9600;

/** Minimum RMS energy to distinguish speech from silence. */
const MIN_RMS_THRESHOLD = 300;

/**
 * STTProvider that uses a separate Gemini model via generateContent() for
 * batch transcription of buffered user audio.
 *
 * Extracted from GeminiLiveTransport. Audio is buffered via feedAudio(),
 * then transcribed when commit() is called (triggered by model turn start).
 */
export class GeminiBatchSTTProvider implements STTProvider {
	private ai: GoogleGenAI;
	private model: string;
	private sampleRate = 16000;
	private _audioChunks: string[] = [];
	private _bufferBytes = 0;
	private _wasInterrupted = false;

	onTranscript?: (text: string, turnId: number | undefined) => void;
	onPartialTranscript?: (text: string) => void;

	constructor(config: GeminiBatchSTTConfig) {
		this.ai = new GoogleGenAI({ apiKey: config.apiKey });
		this.model = config.model;
	}

	configure(audio: STTAudioConfig): void {
		if (audio.bitDepth !== 16) {
			throw new Error(`GeminiBatchSTTProvider requires bitDepth=16, got ${audio.bitDepth}`);
		}
		if (audio.channels !== 1) {
			throw new Error(`GeminiBatchSTTProvider requires channels=1, got ${audio.channels}`);
		}
		this.sampleRate = audio.sampleRate;
	}

	async start(): Promise<void> {
		// No-op — batch model, no persistent connection.
	}

	async stop(): Promise<void> {
		this._audioChunks = [];
		this._bufferBytes = 0;
	}

	feedAudio(base64Pcm: string): void {
		const chunkBytes = Math.ceil((base64Pcm.length * 3) / 4);
		// Enforce buffer limit — drop oldest chunks (FIFO)
		while (this._bufferBytes + chunkBytes > MAX_BUFFER_BYTES && this._audioChunks.length > 0) {
			const dropped = this._audioChunks.shift();
			if (dropped === undefined) break;
			this._bufferBytes -= Math.ceil((dropped.length * 3) / 4);
		}
		this._audioChunks.push(base64Pcm);
		this._bufferBytes += chunkBytes;
	}

	commit(turnId: number): void {
		const chunks = this._audioChunks;
		this._audioChunks = [];
		this._bufferBytes = 0;

		if (chunks.length === 0) return;

		const pcmBuf = Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64')));
		if (pcmBuf.length === 0) return;

		// Skip STT if audio is too short or too quiet
		if (pcmBuf.length < MIN_DURATION_BYTES || pcmRms(pcmBuf) < MIN_RMS_THRESHOLD) return;

		const wavBuf = pcmToWav(pcmBuf, this.sampleRate);

		this.ai.models
			.generateContent({
				model: this.model,
				contents: [
					{
						role: 'user',
						parts: [
							{
								inlineData: {
									data: wavBuf.toString('base64'),
									mimeType: 'audio/wav',
								},
							},
							{
								text: 'Transcribe the spoken words in this audio. If the audio contains only silence, background noise, or no clear speech, respond with exactly: [SILENCE]',
							},
						],
					},
				],
			})
			.then((response) => {
				const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
				if (text && text !== '[SILENCE]') {
					this.onTranscript?.(text, turnId);
				}
			})
			.catch(() => {
				// STT failure is non-fatal — user audio still processed by live model
			});
	}

	handleInterrupted(): void {
		this._wasInterrupted = true;
	}

	handleTurnComplete(): void {
		if (!this._wasInterrupted) {
			this._audioChunks = [];
			this._bufferBytes = 0;
		}
		this._wasInterrupted = false;
	}
}

/** Calculate RMS (root mean square) energy of 16-bit signed PCM audio.
 *  Returns 0 for empty buffers. Typical values: silence ~0-100, speech ~1000-5000. */
function pcmRms(pcm: Buffer): number {
	const sampleCount = pcm.length / 2;
	if (sampleCount === 0) return 0;
	let sumSquares = 0;
	for (let i = 0; i < pcm.length; i += 2) {
		const sample = pcm.readInt16LE(i);
		sumSquares += sample * sample;
	}
	return Math.sqrt(sumSquares / sampleCount);
}

/** Wrap raw PCM (16-bit mono little-endian) in a minimal 44-byte WAV header. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(pcm.length + 36, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16); // chunk size
	header.writeUInt16LE(1, 20); // PCM format
	header.writeUInt16LE(1, 22); // mono
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28); // byte rate
	header.writeUInt16LE(2, 32); // block align
	header.writeUInt16LE(16, 34); // bits per sample
	header.write('data', 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}
