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

	// -- Priority tests -------------------------------------------------------

	describe('priority: high', () => {
		it('delivers immediately when idle (no audio)', () => {
			const sendContent = vi.fn();
			const q = new BackgroundNotificationQueue(sendContent, vi.fn());

			q.sendOrQueue(makeTurns('urgent'), true, { priority: 'high' });

			expect(sendContent).toHaveBeenCalledWith(makeTurns('urgent'), true);
		});

		it('queues at front when busy on non-truncation transport (Gemini)', () => {
			const sendContent = vi.fn();
			// messageTruncation = false (default, Gemini)
			const q = new BackgroundNotificationQueue(sendContent, vi.fn(), false);

			q.markAudioReceived();
			q.sendOrQueue(makeTurns('normal1'), true);
			q.sendOrQueue(makeTurns('urgent'), true, { priority: 'high' });
			q.sendOrQueue(makeTurns('normal2'), true);

			expect(sendContent).not.toHaveBeenCalled();

			// On turn complete, high-priority should flush first
			q.onTurnComplete();
			expect(sendContent).toHaveBeenCalledWith(makeTurns('urgent'), true);
		});

		it('delivers immediately when busy on truncation transport (OpenAI)', () => {
			const sendContent = vi.fn();
			// messageTruncation = true (OpenAI)
			const q = new BackgroundNotificationQueue(sendContent, vi.fn(), true);

			q.markAudioReceived();
			q.sendOrQueue(makeTurns('urgent'), true, { priority: 'high' });

			// Should deliver immediately despite audio being received
			expect(sendContent).toHaveBeenCalledWith(makeTurns('urgent'), true);
		});
	});

	describe('mixed priority ordering', () => {
		it('high-priority items flush before normal items', () => {
			const sendContent = vi.fn();
			const q = new BackgroundNotificationQueue(sendContent, vi.fn(), false);

			q.markAudioReceived();
			q.sendOrQueue(makeTurns('normal1'), true);
			q.sendOrQueue(makeTurns('normal2'), true);
			q.sendOrQueue(makeTurns('urgent'), true, { priority: 'high' });

			// Flush all: urgent should come first
			q.onTurnComplete(); // urgent
			q.onTurnComplete(); // normal1
			q.onTurnComplete(); // normal2

			expect(sendContent).toHaveBeenCalledTimes(3);
			expect(sendContent).toHaveBeenNthCalledWith(1, makeTurns('urgent'), true);
			expect(sendContent).toHaveBeenNthCalledWith(2, makeTurns('normal1'), true);
			expect(sendContent).toHaveBeenNthCalledWith(3, makeTurns('normal2'), true);
		});

		it('normal priority maintains FIFO order among normals', () => {
			const sendContent = vi.fn();
			const q = new BackgroundNotificationQueue(sendContent, vi.fn());

			q.markAudioReceived();
			q.sendOrQueue(makeTurns('first'), true);
			q.sendOrQueue(makeTurns('second'), true);
			q.sendOrQueue(makeTurns('third'), true);

			q.onTurnComplete();
			q.onTurnComplete();
			q.onTurnComplete();

			expect(sendContent).toHaveBeenNthCalledWith(1, makeTurns('first'), true);
			expect(sendContent).toHaveBeenNthCalledWith(2, makeTurns('second'), true);
			expect(sendContent).toHaveBeenNthCalledWith(3, makeTurns('third'), true);
		});
	});
});
