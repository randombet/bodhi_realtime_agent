// SPDX-License-Identifier: MIT

/**
 * LastUtteranceRetainer — session-scoped retention of the user's most recent
 * routed utterance, for watchdog-stall recovery replay.
 *
 * Fed the transport-normalized PCM the AudioRouter actually sent to the model
 * (post greeting-grace gate, post resample), so retention mirrors what the
 * model heard. Segment boundaries come from the client VAD; `seal()` refuses
 * empty segments so VAD events for never-routed audio (greeting grace,
 * dictation, external-audio agents) can never produce a replayable turn.
 *
 * Memory only, bounded (pre-roll ring + per-segment cap), never persisted.
 * See dev_docs/framework/design-retained-user-content-recovery.md.
 */

export interface RetainedUserTurn {
	/** PCM16 mono, transport-normalized (transport.audioFormat.inputSampleRate). */
	pcm: Buffer;
	sampleRateHz: number;
	/** Retainer-owned identity — no framework turn id exists at VAD seal time. */
	utteranceId: number;
	/** Freshness key for age-based replay expiry. */
	sealedAtMs: number;
}

export interface LastUtteranceRetainerOptions {
	/** Rate of the PCM fed in — transport.audioFormat.inputSampleRate. */
	sampleRateHz: number;
	/** Rolling window kept before VAD onset (default 300 ms). */
	preRollMs?: number;
	/** Hard cap per segment (default 15 s); oldest frames evicted, tail kept. */
	maxSegmentMs?: number;
	/** Injectable for tests. */
	clock?: () => number;
}

const DEFAULT_PRE_ROLL_MS = 300;
const DEFAULT_MAX_SEGMENT_MS = 15_000;

/** Chunk list bounded by a byte budget; eviction drops the oldest chunks.
 *  Stores references only — no per-frame copy on the audio fast path. */
class BoundedChunks {
	private chunks: Buffer[] = [];
	private bytes = 0;

	constructor(private readonly maxBytes: number) {}

	push(chunk: Buffer): void {
		if (this.maxBytes <= 0) return;
		this.chunks.push(chunk);
		this.bytes += chunk.length;
		while (this.bytes > this.maxBytes && this.chunks.length > 1) {
			const dropped = this.chunks.shift();
			if (dropped) this.bytes -= dropped.length;
		}
	}

	takeAll(): Buffer[] {
		const out = this.chunks;
		this.chunks = [];
		this.bytes = 0;
		return out;
	}

	get byteLength(): number {
		return this.bytes;
	}

	clear(): void {
		this.chunks = [];
		this.bytes = 0;
	}
}

export class LastUtteranceRetainer {
	private readonly sampleRateHz: number;
	private readonly clock: () => number;
	private readonly preRoll: BoundedChunks;
	private readonly segmentMaxBytes: number;

	private segment: BoundedChunks | null = null;
	private sealed: RetainedUserTurn | null = null;
	private nextUtteranceId = 1;

	constructor(opts: LastUtteranceRetainerOptions) {
		this.sampleRateHz = opts.sampleRateHz;
		this.clock = opts.clock ?? Date.now;
		const bytesPerMs = (this.sampleRateHz * 2) / 1000; // PCM16 mono
		this.preRoll = new BoundedChunks(
			Math.floor((opts.preRollMs ?? DEFAULT_PRE_ROLL_MS) * bytesPerMs),
		);
		this.segmentMaxBytes = Math.floor((opts.maxSegmentMs ?? DEFAULT_MAX_SEGMENT_MS) * bytesPerMs);
	}

	/** Per routed frame from AudioRouter (the transport-normalized PCM). */
	feed(data: Buffer): void {
		if (data.length === 0) return;
		if (this.segment) {
			this.segment.push(data);
		} else {
			this.preRoll.push(data);
		}
	}

	/** From ClientVadDetector.onSpeechStart — begin a segment seeded with the
	 *  pre-roll tail (VAD triggers a few frames into speech). */
	markSpeechStart(): void {
		const segment = new BoundedChunks(this.segmentMaxBytes);
		for (const chunk of this.preRoll.takeAll()) segment.push(chunk);
		this.segment = segment;
	}

	/** From ClientVadDetector.onUserTurnCompleted — freeze the segment as the
	 *  retained last utterance. Returns false (and retains nothing) when the
	 *  segment holds no routed frames. */
	seal(): boolean {
		const segment = this.segment;
		this.segment = null;
		if (!segment || segment.byteLength === 0) return false;
		this.sealed = {
			pcm: Buffer.concat(segment.takeAll()),
			sampleRateHz: this.sampleRateHz,
			utteranceId: this.nextUtteranceId++,
			sealedAtMs: this.clock(),
		};
		return true;
	}

	/** Non-consuming read of the sealed utterance, `null` when absent or older
	 *  than `maxAgeMs` (never replay stale speech). The recovery controller
	 *  bounds replays per utteranceId. */
	peek(maxAgeMs: number): RetainedUserTurn | null {
		if (!this.sealed) return null;
		if (this.clock() - this.sealed.sealedAtMs > maxAgeMs) return null;
		return this.sealed;
	}

	/** On correlated model activity (the utterance was answered) and on session
	 *  close. Keeps any in-progress segment — mid-utterance speech at clear time
	 *  is the NEXT user turn, not the answered one. */
	clear(): void {
		this.sealed = null;
		this.preRoll.clear();
	}
}
