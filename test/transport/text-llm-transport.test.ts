// SPDX-License-Identifier: MIT

import { type CoreMessage, simulateReadableStream } from 'ai';
import { MockLanguageModelV1 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TextLLMTransport } from '../../src/transport/text-llm-transport.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import type { ReplayItem, TransportToolCall } from '../../src/types/transport.js';

const rawCall = { rawPrompt: null, rawSettings: {} } as const;

/** Poll until `cond()` is true (or a cap) — robust to scheduling jitter under load. */
async function waitUntil(cond: () => boolean, capMs = 1000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > capMs) throw new Error('waitUntil timed out');
		await new Promise((r) => setTimeout(r, 2));
	}
}

/** Concatenate the text parts of a prompt message (SDK normalizes content to a part array). */
function textOf(msg: { content: unknown }): string {
	if (typeof msg.content === 'string') return msg.content;
	if (!Array.isArray(msg.content)) return '';
	return msg.content
		.filter((p): p is { type: 'text'; text: string } => p?.type === 'text')
		.map((p) => p.text)
		.join('');
}

function textModel(deltas: string[]): MockLanguageModelV1 {
	return new MockLanguageModelV1({
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [
					...deltas.map((textDelta) => ({ type: 'text-delta' as const, textDelta })),
					{
						type: 'finish' as const,
						finishReason: 'stop' as const,
						usage: { promptTokens: 1, completionTokens: 1 },
					},
				],
			}),
			rawCall,
		}),
	});
}

