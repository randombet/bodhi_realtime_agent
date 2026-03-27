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

	describe('onInputFinalized', () => {
		it('fires on flushInput() with finalized text', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);
			const finalized: string[] = [];
			mgr.onInputFinalized = (text) => finalized.push(text);

			mgr.handleInput('hello world');
			mgr.flushInput();

			expect(finalized).toEqual(['hello world']);
		});

		it('fires on flush() with finalized input text', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);
			const finalized: string[] = [];
			mgr.onInputFinalized = (text) => finalized.push(text);

			mgr.handleInput('question');
			mgr.handleOutput('answer');
			mgr.flush();

			expect(finalized).toEqual(['question']);
		});

		it('does not fire when input buffer is empty', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);
			const finalized: string[] = [];
			mgr.onInputFinalized = (text) => finalized.push(text);

			mgr.handleOutput('answer');
			mgr.flush();

			expect(finalized).toEqual([]);
		});

		it('does not fire when callback is not set', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);
			// No onInputFinalized set — should not throw
			mgr.handleInput('text');
			expect(() => mgr.flushInput()).not.toThrow();
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

	describe('correctInput', () => {
		it('replaces input buffer with authoritative transcript', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			// STT provides initial (incorrect) transcript
			mgr.handleInput('Hola mi nombre es Juan');
			// Gemini corrects it
			mgr.correctInput('Hello my name is John');
			mgr.flush();

			expect(sink.userMessages).toEqual(['Hello my name is John']);
		});

		it('sends corrected partial to client', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.correctInput('corrected text');

			const correctionMsg = sink.messages.find((m) => m.corrected === true);
			expect(correctionMsg).toEqual({
				type: 'transcript',
				role: 'user',
				text: 'corrected text',
				partial: true,
				corrected: true,
			});
		});

		it('no-op when correction is empty or whitespace', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.handleInput('original text');
			mgr.correctInput('');
			mgr.correctInput('   ');
			mgr.flush();

			expect(sink.userMessages).toEqual(['original text']);
		});

		it('last correction wins when multiple arrive', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.handleInput('stt text');
			mgr.correctInput('first correction');
			mgr.correctInput('second correction');
			mgr.flush();

			expect(sink.userMessages).toEqual(['second correction']);
		});
	});
});
