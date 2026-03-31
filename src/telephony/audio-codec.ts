// SPDX-License-Identifier: MIT

/**
 * Audio codec conversion for Twilio Media Streams ↔ framework PCM pipeline.
 *
 * Twilio bidirectional Media Streams use mulaw 8kHz exclusively.
 * The framework uses PCM L16 16kHz mono. This module bridges the two:
 *   - Inbound (human → user):  mulaw 8kHz → PCM L16 16kHz
 *   - Outbound (user → human): PCM L16 16kHz → mulaw 8kHz
 */

// ---------------------------------------------------------------------------
// mulaw decode/encode tables (ITU-T G.711)
// ---------------------------------------------------------------------------

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/** Decode a single mulaw byte to a 16-bit PCM sample. */
export function mulawDecode(mulaw: number): number {
	const mu = ~mulaw & 0xff;
	const sign = mu & 0x80;
	const exponent = (mu >> 4) & 0x07;
	const mantissa = mu & 0x0f;
	let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
	sample -= MULAW_BIAS;
	return sign ? -sample : sample;
}

/** Encode a 16-bit PCM sample to a single mulaw byte. */
export function mulawEncode(sample: number): number {
	const sign = sample < 0 ? 0x80 : 0;
	let magnitude = sample < 0 ? -sample : sample;
	if (magnitude > MULAW_CLIP) magnitude = MULAW_CLIP;
	magnitude += MULAW_BIAS;

	const exponent = Math.floor(Math.log2(magnitude)) - 7;
	const exp = Math.max(0, Math.min(7, exponent));
	const mantissa = (magnitude >> (exp + 3)) & 0x0f;

	return ~(sign | (exp << 4) | mantissa) & 0xff;
}

// ---------------------------------------------------------------------------
// Buffer-level decode/encode
// ---------------------------------------------------------------------------

/**
 * Decode a mulaw buffer to PCM L16 (16-bit signed LE).
 * Output has 2x the byte length of input (1 mulaw byte → 2 PCM bytes).
 */
export function decodeMulawToPcm(mulawBuf: Buffer): Buffer {
	const pcm = Buffer.alloc(mulawBuf.length * 2);
	for (let i = 0; i < mulawBuf.length; i++) {
		const sample = mulawDecode(mulawBuf[i]);
		pcm.writeInt16LE(sample, i * 2);
	}
	return pcm;
}

/**
 * Encode a PCM L16 buffer (16-bit signed LE) to mulaw.
 * Output has half the byte length of input (2 PCM bytes → 1 mulaw byte).
 */
export function encodePcmToMulaw(pcmBuf: Buffer): Buffer {
	const mulaw = Buffer.alloc(pcmBuf.length / 2);
	for (let i = 0; i < mulaw.length; i++) {
		const sample = pcmBuf.readInt16LE(i * 2);
		mulaw[i] = mulawEncode(sample);
	}
	return mulaw;
}

// ---------------------------------------------------------------------------
// Resample (linear interpolation)
// ---------------------------------------------------------------------------

/**
 * Resample PCM L16 audio between sample rates using linear interpolation.
 * Input and output are Buffers of 16-bit signed LE samples.
 */
export function resample(pcmBuf: Buffer, fromRate: number, toRate: number): Buffer {
	if (fromRate === toRate) return pcmBuf;

	const inputSamples = pcmBuf.length / 2;
	const ratio = fromRate / toRate;
	const outputSamples = Math.floor(inputSamples / ratio);
	const output = Buffer.alloc(outputSamples * 2);

	for (let i = 0; i < outputSamples; i++) {
		const srcPos = i * ratio;
		const srcIndex = Math.floor(srcPos);
		const frac = srcPos - srcIndex;

		const s0 = pcmBuf.readInt16LE(Math.min(srcIndex, inputSamples - 1) * 2);
		const s1 = pcmBuf.readInt16LE(Math.min(srcIndex + 1, inputSamples - 1) * 2);
		const interpolated = Math.round(s0 + frac * (s1 - s0));

		output.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
	}

	return output;
}

// ---------------------------------------------------------------------------
// High-level conversion functions
// ---------------------------------------------------------------------------

/**
 * Convert Twilio mulaw 8kHz audio to framework PCM L16 16kHz.
 * Input: base64-encoded mulaw 8kHz buffer.
 * Output: Buffer of PCM L16 16kHz.
 */
export function twilioToFramework(mulawBase64: string): Buffer {
	const mulawBuf = Buffer.from(mulawBase64, 'base64');
	const pcm8k = decodeMulawToPcm(mulawBuf);
	return resample(pcm8k, 8000, 16000);
}

/**
 * Convert framework PCM audio to Twilio mulaw 8kHz.
 * Input: Buffer of PCM L16 (or base64 string) at the given sample rate.
 * Output: base64-encoded mulaw 8kHz buffer.
 *
 * @param pcmInput PCM L16 buffer or base64-encoded PCM string
 * @param inputRate Sample rate of the input in Hz (default: 16000)
 */
export function frameworkToTwilio(pcmInput: Buffer | string, inputRate = 16000): string {
	const pcm = typeof pcmInput === 'string' ? Buffer.from(pcmInput, 'base64') : pcmInput;
	const pcm8k = resample(pcm, inputRate, 8000);
	const mulaw = encodePcmToMulaw(pcm8k);
	return mulaw.toString('base64');
}
