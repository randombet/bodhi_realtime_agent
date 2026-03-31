// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { resamplePcm } from '../../src/audio/resample.js';

describe('resamplePcm', () => {
	it('identity pass-through when rates are equal', () => {
		const input = Buffer.alloc(100);
		for (let i = 0; i < 50; i++) {
			input.writeInt16LE(i * 100, i * 2);
		}
		const result = resamplePcm(input, 24000, 24000, 16);
		expect(result).toBe(input); // Same reference
	});

	it('downsamples 44100 → 24000', () => {
		// Create a 44100 Hz buffer with 441 samples (10ms)
		const sampleCount = 441;
		const input = Buffer.alloc(sampleCount * 2);
		for (let i = 0; i < sampleCount; i++) {
			// Sine wave at ~1kHz
			const value = Math.round(Math.sin((2 * Math.PI * 1000 * i) / 44100) * 16000);
			input.writeInt16LE(value, i * 2);
		}

		const result = resamplePcm(input, 44100, 24000, 16);

		// Expected ~240 samples (441 * 24000/44100)
		const expectedSamples = Math.floor(sampleCount * (24000 / 44100));
		expect(result.length / 2).toBe(expectedSamples);
		expect(result.length).toBe(expectedSamples * 2);
	});

	it('upsamples 16000 → 24000', () => {
		// Create a 16000 Hz buffer with 160 samples (10ms)
		const sampleCount = 160;
		const input = Buffer.alloc(sampleCount * 2);
		for (let i = 0; i < sampleCount; i++) {
			input.writeInt16LE(i * 100, i * 2);
		}

		const result = resamplePcm(input, 16000, 24000, 16);

		// Expected 240 samples (160 * 24000/16000)
		const expectedSamples = Math.floor(sampleCount * (24000 / 16000));
		expect(result.length / 2).toBe(expectedSamples);
	});

	it('handles zero-length buffer', () => {
		const result = resamplePcm(Buffer.alloc(0), 44100, 24000, 16);
		expect(result.length).toBe(0);
	});

	it('handles single-sample buffer', () => {
		const input = Buffer.alloc(2);
		input.writeInt16LE(1000, 0);

		// Downsampling a single sample: depends on ratio
		const result = resamplePcm(input, 44100, 24000, 16);
		// With ratio 44100/24000 ≈ 1.8375, floor(1/1.8375) = 0 samples
		expect(result.length).toBe(0);
	});

	it('handles odd-length buffer (truncates trailing byte)', () => {
		// 5 bytes = 2 complete samples + 1 trailing byte
		const input = Buffer.alloc(5);
		input.writeInt16LE(5000, 0);
		input.writeInt16LE(6000, 2);

		// Downsample 48000→24000: 2 samples → 1 sample (trailing byte is ignored by floor division)
		const result = resamplePcm(input, 48000, 24000, 16);
		expect(result.length).toBe(2); // 1 sample
		expect(result.readInt16LE(0)).toBe(5000);
	});

	it('throws for non-16-bit input', () => {
		expect(() => resamplePcm(Buffer.alloc(10), 24000, 24000, 8)).toThrow(
			'only 16-bit PCM is supported',
		);
	});

	it('preserves sample values within interpolation tolerance', () => {
		// Create 4 samples at 48000 Hz, downsample to 24000 Hz (2:1 ratio)
		const input = Buffer.alloc(8);
		input.writeInt16LE(1000, 0);
		input.writeInt16LE(2000, 2);
		input.writeInt16LE(3000, 4);
		input.writeInt16LE(4000, 6);

		const result = resamplePcm(input, 48000, 24000, 16);
		// 4 samples at 2:1 = 2 output samples
		expect(result.length / 2).toBe(2);
		// First sample at position 0 → source sample 0 = 1000
		expect(result.readInt16LE(0)).toBe(1000);
		// Second sample at position 1 → source position 2.0 → source sample 2 = 3000
		expect(result.readInt16LE(2)).toBe(3000);
	});

	it('clamps output to 16-bit range', () => {
		// Create samples near the limits
		const input = Buffer.alloc(4);
		input.writeInt16LE(32767, 0); // Max positive
		input.writeInt16LE(-32768, 2); // Max negative

		const result = resamplePcm(input, 24000, 24000, 16);
		expect(result.readInt16LE(0)).toBe(32767);
		expect(result.readInt16LE(2)).toBe(-32768);
	});
});
