import { describe, expect, it } from 'vitest';
import {
	decideOnGateReleased,
	decideOnWatchdogFire,
} from '../../../src/core/policies/recovery.policy.js';

describe('decideOnWatchdogFire (H4)', () => {
	it('live user speech defers (R7a) — even when suppression is also armed', () => {
		expect(decideOnWatchdogFire({ speechActive: true, greetingSuppressionArmed: true })).toBe(
			'defer-speech',
		);
	});

	it('full-greeting suppression holds the recovery', () => {
		expect(decideOnWatchdogFire({ speechActive: false, greetingSuppressionArmed: true })).toBe(
			'hold-gate',
		);
	});

	it('otherwise recovers (grace windows are NOT a hold input — callers pass suppression only)', () => {
		expect(decideOnWatchdogFire({ speechActive: false, greetingSuppressionArmed: false })).toBe(
			'recover',
		);
	});
});

describe('decideOnGateReleased (re-evaluation, never blind)', () => {
	it('fresh user speech at release defers instead of recovering underneath it', () => {
		expect(decideOnGateReleased({ speechActive: true, sessionActive: true })).toBe('defer-speech');
	});

	it('a torn-down session idles', () => {
		expect(decideOnGateReleased({ speechActive: false, sessionActive: false })).toBe('idle');
	});

	it('otherwise the held recovery proceeds', () => {
		expect(decideOnGateReleased({ speechActive: false, sessionActive: true })).toBe('recover');
	});
});
