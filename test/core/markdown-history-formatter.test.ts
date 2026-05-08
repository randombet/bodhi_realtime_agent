// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	formatDuration,
	formatTimeOfDay,
	previewJson,
	renderFooter,
	renderFrontmatter,
	renderItem,
	renderOrphanToolCall,
	renderOrphanToolResult,
	renderSummaryItem,
	renderToolCallPair,
	renderTransfer,
} from '../../src/core/markdown-history-formatter.js';
import type { ConversationItem, ToolCall, ToolResult } from '../../src/types/conversation.js';
import type { SessionRecord, SessionReport } from '../../src/types/history.js';

// All fixture timestamps use Date.UTC so tests are deterministic and timezone-independent.
const TS_USER_1 = Date.UTC(2026, 4, 8, 14, 32, 8); // 2026-05-08T14:32:08Z
const TS_ASSISTANT_1 = Date.UTC(2026, 4, 8, 14, 32, 11); // 2026-05-08T14:32:11Z
const TS_TRANSFER = Date.UTC(2026, 4, 8, 14, 33, 2); // 2026-05-08T14:33:02Z
// Session start = 14:32:00Z, end = 14:38:02Z (6m2s duration).
const SESSION_START = Date.UTC(2026, 4, 8, 14, 32, 0);
const SESSION_END = Date.UTC(2026, 4, 8, 14, 38, 2);

const baseRecord: SessionRecord = {
	id: 'sess_42',
	userId: 'u_9001',
	initialAgentName: 'concierge',
	status: 'active',
	startedAt: SESSION_START,
};

describe('formatTimeOfDay', () => {
	it('formats UTC HH:MM:SS', () => {
		expect(formatTimeOfDay(TS_USER_1)).toBe('14:32:08');
	});

	it('zero-pads single-digit components', () => {
		expect(formatTimeOfDay(Date.UTC(2026, 4, 8, 1, 2, 3))).toBe('01:02:03');
	});
});

describe('formatDuration', () => {
	it('formats < 1 minute', () => {
		expect(formatDuration(45_000)).toBe('45s');
	});

	it('formats < 1 hour', () => {
		expect(formatDuration(362_000)).toBe('6m2s');
	});

	it('formats >= 1 hour', () => {
		expect(formatDuration(3_725_000)).toBe('1h2m5s');
	});

	it('clamps negative durations to 0s', () => {
		expect(formatDuration(-100)).toBe('0s');
	});
});

describe('previewJson', () => {
	it('JSON-stringifies and HTML-escapes the result', () => {
		expect(previewJson({ city: 'Paris' })).toBe('{&quot;city&quot;:&quot;Paris&quot;}');
	});

	it('collapses runs of whitespace inside string values', () => {
		// JSON.stringify keeps the actual whitespace inside string values in the output;
		// previewJson collapses runs of whitespace to a single space.
		expect(previewJson('two   spaces')).toBe('&quot;two spaces&quot;');
	});

	it('truncates pre-escape to maxChars and ends with ellipsis', () => {
		const long = 'x'.repeat(200);
		const result = previewJson(long, 20);
		// Truncation point is at maxChars-1 = 19 chars, then "…"; the string starts
		// with `"` (from JSON.stringify) which expands to &quot; after escape.
		expect(result.endsWith('…')).toBe(true);
		// Pre-escape body is 20 chars; the lead `"` adds 5 chars after escape. So
		// total length is bounded by 20 + 5 = 25.
		expect(result.length).toBeLessThanOrEqual(25);
	});

	it('escapes &, <, > inside the preview', () => {
		// Plain string input — no JSON quoting around it.
		const result = previewJson('a<b&c>d');
		expect(result).toContain('&lt;');
		expect(result).toContain('&amp;');
		expect(result).toContain('&gt;');
	});

	it('handles primitive values', () => {
		expect(previewJson(42)).toBe('42');
		expect(previewJson(true)).toBe('true');
		expect(previewJson(null)).toBe('null');
	});
});

