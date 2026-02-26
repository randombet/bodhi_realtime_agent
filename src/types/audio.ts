// SPDX-License-Identifier: MIT

/**
 * PCM 16-bit signed little-endian, 16 kHz mono — Gemini Live API's native audio format.
 * All audio buffers and transport operations assume this format.
 */
export const AUDIO_FORMAT = {
	sampleRate: 16000,
	channels: 1,
	bitDepth: 16,
	bytesPerSample: 2,
	/** 16000 samples/s * 2 bytes/sample = 32 000 bytes/s */
	bytesPerSecond: 32000,
} as const;

/** Type alias for the AUDIO_FORMAT constant's shape. */
export type AudioFormat = typeof AUDIO_FORMAT;

/** Non-audio control message from the client transport (e.g. JSON commands). */
export interface ClientMessage {
	/** Message type identifier (application-defined). */
	type: string;
	/** Message payload. */
	data: unknown;
	/** Unix timestamp (ms) when the message was received. */
	timestamp: number;
}
