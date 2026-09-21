/**
 * Per-frame energy result. Reused (mutated in place) by `ClientVadDetector` so
 * the audio hot path allocates nothing per frame — see `analyzeFrameInto`.
 */
export interface FrameEnergy {
	/** Peak absolute sample amplitude in the frame. */
	maxAbs: number;
	/** Mean absolute sample amplitude (0 when the frame has no samples). */
	avgAbs: number;
	/** Number of 16-bit samples read. */
	samples: number;
}

/**
 * Compute peak and mean absolute amplitude of a little-endian PCM16 frame,
 * writing the result into `out` (no allocation). Extracted verbatim from the
 * former `VoiceSession.updateClientAudioVad` energy loop.
 */
export function analyzeFrameInto(data: Buffer, out: FrameEnergy): void {
	let maxAbs = 0;
	let sumAbs = 0;
	let samples = 0;
	for (let i = 0; i + 1 < data.length; i += 2) {
		const abs = Math.abs(data.readInt16LE(i));
		if (abs > maxAbs) maxAbs = abs;
		sumAbs += abs;
		samples += 1;
	}
	out.maxAbs = maxAbs;
	out.avgAbs = samples > 0 ? sumAbs / samples : 0;
	out.samples = samples;
}