describe('renderFrontmatter', () => {
	it('emits sessionId, userId, initialAgent, startedAt (no agents field)', () => {
		const out = renderFrontmatter(baseRecord);
		expect(out).toContain('sessionId: sess_42');
		expect(out).toContain('userId: u_9001');
		expect(out).toContain('initialAgent: concierge');
		expect(out).toMatch(/startedAt: 2026-05-08T14:32:00\.000Z/);
		expect(out).not.toMatch(/^agents:/m);
	});

	it('includes model when provided', () => {
		const out = renderFrontmatter(baseRecord, { modelName: 'gemini-3.1-flash-live-preview' });
		expect(out).toContain('model: gemini-3.1-flash-live-preview');
	});

	it('omits model when not provided', () => {
		const out = renderFrontmatter(baseRecord);
		expect(out).not.toContain('model:');
	});

	it('quotes values with YAML-special characters', () => {
		const out = renderFrontmatter({ ...baseRecord, id: 'has: colon' });
		expect(out).toContain('sessionId: "has: colon"');
	});

	it('appends an H1 title', () => {
		const out = renderFrontmatter(baseRecord);
		expect(out).toContain('# Voice session sess_42');
	});
});

describe('renderItem', () => {
	const state = { initialAgent: 'concierge', activeAgent: 'concierge' };

	it('renders a user item with HH:MM:SS heading', () => {
		const item: ConversationItem = { role: 'user', content: 'Hello!', timestamp: TS_USER_1 };
		expect(renderItem(item, state)).toBe('## 14:32:08  User\n\nHello!\n\n');
	});

	it('renders an assistant item without agent suffix when active === initial', () => {
		const item: ConversationItem = {
			role: 'assistant',
			content: 'Hi there.',
			timestamp: TS_ASSISTANT_1,
		};
		expect(renderItem(item, state)).toBe('## 14:32:11  Assistant\n\nHi there.\n\n');
	});

	it('renders an assistant item with agent suffix when active !== initial', () => {
		const item: ConversationItem = {
			role: 'assistant',
			content: 'Booking confirmed.',
			timestamp: TS_ASSISTANT_1,
		};
		expect(renderItem(item, { initialAgent: 'concierge', activeAgent: 'booker' })).toBe(
			'## 14:32:11  Assistant (booker)\n\nBooking confirmed.\n\n',
		);
	});

	it('renders a transfer item', () => {
		const item: ConversationItem = {
			role: 'transfer',
			content: 'Transfer: concierge → booker',
			timestamp: TS_TRANSFER,
		};
		expect(renderItem(item, state)).toBe('\n---\n*Agent transfer: concierge → booker*\n\n');
	});

	it('renders the reserved summary rule for items with metadata.kind === "summary"', () => {
		const item: ConversationItem = {
			role: 'user',
			content: 'Compressed turns.',
			timestamp: TS_USER_1,
			metadata: { kind: 'summary' },
		};
		const out = renderItem(item, state);
		expect(out).toContain('<summary>📝 summary (compression checkpoint)</summary>');
		expect(out).toContain('Compressed turns.');
	});

	it('returns empty string for tool_call/tool_result (pairing handled by store)', () => {
		const tool: ConversationItem = {
			role: 'tool_call',
			content: '{}',
			timestamp: TS_USER_1,
		};
		expect(renderItem(tool, state)).toBe('');
	});
});

describe('renderToolCallPair', () => {
	it('emits a single details block with paired args and result', () => {
		const call: ToolCall = {
			toolCallId: 'tc_1',
			toolName: 'get_weather',
			args: { city: 'Paris' },
		};
		const result: ToolResult = {
			toolCallId: 'tc_1',
			toolName: 'get_weather',
			result: { temp: 18, unit: 'C', conditions: 'sunny' },
		};
		const out = renderToolCallPair(call, result);
		expect(out).toContain('<details>');
		expect(out).toContain('⚙️ tool: get_weather');
		expect(out).toContain('→');
		expect(out).toContain('"args"');
		expect(out).toContain('"result"');
		expect(out).toContain('"city": "Paris"');
		expect(out).toContain('</details>');
	});

	it('renders error results with ! and an "error" key in the body', () => {
		const call: ToolCall = { toolCallId: 'tc_2', toolName: 'broken', args: {} };
		const result: ToolResult = {
			toolCallId: 'tc_2',
			toolName: 'broken',
			result: null,
			error: 'boom',
		};
		const out = renderToolCallPair(call, result);
		expect(out).toContain('!');
		expect(out).toContain('"error": "boom"');
	});

	it('escapes tool name HTML in the summary', () => {
		const call: ToolCall = { toolCallId: 'tc', toolName: '<dangerous>', args: {} };
		const result: ToolResult = { toolCallId: 'tc', toolName: '<dangerous>', result: 'ok' };
		const out = renderToolCallPair(call, result);
		expect(out).toContain('&lt;dangerous&gt;');
	});
});

