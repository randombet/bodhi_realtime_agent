// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/event-bus.js';

describe('EventBus', () => {
	it('delivers payload to subscriber', () => {
		const bus = new EventBus();
		const handler = vi.fn();
		bus.subscribe('tool.call', handler);

		const payload = {
			toolCallId: 'tc_1',
			toolName: 'search',
			args: { q: 'hello' },
			sessionId: 'sess_1',
			agentName: 'main',
		};
		bus.publish('tool.call', payload);

		expect(handler).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledWith(payload);
	});

	it('delivers to multiple subscribers', () => {
		const bus = new EventBus();
		const h1 = vi.fn();
		const h2 = vi.fn();
		bus.subscribe('turn.end', h1);
		bus.subscribe('turn.end', h2);

		bus.publish('turn.end', { sessionId: 's', turnId: 't' });

		expect(h1).toHaveBeenCalledOnce();
		expect(h2).toHaveBeenCalledOnce();
	});

	it('unsubscribe removes only the target handler', () => {
		const bus = new EventBus();
		const h1 = vi.fn();
		const h2 = vi.fn();
		const unsub = bus.subscribe('turn.end', h1);
		bus.subscribe('turn.end', h2);

		unsub();
		bus.publish('turn.end', { sessionId: 's', turnId: 't' });

		expect(h1).not.toHaveBeenCalled();
		expect(h2).toHaveBeenCalledOnce();
	});

	it('handler error does not prevent other handlers from running', () => {
		const bus = new EventBus();
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const bad = vi.fn(() => {
			throw new Error('handler broke');
		});
		const good = vi.fn();
		bus.subscribe('session.close', bad);
		bus.subscribe('session.close', good);

		bus.publish('session.close', { sessionId: 's', reason: 'done' });

		expect(bad).toHaveBeenCalledOnce();
		expect(good).toHaveBeenCalledOnce();
		expect(consoleSpy).toHaveBeenCalledOnce();

		consoleSpy.mockRestore();
	});

	it('publish with no subscribers is a no-op', () => {
		const bus = new EventBus();
		expect(() => {
			bus.publish('turn.start', { sessionId: 's', turnId: 't' });
		}).not.toThrow();
	});

	it('clear removes all handlers', () => {
		const bus = new EventBus();
		const h1 = vi.fn();
		const h2 = vi.fn();
		bus.subscribe('turn.start', h1);
		bus.subscribe('session.close', h2);

		bus.clear();

		bus.publish('turn.start', { sessionId: 's', turnId: 't' });
		bus.publish('session.close', { sessionId: 's', reason: 'done' });

		expect(h1).not.toHaveBeenCalled();
		expect(h2).not.toHaveBeenCalled();
	});

	it('does not call handler after unsubscribe', () => {
		const bus = new EventBus();
		const handler = vi.fn();
		const unsub = bus.subscribe('agent.enter', handler);

		unsub();
		bus.publish('agent.enter', { sessionId: 's', agentName: 'a' });

		expect(handler).not.toHaveBeenCalled();
	});

	it('double unsubscribe is safe', () => {
		const bus = new EventBus();
		const handler = vi.fn();
		const unsub = bus.subscribe('turn.start', handler);

		unsub();
		expect(() => unsub()).not.toThrow();
	});
});
