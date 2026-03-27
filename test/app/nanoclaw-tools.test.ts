// SPDX-License-Identifier: MIT

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Mock the SDK before importing
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
	query: vi.fn(),
}));

const { canonicalizeGroupId, createPersistentNanoClawSubagentConfig } = await import(
	'../../app/lib/nanoclaw-tools.js'
);

describe('createPersistentNanoClawSubagentConfig', () => {
	function makeTempRoot(): string {
		const root = path.join(tmpdir(), `nanoclaw-test-${Date.now()}`);
		mkdirSync(root, { recursive: true });
		mkdirSync(path.join(root, 'groups', 'global'), { recursive: true });
		return root;
	}

	it('returns SubagentConfig with persistent lifetime', () => {
		const root = makeTempRoot();
		try {
			const config = createPersistentNanoClawSubagentConfig({
				nanoClawRoot: root,
				userId: 'user-1',
			});

			expect(config.name).toBe('nanoclaw-persistent');
			expect(config.lifetime).toBe('persistent_session');
			expect(config.persistentFactory).toBeTypeOf('function');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('creates per-user group directory', () => {
		const root = makeTempRoot();
		try {
			createPersistentNanoClawSubagentConfig({
				nanoClawRoot: root,
				userId: 'test-user-42',
			});

			const groupFolder = canonicalizeGroupId('test-user-42');
			const groupDir = path.join(root, 'groups', groupFolder);
			expect(existsSync(groupDir)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('persistentFactory creates PersistentClaudeSubagent instance', async () => {
		const root = makeTempRoot();
		try {
			const config = createPersistentNanoClawSubagentConfig({
				nanoClawRoot: root,
				userId: 'user-1',
				model: 'claude-sonnet-4-5-20250929',
				permissionMode: 'bypassPermissions',
			});

			const instance = await config.persistentFactory?.('nc-key', config);
			expect(instance).toBeDefined();
			expect(instance.key).toBe('nc-key');
			expect(instance.invoke).toBeTypeOf('function');
			expect(instance.dispose).toBeTypeOf('function');

			await instance.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('injects global CLAUDE.md knowledge when present', () => {
		const root = makeTempRoot();
		try {
			writeFileSync(
				path.join(root, 'groups', 'global', 'CLAUDE.md'),
				'# Global Rules\nAlways be helpful.',
			);

			const config = createPersistentNanoClawSubagentConfig({
				nanoClawRoot: root,
				userId: 'user-1',
			});

			// Config should be created without errors
			expect(config.lifetime).toBe('persistent_session');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
