// SPDX-License-Identifier: MIT

import { AUDIO_FORMAT } from '../types/audio.js';

/** Default buffer capacity: 2 seconds of audio. */
const DEFAULT_MAX_DURATION_MS = 2000;

/**
 * Bounded ring buffer for PCM audio chunks.
 * When the buffer exceeds its capacity, the oldest chunks are dropped first.
 * Used by ClientTransport to buffer audio during agent transfers and reconnections.
 */
export class AudioBuffer {
	private buffer: Buffer[] = [];
	private totalBytes = 0;
	private maxBytes: number;

	constructor(maxDurationMs = DEFAULT_MAX_DURATION_MS) {
		this.maxBytes = Math.ceil((maxDurationMs / 1000) * AUDIO_FORMAT.bytesPerSecond);
	}

	/** Add an audio chunk, dropping oldest chunks if the buffer is full. */
	push(chunk: Buffer): void {
		this.buffer.push(chunk);
		this.totalBytes += chunk.length;

		// Drop oldest chunks if exceeding max
		while (this.totalBytes > this.maxBytes && this.buffer.length > 1) {
			const dropped = this.buffer.shift();
			if (dropped) {
				this.totalBytes -= dropped.length;
			}
		}
	}

	/** Remove and return all buffered chunks, resetting the buffer to empty. */
	drain(): Buffer[] {
		const chunks = this.buffer;
		this.buffer = [];
		this.totalBytes = 0;
		return chunks;
	}

	clear(): void {
		this.buffer = [];
		this.totalBytes = 0;
	}

	get size(): number {
		return this.totalBytes;
	}

	get isEmpty(): boolean {
		return this.totalBytes === 0;
	}
}
