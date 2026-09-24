import { describe, expect, it, vi } from 'vitest';
import { TranscriptManager } from '../../src/core/transcript-manager.js';
import type { TranscriptSink } from '../../src/core/transcript-manager.js';
import type {
	CoreServerToClientMessage,
	TranscriptMessage,
} from '../../src/types/client-protocol.js';

function createSink(): TranscriptSink & {
	messages: TranscriptMessage[];
	userMessages: string[];
	assistantMessages: string[];
} {
	const sink = {
		messages: [] as TranscriptMessage[],
		userMessages: [] as string[],
		assistantMessages: [] as string[],
		sendToClient: vi.fn((msg: CoreServerToClientMessage) =>
			sink.messages.push(msg as TranscriptMessage),
		),
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

	it('ignores late input after flushInput finalized the user transcript', () => {
		const sink = createSink();
		const mgr = new TranscriptManager(sink);

		mgr.correctInput('What time is it?');
		mgr.flushInput();
		mgr.handleInput('Uh, what time is it?');
		mgr.flush();

		expect(sink.userMessages).toEqual(['What time is it?']);
	});

	it('accepts late input after an empty flushInput call', () => {
		const sink = createSink();
		const mgr = new TranscriptManager(sink);

		mgr.flushInput();
		mgr.handleInput('late transcript');
		mgr.flush();

		expect(sink.userMessages).toEqual(['late transcript']);
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

	describe('showInterruptedInputPartial', () => {
		it('accumulates realtime deltas into a running partial transcript', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.showInterruptedInputPartial('sor');
			mgr.showInterruptedInputPartial('ry, ');
			mgr.showInterruptedInputPartial('how are you?');

			const partials = sink.messages.filter((m) => m.role === 'user' && m.partial === true);
			expect(partials.at(-1)).toEqual({
				type: 'transcript',
				role: 'user',
				text: 'sorry, how are you?',
				partial: true,
			});
		});

		it('is display-only — batch STT (handleInput) remains authoritative for the finalized message', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			// Realtime transcription shown immediately on an interrupted turn…
			mgr.showInterruptedInputPartial('sorry, how are you?');
			// …then the slower batch STT corrects and finalizes it.
			mgr.handleInput('Oh sorry, how you doing today?');
			mgr.flush();

			expect(sink.userMessages).toEqual(['Oh sorry, how you doing today?']);
		});

		it('resets the display buffer on flush so the next turn starts fresh', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.showInterruptedInputPartial('first turn');
			mgr.flush();
			mgr.showInterruptedInputPartial('second');

			const partials = sink.messages.filter((m) => m.role === 'user' && m.partial === true);
			expect(partials.at(-1)?.text).toBe('second');
		});

		it('ignores whitespace-only deltas', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.showInterruptedInputPartial('   ');
			expect(sink.messages).toHaveLength(0);
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

	describe('onBeforeFlush', () => {
		it('runs at the top of flush(), before the output buffer is committed, and not from flushInput()', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);
			const calls: string[][] = [];
			mgr.onBeforeFlush = () => {
				calls.push([...sink.assistantMessages]);
				mgr.handleOutput(' and the held rest');
			};

			mgr.handleInput('question');
			mgr.handleOutput('An answer');
			mgr.flushInput();
			expect(calls).toEqual([]);

			mgr.flush();

			expect(calls).toEqual([[]]);
			expect(sink.assistantMessages).toEqual(['An answer and the held rest']);
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
		// Precedence: the external STT provider (handleInput) is the authoritative
		// transcript; the transport's own transcription (correctInput) is a live
		// display source and a fallback. This must hold in BOTH arrival orders.
		it('external STT outranks the provider correction when STT lands first', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.handleInput('Hola mi nombre es Juan');
			mgr.correctInput('Hello my name is John');
			mgr.flush();

			expect(sink.userMessages).toEqual(['Hola mi nombre es Juan']);
		});

		it('external STT outranks the provider correction when STT lands last', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.correctInput('Hello my name is John');
			mgr.handleInput('Hola mi nombre es Juan');
			mgr.flush();

			expect(sink.userMessages).toEqual(['Hola mi nombre es Juan']);
		});

		it('falls back to the provider correction when STT never produces text', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

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

		// Gemini's inputTranscription arrives as incremental deltas, not as a
		// whole restated transcript per call (same contract as the no-STT path,
		// which appends, and as showInterruptedInputPartial, which accumulates).
		it('accumulates successive deltas of one utterance', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.correctInput('Hi');
			mgr.correctInput(', uh');
			mgr.correctInput(', I would');
			mgr.correctInput(' like to know');

			const corrections = sink.messages.filter((m) => m.corrected === true);
			expect(corrections.map((m) => m.text)).toEqual([
				'Hi',
				'Hi, uh',
				'Hi, uh, I would',
				'Hi, uh, I would like to know',
			]);
		});

		it('finalizes the whole corrected utterance, not the last delta', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			for (const delta of ['Is', ' there', ' any', ' pending', ' task?']) {
				mgr.correctInput(delta);
			}
			mgr.flush();

			expect(sink.userMessages).toEqual(['Is there any pending task?']);
		});

		// The batch STT provider emits the full utterance once per turn and is
		// authoritative for the finalized message, so it must replace the
		// provider-correction text rather than concatenate onto its tail.
		it('batch STT replaces accumulated correction text instead of appending', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.correctInput('how');
			mgr.correctInput(' it could');
			mgr.correctInput(' connect to my lo');
			mgr.correctInput('cal');
			// Batch STT lands after the realtime deltas with the full utterance.
			mgr.handleInput('How could it connect to Sutando on my local Mac.', 1);
			mgr.flush();

			expect(sink.userMessages).toEqual(['How could it connect to Sutando on my local Mac.']);
		});

		it('a late correction delta cannot clobber the authoritative transcript', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.correctInput('how it could connect to my lo');
			mgr.handleInput('How could it connect to Sutando on my local Mac.', 1);
			// Gemini keeps streaming after the batch result landed.
			mgr.correctInput('cal');
			mgr.flush();

			expect(sink.userMessages).toEqual(['How could it connect to Sutando on my local Mac.']);
		});

		it('resets the correction buffer between utterances', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.correctInput('first');
			mgr.correctInput(' utterance');
			mgr.flush();
			mgr.correctInput('second');
			mgr.correctInput(' utterance');
			mgr.flush();

			expect(sink.userMessages).toEqual(['first utterance', 'second utterance']);
		});
	});

	describe('reservation (authoritative transcript still in flight)', () => {
		function createReservingSink() {
			const base = createSink();
			const reserved: { id: string; text: string; sealed: boolean }[] = [];
			return Object.assign(base, {
				reserved,
				reserveUserMessage: vi.fn((text: string) => {
					const id = `r${reserved.length + 1}`;
					reserved.push({ id, text, sealed: false });
					return id;
				}),
				sealUserMessage: vi.fn((id: string, text?: string) => {
					const slot = reserved.find((r) => r.id === id);
					if (!slot || slot.sealed) return false;
					if (text?.trim()) slot.text = text.trim();
					slot.sealed = true;
					return true;
				}),
			});
		}

		const opts = { expectsAuthoritativeInput: true, currentTurnId: () => 7 };

		it('reserves instead of committing when only fallback text is available', () => {
			const sink = createReservingSink();
			const mgr = new TranscriptManager(sink, opts);

			mgr.correctInput('task.');
			mgr.flush();

			expect(sink.userMessages).toEqual([]); // not committed outright
			expect(sink.reserved).toEqual([{ id: 'r1', text: 'task.', sealed: false }]);
		});

		it('seals the reservation when the authoritative transcript finally lands', () => {
			const sink = createReservingSink();
			const mgr = new TranscriptManager(sink, opts);

			mgr.correctInput('task.');
			mgr.flush();

			expect(mgr.sealReservedInput(7, 'Is there any pending task?')).toBe(true);
			expect(sink.reserved[0]).toEqual({
				id: 'r1',
				text: 'Is there any pending task?',
				sealed: true,
			});
		});

		it('commits outright — no reservation — when the authoritative text is already in hand', () => {
			const sink = createReservingSink();
			const mgr = new TranscriptManager(sink, opts);

			mgr.correctInput('task.');
			mgr.handleInput('Is there any pending task?', 7);
			mgr.flush();

			expect(sink.reserved).toEqual([]);
			expect(sink.userMessages).toEqual(['Is there any pending task?']);
		});

		it('sealPendingInput keeps the fallback text when STT never returns', () => {
			const sink = createReservingSink();
			const mgr = new TranscriptManager(sink, opts);

			mgr.correctInput('task.');
			mgr.flush();
			mgr.sealPendingInput();

			expect(sink.reserved[0]).toEqual({ id: 'r1', text: 'task.', sealed: true });
			expect(mgr.sealReservedInput(7, 'too late')).toBe(false);
		});

		it('reports false for a turn with no outstanding reservation', () => {
			const sink = createReservingSink();
			const mgr = new TranscriptManager(sink, opts);

			expect(mgr.sealReservedInput(7, 'anything')).toBe(false);
		});

		it('never reserves when no authoritative source is configured', () => {
			const sink = createReservingSink();
			const mgr = new TranscriptManager(sink, { currentTurnId: () => 7 });

			mgr.handleInput('plain transcript');
			mgr.flush();

			expect(sink.reserved).toEqual([]);
			expect(sink.userMessages).toEqual(['plain transcript']);
		});
	});

	describe('per-utterance boundary (turn-aware input)', () => {
		// Two user utterances spoken without an intervening turn flush (e.g. the
		// first barge-in was rejected as too quiet, so no turn finalized) used to
		// concatenate into one user message: "Hi, how are you doing?Hi, how are
		// you doing?". A change of STT turnId now finalizes the prior utterance.
		it('a new STT turnId finalizes the prior utterance instead of concatenating', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.handleInput('Hi, how are you doing?', 0);
			mgr.handleInput('Hi, how are you doing?', 1);
			mgr.flush();

			expect(sink.userMessages).toEqual(['Hi, how are you doing?', 'Hi, how are you doing?']);
			const finals = sink.messages.filter((m) => m.partial === false && m.role === 'user');
			expect(finals).toHaveLength(2);
		});

		it('distinct utterances with different turnIds stay separate (no merged garbage)', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.handleInput('No, no, can you tell me a story?', 2);
			mgr.handleInput('Hello hello.', 3);
			mgr.flush();

			expect(sink.userMessages).toEqual(['No, no, can you tell me a story?', 'Hello hello.']);
		});

		it('a batch transcript restating an existing correction does not double the text', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			// Provider correction lands first (replace), then the batch STT result
			// for the same utterance arrives (turn-bearing) — must not append.
			mgr.correctInput('Hi, how are you doing?');
			mgr.handleInput('Hi, how are you doing?', 0);
			mgr.flush();

			expect(sink.userMessages).toEqual(['Hi, how are you doing?']);
		});

		it('id-less providers keep plain delta-append behavior', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.handleInput('hello ');
			mgr.handleInput('world');
			mgr.flush();

			expect(sink.userMessages).toEqual(['hello world']);
		});

		it('same-utterance streaming refinements (same turnId) still accumulate', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.handleInput('how ', 0);
			mgr.handleInput('are you', 0);
			mgr.flush();

			expect(sink.userMessages).toEqual(['how are you']);
		});
	});

	describe('finalizeInterruptedInputPartial (R7b — replayed-turn transcript)', () => {
		it('promotes the interrupted display partial to a finalized user message', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.showInterruptedInputPartial('how about ');
			mgr.showInterruptedInputPartial('tomorrow?');
			expect(sink.userMessages).toEqual([]); // display-only so far

			expect(mgr.finalizeInterruptedInputPartial()).toBe(true);
			expect(sink.userMessages).toEqual(['how about tomorrow?']);
			expect(sink.messages.at(-1)).toMatchObject({
				type: 'transcript',
				role: 'user',
				text: 'how about tomorrow?',
				partial: false,
				recovered: true,
			});
		});

		it('prefers the authoritative inputBuffer over the display partial', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.showInterruptedInputPartial('how bout tmrrow'); // garbled realtime delta
			mgr.handleInput('How about tomorrow?', 3); // batch STT (authoritative)

			expect(mgr.finalizeInterruptedInputPartial()).toBe(true);
			expect(sink.userMessages).toEqual(['How about tomorrow?']);
		});

		it('returns false and emits nothing when no partial is pending', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);
			expect(mgr.finalizeInterruptedInputPartial()).toBe(false);
			expect(sink.userMessages).toEqual([]);
			expect(sink.messages).toEqual([]);
		});

		it('locks the turn: late input after promotion does not duplicate the message', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);

			mgr.showInterruptedInputPartial('hello there');
			expect(mgr.finalizeInterruptedInputPartial()).toBe(true);

			// A trailing batch transcript for the same (already promoted) utterance
			// must not re-accumulate; a second promotion is a no-op; flush() adds
			// no duplicate user message.
			mgr.handleInput('hello there', 5);
			expect(mgr.finalizeInterruptedInputPartial()).toBe(false);
			mgr.flush();
			expect(sink.userMessages).toEqual(['hello there']);
		});

		it('fires onInputFinalized with the promoted text', () => {
			const sink = createSink();
			const mgr = new TranscriptManager(sink);
			const finalized: string[] = [];
			mgr.onInputFinalized = (text) => finalized.push(text);

			mgr.showInterruptedInputPartial('promote me');
			mgr.finalizeInterruptedInputPartial();
			expect(finalized).toEqual(['promote me']);
		});
	});
});
