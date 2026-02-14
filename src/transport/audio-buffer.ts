import { AUDIO_FORMAT } from '../types/audio.js';

const DEFAULT_MAX_DURATION_MS = 2000;

export class AudioBuffer {
	private buffer: Buffer[] = [];
	private totalBytes = 0;
	private maxBytes: number;

	constructor(maxDurationMs = DEFAULT_MAX_DURATION_MS) {
		this.maxBytes = Math.ceil((maxDurationMs / 1000) * AUDIO_FORMAT.bytesPerSecond);
	}

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