describe('renderOrphanToolCall', () => {
	it('emits "(no result)" in the summary', () => {
		const call: ToolCall = { toolCallId: 'tc', toolName: 'noop', args: { a: 1 } };
		const out = renderOrphanToolCall(call);
		expect(out).toContain('⚙️ tool: noop');
		expect(out).toContain('(no result)');
		expect(out).toContain('"args"');
	});
});

describe('renderOrphanToolResult', () => {
	it('emits the ↩️ prefix and the result body', () => {
		const result: ToolResult = {
			toolCallId: 'tc',
			toolName: 'late_arrival',
			result: { x: 1 },
		};
		const out = renderOrphanToolResult(result);
		expect(out).toContain('↩️ tool result: late_arrival');
		expect(out).toContain('"result"');
	});
});

describe('renderTransfer', () => {
	it('parses "Transfer: A → B" content', () => {
		const item: ConversationItem = {
			role: 'transfer',
			content: 'Transfer: concierge → booker',
			timestamp: TS_TRANSFER,
		};
		expect(renderTransfer(item)).toBe('\n---\n*Agent transfer: concierge → booker*\n\n');
	});

	it('falls back to literal content when format is unexpected', () => {
		const item: ConversationItem = {
			role: 'transfer',
			content: 'something else',
			timestamp: TS_TRANSFER,
		};
		expect(renderTransfer(item)).toBe('\n---\n*something else*\n\n');
	});
});

describe('renderSummaryItem', () => {
	it('emits a 📝 details block', () => {
		const item: ConversationItem = {
			role: 'user',
			content: 'Earlier turns summarized.',
			timestamp: TS_USER_1,
			metadata: { kind: 'summary' },
		};
		const out = renderSummaryItem(item);
		expect(out).toContain('<summary>📝 summary (compression checkpoint)</summary>');
		expect(out).toContain('Earlier turns summarized.');
	});
});

describe('renderFooter', () => {
	const baseReport: SessionReport = {
		...baseRecord,
		status: 'ended',
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

	it('emits HH:MM:SS, duration, turn count, tool count', () => {
		const out = renderFooter(baseReport, ['concierge'], SESSION_END);
		expect(out).toBe('\n---\n_Session ended 14:38:02 · 6m2s · 18 turns · 4 tool calls_\n');
	});

	it('appends agents segment when more than one agent observed', () => {
		const out = renderFooter(baseReport, ['concierge', 'booker'], SESSION_END);
		expect(out).toContain('agents: concierge → booker');
	});

	it('omits agents segment for single-agent sessions', () => {
		const out = renderFooter(baseReport, ['concierge'], SESSION_END);
		expect(out).not.toContain('agents:');
	});

	it('omits duration when report.startedAt is 0 (upstream bug workaround)', () => {
		const report = { ...baseReport, startedAt: 0 };
		const out = renderFooter(report, ['concierge'], SESSION_END);
		expect(out).toContain('Session ended');
		// No `Xm` / `Xs` duration token between "ended HH:MM:SS" and the turn count.
		expect(out).toMatch(/Session ended \d\d:\d\d:\d\d · 18 turns/);
	});

	it('reads turn / tool counts from analytics; defaults to 0 when missing', () => {
		const report: SessionReport = {
			...baseReport,
			analytics: undefined,
		};
		const out = renderFooter(report, ['concierge'], SESSION_END);
		expect(out).toContain('0 turns');
		expect(out).toContain('0 tool calls');
	});

	it('uses the supplied endTimeMs without calling Date.now (deterministic)', () => {
		// Different end times must produce different outputs.
		const a = renderFooter(baseReport, ['concierge'], SESSION_END);
		const b = renderFooter(baseReport, ['concierge'], SESSION_END + 60_000);
		expect(a).not.toBe(b);
	});
});
