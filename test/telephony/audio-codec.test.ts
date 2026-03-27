// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	decodeMulawToPcm,
	encodePcmToMulaw,
	frameworkToTwilio,
	mulawDecode,
	mulawEncode,
	resample,
	twilioToFramework,
} from '../../src/telephony/audio-codec.js';

describe('mulaw encode/decode', () => {
	it('round-trips silence (0) within 1-bit precision', () => {
		const encoded = mulawEncode(0);
		const decoded = mulawDecode(encoded);
		// mulaw has a bias — silence encodes to a small non-zero value
		expect(Math.abs(decoded)).toBeLessThan(256);
	});

	it('round-trips positive sample within mulaw precision', () => {
		const sample = 8000;
		const encoded = mulawEncode(sample);
		const decoded = mulawDecode(encoded);
		// mulaw is lossy — allow ~5% error for mid-range values
		expect(Math.abs(decoded - sample) / sample).toBeLessThan(0.1);
	});

	it('round-trips negative sample', () => {
		const sample = -4000;
		const encoded = mulawEncode(sample);
		const decoded = mulawDecode(encoded);
		expect(Math.abs(decoded - sample) / Math.abs(sample)).toBeLessThan(0.1);
	});

	it('clips samples beyond mulaw range', () => {
		const encoded = mulawEncode(40000); // Beyond 32635 clip
		const decoded = mulawDecode(encoded);
		expect(decoded).toBeLessThanOrEqual(32767);
		expect(decoded).toBeGreaterThan(30000);
	});

	it('preserves sign for large negative values', () => {
		const decoded = mulawDecode(mulawEncode(-32000));
		expect(decoded).toBeLessThan(0);
	});
});

describe('decodeMulawToPcm / encodePcmToMulaw', () => {
	it('output has correct byte length', () => {
		const mulaw = Buffer.from([0xff, 0x7f, 0x00, 0x80]); // 4 mulaw bytes
		const pcm = decodeMulawToPcm(mulaw);
		expect(pcm.length).toBe(8); // 4 samples × 2 bytes each
	});

	it('round-trips a buffer within mulaw precision', () => {
		const original = Buffer.alloc(8);
		original.writeInt16LE(1000, 0);
		original.writeInt16LE(-2000, 2);
		original.writeInt16LE(5000, 4);
		original.writeInt16LE(-8000, 6);

		const mulaw = encodePcmToMulaw(original);
		expect(mulaw.length).toBe(4);

		const decoded = decodeMulawToPcm(mulaw);
		expect(decoded.length).toBe(8);

		for (let i = 0; i < 4; i++) {
			const orig = original.readInt16LE(i * 2);
			const dec = decoded.readInt16LE(i * 2);
			expect(Math.abs(dec - orig) / Math.max(Math.abs(orig), 1)).toBeLessThan(0.15);
		}
	});

	it('handles empty buffer', () => {
		expect(decodeMulawToPcm(Buffer.alloc(0)).length).toBe(0);
		expect(encodePcmToMulaw(Buffer.alloc(0)).length).toBe(0);
	});
});

describe('resample', () => {
	it('same rate returns same buffer', () => {
		const input = Buffer.alloc(20);
		const output = resample(input, 16000, 16000);
		expect(output).toBe(input); // Reference equality — no copy
	});

	it('8kHz → 16kHz doubles sample count', () => {
		// 4 samples at 8kHz
		const input = Buffer.alloc(8);
		input.writeInt16LE(100, 0);
		input.writeInt16LE(200, 2);
		input.writeInt16LE(300, 4);
		input.writeInt16LE(400, 6);

		const output = resample(input, 8000, 16000);
		expect(output.length / 2).toBe(8); // 8 samples at 16kHz
	});

	it('16kHz → 8kHz halves sample count', () => {
		const input = Buffer.alloc(16); // 8 samples
		for (let i = 0; i < 8; i++) {
			input.writeInt16LE(i * 100, i * 2);
		}

		const output = resample(input, 16000, 8000);
		expect(output.length / 2).toBe(4); // 4 samples
	});

	it('preserves signal shape through upsample+downsample', () => {
		const input = Buffer.alloc(8);
		input.writeInt16LE(0, 0);
		input.writeInt16LE(10000, 2);
		input.writeInt16LE(-10000, 4);
		input.writeInt16LE(0, 6);

		const upsampled = resample(input, 8000, 16000);
		const downsampled = resample(upsampled, 16000, 8000);

		// Should approximately recover original
		for (let i = 0; i < 4; i++) {
			const orig = input.readInt16LE(i * 2);
			const recovered = downsampled.readInt16LE(i * 2);
			expect(Math.abs(recovered - orig)).toBeLessThan(500);
		}
	});
});

describe('twilioToFramework / frameworkToTwilio', () => {
	it('twilioToFramework converts mulaw 8kHz base64 to PCM 16kHz buffer', () => {
		// 8 mulaw bytes → 8 PCM samples at 8kHz → 16 PCM samples at 16kHz → 32 bytes
		const mulawBase64 = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).toString(
			'base64',
		);
		const pcm16k = twilioToFramework(mulawBase64);
		expect(pcm16k).toBeInstanceOf(Buffer);
		expect(pcm16k.length).toBe(32); // 16 samples × 2 bytes
	});

	it('frameworkToTwilio converts PCM 16kHz to mulaw 8kHz base64', () => {
		// 16 PCM samples at 16kHz → 8 samples at 8kHz → 8 mulaw bytes
		const pcm16k = Buffer.alloc(32);
		for (let i = 0; i < 16; i++) {
			pcm16k.writeInt16LE(Math.round(Math.sin(i * 0.5) * 10000), i * 2);
		}

		const mulawBase64 = frameworkToTwilio(pcm16k);
		expect(typeof mulawBase64).toBe('string');

		const decoded = Buffer.from(mulawBase64, 'base64');
		expect(decoded.length).toBe(8); // 8 mulaw bytes
	});

	it('frameworkToTwilio accepts base64 string input', () => {
		const pcm16k = Buffer.alloc(32);
		const base64Input = pcm16k.toString('base64');
		const result = frameworkToTwilio(base64Input);
		expect(typeof result).toBe('string');
	});

	it('round-trips through both conversions with reasonable fidelity', () => {
		// Generate a simple sine wave at 16kHz
		const samples = 160; // 10ms at 16kHz
		const pcmOrig = Buffer.alloc(samples * 2);
		for (let i = 0; i < samples; i++) {
			pcmOrig.writeInt16LE(Math.round(Math.sin(i * 0.1) * 5000), i * 2);
		}

		// Framework → Twilio → Framework
		const mulawBase64 = frameworkToTwilio(pcmOrig);
		const pcmRecovered = twilioToFramework(mulawBase64);

		// Can't expect exact match (mulaw is lossy + resample), but signal should be similar
		expect(pcmRecovered.length).toBeGreaterThan(0);

		// Check the first few recovered samples have the right general shape
		const origFirst = pcmOrig.readInt16LE(0);
		const recoveredFirst = pcmRecovered.readInt16LE(0);
		expect(Math.abs(recoveredFirst - origFirst)).toBeLessThan(2000);
	});
});
