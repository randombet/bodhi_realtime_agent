// SPDX-License-Identifier: MIT

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactRegistry } from '../../app/lib/artifact-registry.js';
import { PersistentClaudeSubagent } from '../../app/lib/persistent-claude-subagent.js';
import type { PersistentClaudeSubagentOptions } from '../../app/lib/persistent-claude-subagent.js';

// Mock the ClaudeCodeSession class
vi.mock('../../app/lib/claude-code-client.js', () => {
	let callCount = 0;
	return {
		ClaudeCodeSession: vi.fn().mockImplementation(() => {
			callCount++;
			const id = callCount;
			return {
				start: vi.fn().mockResolvedValue({
					status: 'completed',
					text: `result from session #${id}`,
					sdkSessionId: `sdk-session-${id}`,
				}),
				resume: vi.fn().mockResolvedValue({
					status: 'completed',
					text: `resumed result from session #${id}`,
					sdkSessionId: `sdk-session-${id}`,
				}),
				respond: vi.fn(),
				abort: vi.fn().mockResolvedValue(undefined),
				isAborted: false,
			};
		}),
	};
});

const sessionOptions: PersistentClaudeSubagentOptions = {
	cwd: '/test/project',
	model: 'claude-sonnet-4-5-20250929',
};

describe('PersistentClaudeSubagent', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('first invoke calls start(), not resume()', async () => {
		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		const result = await agent.invoke('Fix the bug', {});

		expect(result).toContain('result from session');
		// ClaudeCodeSession was constructed
		const { ClaudeCodeSession } = await import('../../app/lib/claude-code-client.js');
		expect(ClaudeCodeSession).toHaveBeenCalled();
	});

	it('second invoke calls resume() with saved sdkSessionId', async () => {
		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);

		// First call — uses start()
		await agent.invoke('Fix the bug', {});

		// Second call — should use resume() with the saved sdkSessionId
		const result = await agent.invoke('Now add tests', {});
		expect(result).toContain('resumed result');
	});

	it('creates a new ClaudeCodeSession per invoke (avoids started flag)', async () => {
		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		const { ClaudeCodeSession } = await import('../../app/lib/claude-code-client.js');

		await agent.invoke('Task 1', {});
		await agent.invoke('Task 2', {});

		// Two separate ClaudeCodeSession instances were created
		expect(ClaudeCodeSession).toHaveBeenCalledTimes(2);
	});

	it('throws when invoked after dispose', async () => {
		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		await agent.dispose();

		await expect(agent.invoke('Task', {})).rejects.toThrow('disposed');
	});

	it('dispose is idempotent', async () => {
		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		await agent.dispose();
		await agent.dispose(); // Should not throw
	});

	it('abort signal aborts the active session', async () => {
		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		const controller = new AbortController();

		// Start invoke but don't await it yet
		const promise = agent.invoke('Long task', {}, controller.signal);

		// The session was already created synchronously, abort it
		controller.abort();

		// Should still resolve (mock resolves immediately)
		const result = await promise;
		expect(result).toBeDefined();
	});

	it('propagates errors from ClaudeCodeSession', async () => {
		const { ClaudeCodeSession } = await import('../../app/lib/claude-code-client.js');
		(ClaudeCodeSession as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
			start: vi.fn().mockResolvedValue({
				status: 'error',
				text: '',
				error: 'Something went wrong',
			}),
			abort: vi.fn().mockResolvedValue(undefined),
		}));

		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		await expect(agent.invoke('Bad task', {})).rejects.toThrow('Something went wrong');
	});

	it('surfaces needs_input as descriptive text with question', async () => {
		const { ClaudeCodeSession } = await import('../../app/lib/claude-code-client.js');
		(ClaudeCodeSession as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
			start: vi.fn().mockResolvedValue({
				status: 'needs_input',
				text: 'Partial work done.',
				sdkSessionId: 'sdk-needs-input',
				question: 'Which file should I edit?',
				questionOptions: [
					{ label: 'src/index.ts', description: 'Main entry point' },
					{ label: 'src/utils.ts', description: 'Utility functions' },
				],
			}),
			abort: vi.fn().mockResolvedValue(undefined),
		}));

		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		const result = await agent.invoke('Edit a file', {});

		expect(result).toContain('Partial work done.');
		expect(result).toContain('[Needs input]');
		expect(result).toContain('Which file should I edit?');
		expect(result).toContain('src/index.ts');
		expect(result).toContain('src/utils.ts');
	});

	it('needs_input without options omits options list', async () => {
		const { ClaudeCodeSession } = await import('../../app/lib/claude-code-client.js');
		(ClaudeCodeSession as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
			start: vi.fn().mockResolvedValue({
				status: 'needs_input',
				text: '',
				sdkSessionId: 'sdk-ni',
				question: 'What should I do next?',
			}),
			abort: vi.fn().mockResolvedValue(undefined),
		}));

		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		const result = await agent.invoke('Do something', {});

		expect(result).toContain('[Needs input] What should I do next?');
		expect(result).not.toContain('Options:');
	});

	it('creates fresh MCP servers per invoke via mcpServerFactory', async () => {
		const { ClaudeCodeSession } = await import('../../app/lib/claude-code-client.js');
		const factory = vi.fn().mockReturnValue({ myServer: {} });

		const agent = new PersistentClaudeSubagent('claude-1', {
			...sessionOptions,
			mcpServerFactory: factory,
		});

		await agent.invoke('Task 1', {});
		await agent.invoke('Task 2', {});

		// Factory called once per invoke, not once at construction
		expect(factory).toHaveBeenCalledTimes(2);

		// Each ClaudeCodeSession receives fresh mcpServers
		const calls = (ClaudeCodeSession as unknown as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls[0][0].mcpServers).toEqual({ myServer: {} });
		expect(calls[1][0].mcpServers).toEqual({ myServer: {} });
	});

	it('materializes requested artifacts into workspace and augments task', async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), 'bodhi-persistent-claude-'));
		try {
			const registry = new ArtifactRegistry();
			const artId = registry.store('aGVsbG8=', 'image/png', 'demo image', 'generated', 'demo.png');

			const agent = new PersistentClaudeSubagent('claude-1', {
				...sessionOptions,
				cwd,
				artifactRegistry: registry,
			});
			await agent.invoke('Please analyze this image', { artifactIds: [artId] });

			const { ClaudeCodeSession } = await import('../../app/lib/claude-code-client.js');
			const ctor = ClaudeCodeSession as unknown as ReturnType<typeof vi.fn>;
			const instance = ctor.mock.results[0]?.value as { start: ReturnType<typeof vi.fn> };
			const startedWith = instance.start.mock.calls[0]?.[0] as string;

			expect(startedWith).toContain('The user attached artifact file(s) for this task.');
			expect(startedWith).toContain(artId);
			expect(startedWith).toContain('Original task:');
			expect(startedWith).toContain('Please analyze this image');

			const materializedPath = path.join(cwd, '.bodhi_artifacts', `${artId}_demo.png`);
			expect(existsSync(materializedPath)).toBe(true);
			expect(readFileSync(materializedPath, 'utf8')).toBe('hello');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it('throws when artifactIds are provided but no registry is configured', async () => {
		const agent = new PersistentClaudeSubagent('claude-1', sessionOptions);
		await expect(
			agent.invoke('Use file', { artifactIds: ['art_missing_registry'] }),
		).rejects.toThrow('no artifact registry');
	});
});
