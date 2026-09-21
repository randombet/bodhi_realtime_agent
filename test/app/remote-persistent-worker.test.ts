import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemotePersistentWorker } from '../../app/agents/runtime/remote-persistent-worker.js';

describe('RemotePersistentWorker', () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('POSTs sessionId and task, returns text on completed', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ status: 'completed', text: 'done' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const w = new RemotePersistentWorker('k', 'https://worker.test', 'secret', 'bodhi_sess_tool');
		const out = await w.invoke('ignored', { task: 'fix bug' });

		expect(out).toBe('done');
		expect(globalThis.fetch).toHaveBeenCalledWith(
			'https://worker.test/task',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					Authorization: 'Bearer secret',
					'Content-Type': 'application/json',
				}),
				body: JSON.stringify({ sessionId: 'bodhi_sess_tool', task: 'fix bug' }),
			}),
		);
	});

	it('throws on status error in JSON body', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ status: 'error', text: 'nope' }), { status: 200 }),
			);
		const w = new RemotePersistentWorker('k', 'https://worker.test', 't', 'sid');
		await expect(w.invoke('x', { task: 'y' })).rejects.toThrow('nope');
	});

	it('throws on non-OK HTTP', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue(new Response('bad', { status: 502 }));
		const w = new RemotePersistentWorker('k', 'https://worker.test', 't', 'sid');
		await expect(w.invoke('x', { task: 'y' })).rejects.toThrow(/502/);
	});

	it('uses taskDescription when args.task missing', async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ status: 'completed', text: 'ok' }), { status: 200 }),
			);
		const w = new RemotePersistentWorker('k', 'https://worker.test', 't', 'sid');
		await w.invoke('from description', {});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				body: JSON.stringify({ sessionId: 'sid', task: 'from description' }),
			}),
		);
	});

	it('surfaces fetch failure as Remote worker request failed', async () => {
		const err = new Error('network down');
		globalThis.fetch = vi.fn().mockRejectedValue(err);
		const w = new RemotePersistentWorker('k', 'https://worker.test', 't', 'sid');
		await expect(w.invoke('t', { task: 'x' })).rejects.toThrow(/Remote worker request failed/);
	});
});
