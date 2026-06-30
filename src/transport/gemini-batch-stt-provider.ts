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
 * Output rules pinned via systemInstruction. Output rules are stronger as a
 * system instruction than embedded in the user message; the gemini-flash
 * models occasionally drift into a chatty wrapper ("The transcription for the
 * audio provided is as follows:") when the rules sit only in the user prompt.
 */
const SYSTEM_INSTRUCTION = [
	'You are a verbatim audio transcription engine.',
	'Reply with ONLY the spoken words from the audio — nothing else.',
	'Forbidden: preamble, labels, quotation marks, brackets, headings, explanations.',
	'Do NOT prefix the response with phrases like "The transcription is", "Here is what was said", or "The transcribed text".',
	'Do NOT wrap the transcript in quotation marks.',
	'If the audio contains only silence, background noise, or no clear speech, reply with exactly: [SILENCE]',
].join('\n');

const USER_PROMPT = 'Transcribe.';

/** Conservative regexes for envelope phrases the model occasionally still leaks. */
const ENVELOPE_PATTERNS: RegExp[] = [
	// Leading filler / agreement.
	/^(?:Sure[,.]?\s+|Okay[,.]?\s+|Of course[,.]?\s+)/i,
	// "The transcription […]:" / "The transcribed […]:" — must end with a colon
	// to avoid eating user content that legitimately starts with these words.
	/^(?:The )?transcription\b[^\n]{0,120}?:\s*\n?/i,
	/^(?:The )?transcribed (?:text|audio|content)\b[^\n]{0,120}?:\s*\n?/i,
	// "Here is/Here's the transcription […]:"
	/^Here(?:'s| is)\s+(?:the\s+)?(?:transcription|transcribed)\b[^\n]{0,120}?:\s*\n?/i,
	// "The audio […] contains/says […]:"
	/^The audio\b[^\n]{0,120}?:\s*\n?/i,
];

/**
 * Strip the meta-envelope phrases that gemini-flash models occasionally wrap
 * around their transcription output, plus paired surrounding quotes if the
 * entire response is quoted. Conservative by design — every pattern requires
 * a colon (or the audio-meta lead phrase), which is unlikely in real speech.
 */
export function stripMetaEnvelope(text: string): string {
	let s = text.trim();
	// Apply repeatedly in case the model layers prefixes/quotes
	// (e.g. `Sure, the transcription is: "Here is the transcription: ...."`).
	for (let i = 0; i < 6; i++) {
		let changed = false;
		for (const pat of ENVELOPE_PATTERNS) {
			const next = s.replace(pat, '');
			if (next !== s) {
				s = next.trimStart();
				changed = true;
			}
		}
		// Strip surrounding quotes if the entire remaining string is wrapped.
		const quoted = s.match(/^["“”'`]\s*([\s\S]*?)\s*["“”'`]$/);
		if (quoted) {
			s = quoted[1].trim();
			changed = true;
		}
		if (!changed) break;
	}
	return s.trim();
}

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
							{ text: USER_PROMPT },
						],
					},
				],
				config: { systemInstruction: SYSTEM_INSTRUCTION },
			})
			.then((response) => {
				const raw = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
				if (!raw) return;
				const cleaned = stripMetaEnvelope(raw);
				// Apply [SILENCE] filter AFTER stripping so a leaked
				// "The transcription is: [SILENCE]" still gets filtered.
				if (cleaned && cleaned !== '[SILENCE]') {
					this.onTranscript?.(cleaned, turnId);
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
