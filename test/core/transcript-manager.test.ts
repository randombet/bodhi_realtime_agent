// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { TranscriptManager } from '../../src/core/transcript-manager.js';
import type { TranscriptSink } from '../../src/core/transcript-manager.js';

function createSink(): TranscriptSink & {
	messages: Record<string, unknown>[];
	userMessages: string[];
	assistantMessages: string[];
} {
	const sink = {
		messages: [] as Record<string, unknown>[],
		userMessages: [] as string[],
		assistantMessages: [] as string[],
		sendToClient: vi.fn((msg: Record<string, unknown>) => sink.messages.push(msg)),
		addUserMessage: vi.fn((text: string) => sink.userMessages.push(text)),
		addAssistantMessage: vi.fn((text: string) => sink.assistantMessages.push(text)),
	};
	return sink;
}

describe('TranscriptManager', () => {
	it('accumulates input and sends partial transcripts', () => {
		const sink = createSink();
		const mgr = new TranscriptManager(sink);

		mgr.handleInput('hello ');
		mgr.handleInput('world');

		expect(sink.messages).toHaveLength(2);
		expect(sink.messages[0]).toEqual({
			type: 'transcript',
			role: 'user',
			text: 'hello',
			partial: true,
		});
		expect(sink.messages[1]).toEqual({
			type: 'transcript',
			role: 'user',
			text: 'hello world',
			partial: true,
		});
	});

	it('accumulates output and sends partial transcripts', () => {
		const sink = createSink();
		const mgr = new TranscriptManager(sink);

		mgr.handleOutput('Hi ');
		mgr.handleOutput('there');

		expect(sink.messages).toHaveLength(2);
		expect(sink.messages[1]).toMatchObject({
			role: 'assistant',
			text: 'Hi there',
			partial: true,
		});
	});

	it('flush finalizes user and assistant messages', () => {
		const sink = createSink();
		const mgr = new TranscriptManager(sink);

		mgr.handleInput('hello');
		mgr.handleOutput('hi');
		mgr.flush();

		expect(sink.userMessages).toEqual(['hello']);
		expect(sink.assistantMessages).toEqual(['hi']);
		// Final (non-partial) messages sent
		const finalUser = sink.messages.find((m) => m.role === 'user' && m.partial === false);
		const finalAssistant = sink.messages.find((m) => m.role === 'assistant' && m.partial === false);
		expect(finalUser).toBeDefined();
		expect(finalAssistant).toBeDefined();
	});

	it('flush clears buffers so next flush is a no-op', () => {
		const sink = createSink();
		const mgr = new TranscriptManager(sink);

		mgr.handleInput('hello');
		mgr.flush();
		const countAfterFirst = sink.messages.length;

		mgr.flush();
		expect(sink.messages).toHaveLength(countAfterFirst);
	});

	it('flushInput only flushes user transcript and leaves output', () => {
		const sink = createSink();
		const mgr = new TranscriptManager(sink);

		mgr.handleInput('question');
		mgr.handleOutput('answer');
		mgr.flushInput();

		expect(sink.userMessages).toEqual(['question']);
		expect(sink.assistantMessages).toEqual([]);

		// Output should still flush on later flush()
		mgr.flush();
		expect(sink.assistantMessages).toEqual(['answer']);
	});

	it('saveOutputPrefix preserves pre-tool output for deduplication', () => {
		const sink = createSink();
		const mgr = new TranscriptManager(sink);

		mgr.handleOutput('Before tool. ');
		mgr.saveOutputPrefix();
		// Post-tool: Gemini re-sends overlapping text
		mgr.handleOutput('tool. After tool.');
		mgr.flush();

		// Should deduplicate the overlap
		expect(sink.assistantMessages[0]).toBe('Before tool. After tool.');
	});

	it('handles exact duplicate post-tool buffer', () => {
		const sink = createSink();
		const mgr = new TranscriptManager(sink);

		mgr.handleOutput('Hello world');
		mgr.saveOutputPrefix();
		// Post-tool output is entirely contained in prefix
		mgr.handleOutput('world');
		mgr.flush();

		expect(sink.assistantMessages[0]).toBe('Hello world');
	});

	it('ignores whitespace-only input', () => {
		const sink = createSink();
		const mgr = new TranscriptManager(sink);

		mgr.handleInput('   ');
		mgr.handleOutput('  \n  ');

		expect(sink.messages).toHaveLength(0);
	});

	describe('handleInputPartial', () => {
		it('sends partial transcript to client', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.handleInputPartial('searching for');

			expect(sink.messages).toHaveLength(1);
			expect(sink.messages[0]).toEqual({
				type: 'transcript',
				role: 'user',
				text: 'searching for',
				partial: true,
			});
		});

		it('does NOT accumulate in input buffer', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.handleInputPartial('partial text');
			mgr.flush();

			// No user message should be recorded — partials don't accumulate
			expect(sink.userMessages).toHaveLength(0);
		});

		it('ignores whitespace-only partials', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.handleInputPartial('   ');
			expect(sink.messages).toHaveLength(0);
		});

		it('does not interfere with handleInput accumulation', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			// Mix partials and regular input
			mgr.handleInputPartial('interim result');
			mgr.handleInput('final text');
			mgr.flush();

			// Only handleInput text should be in user messages
			expect(sink.userMessages).toEqual(['final text']);
		});
	});

	it('handles no-overlap prefix + buffer by joining with space', () => {
		const sink = createSink();
		const mgr = new TranscriptManager(sink);

		mgr.handleOutput('First part.');
		mgr.saveOutputPrefix();
		mgr.handleOutput('Second part.');
		mgr.flush();

		expect(sink.assistantMessages[0]).toBe('First part. Second part.');
	});
});
