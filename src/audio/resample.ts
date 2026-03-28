// SPDX-License-Identifier: MIT

/**
 * Resample PCM audio buffer from one sample rate to another using linear interpolation.
 *
 * @param buffer Raw PCM audio data
 * @param fromRate Source sample rate in Hz
 * @param toRate Target sample rate in Hz
 * @param bitDepth Bits per sample (must be 16)
 * @returns Resampled PCM buffer at the target rate
 */
export function resamplePcm(
	buffer: Buffer,
	fromRate: number,
	toRate: number,
	bitDepth: number,
): Buffer {
	if (bitDepth !== 16) {
		throw new Error(`resamplePcm: only 16-bit PCM is supported, got ${bitDepth}`);
	}

	// Identity pass-through
	if (fromRate === toRate) {
		return buffer;
	}

	const bytesPerSample = 2; // 16-bit
	const srcSampleCount = Math.floor(buffer.length / bytesPerSample);

	if (srcSampleCount === 0) {
		return Buffer.alloc(0);
	}

	const ratio = fromRate / toRate;
	const dstSampleCount = Math.floor(srcSampleCount / ratio);

	if (dstSampleCount === 0) {
		return Buffer.alloc(0);
	}

	const output = Buffer.alloc(dstSampleCount * bytesPerSample);

	for (let i = 0; i < dstSampleCount; i++) {
		const srcPos = i * ratio;
		const srcIndex = Math.floor(srcPos);
		const fraction = srcPos - srcIndex;

		const s0 = buffer.readInt16LE(srcIndex * bytesPerSample);

		let sample: number;
		if (srcIndex + 1 < srcSampleCount) {
			const s1 = buffer.readInt16LE((srcIndex + 1) * bytesPerSample);
			// Linear interpolation
			sample = s0 + fraction * (s1 - s0);
		} else {
			sample = s0;
		}

		// Clamp to 16-bit range
		sample = Math.max(-32768, Math.min(32767, Math.round(sample)));
		output.writeInt16LE(sample, i * bytesPerSample);
	}

	return output;
}
