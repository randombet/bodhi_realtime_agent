// SPDX-License-Identifier: MIT

/**
 * Generate silence PCM audio data (16-bit, 16kHz, mono).
 * @param durationMs Duration of silence in milliseconds
 */
export function generateSilence(durationMs: number): Buffer {
	const sampleRate = 16000;
	const bytesPerSample = 2; // 16-bit
	const numSamples = Math.floor((sampleRate * durationMs) / 1000);
	return Buffer.alloc(numSamples * bytesPerSample);
}

/**
 * Generate a sine wave tone as PCM audio (16-bit, 16kHz, mono).
 * @param durationMs Duration in milliseconds
 * @param frequency Frequency in Hz (default 440)
 */
export function generateTone(durationMs: number, frequency = 440): Buffer {
	const sampleRate = 16000;
	const bytesPerSample = 2;
	const numSamples = Math.floor((sampleRate * durationMs) / 1000);
	const buffer = Buffer.alloc(numSamples * bytesPerSample);

	for (let i = 0; i < numSamples; i++) {
		const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.5 * 32767;
		buffer.writeInt16LE(Math.round(sample), i * bytesPerSample);
	}

	return buffer;
}
