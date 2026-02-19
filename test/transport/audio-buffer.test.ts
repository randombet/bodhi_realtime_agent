// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { AudioBuffer } from '../../src/transport/audio-buffer.js';

describe('AudioBuffer', () => {
	it('starts empty', () => {
		const buf = new AudioBuffer();
		expect(buf.isEmpty).toBe(true);
		expect(buf.size).toBe(0);
	});

	it('push adds data', () => {
		const buf = new AudioBuffer();
		buf.push(Buffer.alloc(100));
		expect(buf.isEmpty).toBe(false);
		expect(buf.size).toBe(100);
	});

	it('drain returns all chunks and resets', () => {
		const buf = new AudioBuffer();
		buf.push(Buffer.alloc(50));
		buf.push(Buffer.alloc(75));

		const chunks = buf.drain();
		expect(chunks).toHaveLength(2);
		expect(chunks[0].length).toBe(50);
		expect(chunks[1].length).toBe(75);

		expect(buf.isEmpty).toBe(true);
		expect(buf.size).toBe(0);
	});

	it('clear empties buffer', () => {
		const buf = new AudioBuffer();
		buf.push(Buffer.alloc(100));
		buf.clear();
		expect(buf.isEmpty).toBe(true);
	});

	it('drops oldest chunks when exceeding max', () => {
		// 2s at 32000 bytes/sec = 64000 bytes max
		const buf = new AudioBuffer(2000);
		// Push 3 chunks of 30000 bytes each = 90000 total (exceeds 64000)
		buf.push(Buffer.alloc(30000));
		buf.push(Buffer.alloc(30000));
		buf.push(Buffer.alloc(30000));

		// First chunk should be dropped, leaving 60000 bytes
		expect(buf.size).toBe(60000);
		const chunks = buf.drain();
		expect(chunks).toHaveLength(2);
	});

	it('keeps at least one chunk even if it exceeds max', () => {
		const buf = new AudioBuffer(100); // ~3200 bytes max
		buf.push(Buffer.alloc(10000)); // Single large chunk
		expect(buf.size).toBe(10000);

		const chunks = buf.drain();
		expect(chunks).toHaveLength(1);
	});
});