describe('TextLLMTransport', () => {
	it('advertises text-response capability and stubs audio', () => {
		const t = new TextLLMTransport({ model: textModel(['hi']) });
		expect(t.capabilities.textResponseModality).toBe(true);
		expect(() => t.sendAudio()).not.toThrow();
	});

	it('normal disconnect() does NOT fire onClose (reserved for unexpected closure)', async () => {
		const t = new TextLLMTransport({ model: textModel(['hi']) });
		let closed = false;
		t.onClose = () => {
			closed = true;
		};
		await t.connect();
		await t.disconnect();
		expect(closed).toBe(false);
		expect(t.isConnected).toBe(false);
	});

	it('streams assistant text and finalizes the turn', async () => {
		const t = new TextLLMTransport({ model: textModel(['Hello', ' world']) });
		const chunks: string[] = [];
		let done = false;
		t.onTextOutput = (s) => chunks.push(s);
		t.onTextDone = () => {
			done = true;
		};
		const completed = new Promise<void>((resolve) => {
			t.onTurnComplete = () => resolve();
		});

		await t.connect();
		t.sendContent([{ role: 'user', text: 'hi' }], true);
		await completed;

		expect(chunks.join('')).toBe('Hello world');
		expect(done).toBe(true);
	});

	it('surfaces a tool call, then resumes the turn after the result', async () => {
		let round = 0;
		const model = new MockLanguageModelV1({
			doStream: async () => {
				round += 1;
				if (round === 1) {
					return {
						stream: simulateReadableStream({
							chunks: [
								{
									type: 'tool-call' as const,
									toolCallType: 'function' as const,
									toolCallId: 'c1',
									toolName: 'do_thing',
									args: JSON.stringify({ x: 1 }),
								},
								{
									type: 'finish' as const,
									finishReason: 'tool-calls' as const,
									usage: { promptTokens: 1, completionTokens: 1 },
								},
							],
						}),
						rawCall,
					};
				}
				return {
					stream: simulateReadableStream({
						chunks: [
							{ type: 'text-delta' as const, textDelta: 'Done.' },
							{
								type: 'finish' as const,
								finishReason: 'stop' as const,
								usage: { promptTokens: 1, completionTokens: 1 },
							},
						],
					}),
					rawCall,
				};
			},
		});

		const toolDef: ToolDefinition = {
			name: 'do_thing',
			description: 'does a thing',
			parameters: z.object({ x: z.number() }),
			execution: 'inline',
			execute: async () => ({ ok: true }),
		};
		const t = new TextLLMTransport({ model, tools: [toolDef] });

		let calls: TransportToolCall[] = [];
		t.onToolCall = (c) => {
			calls = c;
		};
		const finalText: string[] = [];
		t.onTextOutput = (s) => finalText.push(s);
		const completed = new Promise<void>((resolve) => {
			t.onTurnComplete = () => resolve();
		});

		await t.connect();
		t.sendContent([{ role: 'user', text: 'go' }], true);
		// Let the first generation surface the tool call.
		await waitUntil(() => calls.length === 1);
		expect(calls[0].name).toBe('do_thing');

		t.sendToolResult({ id: 'c1', name: 'do_thing', result: { ok: true } });
		await completed;
		expect(finalText.join('')).toBe('Done.');
	});

	it('ignores a tool result that arrives after cancelResponse (no phantom turn)', async () => {
		const model = new MockLanguageModelV1({
			doStream: async () => ({
				stream: simulateReadableStream({
					chunks: [
						{
							type: 'tool-call' as const,
							toolCallType: 'function' as const,
							toolCallId: 'c1',
							toolName: 'do_thing',
							args: '{}',
						},
						{
							type: 'finish' as const,
							finishReason: 'tool-calls' as const,
							usage: { promptTokens: 1, completionTokens: 1 },
						},
					],
				}),
				rawCall,
			}),
		});
		const toolDef: ToolDefinition = {
			name: 'do_thing',
			description: 'x',
			parameters: z.object({}),
			execution: 'inline',
			execute: async () => ({}),
		};
		const t = new TextLLMTransport({ model, tools: [toolDef] });
		let toolCallSeen = false;
		let completes = 0;
		t.onToolCall = () => {
			toolCallSeen = true;
		};
		t.onTurnComplete = () => {
			completes += 1;
		};

		await t.connect();
		t.sendContent([{ role: 'user', text: 'go' }], true);
		await waitUntil(() => toolCallSeen);

		await t.cancelResponse();
		// Late result for the cancelled tool call must be dropped — no resume, no completion.
		t.sendToolResult({ id: 'c1', name: 'do_thing', result: { ok: true } });
		await new Promise((r) => setTimeout(r, 20));
		expect(completes).toBe(0);
	});

	it('buffers user content sent mid-generation and keeps history order', async () => {
		// Capture the messages each round so we can assert ordering of the SECOND turn.
		const rounds: CoreMessage[][] = [];
		const model = new MockLanguageModelV1({
			doStream: async (opts) => {
				rounds.push(opts.prompt as unknown as CoreMessage[]);
				const textDelta = rounds.length === 1 ? 'first' : 'second';
				return {
					stream: simulateReadableStream({
						chunks: [
							{ type: 'text-delta' as const, textDelta },
							{
								type: 'finish' as const,
								finishReason: 'stop' as const,
								usage: { promptTokens: 1, completionTokens: 1 },
							},
						],
					}),
					rawCall,
				};
			},
		});
		const t = new TextLLMTransport({ model });
		let completes = 0;
		const twoTurns = new Promise<void>((resolve) => {
			t.onTurnComplete = () => {
				completes += 1;
				if (completes === 2) resolve();
			};
		});

		await t.connect();
		t.sendContent([{ role: 'user', text: 'u1' }], true);
		// Sent while the first generation is in flight → must be buffered, not interleaved.
		t.sendContent([{ role: 'user', text: 'u2' }], true);
		await twoTurns;

		// The second round must see: u1, assistant("first"), u2 — in that order.
		const second = rounds[1];
		expect(second).toHaveLength(3);
		expect(second[0].role).toBe('user');
		expect(textOf(second[0])).toBe('u1');
		expect(second[1].role).toBe('assistant');
		expect(textOf(second[1])).toBe('first');
		expect(second[2].role).toBe('user');
		expect(textOf(second[2])).toBe('u2');
	});

	it('does not start a parallel generation while a tool call is outstanding', async () => {
		let round = 0;
		const rounds: CoreMessage[][] = [];
		const model = new MockLanguageModelV1({
			doStream: async (opts) => {
				round += 1;
				rounds.push(opts.prompt as unknown as CoreMessage[]);
				if (round === 1) {
					return {
						stream: simulateReadableStream({
							chunks: [
								{
									type: 'tool-call' as const,
									toolCallType: 'function' as const,
									toolCallId: 'c1',
									toolName: 'do_thing',
									args: '{}',
								},
								{
									type: 'finish' as const,
									finishReason: 'tool-calls' as const,
									usage: { promptTokens: 1, completionTokens: 1 },
								},
							],
						}),
						rawCall,
					};
				}
				return {
					stream: simulateReadableStream({
						chunks: [
							{ type: 'text-delta' as const, textDelta: 'done' },
							{
								type: 'finish' as const,
								finishReason: 'stop' as const,
								usage: { promptTokens: 1, completionTokens: 1 },
							},
						],
					}),
					rawCall,
				};
			},
		});
		const toolDef: ToolDefinition = {
			name: 'do_thing',
			description: 'x',
			parameters: z.object({}),
			execution: 'inline',
			execute: async () => ({}),
		};
		const t = new TextLLMTransport({ model, tools: [toolDef] });
		let toolCallSeen = false;
		t.onToolCall = () => {
			toolCallSeen = true;
		};
		const completed = new Promise<void>((resolve) => {
			t.onTurnComplete = () => resolve();
		});

		await t.connect();
		t.sendContent([{ role: 'user', text: 'go' }], true);
		// Wait until the tool call is outstanding (surfaced but unanswered).
		await waitUntil(() => toolCallSeen);
		// A new user turn arrives while the tool call is still outstanding — must NOT spawn a
		// second generation; it is buffered until the tool turn resumes and completes.
		t.sendContent([{ role: 'user', text: 'later' }], true);
		expect(round).toBe(1); // still only the first generation

		t.sendToolResult({ id: 'c1', name: 'do_thing', result: { ok: true } });
		await completed;
		// Exactly two generations total: the original (resumed with the tool result) and then
		// the buffered user turn — never a malformed parallel one.
		await waitUntil(() => round === 3);
		expect(round).toBe(3);
		// The buffered 'later' turn must be the LAST user message, after the tool result.
		const last = rounds[2];
		const tail = last[last.length - 1];
		expect(tail.role).toBe('user');
		expect(textOf(tail)).toBe('later');
	});

	it('does not strand partial (turnComplete=false) content buffered mid-turn', async () => {
		const rounds: CoreMessage[][] = [];
		const model = new MockLanguageModelV1({
			doStream: async (opts) => {
				rounds.push(opts.prompt as unknown as CoreMessage[]);
				const textDelta = rounds.length === 1 ? 'first' : 'second';
				return {
					stream: simulateReadableStream({
						chunks: [
							{ type: 'text-delta' as const, textDelta },
							{
								type: 'finish' as const,
								finishReason: 'stop' as const,
								usage: { promptTokens: 1, completionTokens: 1 },
							},
						],
					}),
					rawCall,
				};
			},
		});
		const t = new TextLLMTransport({ model });
		let completes = 0;
		const firstDone = new Promise<void>((resolve) => {
			t.onTurnComplete = () => {
				completes += 1;
				if (completes === 1) resolve();
			};
		});

		await t.connect();
		t.sendContent([{ role: 'user', text: 'u1' }], true);
		// Partial content arrives mid-turn — buffered, no generation queued by it.
		t.sendContent([{ role: 'user', text: 'partial' }], false);
		await firstDone;
		// The partial content must be committed to history (not stranded), even though no
		// generation was triggered by it. A later turn includes it in order.
		t.sendContent([{ role: 'user', text: 'u2' }], true);
		await waitUntil(() => rounds.length === 2);
		const second = rounds[1];
		const texts = second.map(textOf);
		expect(texts).toEqual(['u1', 'first', 'partial', 'u2']);
	});

	it('a stream that settles after disconnect+reconnect emits nothing (genId superseded)', async () => {
		const model = new MockLanguageModelV1({
			doStream: async () => ({
				stream: simulateReadableStream({
					// Delay the FIRST chunk too, so we can disconnect before any delta arrives.
					initialDelayInMs: 40,
					chunkDelayInMs: 40,
					chunks: [
						{ type: 'text-delta' as const, textDelta: 'late' },
						{
							type: 'finish' as const,
							finishReason: 'stop' as const,
							usage: { promptTokens: 1, completionTokens: 1 },
						},
					],
				}),
				rawCall,
			}),
		});
		const t = new TextLLMTransport({ model });
		const out: string[] = [];
		let completed = false;
		t.onTextOutput = (s) => out.push(s);
		t.onTurnComplete = () => {
			completed = true;
		};

		await t.connect();
		t.sendContent([{ role: 'user', text: 'hi' }], true);
		await new Promise((r) => setTimeout(r, 5)); // generation in flight, before deltas
		await t.disconnect();
		await t.reconnect(); // clears `closing` — only the genId bump keeps the old stream stale
		await new Promise((r) => setTimeout(r, 80)); // let the old stream fully drain
		expect(out).toHaveLength(0);
		expect(completed).toBe(false);
	});
});

