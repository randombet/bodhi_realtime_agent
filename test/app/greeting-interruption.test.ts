import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { greetingInterruptibleForSurface } from '../../app/lib/greeting-interruption.js';

/**
 * Per-surface operator config for greeting interruption:
 * GREETING_INTERRUPTION_ENABLED_WEB / _MOBILE / _PHONE. Unset → enabled
 * (today's behavior); explicit false/0/no → the surface's sessions get
 * `greetingInterruptible: false` (full-greeting suppression).
 */

const VARS = [
	'GREETING_INTERRUPTION_ENABLED_WEB',
	'GREETING_INTERRUPTION_ENABLED_MOBILE',
	'GREETING_INTERRUPTION_ENABLED_PHONE',
] as const;

describe('greetingInterruptibleForSurface', () => {
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
		for (const v of VARS) delete process.env[v];
	});

	afterEach(() => {
		for (const v of VARS) {
			if (saved[v] === undefined) delete process.env[v];
			else process.env[v] = saved[v];
		}
	});

	it('defaults to interruptible (true) for every surface when env is unset', () => {
		expect(greetingInterruptibleForSurface('web')).toBe(true);
		expect(greetingInterruptibleForSurface('mobile')).toBe(true);
		expect(greetingInterruptibleForSurface('phone')).toBe(true);
	});

	it('disables only the surface whose var is set to false', () => {
		process.env.GREETING_INTERRUPTION_ENABLED_WEB = 'false';
		expect(greetingInterruptibleForSurface('web')).toBe(false);
		expect(greetingInterruptibleForSurface('mobile')).toBe(true);
		expect(greetingInterruptibleForSurface('phone')).toBe(true);
	});

	it('accepts false/0/no (any case, trimmed) as disabled', () => {
		for (const raw of ['false', 'FALSE', ' 0 ', 'No']) {
			process.env.GREETING_INTERRUPTION_ENABLED_MOBILE = raw;
			expect(greetingInterruptibleForSurface('mobile')).toBe(false);
		}
	});

	it('treats unrecognized values as enabled (fail-open to current behavior)', () => {
		process.env.GREETING_INTERRUPTION_ENABLED_PHONE = 'off-ish';
		expect(greetingInterruptibleForSurface('phone')).toBe(true);
	});
});
