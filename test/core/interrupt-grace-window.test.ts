import { describe, expect, it } from 'vitest';
import { InterruptGraceWindow } from '../../src/core/interrupt-grace-window.js';

/**
 * Phase C1 verification — InterruptGraceWindow class.
 */

function makeClock(initial = 0): { now: () => number; advance: (ms: number) => void } {
	let t = initial;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

describe('InterruptGraceWindow', () => {
	it('windowMs=0 disables the window entirely — onAudioStart is a no-op', () => {
		const clock = makeClock();
		const w = new InterruptGraceWindow(0, clock.now);
		w.onAudioStart();
		expect(w.isActive()).toBe(false);
		expect(w.remainingMs()).toBe(0);
	});

	it('arms on first onAudioStart with windowMs > 0', () => {
		const clock = makeClock(1000);
		const w = new InterruptGraceWindow(1000, clock.now);
		expect(w.isActive()).toBe(false);
		w.onAudioStart();
		expect(w.isActive()).toBe(true);
		expect(w.remainingMs()).toBe(1000);
	});

	it('isActive=true at t=999, false at t=1000 (window is half-open [arm, arm+ms))', () => {
		const clock = makeClock(0);
		const w = new InterruptGraceWindow(1000, clock.now);
		w.onAudioStart();
		clock.advance(999);
		expect(w.isActive()).toBe(true);
		expect(w.remainingMs()).toBe(1);
		clock.advance(1);
		expect(w.isActive()).toBe(false);
		expect(w.remainingMs()).toBe(0);
	});

	it('second onAudioStart without reset() is a no-op — does NOT re-arm after expiry', () => {
		const clock = makeClock(0);
		const w = new InterruptGraceWindow(1000, clock.now);
		w.onAudioStart();
		clock.advance(1500); // past expiry
		expect(w.isActive()).toBe(false);
		w.onAudioStart(); // would re-arm if not idempotent
		expect(w.isActive()).toBe(false);
		expect(w.remainingMs()).toBe(0);
	});

	it('reset() clears both deadline and first-audio flag — next onAudioStart re-arms', () => {
		const clock = makeClock(0);
		const w = new InterruptGraceWindow(1000, clock.now);
		w.onAudioStart();
		clock.advance(500);
		expect(w.isActive()).toBe(true);
		w.reset();
		expect(w.isActive()).toBe(false);
		expect(w.remainingMs()).toBe(0);
		// Next chunk re-arms.
		w.onAudioStart();
		expect(w.isActive()).toBe(true);
		expect(w.remainingMs()).toBe(1000);
	});

	it('reset() during the window pre-expiry also re-arms cleanly', () => {
		const clock = makeClock(0);
		const w = new InterruptGraceWindow(1000, clock.now);
		w.onAudioStart();
		clock.advance(200);
		w.reset();
		clock.advance(50);
		w.onAudioStart();
		expect(w.remainingMs()).toBe(1000);
	});

	it('remainingMs returns 0 when never armed', () => {
		const clock = makeClock(0);
		const w = new InterruptGraceWindow(500, clock.now);
		expect(w.remainingMs()).toBe(0);
	});

	it('defaults to Date.now when no clock is injected', () => {
		const w = new InterruptGraceWindow(100);
		expect(w.isActive()).toBe(false);
		w.onAudioStart();
		// We can't deterministically check remainingMs, but it must be > 0
		// immediately after arming with a positive window.
		expect(w.isActive()).toBe(true);
		expect(w.remainingMs()).toBeGreaterThan(0);
		expect(w.remainingMs()).toBeLessThanOrEqual(100);
	});
});
