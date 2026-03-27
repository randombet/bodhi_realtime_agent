// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it } from 'vitest';
import { OpenAIResponseStateTracker } from '../../src/transport/openai-response-state.js';

describe('OpenAIResponseStateTracker', () => {
	let tracker: OpenAIResponseStateTracker;

	beforeEach(() => {
		tracker = new OpenAIResponseStateTracker();
	});

	it('starts in idle state', () => {
		expect(tracker.state).toBe('idle');
		expect(tracker.isIdle).toBe(true);
		expect(tracker.isGenerating).toBe(false);
		expect(tracker.activeResponseId).toBeNull();
	});

	it('transitions to generating on responseCreated', () => {
		tracker.responseCreated('resp-1');

		expect(tracker.state).toBe('generating');
		expect(tracker.isGenerating).toBe(true);
		expect(tracker.isIdle).toBe(false);
		expect(tracker.activeResponseId).toBe('resp-1');
	});

	it('transitions back to idle on responseDone', () => {
		tracker.responseCreated('resp-1');
		tracker.responseDone();

		expect(tracker.state).toBe('idle');
		expect(tracker.activeResponseId).toBeNull();
	});

	it('allows cancel only while generating', () => {
		// Cancel while idle — invalid
		expect(tracker.requestCancel()).toBe(false);
		expect(tracker.state).toBe('idle');

		// Cancel while generating — valid
		tracker.responseCreated('resp-1');
		expect(tracker.requestCancel()).toBe(true);
		expect(tracker.state).toBe('cancelling');
	});

	it('transitions to idle on cancelCompleted', () => {
		tracker.responseCreated('resp-1');
		tracker.requestCancel();
		tracker.cancelCompleted();

		expect(tracker.state).toBe('idle');
		expect(tracker.activeResponseId).toBeNull();
	});

	it('prevents double cancel', () => {
		tracker.responseCreated('resp-1');
		expect(tracker.requestCancel()).toBe(true);
		expect(tracker.requestCancel()).toBe(false); // Already cancelling
	});

	it('resets to idle', () => {
		tracker.responseCreated('resp-1');
		tracker.reset();

		expect(tracker.state).toBe('idle');
		expect(tracker.activeResponseId).toBeNull();
	});
});
