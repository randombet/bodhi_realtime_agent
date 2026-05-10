// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownConversationHistoryStore } from '../../src/core/markdown-conversation-history-store.js';
import type { ConversationItem, ToolCall, ToolResult } from '../../src/types/conversation.js';
import type { SessionRecord, SessionReport } from '../../src/types/history.js';

const SESSION_START = Date.UTC(2026, 4, 8, 14, 32, 0);
const SESSION_END = Date.UTC(2026, 4, 8, 14, 38, 2);
const TS_USER_1 = Date.UTC(2026, 4, 8, 14, 32, 8);
const TS_ASSISTANT_1 = Date.UTC(2026, 4, 8, 14, 32, 11);
const TS_TOOL_CALL = Date.UTC(2026, 4, 8, 14, 32, 12);
const TS_TOOL_RESULT = Date.UTC(2026, 4, 8, 14, 32, 14);
const TS_ASSISTANT_2 = Date.UTC(2026, 4, 8, 14, 32, 15);
const TS_TRANSFER = Date.UTC(2026, 4, 8, 14, 33, 2);
const TS_ASSISTANT_3 = Date.UTC(2026, 4, 8, 14, 33, 5);

let baseDir: string;

const baseRecord: SessionRecord = {
	id: 'sess_42',
	userId: 'u_9001',
	initialAgentName: 'concierge',
	status: 'active',
	startedAt: SESSION_START,
};

const baseReport: SessionReport = {
	...baseRecord,
	status: 'ended',
	endedAt: SESSION_END,
	analytics: {
		turnCount: 18,
		userMessageCount: 9,
		assistantMessageCount: 9,
		toolCallCount: 4,
		agentTransferCount: 1,
	},
	items: [],
	pendingToolCalls: [],
};

beforeEach(async () => {
	baseDir = await mkdtemp(join(tmpdir(), 'mdhist-'));
});

afterEach(async () => {
	await rm(baseDir, { recursive: true, force: true });
});

describe('MarkdownConversationHistoryStore — frontmatter', () => {
	it('writes the frontmatter + H1 on createSession (no agents field)', async () => {
		const store = new MarkdownConversationHistoryStore({ baseDir, modelName: 'test-model' });
		await store.createSession(baseRecord);

		const md = await readFile(join(baseDir, 'sess_42.md'), 'utf-8');
		expect(md).toContain('sessionId: sess_42');
		expect(md).toContain('userId: u_9001');
		expect(md).toContain('initialAgent: concierge');
		expect(md).toContain('model: test-model');
		expect(md).toContain('startedAt: 2026-05-08T14:32:00.000Z');
		expect(md).not.toMatch(/^agents:/m);
		expect(md).toContain('# Voice session sess_42');
	});

	it('creates baseDir if it does not exist', async () => {
		const nestedBase = join(baseDir, 'nested', 'dir');
		const store = new MarkdownConversationHistoryStore({ baseDir: nestedBase });
		await store.createSession(baseRecord);

		const md = await readFile(join(nestedBase, 'sess_42.md'), 'utf-8');
		expect(md).toContain('# Voice session sess_42');
	});
});

