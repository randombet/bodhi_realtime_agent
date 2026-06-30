/**
 * Pure rendering functions for the WhatsApp-style markdown history.
 *
 * No filesystem, no Date.now(), no per-session state — every dependency
 * (timestamps, session id, end-of-session time) flows through arguments.
 * Per-session bookkeeping (active agent, pending tool calls, agents seen)
 * lives in `MarkdownConversationHistoryStore`, which composes these
 * helpers.
 */

import type { ConversationItem, ToolCall, ToolResult } from '../types/conversation.js';
import type { SessionRecord, SessionReport } from '../types/history.js';

/** Options that flow into `renderFrontmatter`. */
export interface FrontmatterOptions {
	/** Optional model name embedded in the YAML frontmatter. */
	modelName?: string;
}

/** State threaded into `renderItem` so heading labels reflect the active agent. */
export interface RenderItemState {
	/** Agent name recorded at `createSession` — used to decide whether the assistant heading needs an `(agent)` suffix. */
	initialAgent: string;
	/** Currently-active agent (updated externally via transfer items). */
	activeAgent: string;
}

/** Format a millisecond timestamp as `HH:MM:SS` (UTC). */
export function formatTimeOfDay(timestamp: number): string {
	const d = new Date(timestamp);
	const hh = String(d.getUTCHours()).padStart(2, '0');
	const mm = String(d.getUTCMinutes()).padStart(2, '0');
	const ss = String(d.getUTCSeconds()).padStart(2, '0');
	return `${hh}:${mm}:${ss}`;
}

/** Format a millisecond duration as `Xh Ym Zs` / `Ym Zs` / `Zs`. */
export function formatDuration(ms: number): string {
	if (ms < 0) return '0s';
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h${m}m${s}s`;
	if (m > 0) return `${m}m${s}s`;
	return `${s}s`;
}

/** YAML-safe scalar — quotes only when the value would change parse meaning. */
function yamlScalar(value: string): string {
	if (value === '') return '""';
	const needsQuotes =
		// Starts with a YAML indicator that would change the structural parse.
		/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
		// `: ` or trailing colon would be parsed as a mapping separator.
		/:\s|:$/.test(value) ||
		// ` #` would be parsed as a comment.
		/\s#/.test(value) ||
		// Newlines / tabs / leading-or-trailing whitespace would alter scalars.
		/\n|\t|\s$/.test(value);
	return needsQuotes ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
}

