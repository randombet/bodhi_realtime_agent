// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it } from 'vitest';
import { OpenAIFunctionCallAssembler } from '../../src/transport/openai-function-call-assembler.js';

describe('OpenAIFunctionCallAssembler', () => {
	let assembler: OpenAIFunctionCallAssembler;

	beforeEach(() => {
		assembler = new OpenAIFunctionCallAssembler();
	});

	it('assembles a complete function call from deltas', () => {
		assembler.startCall('call-1', 'get_weather');
		assembler.appendDelta('call-1', '{"ci');
		assembler.appendDelta('call-1', 'ty":');
		assembler.appendDelta('call-1', '"NYC"}');

		const result = assembler.finalize('call-1');

		expect(result).toEqual({
			callId: 'call-1',
			name: 'get_weather',
			args: { city: 'NYC' },
		});
	});

	it('handles empty args', () => {
		assembler.startCall('call-1', 'no_args');
		assembler.appendDelta('call-1', '{}');

		const result = assembler.finalize('call-1');
		expect(result?.args).toEqual({});
	});

	it('handles malformed JSON gracefully', () => {
		assembler.startCall('call-1', 'broken');
		assembler.appendDelta('call-1', '{"incomplete');

		const result = assembler.finalize('call-1');
		expect(result?.args).toEqual({ _raw: '{"incomplete' });
	});

	it('returns null for unknown callId', () => {
		expect(assembler.finalize('unknown')).toBeNull();
	});

	it('tracks pending calls', () => {
		expect(assembler.pendingCount).toBe(0);

		assembler.startCall('call-1', 'fn1');
		assembler.startCall('call-2', 'fn2');

		expect(assembler.pendingCount).toBe(2);
		expect(assembler.hasPendingCall('call-1')).toBe(true);

		assembler.finalize('call-1');
		expect(assembler.pendingCount).toBe(1);
		expect(assembler.hasPendingCall('call-1')).toBe(false);
	});

	it('clears all pending on disconnect', () => {
		assembler.startCall('call-1', 'fn1');
		assembler.startCall('call-2', 'fn2');

		assembler.clear();

		expect(assembler.pendingCount).toBe(0);
	});

	it('ignores delta for unknown callId', () => {
		// Should not throw
		assembler.appendDelta('unknown', 'data');
		expect(assembler.pendingCount).toBe(0);
	});
});