describe('MarkdownConversationHistoryStore — items', () => {
	async function setup(record: SessionRecord = baseRecord) {
		const store = new MarkdownConversationHistoryStore({ baseDir });
		await store.createSession(record);
		return { store, file: join(baseDir, `${record.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`) };
	}

	it('renders a basic single-agent conversation', async () => {
		const { store, file } = await setup();
		await store.addItems('sess_42', [
			{ role: 'user', content: 'Hello!', timestamp: TS_USER_1 },
			{ role: 'assistant', content: 'Hi there.', timestamp: TS_ASSISTANT_1 },
		]);

		const md = await readFile(file, 'utf-8');
		expect(md).toContain('## 14:32:08  User\n\nHello!');
		expect(md).toContain('## 14:32:11  Assistant\n\nHi there.');
		// No agent-name suffix when active === initial.
		expect(md).not.toContain('Assistant (concierge)');
	});

	it('appends across addItems calls (does not rewrite the file)', async () => {
		const { store, file } = await setup();
		await store.addItems('sess_42', [
			{ role: 'user', content: 'first turn', timestamp: TS_USER_1 },
		]);
		await store.addItems('sess_42', [
			{ role: 'assistant', content: 'second turn', timestamp: TS_ASSISTANT_1 },
		]);

		const md = await readFile(file, 'utf-8');
		expect(md.indexOf('first turn')).toBeLessThan(md.indexOf('second turn'));
		expect(md).toContain('first turn');
		expect(md).toContain('second turn');
	});

	it('pairs tool_call + tool_result into one <details> block', async () => {
		const { store, file } = await setup();
		const call: ToolCall = {
			toolCallId: 'tc_1',
			toolName: 'get_weather',
			args: { city: 'Paris' },
		};
		const result: ToolResult = {
			toolCallId: 'tc_1',
			toolName: 'get_weather',
			result: { temp: 18, conditions: 'sunny' },
		};
		await store.addItems('sess_42', [
			{ role: 'tool_call', content: JSON.stringify(call), timestamp: TS_TOOL_CALL },
			{ role: 'tool_result', content: JSON.stringify(result), timestamp: TS_TOOL_RESULT },
		]);

		const md = await readFile(file, 'utf-8');
		const detailsCount = (md.match(/<details>/g) ?? []).length;
		expect(detailsCount).toBe(1);
		expect(md).toContain('⚙️ tool: get_weather');
		expect(md).toContain('"args"');
		expect(md).toContain('"result"');
	});

	it('pairs across separate addItems batches', async () => {
		const { store, file } = await setup();
		const call: ToolCall = { toolCallId: 'tc_1', toolName: 'noop', args: {} };
		const result: ToolResult = { toolCallId: 'tc_1', toolName: 'noop', result: 'ok' };

		await store.addItems('sess_42', [
			{ role: 'tool_call', content: JSON.stringify(call), timestamp: TS_TOOL_CALL },
		]);
		// Between batches: tool_call should NOT be rendered yet.
		let md = await readFile(file, 'utf-8');
		expect(md).not.toContain('<details>');

		await store.addItems('sess_42', [
			{ role: 'tool_result', content: JSON.stringify(result), timestamp: TS_TOOL_RESULT },
		]);
		md = await readFile(file, 'utf-8');
		expect(md).toContain('<details>');
		expect(md).toContain('⚙️ tool: noop');
	});

	it('renders an orphan tool_result (no prior call) with the ↩️ prefix', async () => {
		const { store, file } = await setup();
		const result: ToolResult = { toolCallId: 'tc_late', toolName: 'late', result: 'value' };
		await store.addItems('sess_42', [
			{ role: 'tool_result', content: JSON.stringify(result), timestamp: TS_TOOL_RESULT },
		]);

		const md = await readFile(file, 'utf-8');
		expect(md).toContain('↩️ tool result: late');
	});

	it('renders an orphan tool_call as "(no result)" on saveSessionReport', async () => {
		const { store, file } = await setup();
		const call: ToolCall = { toolCallId: 'tc_lonely', toolName: 'lonely', args: { x: 1 } };
		await store.addItems('sess_42', [
			{ role: 'tool_call', content: JSON.stringify(call), timestamp: TS_TOOL_CALL },
		]);
		// Tool call is buffered; not in file yet.
		let md = await readFile(file, 'utf-8');
		expect(md).not.toContain('lonely');

		await store.saveSessionReport(baseReport);
		md = await readFile(file, 'utf-8');
		expect(md).toContain('⚙️ tool: lonely');
		expect(md).toContain('(no result)');
	});

	it('updates active agent on transfer and adds suffix to subsequent assistant turns', async () => {
		const { store, file } = await setup();
		await store.addItems('sess_42', [
			{ role: 'assistant', content: 'before', timestamp: TS_ASSISTANT_1 },
			{ role: 'transfer', content: 'Transfer: concierge → booker', timestamp: TS_TRANSFER },
			{ role: 'assistant', content: 'after', timestamp: TS_ASSISTANT_3 },
		]);

		const md = await readFile(file, 'utf-8');
		expect(md).toContain('## 14:32:11  Assistant\n\nbefore');
		expect(md).toContain('*Agent transfer: concierge → booker*');
		expect(md).toContain('## 14:33:05  Assistant (booker)\n\nafter');
	});

	it('renders the reserved summary rule when an item carries metadata.kind === "summary"', async () => {
		const { store, file } = await setup();
		await store.addItems('sess_42', [
			{
				role: 'user',
				content: 'Earlier turns summarized.',
				timestamp: TS_USER_1,
				metadata: { kind: 'summary' },
			},
		]);

		const md = await readFile(file, 'utf-8');
		expect(md).toContain('<summary>📝 summary (compression checkpoint)</summary>');
		expect(md).toContain('Earlier turns summarized.');
	});

	it('drops items that arrive without a prior createSession (state never initialized)', async () => {
		const store = new MarkdownConversationHistoryStore({ baseDir });
		await store.addItems('sess_unknown', [{ role: 'user', content: 'x', timestamp: TS_USER_1 }]);
		// No throw, no file.
	});
});

