import { describe, expect, it, vi } from 'vitest';
import { ResponseTriggerCoordinator } from '../../src/core/response-trigger-coordinator.js';

describe('ResponseTriggerCoordinator (Phase 3: invalidation-only)', () => {
	it('competing triggers invalidate the greeting token before dispatch', () => {
		const onCompetingTrigger = vi.fn();
		const c = new ResponseTriggerCoordinator({ onCompetingTrigger });
		c.dispatch('direct-input');
		c.dispatch('notification');
		c.dispatch('watchdog-recovery');
		expect(onCompetingTrigger.mock.calls.map((c0) => c0[0])).toEqual([
			'direct-input',
			'notification',
			'watchdog-recovery',
		]);
	});

	it('greeting registrations and same-response tool continuations are NOT competing', () => {
		const onCompetingTrigger = vi.fn();
		const c = new ResponseTriggerCoordinator({ onCompetingTrigger });
		c.dispatch('greeting');
		c.dispatch('transfer-greeting');
		c.dispatch('tool-result');
		expect(onCompetingTrigger).not.toHaveBeenCalled();
	});
});
