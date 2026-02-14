/** PCM 16-bit signed little-endian, 16kHz mono — Gemini's native format */
export const AUDIO_FORMAT = {
	sampleRate: 16000,
	channels: 1,
	bitDepth: 16,
	bytesPerSample: 2,
	bytesPerSecond: 32000, // 16000 * 2
} as const;

export type AudioFormat = typeof AUDIO_FORMAT;

/** Messages from client transport (non-audio control messages) */
export interface ClientMessage {
	type: string;
	data: unknown;
	timestamp: number;
}