describe('MarkdownConversationHistoryStore — saveSessionReport / footer', () => {
	it('appends the footer line on session close', async () => {
		const store = new MarkdownConversationHistoryStore({ baseDir });
		await store.createSession(baseRecord);
		await store.addItems('sess_42', [{ role: 'user', content: 'hi', timestamp: TS_USER_1 }]);
		await store.saveSessionReport(baseReport);

		const md = await readFile(join(baseDir, 'sess_42.md'), 'utf-8');
		expect(md).toContain('Session ended 14:38:02');
		expect(md).toContain('6m2s');
		expect(md).toContain('18 turns');
		expect(md).toContain('4 tool calls');
	});

	it('appends agents segment when more than one agent observed', async () => {
		const store = new MarkdownConversationHistoryStore({ baseDir });
		await store.createSession(baseRecord);
		await store.addItems('sess_42', [
			{ role: 'transfer', content: 'Transfer: concierge → booker', timestamp: TS_TRANSFER },
		]);
		await store.saveSessionReport(baseReport);

		const md = await readFile(join(baseDir, 'sess_42.md'), 'utf-8');
		expect(md).toContain('agents: concierge → booker');
	});

	it('falls back to Date.now() for end time when report.endedAt is missing', async () => {
		const fixedNow = Date.UTC(2026, 4, 8, 14, 38, 2);
		vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

		const store = new MarkdownConversationHistoryStore({ baseDir });
		await store.createSession(baseRecord);
		const reportNoEnd = { ...baseReport, endedAt: undefined };
		await store.saveSessionReport(reportNoEnd);

		vi.restoreAllMocks();

		const md = await readFile(join(baseDir, 'sess_42.md'), 'utf-8');
		expect(md).toContain('Session ended 14:38:02');
	});

	it('omits duration when report.startedAt === 0 (upstream bug workaround)', async () => {
		const store = new MarkdownConversationHistoryStore({ baseDir });
		await store.createSession(baseRecord);
		await store.saveSessionReport({ ...baseReport, startedAt: 0 });

		const md = await readFile(join(baseDir, 'sess_42.md'), 'utf-8');
		// No duration token between "Session ended HH:MM:SS" and "N turns".
		expect(md).toMatch(/Session ended \d\d:\d\d:\d\d · \d+ turns/);
	});

	it('clears per-session state and queue entry after saveSessionReport', async () => {
		const store = new MarkdownConversationHistoryStore({ baseDir });
		await store.createSession(baseRecord);
		await store.saveSessionReport(baseReport);

		// Internal maps are private but observable via behavior: another addItems
		// after close should now be a no-op (state was cleared).
		await store.addItems('sess_42', [{ role: 'user', content: 'late turn', timestamp: TS_USER_1 }]);
		const md = await readFile(join(baseDir, 'sess_42.md'), 'utf-8');
		expect(md).not.toContain('late turn');
	});
});

describe('MarkdownConversationHistoryStore — read methods', () => {
	const store = new MarkdownConversationHistoryStore({ baseDir: '/tmp/unused' });

	it('getSession throws the documented error', () => {
		expect(() => store.getSession('any')).toThrow(/write-only/);
	});

	it('getSessionItems throws the documented error', () => {
		expect(() => store.getSessionItems('any')).toThrow(/write-only/);
	});

	it('listUserSessions throws the documented error', () => {
		expect(() => store.listUserSessions('any')).toThrow(/write-only/);
	});
});