/** HTML-escape text for safe placement inside `<summary>` element content. */
function htmlEscape(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Build a short single-line preview suitable for a `<summary>` element:
 * JSON-stringify, collapse whitespace, truncate to `maxChars`, then
 * HTML-escape.
 */
export function previewJson(value: unknown, maxChars = 80): string {
	let s: string;
	try {
		s = JSON.stringify(value);
	} catch {
		s = String(value);
	}
	if (s === undefined) s = String(value);
	const collapsed = s.replace(/\s+/g, ' ').trim();
	const truncated =
		collapsed.length > maxChars ? `${collapsed.slice(0, Math.max(0, maxChars - 1))}…` : collapsed;
	return htmlEscape(truncated);
}

/**
 * YAML frontmatter + H1 title for a session, written once at session start.
 * Does NOT include `agents` — that's emitted in the footer once all
 * transfers are observable.
 */
export function renderFrontmatter(record: SessionRecord, opts: FrontmatterOptions = {}): string {
	const startedAtIso = new Date(record.startedAt).toISOString();
	const lines = ['---'];
	lines.push(`sessionId: ${yamlScalar(record.id)}`);
	lines.push(`userId: ${yamlScalar(record.userId)}`);
	lines.push(`initialAgent: ${yamlScalar(record.initialAgentName)}`);
	if (opts.modelName) lines.push(`model: ${yamlScalar(opts.modelName)}`);
	lines.push(`startedAt: ${startedAtIso}`);
	lines.push('---');
	lines.push('');
	lines.push(`# Voice session ${record.id}`);
	lines.push('');
	return `${lines.join('\n')}\n`;
}

/** Render a single conversation item using the supplied agent state. */
export function renderItem(item: ConversationItem, state: RenderItemState): string {
	// Summary rule (reserved): an item carrying `metadata.kind === 'summary'`
	// renders as a compression-checkpoint <details> block regardless of its
	// nominal role. The upstream does not emit such items today.
	if (item.metadata?.kind === 'summary') {
		return renderSummaryItem(item);
	}
	switch (item.role) {
		case 'user':
			return renderUserItem(item);
		case 'assistant':
			return renderAssistantItem(item, state);
		case 'transfer':
			return renderTransfer(item);
		case 'tool_call':
		case 'tool_result':
			// Pairing handled at the store level; these helpers exist on this
			// module for the orphan paths and are exported separately.
			return '';
		default:
			return '';
	}
}

function renderUserItem(item: ConversationItem): string {
	const time = formatTimeOfDay(item.timestamp);
	return `## ${time}  User\n\n${item.content}\n\n`;
}

function renderAssistantItem(item: ConversationItem, state: RenderItemState): string {
	const time = formatTimeOfDay(item.timestamp);
	const suffix =
		state.activeAgent && state.activeAgent !== state.initialAgent ? ` (${state.activeAgent})` : '';
	return `## ${time}  Assistant${suffix}\n\n${item.content}\n\n`;
}

/**
 * Render a paired tool_call + tool_result block as a single
 * collapsible details element.
 */
export function renderToolCallPair(call: ToolCall, result: ToolResult): string {
	const argsPreview = previewJson(call.args);
	const resultPreview = previewJson(result.error ?? result.result);
	const arrow = result.error ? '!' : '→';
	const summary = `⚙️ tool: ${htmlEscape(call.toolName)} — ${argsPreview} ${arrow} ${resultPreview}`;
	const body = JSON.stringify(
		{
			args: call.args,
			...(result.error !== undefined ? { error: result.error } : { result: result.result }),
		},
		null,
		2,
	);
	return `<details>\n<summary>${summary}</summary>\n\n\`\`\`json\n${body}\n\`\`\`\n</details>\n\n`;
}

/** Render a tool_call that never received its matching tool_result. */
export function renderOrphanToolCall(call: ToolCall): string {
	const argsPreview = previewJson(call.args);
	const summary = `⚙️ tool: ${htmlEscape(call.toolName)} — ${argsPreview} (no result)`;
	const body = JSON.stringify({ args: call.args }, null, 2);
	return `<details>\n<summary>${summary}</summary>\n\n\`\`\`json\n${body}\n\`\`\`\n</details>\n\n`;
}

/** Render a tool_result that arrived without a prior tool_call. */
export function renderOrphanToolResult(result: ToolResult): string {
	const resultPreview = previewJson(result.error ?? result.result);
	const summary = `↩️ tool result: ${htmlEscape(result.toolName)} ${result.error ? '!' : '→'} ${resultPreview}`;
	const body = JSON.stringify(
		result.error !== undefined ? { error: result.error } : { result: result.result },
		null,
		2,
	);
	return `<details>\n<summary>${summary}</summary>\n\n\`\`\`json\n${body}\n\`\`\`\n</details>\n\n`;
}

/** Render an `agent transfer` boundary marker. */
export function renderTransfer(item: ConversationItem): string {
	// item.content is `"Transfer: ${from} → ${to}"` per ConversationContext.addAgentTransfer.
	const match = item.content.match(/^Transfer:\s*(.+?)\s*→\s*(.+)$/);
	if (match) {
		return `\n---\n*Agent transfer: ${match[1]} → ${match[2]}*\n\n`;
	}
	return `\n---\n*${item.content}*\n\n`;
}

/**
 * Reserved rule — fires only when an item with `metadata.kind === 'summary'`
 * flows through the stream. `ConversationContext.setSummary` does not
 * emit such items today (see design doc Open Questions).
 */
export function renderSummaryItem(item: ConversationItem): string {
	return `<details>\n<summary>📝 summary (compression checkpoint)</summary>\n\n${item.content}\n</details>\n\n`;
}

/**
 * Closing footer line. The store passes a precomputed `endTimeMs` so this
 * function stays pure (no `Date.now()` inside).
 *
 * Format:
 *   `\n---\n_Session ended HH:MM:SS · {duration} · {N} turns · {M} tool calls{ · agents: A → B → C}?_\n`
 *
 * Duration is omitted when `report.startedAt === 0` (workaround for the
 * upstream `ConversationHistoryWriter.handleSessionClose` bug).
 * The `agents:` segment is appended only when more than one agent was
 * observed in the session.
 */
export function renderFooter(
	report: SessionReport,
	agentsSeen: readonly string[],
	endTimeMs: number,
): string {
	const turns = report.analytics?.turnCount ?? 0;
	const tools = report.analytics?.toolCallCount ?? 0;
	const segments: string[] = [`Session ended ${formatTimeOfDay(endTimeMs)}`];
	if (report.startedAt && report.startedAt > 0) {
		segments.push(formatDuration(endTimeMs - report.startedAt));
	}
	segments.push(`${turns} turns`);
	segments.push(`${tools} tool calls`);
	if (agentsSeen.length > 1) {
		segments.push(`agents: ${agentsSeen.join(' → ')}`);
	}
	return `\n---\n_${segments.join(' · ')}_\n`;
}
