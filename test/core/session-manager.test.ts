// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { SessionError } from '../../src/core/errors.js';
import { EventBus } from '../../src/core/event-bus.js';
import { HooksManager } from '../../src/core/hooks.js';
import { SessionManager } from '../../src/core/session-manager.js';

function createManager() {
	const eventBus = new EventBus();
	const hooks = new HooksManager();
	const mgr = new SessionManager(
		{ sessionId: 'sess_1', userId: 'user_1', initialAgent: 'general' },
		eventBus,
		hooks,
	);
	return { mgr, eventBus, hooks };
}

describe('SessionManager', () => {
	it('starts in CREATED state', () => {
		const { mgr } = createManager();
		expect(mgr.state).toBe('CREATED');
		expect(mgr.isActive).toBe(false);
		expect(mgr.isDisconnected).toBe(false);
	});

	describe('valid transitions', () => {
		it('CREATED → CONNECTING → ACTIVE', () => {
			const { mgr } = createManager();
			mgr.transitionTo('CONNECTING');
			expect(mgr.state).toBe('CONNECTING');
			mgr.transitionTo('ACTIVE');
			expect(mgr.state).toBe('ACTIVE');
			expect(mgr.isActive).toBe(true);
		});

		it('ACTIVE → RECONNECTING → ACTIVE', () => {
			const { mgr } = createManager();
			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			mgr.transitionTo('RECONNECTING');
			expect(mgr.state).toBe('RECONNECTING');
			expect(mgr.isDisconnected).toBe(true);
			mgr.transitionTo('ACTIVE');
			expect(mgr.state).toBe('ACTIVE');
		});

		it('ACTIVE → TRANSFERRING → ACTIVE', () => {
			const { mgr } = createManager();
			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			mgr.transitionTo('TRANSFERRING');
			expect(mgr.state).toBe('TRANSFERRING');
			expect(mgr.isDisconnected).toBe(true);
			mgr.transitionTo('ACTIVE');
			expect(mgr.state).toBe('ACTIVE');
		});

		it('ACTIVE → CLOSED', () => {
			const { mgr } = createManager();
			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			mgr.transitionTo('CLOSED');
			expect(mgr.state).toBe('CLOSED');
		});

		it('CREATED → CLOSED (fatal)', () => {
			const { mgr } = createManager();
			mgr.transitionTo('CLOSED');
			expect(mgr.state).toBe('CLOSED');
		});
	});

	describe('invalid transitions', () => {
		it('CREATED → ACTIVE throws', () => {
			const { mgr } = createManager();
			expect(() => mgr.transitionTo('ACTIVE')).toThrow(SessionError);
		});

		it('CLOSED → anything throws', () => {
			const { mgr } = createManager();
			mgr.transitionTo('CLOSED');
			expect(() => mgr.transitionTo('CONNECTING')).toThrow(SessionError);
			expect(() => mgr.transitionTo('ACTIVE')).toThrow(SessionError);
		});

		it('CONNECTING → RECONNECTING throws', () => {
			const { mgr } = createManager();
			mgr.transitionTo('CONNECTING');
			expect(() => mgr.transitionTo('RECONNECTING')).toThrow(SessionError);
		});
	});

	describe('events and hooks', () => {
		it('fires session.stateChange event on transition', () => {
			const { mgr, eventBus } = createManager();
			const handler = vi.fn();
			eventBus.subscribe('session.stateChange', handler);

			mgr.transitionTo('CONNECTING');

			expect(handler).toHaveBeenCalledWith({
				sessionId: 'sess_1',
				fromState: 'CREATED',
				toState: 'CONNECTING',
			});
		});

		it('fires onSessionStart hook on first ACTIVE', () => {
			const { mgr, hooks } = createManager();
			const onSessionStart = vi.fn();
			hooks.register({ onSessionStart });

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');

			expect(onSessionStart).toHaveBeenCalledWith({
				sessionId: 'sess_1',
				userId: 'user_1',
				agentName: 'general',
			});
		});

		it('fires session.start event on first ACTIVE', () => {
			const { mgr, eventBus } = createManager();
			const handler = vi.fn();
			eventBus.subscribe('session.start', handler);

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');

			expect(handler).toHaveBeenCalledOnce();
		});

		it('does not fire onSessionStart on reconnect ACTIVE', () => {
			const { mgr, hooks } = createManager();
			const onSessionStart = vi.fn();
			hooks.register({ onSessionStart });

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			onSessionStart.mockClear();

			mgr.transitionTo('RECONNECTING');
			mgr.transitionTo('ACTIVE');

			expect(onSessionStart).not.toHaveBeenCalled();
		});

		it('fires onSessionEnd hook on CLOSED', () => {
			const { mgr, hooks } = createManager();
			const onSessionEnd = vi.fn();
			hooks.register({ onSessionEnd });

			mgr.transitionTo('CONNECTING');
			mgr.transitionTo('ACTIVE');
			mgr.transitionTo('CLOSED');

			expect(onSessionEnd).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: 'sess_1',
					reason: 'normal',
				}),
			);
		});
	});

	describe('resumption', () => {
		it('starts with null handle', () => {
			const { mgr } = createManager();
			expect(mgr.resumptionHandle).toBeNull();
		});

		it('updateResumptionHandle stores handle', () => {
			const { mgr } = createManager();
			mgr.updateResumptionHandle('handle_abc');
			expect(mgr.resumptionHandle).toBe('handle_abc');
		});

		it('fires session.resume event', () => {
			const { mgr, eventBus } = createManager();
			const handler = vi.fn();
			eventBus.subscribe('session.resume', handler);

			mgr.updateResumptionHandle('handle_abc');

			expect(handler).toHaveBeenCalledWith({
				sessionId: 'sess_1',
				handle: 'handle_abc',
			});
		});
	});

	describe('message buffering', () => {
		it('buffers and drains messages in order', () => {
			const { mgr } = createManager();
			mgr.bufferMessage({ type: 'audio', data: 'chunk1', timestamp: 1 });
			mgr.bufferMessage({ type: 'audio', data: 'chunk2', timestamp: 2 });

			const messages = mgr.drainBufferedMessages();
			expect(messages).toHaveLength(2);
			expect(messages[0].data).toBe('chunk1');
			expect(messages[1].data).toBe('chunk2');
		});

		it('drain empties the buffer', () => {
			const { mgr } = createManager();
			mgr.bufferMessage({ type: 'audio', data: 'chunk', timestamp: 1 });
			mgr.drainBufferedMessages();

			const second = mgr.drainBufferedMessages();
			expect(second).toHaveLength(0);
		});
	});

	it('exposes config properties', () => {
		const { mgr } = createManager();
		expect(mgr.sessionId).toBe('sess_1');
		expect(mgr.userId).toBe('user_1');
		expect(mgr.initialAgent).toBe('general');
	});
});