describe('MarkdownConversationHistoryStore — path safety', () => {
	it('sanitizes session ids to prevent path traversal', async () => {
		const store = new MarkdownConversationHistoryStore({ baseDir });
		const evilRecord = { ...baseRecord, id: '../evil' };
		await store.createSession(evilRecord);

		// The on-disk file should be in baseDir, named with the unsafe characters
		// replaced ('.' '.' '/' → '_' '_' '_').
		const md = await readFile(join(baseDir, '___evil.md'), 'utf-8');
		expect(md).toContain('# Voice session ../evil');
	});

	it('replaces slashes, dots, and other unsafe chars with _', async () => {
		const store = new MarkdownConversationHistoryStore({ baseDir });
		await store.createSession({ ...baseRecord, id: 'a/b.c' });

		const md = await readFile(join(baseDir, 'a_b_c.md'), 'utf-8');
		expect(md).toContain('# Voice session a/b.c');
	});
});

describe('MarkdownConversationHistoryStore — fire-and-forget contract', () => {
	it('per-session queue serializes interleaved unawaited calls', async () => {
		const store = new MarkdownConversationHistoryStore({ baseDir });

		// Fire all three without awaiting individually — the writer pattern.
		const p1 = store.createSession(baseRecord);
		const p2 = store.addItems('sess_42', [
			{ role: 'user', content: 'first', timestamp: TS_USER_1 },
			{ role: 'assistant', content: 'second', timestamp: TS_ASSISTANT_1 },
		]);
		const p3 = store.saveSessionReport(baseReport);
		await Promise.all([p1, p2, p3]);

		const md = await readFile(join(baseDir, 'sess_42.md'), 'utf-8');
		// Frontmatter first.
		expect(md.indexOf('# Voice session')).toBeLessThan(md.indexOf('first'));
		// Items in order.
		expect(md.indexOf('first')).toBeLessThan(md.indexOf('second'));
		// Footer last.
		expect(md.indexOf('second')).toBeLessThan(md.indexOf('Session ended'));
	});

	it('calls opts.log when a write fails and the public method resolves', async () => {
		const log = vi.fn();
		// Use a baseDir that points at a regular file so mkdir fails.
		const fakeBase = join(baseDir, 'not-a-dir.md');
		await import('node:fs/promises').then((fs) => fs.writeFile(fakeBase, 'x'));
		const store = new MarkdownConversationHistoryStore({ baseDir: fakeBase, log });

		// Should resolve, not throw.
		await expect(store.createSession(baseRecord)).resolves.toBeUndefined();
		expect(log).toHaveBeenCalled();
		expect(log.mock.calls[0][0]).toMatch(/createSession/);
	});

	it('addItems for an unknown session is a no-op (not an error)', async () => {
		const log = vi.fn();
		const store = new MarkdownConversationHistoryStore({ baseDir, log });
		await expect(
			store.addItems('never-seen', [{ role: 'user', content: 'x', timestamp: TS_USER_1 }]),
		).resolves.toBeUndefined();
		expect(log).not.toHaveBeenCalled();
	});
});

describe('MarkdownConversationHistoryStore — tool result and assistant after pair', () => {
	it('shows assistant turn on a separate heading after tool pair', async () => {
		const store = new MarkdownConversationHistoryStore({ baseDir });
		await store.createSession(baseRecord);
		const call: ToolCall = { toolCallId: 'tc', toolName: 'fetch', args: {} };
		const result: ToolResult = { toolCallId: 'tc', toolName: 'fetch', result: 'ok' };
		await store.addItems('sess_42', [
			{ role: 'assistant', content: 'Looking up.', timestamp: TS_ASSISTANT_1 },
			{ role: 'tool_call', content: JSON.stringify(call), timestamp: TS_TOOL_CALL },
			{ role: 'tool_result', content: JSON.stringify(result), timestamp: TS_TOOL_RESULT },
			{ role: 'assistant', content: 'Got it.', timestamp: TS_ASSISTANT_2 },
		]);

		const md = await readFile(join(baseDir, 'sess_42.md'), 'utf-8');
		expect(md).toContain('Looking up.');
		expect(md).toContain('<details>');
		expect(md).toContain('Got it.');
		expect(md.indexOf('Looking up.')).toBeLessThan(md.indexOf('<details>'));
		expect(md.indexOf('<details>')).toBeLessThan(md.indexOf('Got it.'));
	});
});