// --- E1: resume / replayHistory -------------------------------------------------------------

/** A model that records the `prompt` (SDK message list) it receives on each generation. */
function capturingModel(deltas: string[] = ['ok']): {
	model: MockLanguageModelV1;
	prompts: Array<Array<{ role: string; content: unknown }>>;
} {
	const prompts: Array<Array<{ role: string; content: unknown }>> = [];
	const model = new MockLanguageModelV1({
		doStream: async (options) => {
			prompts.push(options.prompt as Array<{ role: string; content: unknown }>);
			return {
				stream: simulateReadableStream({
					chunks: [
						...deltas.map((textDelta) => ({ type: 'text-delta' as const, textDelta })),
						{
							type: 'finish' as const,
							finishReason: 'stop' as const,
							usage: { promptTokens: 1, completionTokens: 1 },
						},
					],
				}),
				rawCall,
			};
		},
	});
	return { model, prompts };
}

/** Drive exactly one user turn and return the message list the model saw for it. */
async function firstTurnMessages(
	t: TextLLMTransport,
	prompts: Array<Array<{ role: string; content: unknown }>>,
	userText = 'now',
): Promise<Array<{ role: string; content: unknown }>> {
	const done = new Promise<void>((resolve) => {
		t.onTurnComplete = () => resolve();
	});
	t.sendContent([{ role: 'user', text: userText }], true);
	await done;
	return prompts[0];
}

