// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { InteractionModeManager } from '../../src/core/interaction-mode.js';

describe('InteractionModeManager', () => {
	it('starts in main_agent mode', () => {
		const mgr = new InteractionModeManager();
		expect(mgr.getMode()).toEqual({ type: 'main_agent' });
		expect(mgr.isSubagentActive()).toBe(false);
		expect(mgr.getActiveToolCallId()).toBeNull();
	});

	it('activate() switches to subagent_interaction immediately when idle', async () => {
		const mgr = new InteractionModeManager();
		await mgr.activate('tc-1', 'Enter your info');

		expect(mgr.getMode()).toEqual({
			type: 'subagent_interaction',
			toolCallId: 'tc-1',
			prompt: 'Enter your info',
		});
		expect(mgr.isSubagentActive()).toBe(true);
		expect(mgr.getActiveToolCallId()).toBe('tc-1');
	});

	it('deactivate() reverts to main_agent when no queue', () => {
		const mgr = new InteractionModeManager();
		mgr.activate('tc-1');
		mgr.deactivate('tc-1');

		expect(mgr.getMode()).toEqual({ type: 'main_agent' });
		expect(mgr.isSubagentActive()).toBe(false);
	});

	it('queues second subagent and promotes on deactivate (FIFO)', async () => {
		const mgr = new InteractionModeManager();
		await mgr.activate('tc-1');

		// Second activation should queue
		let promoted = false;
		const p = mgr.activate('tc-2', 'second').then(() => {
			promoted = true;
		});
		expect(mgr.getActiveToolCallId()).toBe('tc-1');
		expect(mgr.queueLength).toBe(1);
		expect(promoted).toBe(false);

		// Deactivate first — should promote second
		mgr.deactivate('tc-1');
		await p;

		expect(promoted).toBe(true);
		expect(mgr.getActiveToolCallId()).toBe('tc-2');
		expect(mgr.queueLength).toBe(0);

		// Deactivate second — back to main_agent
		mgr.deactivate('tc-2');
		expect(mgr.getMode()).toEqual({ type: 'main_agent' });
	});

	it('deactivate() a queued (non-active) subagent removes it from queue', async () => {
		const mgr = new InteractionModeManager();
		await mgr.activate('tc-1');

		// Queue two more
		mgr.activate('tc-2');
		mgr.activate('tc-3');
		expect(mgr.queueLength).toBe(2);

		// Remove tc-2 from queue (not active)
		mgr.deactivate('tc-2');
		expect(mgr.queueLength).toBe(1);
		expect(mgr.getActiveToolCallId()).toBe('tc-1');

		// Deactivate active — should promote tc-3 (tc-2 was removed)
		mgr.deactivate('tc-1');
		expect(mgr.getActiveToolCallId()).toBe('tc-3');
	});

	it('deactivate() is a no-op for unknown toolCallId', () => {
		const mgr = new InteractionModeManager();
		mgr.activate('tc-1');
		// Should not throw or change state
		mgr.deactivate('unknown');
		expect(mgr.getActiveToolCallId()).toBe('tc-1');
	});

	it('FIFO order is maintained for 3+ queued subagents', async () => {
		const mgr = new InteractionModeManager();
		await mgr.activate('tc-1');

		const order: string[] = [];
		const p2 = mgr.activate('tc-2').then(() => order.push('tc-2'));
		const p3 = mgr.activate('tc-3').then(() => order.push('tc-3'));
		const p4 = mgr.activate('tc-4').then(() => order.push('tc-4'));

		mgr.deactivate('tc-1');
		await p2;
		mgr.deactivate('tc-2');
		await p3;
		mgr.deactivate('tc-3');
		await p4;

		expect(order).toEqual(['tc-2', 'tc-3', 'tc-4']);
	});
});
