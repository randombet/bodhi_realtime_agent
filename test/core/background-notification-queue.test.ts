// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { BackgroundNotificationQueue } from '../../src/core/background-notification-queue.js';

function makeTurns(text: string) {
	return [{ role: 'user', parts: [{ text }] }];
}

describe('BackgroundNotificationQueue', () => {
	it('sends immediately when no audio has been received', () => {
		const sendContent = vi.fn();
		const q = new BackgroundNotificationQueue(sendContent, vi.fn());

		q.sendOrQueue(makeTurns('hello'), true);

		expect(sendContent).toHaveBeenCalledWith(makeTurns('hello'), true);
	});

	it('queues when audio has been received', () => {
		const sendContent = vi.fn();
		const q = new BackgroundNotificationQueue(sendContent, vi.fn());

		q.markAudioReceived();
		q.sendOrQueue(makeTurns('hello'), true);

		expect(sendContent).not.toHaveBeenCalled();
	});

	it('flushes one queued notification on natural turn complete', () => {
		const sendContent = vi.fn();
		const q = new BackgroundNotificationQueue(sendContent, vi.fn());

		q.markAudioReceived();
		q.sendOrQueue(makeTurns('msg1'), true);
		q.sendOrQueue(makeTurns('msg2'), true);

		q.onTurnComplete();

		// Should flush exactly one
		expect(sendContent).toHaveBeenCalledTimes(1);
		expect(sendContent).toHaveBeenCalledWith(makeTurns('msg1'), true);
	});

	it('does NOT flush on interrupted turn', () => {
		const sendContent = vi.fn();
		const q = new BackgroundNotificationQueue(sendContent, vi.fn());

		q.markAudioReceived();
		q.sendOrQueue(makeTurns('hello'), true);
		q.markInterrupted();

		q.onTurnComplete();

		expect(sendContent).not.toHaveBeenCalled();
	});

	it('flushes remaining after interrupted turn on next natural turn', () => {
		const sendContent = vi.fn();
		const q = new BackgroundNotificationQueue(sendContent, vi.fn());

		q.markAudioReceived();
		q.sendOrQueue(makeTurns('hello'), true);
		q.markInterrupted();
		q.onTurnComplete();
		expect(sendContent).not.toHaveBeenCalled();

		// Next natural turn complete should flush
		q.onTurnComplete();
		expect(sendContent).toHaveBeenCalledWith(makeTurns('hello'), true);
	});

	it('clear drops all queued notifications', () => {
		const sendContent = vi.fn();
		const q = new BackgroundNotificationQueue(sendContent, vi.fn());

		q.markAudioReceived();
		q.sendOrQueue(makeTurns('msg1'), true);
		q.sendOrQueue(makeTurns('msg2'), true);
		q.clear();

		q.onTurnComplete();
		expect(sendContent).not.toHaveBeenCalled();
	});

	it('resetAudio allows immediate send on next call', () => {
		const sendContent = vi.fn();
		const q = new BackgroundNotificationQueue(sendContent, vi.fn());

		q.markAudioReceived();
		q.resetAudio();
		q.sendOrQueue(makeTurns('hello'), true);

		expect(sendContent).toHaveBeenCalledWith(makeTurns('hello'), true);
	});
});
