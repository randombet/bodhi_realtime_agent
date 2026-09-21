import { describe, expect, it } from 'vitest';
import { aggregateUsageRows } from '../../app/server/stores/user-usage-repository.js';

describe('user-usage-repository', () => {
	it('aggregateUsageRows sums same day, surface, profile, metric, unit', () => {
		const rows = [
			{
				createdAt: '2026-01-15T10:00:00.000Z',
				surface: 'studio_web',
				agentProfile: 'ua_abc',
				metric: 'llm_total_tokens',
				quantity: 10,
				unit: 'tokens',
			},
			{
				createdAt: '2026-01-15T18:00:00.000Z',
				surface: 'studio_web',
				agentProfile: 'ua_abc',
				metric: 'llm_total_tokens',
				quantity: 5,
				unit: 'tokens',
			},
			{
				createdAt: '2026-01-16T01:00:00.000Z',
				surface: 'integration_api',
				agentProfile: 'ua_abc',
				metric: 'rest_session_intent',
				quantity: 1,
				unit: 'count',
			},
		];
		const out = aggregateUsageRows(rows);
		const tokens = out.find((b) => b.metric === 'llm_total_tokens' && b.day === '2026-01-15');
		expect(tokens?.total).toBe(15);
		expect(out.find((b) => b.metric === 'rest_session_intent')?.total).toBe(1);
	});
});
