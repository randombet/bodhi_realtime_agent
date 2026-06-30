/**
 * Type-only tests for the BackgroundAgent public surface
 * (`src/agent/background-agent.ts`). The host actor's runtime behavior is
 * tested separately in
 * `test/runtime/background-agent-host-actor.test.ts`.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
	BackgroundAgent,
	BackgroundAgentContext,
	PublishNotification,
} from '../../src/agent/background-agent.js';

describe('BackgroundAgent — type surface', () => {
	it('accepts a minimal user agent with only name + onStart', () => {
		const agent: BackgroundAgent = {
			name: 'minimal-reminder',
			onStart: () => undefined,
		};
		expect(agent.name).toBe('minimal-reminder');
	});

	it('accepts the full lifecycle hook surface', () => {
		const agent: BackgroundAgent = {
			name: 'full-suite',
			cancelOnTransfer: true,
			onStart: async (ctx) => {
				ctx.publish({ label: 'TIME REMINDER', text: 'started' });
			},
			onStop: (reason) => {
				expectTypeOf(reason).toEqualTypeOf<string>();
			},
			onAgentTransfer: (event) => {
				expectTypeOf(event).toEqualTypeOf<{ fromAgent: string; toAgent: string }>();
			},
			onReconnect: () => undefined,
		};
		expect(agent.cancelOnTransfer).toBe(true);
	});

	it('publish accepts the documented payload fields', () => {
		const fakeCtx: BackgroundAgentContext = {
			sessionId: 's1',
			userId: 'u1',
			publish: () => undefined,
			signal: new AbortController().signal,
			session: { phase: 'active', activeAgent: 'main' },
			log: () => undefined,
		};
		const fullPayload: PublishNotification = {
			label: 'TIME REMINDER',
			text: '5 min left',
			priority: 'high',
			turnComplete: true,
			dedupKey: 'time',
			correlationId: 'trace-abc',
		};
		fakeCtx.publish(fullPayload);

		// KnownNotificationLabel autocomplete + (string & {}) escape hatch:
		// both literal and arbitrary user labels are valid.
		fakeCtx.publish({ label: 'SYSTEM', text: 'known' });
		fakeCtx.publish({ label: 'CUSTOM_USER_LABEL', text: 'custom' });
	});

	it('session view exposes phase + activeAgent only (read-only)', () => {
		const view = { phase: 'active' as const, activeAgent: 'main' };
		expectTypeOf(view).toMatchTypeOf<BackgroundAgentContext['session']>();
	});

	it('signal is a standard AbortSignal', () => {
		const fakeCtx: BackgroundAgentContext = {
			sessionId: 's1',
			userId: 'u1',
			publish: () => undefined,
			signal: new AbortController().signal,
			session: { phase: 'active', activeAgent: 'main' },
			log: () => undefined,
		};
		expect(fakeCtx.signal).toBeInstanceOf(AbortSignal);
	});
});
