import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientActionHandlers } from '../../app/web-client/src/client-action-handlers.js';
import { state } from '../../app/web-client/src/state.js';

// session_end (issues-client-protocol-audit.md §3): app tools emit
// { type: 'session_end', reason } when the agent decides the call is over
// (user said goodbye, interview completed) — historically a live no-op in
// this client (emitter with no listener). Decision implemented: the client
// ends the call, mirroring what the voice-tool promised the model it would
// do, with a visible transcript line explaining why.

describe('session_end handler', () => {
	afterEach(() => {
		state.ws = null;
		state.connected = false;
	});

	it('exists (the frame is no longer an emitter-with-no-listener)', () => {
		expect(typeof clientActionHandlers.session_end).toBe('function');
	});

	it('ends the call by closing the active socket', () => {
		const close = vi.fn();
		state.ws = { readyState: WebSocket.OPEN, close } as unknown as WebSocket;
		state.connected = true;

		clientActionHandlers.session_end?.({ type: 'session_end', reason: 'user_goodbye' });

		expect(close).toHaveBeenCalledOnce();
	});

	it('is a safe no-op when no call is active (late/duplicate frame)', () => {
		state.ws = null;
		state.connected = false;
		expect(() =>
			clientActionHandlers.session_end?.({ type: 'session_end', reason: 'user_goodbye' }),
		).not.toThrow();
	});
});
