// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	type ChatEvent,
	type GatewayChatEventRaw,
	normalizeEvent,
} from '../../app/lib/openclaw-client.js';

describe('normalizeEvent', () => {
	const baseRaw: GatewayChatEventRaw = {
		runId: 'run-1',
		sessionKey: 'bodhi:sess-1',
		seq: 0,
		state: 'delta',
		message: { role: 'assistant', content: 'Working on it...' },
	};

	it('normalizes delta event — extracts text from message.content', () => {
		const event = normalizeEvent(baseRaw);

		expect(event).toEqual({
			source: 'chat',
			runId: 'run-1',
			state: 'delta',
			text: 'Working on it...',
			error: undefined,
			stopReason: undefined,
		});
	});

	it('normalizes final event with stopReason=stop → finalDisposition=completed', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			seq: 2,
			state: 'final',
			message: { role: 'assistant', content: 'Done! Here is the code.' },
			stopReason: 'stop',
		};

		const event = normalizeEvent(raw);

		expect(event.state).toBe('final');
		expect(event.finalDisposition).toBe('completed');
		expect(event.text).toBe('Done! Here is the code.');
	});

	it('normalizes final event with stopReason=max_tokens → finalDisposition=completed', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			state: 'final',
			stopReason: 'max_tokens',
		};

		const event = normalizeEvent(raw);
		expect(event.finalDisposition).toBe('completed');
	});

	it('normalizes final event with stopReason=needs_input → finalDisposition=needs_input', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			state: 'final',
			message: { role: 'assistant', content: 'Which file should I edit?' },
			stopReason: 'needs_input',
		};

		const event = normalizeEvent(raw);

		expect(event.finalDisposition).toBe('needs_input');
		expect(event.text).toBe('Which file should I edit?');
	});

	it('normalizes final event with missing stopReason → finalDisposition=completed', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			state: 'final',
			// No stopReason — treated as completed (gateway may omit stopReason)
		};

		const event = normalizeEvent(raw);
		expect(event.finalDisposition).toBe('completed');
	});

	it('normalizes final event with unrecognized stopReason → finalDisposition=completed', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			state: 'final',
			stopReason: 'end_turn',
		};

		const event = normalizeEvent(raw);
		expect(event.finalDisposition).toBe('completed');
	});

	it('normalizes error event — extracts errorMessage', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			state: 'error',
			message: undefined,
			errorMessage: 'Rate limit exceeded',
		};

		const event = normalizeEvent(raw);

		expect(event.state).toBe('error');
		expect(event.error).toBe('Rate limit exceeded');
		expect(event.text).toBeUndefined();
		expect(event.finalDisposition).toBeUndefined();
	});

	it('normalizes aborted event', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			state: 'aborted',
			message: undefined,
		};

		const event = normalizeEvent(raw);

		expect(event.state).toBe('aborted');
		expect(event.finalDisposition).toBeUndefined();
	});

	it('delta event has no finalDisposition', () => {
		const event = normalizeEvent(baseRaw);
		expect(event.finalDisposition).toBeUndefined();
	});

	it('preserves stopReason on final events', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			state: 'final',
			stopReason: 'stop',
		};

		const event = normalizeEvent(raw);
		expect(event.stopReason).toBe('stop');
	});
});
