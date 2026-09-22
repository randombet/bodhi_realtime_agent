import { describe, expect, it } from 'vitest';
import { computeWER, renderOfflineEvalMetrics } from '../../src/observability/offline-eval.js';

describe('computeWER', () => {
	it('is 0 for an exact match (case/space-insensitive)', () => {
		expect(computeWER('How are you doing', 'how   are you doing')).toBe(0);
	});

	it('counts one substitution over four reference words', () => {
		// "doing" → "today": 1 edit / 4 words.
		expect(computeWER('how are you doing', 'how are you today')).toBeCloseTo(0.25, 5);
	});

	it('counts a deletion and an insertion', () => {
		expect(computeWER('a b c', 'a c')).toBeCloseTo(1 / 3, 5); // one deletion / 3
		expect(computeWER('a b c', 'a b c d')).toBeCloseTo(1 / 3, 5); // one insertion / 3
	});

	it('edge cases: empty reference', () => {
		expect(computeWER('', '')).toBe(0);
		expect(computeWER('', 'hello')).toBe(1);
	});
});

describe('renderOfflineEvalMetrics', () => {
	it('emits gauges only for provided fields, with labels', () => {
		const text = renderOfflineEvalMetrics(
			{ wer: 0.05, mos: 4.4, taskSuccess: true, firstCallResolution: false, sentimentScore: 0.3 },
			{ agent: 'interview' },
		);
		expect(text).toContain('# TYPE voice_eval_wer gauge');
		expect(text).toContain('voice_eval_wer{agent="interview"} 0.05');
		expect(text).toContain('voice_eval_mos{agent="interview"} 4.4');
		expect(text).toContain('voice_eval_task_success{agent="interview"} 1');
		expect(text).toContain('voice_eval_fcr{agent="interview"} 0');
		expect(text).toContain('voice_eval_sentiment{agent="interview"} 0.3');
	});

	it('omits absent fields', () => {
		const text = renderOfflineEvalMetrics({ wer: 0.1 });
		expect(text).toContain('voice_eval_wer 0.1');
		expect(text).not.toContain('voice_eval_mos');
	});
});
