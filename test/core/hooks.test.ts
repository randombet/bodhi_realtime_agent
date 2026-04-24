// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { HooksManager } from '../../src/core/hooks.js';

describe('HooksManager', () => {
	it('returns undefined for unregistered hooks', () => {
		const mgr = new HooksManager();
		expect(mgr.onSessionStart).toBeUndefined();
		expect(mgr.onSessionEnd).toBeUndefined();
		expect(mgr.onTurnLatency).toBeUndefined();
		expect(mgr.onToolCall).toBeUndefined();
		expect(mgr.onToolResult).toBeUndefined();
		expect(mgr.onAgentTransfer).toBeUndefined();
		expect(mgr.onSubagentStep).toBeUndefined();
		expect(mgr.onRealtimeLLMUsage).toBeUndefined();
		expect(mgr.onMemoryExtraction).toBeUndefined();
		expect(mgr.onTTSSynthesis).toBeUndefined();
		expect(mgr.onError).toBeUndefined();
	});

	it('onTTSSynthesis hook fires with timing metrics', () => {
		const mgr = new HooksManager();
		const handler = vi.fn();
		mgr.register({ onTTSSynthesis: handler });

		const event = {
			sessionId: 's',
			provider: 'ElevenLabsTTSProvider',
			textLength: 50,
			durationMs: 1200,
			audioMs: 1000,
			ttfbMs: 200,
			requestId: 1,
		};
		mgr.onTTSSynthesis?.(event);

		expect(handler).toHaveBeenCalledWith(event);
	});

	it('registered handler is invoked', () => {
		const mgr = new HooksManager();
		const handler = vi.fn();
		mgr.register({ onSessionStart: handler });

		const event = { sessionId: 's', userId: 'u', agentName: 'a' };
		mgr.onSessionStart?.(event);

		expect(handler).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledWith(event);
	});

	it('register overwrites per-hook', () => {
		const mgr = new HooksManager();
		const first = vi.fn();
		const second = vi.fn();

		mgr.register({ onError: first });
		mgr.register({ onError: second });

		mgr.onError?.({ component: 'test', error: new Error('x'), severity: 'error' });

		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledOnce();
	});

	it('register merges different hooks', () => {
		const mgr = new HooksManager();
		const startHandler = vi.fn();
		const errorHandler = vi.fn();

		mgr.register({ onSessionStart: startHandler });
		mgr.register({ onError: errorHandler });

		mgr.onSessionStart?.({ sessionId: 's', userId: 'u', agentName: 'a' });
		mgr.onError?.({ component: 'test', error: new Error('x'), severity: 'error' });

		expect(startHandler).toHaveBeenCalledOnce();
		expect(errorHandler).toHaveBeenCalledOnce();
	});

	it('zero-overhead: no function call when hook is not set', () => {
		const mgr = new HooksManager();
		// This pattern: if (hooks.onX) hooks.onX(...) — no overhead when undefined
		let called = false;
		if (mgr.onToolCall) {
			mgr.onToolCall({
				sessionId: 's',
				toolCallId: 'tc',
				toolName: 't',
				execution: 'inline',
				agentName: 'a',
			});
			called = true;
		}
		expect(called).toBe(false);
	});
});