/** All tool-call/tool-result parts across the message list, flattened, in order. */
function toolParts(
	msgs: Array<{ role: string; content: unknown }>,
): Array<Record<string, unknown>> {
	const parts: Array<Record<string, unknown>> = [];
	for (const m of msgs) {
		if (Array.isArray(m.content)) {
			for (const p of m.content as Array<Record<string, unknown>>) {
				if (p.type === 'tool-call' || p.type === 'tool-result') parts.push(p);
			}
		}
	}
	return parts;
}

describe('TextLLMTransport — resume / replayHistory', () => {
	it('seeds constructor initialHistory into the first turn (prefix then new user msg)', async () => {
		const { model, prompts } = capturingModel();
		const t = new TextLLMTransport({
			model,
			initialHistory: [
				{ type: 'text', role: 'user', text: 'earlier user' },
				{ type: 'text', role: 'assistant', text: 'earlier assistant' },
			],
		});
		await t.connect();
		const msgs = await firstTurnMessages(t, prompts);
		expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
		expect(textOf(msgs[0])).toBe('earlier user');
		expect(textOf(msgs[1])).toBe('earlier assistant');
		expect(textOf(msgs[2])).toBe('now');
	});

	it('tool_call + matching tool_result round-trips to a valid assistant→tool pair', async () => {
		const { model, prompts } = capturingModel();
		const t = new TextLLMTransport({
			model,
			initialHistory: [
				{ type: 'tool_call', id: 'c1', name: 'calc', args: { a: 1 } },
				{ type: 'tool_result', id: 'c1', name: 'calc', result: { sum: 3 } },
			],
		});
		await t.connect();
		const msgs = await firstTurnMessages(t, prompts);
		const parts = toolParts(msgs);
		expect(parts).toHaveLength(2);
		expect(parts[0]).toMatchObject({ type: 'tool-call', toolCallId: 'c1', toolName: 'calc' });
		expect(parts[1]).toMatchObject({ type: 'tool-result', toolCallId: 'c1', toolName: 'calc' });
	});

	it('errored tool_result folds error into result payload with isError', async () => {
		const { model, prompts } = capturingModel();
		const t = new TextLLMTransport({
			model,
			initialHistory: [
				{ type: 'tool_call', id: 'c1', name: 'calc', args: {} },
				{ type: 'tool_result', id: 'c1', name: 'calc', result: null, error: 'boom' },
			],
		});
		await t.connect();
		const parts = toolParts(await firstTurnMessages(t, prompts));
		expect(parts[1]).toMatchObject({
			type: 'tool-result',
			toolCallId: 'c1',
			isError: true,
			result: { error: 'boom', result: null },
		});
	});

	it('drops an unanswered tool_call — trailing and non-trailing', async () => {
		// trailing
		{
			const { model, prompts } = capturingModel();
			const t = new TextLLMTransport({
				model,
				initialHistory: [
					{ type: 'text', role: 'user', text: 'q' },
					{ type: 'tool_call', id: 'c1', name: 'calc', args: {} },
				],
			});
			await t.connect();
			expect(toolParts(await firstTurnMessages(t, prompts))).toHaveLength(0);
		}
		// non-trailing (tool_call then a user text before any result)
		{
			const { model, prompts } = capturingModel();
			const t = new TextLLMTransport({
				model,
				initialHistory: [
					{ type: 'tool_call', id: 'c1', name: 'calc', args: {} },
					{ type: 'text', role: 'user', text: 'never got the result' },
				],
			});
			await t.connect();
			const msgs = await firstTurnMessages(t, prompts);
			expect(toolParts(msgs)).toHaveLength(0);
			// the user text still replays
			expect(msgs.some((m) => m.role === 'user' && textOf(m) === 'never got the result')).toBe(
				true,
			);
		}
	});

	it('parallel calls: two calls before their two results → one assistant msg + two tool msgs', async () => {
		const { model, prompts } = capturingModel();
		const t = new TextLLMTransport({
			model,
			initialHistory: [
				{ type: 'tool_call', id: 'a', name: 'f', args: {} },
				{ type: 'tool_call', id: 'b', name: 'g', args: {} },
				{ type: 'tool_result', id: 'a', name: 'f', result: 1 },
				{ type: 'tool_result', id: 'b', name: 'g', result: 2 },
			],
		});
		await t.connect();
		const msgs = await firstTurnMessages(t, prompts);
		const assistantToolMsgs = msgs.filter(
			(m) =>
				m.role === 'assistant' &&
				Array.isArray(m.content) &&
				(m.content as Array<Record<string, unknown>>).some((p) => p.type === 'tool-call'),
		);
		const toolMsgs = msgs.filter((m) => m.role === 'tool');
		expect(assistantToolMsgs).toHaveLength(1);
		expect((assistantToolMsgs[0].content as unknown[]).length).toBe(2); // two tool-call parts
		expect(toolMsgs).toHaveLength(2); // one tool message per result
	});

	it('drops duplicate tool_call ids — same group and across groups', async () => {
		const logs: string[] = [];
		const { model, prompts } = capturingModel();
		const t = new TextLLMTransport({
			model,
			log: (m) => logs.push(m),
			initialHistory: [
				{ type: 'tool_call', id: 'a', name: 'f', args: {} },
				{ type: 'tool_call', id: 'a', name: 'f', args: {} }, // dup, same group
				{ type: 'tool_result', id: 'a', name: 'f', result: 1 },
				{ type: 'tool_call', id: 'a', name: 'f', args: {} }, // dup, later group
				{ type: 'tool_result', id: 'a', name: 'f', result: 2 },
			],
		});
		await t.connect();
		const parts = toolParts(await firstTurnMessages(t, prompts));
		// exactly one call and one result survive
		expect(parts.filter((p) => p.type === 'tool-call')).toHaveLength(1);
		expect(parts.filter((p) => p.type === 'tool-result')).toHaveLength(1);
		expect(logs.filter((l) => l.includes('duplicate tool_call')).length).toBeGreaterThanOrEqual(2);
	});

	it('mixed assistant turn (text then tool_call) → two separate assistant messages', async () => {
		const { model, prompts } = capturingModel();
		const t = new TextLLMTransport({
			model,
			initialHistory: [
				{ type: 'text', role: 'assistant', text: 'let me compute' },
				{ type: 'tool_call', id: 'c1', name: 'calc', args: {} },
				{ type: 'tool_result', id: 'c1', name: 'calc', result: 3 },
			],
		});
		await t.connect();
		const msgs = await firstTurnMessages(t, prompts);
		const assistantMsgs = msgs.filter((m) => m.role === 'assistant');
		expect(assistantMsgs.length).toBe(2); // text message, then tool-call message
		expect(textOf(assistantMsgs[0])).toBe('let me compute');
	});

	it('normalizes a tool_result name mismatch to the call name (and logs)', async () => {
		const logs: string[] = [];
		const { model, prompts } = capturingModel();
		const t = new TextLLMTransport({
			model,
			log: (m) => logs.push(m),
			initialHistory: [
				{ type: 'tool_call', id: 'c1', name: 'calc', args: {} },
				{ type: 'tool_result', id: 'c1', name: 'WRONG', result: 1 },
			],
		});
		await t.connect();
		const parts = toolParts(await firstTurnMessages(t, prompts));
		expect(parts[0]).toMatchObject({ toolName: 'calc' });
		expect(parts[1]).toMatchObject({ toolName: 'calc' }); // result uses the call's name
		expect(logs.some((l) => l.includes('name mismatch'))).toBe(true);
	});

	it('drops an orphan tool_result (id never opened)', async () => {
		const { model, prompts } = capturingModel();
		const t = new TextLLMTransport({
			model,
			initialHistory: [{ type: 'tool_result', id: 'ghost', name: 'f', result: 1 }],
		});
		await t.connect();
		expect(toolParts(await firstTurnMessages(t, prompts))).toHaveLength(0);
	});

	it('absent initialHistory is a no-op (only the new user message)', async () => {
		const { model, prompts } = capturingModel();
		const t = new TextLLMTransport({ model });
		await t.connect();
		const msgs = await firstTurnMessages(t, prompts);
		expect(msgs.map((m) => m.role)).toEqual(['user']);
	});

	it('seeds exactly once across a second connect()', async () => {
		const { model, prompts } = capturingModel();
		const t = new TextLLMTransport({
			model,
			initialHistory: [{ type: 'text', role: 'user', text: 'once' }],
		});
		await t.connect();
		await t.connect(); // second connect must not re-seed
		const msgs = await firstTurnMessages(t, prompts);
		expect(msgs.filter((m) => m.role === 'user' && textOf(m) === 'once')).toHaveLength(1);
	});

	it('snapshot isolation: mutating the caller array after construction does not change replay', async () => {
		const { model, prompts } = capturingModel();
		const arr: ReplayItem[] = [{ type: 'text', role: 'user', text: 'first' }];
		const t = new TextLLMTransport({ model, initialHistory: arr });
		arr.push({ type: 'text', role: 'user', text: 'injected after construction' });
		await t.connect();
		const msgs = await firstTurnMessages(t, prompts);
		expect(msgs.some((m) => textOf(m) === 'injected after construction')).toBe(false);
		expect(msgs.some((m) => textOf(m) === 'first')).toBe(true);
	});

	it('public replayHistory() seeds when no constructor history was given (and is idempotent)', async () => {
		const { model, prompts } = capturingModel();
		const t = new TextLLMTransport({ model });
		await t.connect();
		t.replayHistory([{ type: 'text', role: 'user', text: 'via method' }]);
		t.replayHistory([{ type: 'text', role: 'user', text: 'second call ignored' }]);
		const msgs = await firstTurnMessages(t, prompts);
		expect(msgs.some((m) => textOf(m) === 'via method')).toBe(true);
		expect(msgs.some((m) => textOf(m) === 'second call ignored')).toBe(false);
	});

	it('skips file and transfer items (and flushes the group across a skip)', async () => {
		const logs: string[] = [];
		const { model, prompts } = capturingModel();
		const t = new TextLLMTransport({
			model,
			log: (m) => logs.push(m),
			initialHistory: [
				{ type: 'tool_call', id: 'c1', name: 'f', args: {} },
				{ type: 'file', role: 'user', base64Data: 'AAAA', mimeType: 'image/png' },
				{ type: 'tool_result', id: 'c1', name: 'f', result: 1 }, // orphaned by the skip boundary
				{ type: 'transfer', fromAgent: 'main', toAgent: 'x' },
			],
		});
		await t.connect();
		// the call was flushed (unanswered) at the file boundary; the later result is an orphan
		expect(toolParts(await firstTurnMessages(t, prompts))).toHaveLength(0);
		expect(logs.some((l) => l.includes('skipped file'))).toBe(true);
		expect(logs.some((l) => l.includes('skipped transfer'))).toBe(true);
	});

	it('drops structurally invalid items and still seeds a valid one after', async () => {
		const logs: string[] = [];
		const { model, prompts } = capturingModel();
		const t = new TextLLMTransport({
			model,
			log: (m) => logs.push(m),
			initialHistory: [
				{ type: 'tool_call', id: 42 as unknown as string, name: 'f', args: {} }, // non-string id
				{ type: 'wat' as unknown as 'text' } as unknown as ReplayItem, // unknown type
				{ type: 'text', role: 'user', text: 'valid after invalid' },
			],
		});
		await t.connect();
		const msgs = await firstTurnMessages(t, prompts);
		expect(msgs.some((m) => textOf(m) === 'valid after invalid')).toBe(true);
		expect(logs.filter((l) => l.includes('dropped invalid item')).length).toBeGreaterThanOrEqual(2);
	});

	it('drops null / non-object items without throwing', async () => {
		const logs: string[] = [];
		const { model, prompts } = capturingModel();
		const t = new TextLLMTransport({
			model,
			log: (m) => logs.push(m),
			initialHistory: [
				null as unknown as ReplayItem,
				42 as unknown as ReplayItem,
				{ type: 'text', role: 'user', text: 'survivor' },
			],
		});
		await expect(t.connect()).resolves.toBeUndefined(); // no throw
		const msgs = await firstTurnMessages(t, prompts);
		expect(msgs.some((m) => textOf(m) === 'survivor')).toBe(true);
		expect(logs.filter((l) => l.includes('not an object')).length).toBeGreaterThanOrEqual(2);
	});

	it('drop/skip logs are payload-free (no text/args/result/base64)', async () => {
		const logs: string[] = [];
		const { model } = capturingModel();
		const t = new TextLLMTransport({
			model,
			log: (m) => logs.push(m),
			initialHistory: [
				{ type: 'text', role: 'nope' as unknown as 'user', text: 'SECRET-TEXT' },
				{ type: 'file', role: 'user', base64Data: 'SECRET-B64', mimeType: 'image/png' },
				{ type: 'tool_result', id: 'ghost', name: 'f', result: 'SECRET-RESULT' },
			],
		});
		await t.connect();
		const joined = logs.join('\n');
		expect(joined).not.toContain('SECRET-TEXT');
		expect(joined).not.toContain('SECRET-B64');
		expect(joined).not.toContain('SECRET-RESULT');
	});
});
