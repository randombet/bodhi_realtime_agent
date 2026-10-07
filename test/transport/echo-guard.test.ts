// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest';
import { EchoGuard, bestEnvelopeLag, envelopePearson } from '../../src/transport/echo-guard.js';

/** Build an s16le mono PCM buffer whose 20ms-frame RMS follows `envelope` (0..1). */
function pcmFromEnvelope(envelope: number[], sampleRate: number): Buffer {
	const samplesPerFrame = Math.round((sampleRate * 20) / 1000);
	const buf = Buffer.alloc(envelope.length * samplesPerFrame * 2);
	let idx = 0;
	for (const level of envelope) {
		for (let i = 0; i < samplesPerFrame; i++) {
			// square wave at the target RMS — deterministic, RMS == level
			const s = Math.round((i % 2 === 0 ? level : -level) * 32767 * 0.99);
			buf.writeInt16LE(s, idx * 2);
			idx++;
		}
	}
	return buf;
}

/** Random-walk envelope — enough structure for correlation to be meaningful. */
function randomWalkEnvelope(n: number, seed = 42): number[] {
	let x = 0.5;
	// Warm the LCG up: small seeds fed straight in start on near-identical
	// trajectories, which made "unrelated" test envelopes spuriously correlated
	// (a test artifact, not a guard weakness).
	let s = (seed * 2654435761) % 2 ** 31;
	for (let i = 0; i < 20; i++) s = (s * 1103515245 + 12345) % 2 ** 31;
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		s = (s * 1103515245 + 12345) % 2 ** 31;
		x += (s / 2 ** 31 - 0.5) * 0.3;
		x = Math.min(0.95, Math.max(0.05, x));
		out.push(x);
	}
	return out;
}

describe('envelopePearson', () => {
	it('is ~1 for identical envelopes and lower for unrelated ones', () => {
		const a = randomWalkEnvelope(32);
		expect(envelopePearson(a, a)).toBeGreaterThan(0.99);
		const b = randomWalkEnvelope(32, 7);
		expect(Math.abs(envelopePearson(a, b))).toBeLessThan(0.6);
	});
});

describe('bestEnvelopeLag', () => {
	it('finds the lag at which the input matches the played ring', () => {
		const env = randomWalkEnvelope(24);
		const now = 100000;
		const lag = 400;
		// played entries: envelope frames ending at (now - lag)
		const played = env.map((rms, i) => ({ rms, at: now - lag - (env.length - 1 - i) * 20 }));
		const best = bestEnvelopeLag(env, played, now, 12, 1500, 20);
		expect(best.corr).toBeGreaterThan(0.9);
		expect(Math.abs(best.lagMs - lag)).toBeLessThanOrEqual(40);
	});
});

// Streaming scenario used below: a 48-frame (960ms) reference envelope is
// "played" ending at t0; the SAME envelope arrives back on the mic 300ms
// later, delivered as two 24-frame chunks — like real speaker loopback.
const ECHO_LAG = 300;
function playAndEcho(guard: EchoGuard): { first: boolean; second: boolean; corr: number } {
	const env = randomWalkEnvelope(48);
	const t0 = 1000000;
	guard.feedReference(pcmFromEnvelope(env, 24000), 24000, t0);
	// chunk1 = first half of the echo, ends 480ms before the echo's end
	const r1 = guard.check(pcmFromEnvelope(env.slice(0, 24), 16000), 16000, t0 - 480 + ECHO_LAG);
	const r2 = guard.check(pcmFromEnvelope(env.slice(24), 16000), 16000, t0 + ECHO_LAG);
	return { first: r1.suppress, second: r2.suppress, corr: r2.corr };
}

describe('EchoGuard', () => {
	it('suppresses inbound audio that echoes recent playback (default streak=2)', () => {
		const res = playAndEcho(new EchoGuard({ enabled: true }));
		expect(res.first).toBe(false); // one correlated window is never enough
		expect(res.second).toBe(true);
		expect(res.corr).toBeGreaterThan(0.75);
	});

	it('passes real speech (uncorrelated with playback, two chunks)', () => {
		const guard = new EchoGuard({ enabled: true });
		const t0 = 1000000;
		guard.feedReference(pcmFromEnvelope(randomWalkEnvelope(48, 42), 24000), 24000, t0);
		const a = guard.check(pcmFromEnvelope(randomWalkEnvelope(24, 7), 16000), 16000, t0 - 180);
		const b = guard.check(pcmFromEnvelope(randomWalkEnvelope(24, 13), 16000), 16000, t0 + 300);
		expect(a.suppress).toBe(false);
		expect(b.suppress).toBe(false);
	});

	it('never suppresses when nothing played recently (stale reference)', () => {
		const guard = new EchoGuard({ enabled: true, refFreshMs: 2000 });
		const env = randomWalkEnvelope(48);
		const t0 = 1000000;
		guard.feedReference(pcmFromEnvelope(env, 24000), 24000, t0);
		// identical audio but 5s after playback stopped — reference stale, fail open
		const r1 = guard.check(pcmFromEnvelope(env.slice(0, 24), 16000), 16000, t0 + 5000);
		const r2 = guard.check(pcmFromEnvelope(env.slice(24), 16000), 16000, t0 + 5480);
		expect(r1.suppress).toBe(false);
		expect(r2.suppress).toBe(false);
	});

	it('honors enabled:false', () => {
		const res = playAndEcho(new EchoGuard({ enabled: false }));
		expect(res.first).toBe(false);
		expect(res.second).toBe(false);
	});
});

describe('EchoGuard opt-in default', () => {
	it('is disabled unless explicitly enabled', () => {
		const guard = new EchoGuard(); // no config — must default OFF
		expect(guard.enabled).toBe(false);
		const env = randomWalkEnvelope(48);
		const t0 = 1000000;
		guard.feedReference(pcmFromEnvelope(env, 24000), 24000, t0);
		const r = guard.check(pcmFromEnvelope(env.slice(24), 16000), 16000, t0 + 300);
		expect(r.suppress).toBe(false);
	});

	it('BODHI_ECHO_GUARD=0 hard-disables even with enabled: true', () => {
		vi.stubEnv('BODHI_ECHO_GUARD', '0');
		try {
			const guard = new EchoGuard({ enabled: true });
			expect(guard.enabled).toBe(false);
			const res = playAndEcho(guard);
			expect(res.first).toBe(false);
			expect(res.second).toBe(false);
			expect(guard.suppressedCount).toBe(0);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
