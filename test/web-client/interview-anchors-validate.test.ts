// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { validateInterviewAnchorsForDraft } from '../../app/web-client/src/interview-anchors-validate.js';

describe('validateInterviewAnchorsForDraft', () => {
	it('accepts valid anchors', () => {
		const r = validateInterviewAnchorsForDraft([
			{ id: 'a', focus: 'x' },
			{ id: 'b', spec: 'y' },
		]);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.anchors).toEqual([
			{ id: 'a', focus: 'x' },
			{ id: 'b', spec: 'y' },
		]);
	});

	it('rejects invalid id pattern', () => {
		const r = validateInterviewAnchorsForDraft([{ id: 'Bad', focus: 'x' }]);
		expect(r.ok).toBe(false);
	});

	it('rejects duplicate ids', () => {
		const r = validateInterviewAnchorsForDraft([{ id: 'same' }, { id: 'same' }]);
		expect(r.ok).toBe(false);
	});
});
