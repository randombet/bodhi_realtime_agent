// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpatialAssistantAudioDrip } from '../../app/web-client/src/spatial-web-avatar/assistant-audio-drip.js';

describe('SpatialAssistantAudioDrip', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('prebuffers before yielding avatar audio so speech and keyframes stay aligned', () => {
		const yielded: Array<{ bytes: number; last: boolean }> = [];
		const drip = new SpatialAssistantAudioDrip(24_000, (data, isLast) => {
			yielded.push({ bytes: data.byteLength, last: isLast });
		});

		drip.enqueue(new ArrayBuffer(47_999));
		vi.advanceTimersByTime(20);
		expect(yielded).toEqual([]);

		drip.enqueue(new ArrayBuffer(1));
		vi.advanceTimersByTime(10);
		expect(yielded).toEqual([{ bytes: 4_800, last: false }]);
	});

	it('sends an empty last marker after queued speech drains on turn end', () => {
		const yielded: Array<{ bytes: number; last: boolean }> = [];
		const drip = new SpatialAssistantAudioDrip(24_000, (data, isLast) => {
			yielded.push({ bytes: data.byteLength, last: isLast });
		});

		drip.enqueue(new ArrayBuffer(48_000));
		drip.enqueueEndMarker();

		for (let i = 0; i < 10; i++) {
			vi.advanceTimersByTime(10);
		}

		expect(yielded.at(-1)).toEqual({ bytes: 0, last: true });
		expect(yielded.filter((y) => y.last)).toHaveLength(1);
	});

	it('drops queued speech and suppresses a stale last marker on interruption', () => {
		const yielded: Array<{ bytes: number; last: boolean }> = [];
		const drip = new SpatialAssistantAudioDrip(24_000, (data, isLast) => {
			yielded.push({ bytes: data.byteLength, last: isLast });
		});

		drip.enqueue(new ArrayBuffer(96_000));
		drip.enqueueEndMarker();
		vi.advanceTimersByTime(10);
		expect(yielded).toEqual([{ bytes: 4_800, last: false }]);

		drip.interrupt();
		vi.advanceTimersByTime(500);

		expect(yielded).toEqual([{ bytes: 4_800, last: false }]);
	});
});
