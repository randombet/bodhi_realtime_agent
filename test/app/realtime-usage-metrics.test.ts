// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { deriveUsageMetricRowsFromRealtimeUsage } from '../../app/server/realtime-usage-metrics.js';

describe('deriveUsageMetricRowsFromRealtimeUsage', () => {
	it('returns empty for non-final phase', () => {
		expect(
			deriveUsageMetricRowsFromRealtimeUsage({
				provider: 'gemini_live',
				kind: 'response',
				phase: 'update',
				unit: 'tokens',
				totalTokens: 99,
			}),
		).toEqual([]);
	});

	it('splits OpenAI-style response into input and output token rows', () => {
		const rows = deriveUsageMetricRowsFromRealtimeUsage({
			provider: 'openai_realtime',
			kind: 'response',
			phase: 'final',
			unit: 'tokens',
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
		});
		expect(rows).toEqual([
			{ metric: 'realtime_voice_input_tokens', quantity: 10, unit: 'tokens' },
			{ metric: 'realtime_voice_output_tokens', quantity: 5, unit: 'tokens' },
		]);
	});

	it('uses total row when split is incomplete', () => {
		const rows = deriveUsageMetricRowsFromRealtimeUsage({
			provider: 'gemini_live',
			kind: 'response',
			phase: 'final',
			unit: 'tokens',
			totalTokens: 42,
		});
		expect(rows).toEqual([{ metric: 'realtime_voice_total_tokens', quantity: 42, unit: 'tokens' }]);
	});

	it('maps transcription duration to ms', () => {
		const rows = deriveUsageMetricRowsFromRealtimeUsage({
			provider: 'openai_realtime',
			kind: 'input_transcription',
			phase: 'final',
			unit: 'duration_seconds',
			durationSeconds: 1.5,
		});
		expect(rows).toEqual([{ metric: 'realtime_transcription_ms', quantity: 1500, unit: 'ms' }]);
	});
});
