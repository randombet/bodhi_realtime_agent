import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	GeminiBatchSTTProvider,
	stripMetaEnvelope,
} from '../../src/transport/gemini-batch-stt-provider.js';
import { generateSilence, generateTone } from '../__tests__/helpers/test-audio.js';

const mockGenerateContent = vi.fn();

vi.mock('@google/genai', () => ({
	GoogleGenAI: vi.fn().mockImplementation(() => ({
		models: {
			generateContent: mockGenerateContent,
		},
	})),
}));

// Generate test audio data
const toneChunk = generateTone(500).toString('base64');
const silenceChunk = generateSilence(500).toString('base64');
const shortTone = generateTone(100).toString('base64');

describe('GeminiBatchSTTProvider', () => {
	let provider: GeminiBatchSTTProvider;

	beforeEach(() => {
		mockGenerateContent.mockReset();
		provider = new GeminiBatchSTTProvider({
			apiKey: 'test-key',
			model: 'gemini-3-flash-preview',
		});
		provider.configure({ sampleRate: 16000, bitDepth: 16, channels: 1 });
	});

	describe('configure', () => {
		it('stores sample rate for WAV header', () => {
			// Implicitly tested — configure succeeds without error
			const p = new GeminiBatchSTTProvider({ apiKey: 'k', model: 'm' });
			p.configure({ sampleRate: 24000, bitDepth: 16, channels: 1 });
			// No assertion needed — the sample rate is used internally in commit()
		});

		it('rejects unsupported bit depth', () => {
			const p = new GeminiBatchSTTProvider({ apiKey: 'k', model: 'm' });
			expect(() => p.configure({ sampleRate: 16000, bitDepth: 8, channels: 1 })).toThrow(
				'bitDepth=16',
			);
		});

		it('rejects unsupported channel count', () => {
			const p = new GeminiBatchSTTProvider({ apiKey: 'k', model: 'm' });
			expect(() => p.configure({ sampleRate: 16000, bitDepth: 16, channels: 2 })).toThrow(
				'channels=1',
			);
		});
	});

	describe('feedAudio', () => {
		it('buffers chunks', () => {
			provider.feedAudio(toneChunk);
			provider.feedAudio(toneChunk);

			// Verify buffering by committing and checking generateContent was called
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: 'hello' }] } }],
			});
			provider.commit(0);
			expect(mockGenerateContent).toHaveBeenCalledOnce();
		});

		it('enforces MAX_BUFFER_BYTES by dropping oldest chunks', () => {
			// MAX_BUFFER_BYTES = 960_000 (~30s at 16kHz 16-bit mono)
			// Each 500ms tone chunk is ~16000 bytes of raw PCM
			// We need many chunks to exceed the limit
			const bigChunk = generateTone(5000).toString('base64'); // 5s = ~160KB
			for (let i = 0; i < 8; i++) {
				provider.feedAudio(bigChunk); // 8 * ~160KB = ~1.28MB > 960KB
			}

			// Should not throw, and the provider should have dropped oldest chunks
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: 'test' }] } }],
			});
			provider.commit(0);
			expect(mockGenerateContent).toHaveBeenCalledOnce();

			// The WAV data sent should be less than MAX_BUFFER_BYTES
			const callArgs = mockGenerateContent.mock.calls[0][0];
			const b64Data = callArgs.contents[0].parts[0].inlineData.data;
			const wavBytes = Buffer.from(b64Data, 'base64').length;
			// WAV = 44 header + PCM data; PCM data should be <= MAX_BUFFER_BYTES
			expect(wavBytes - 44).toBeLessThanOrEqual(960_000);
		});
	});

	describe('commit', () => {
		it('triggers generateContent and fires onTranscript with correct turnId', async () => {
			const onTranscript = vi.fn();
			provider.onTranscript = onTranscript;

			provider.feedAudio(toneChunk);

			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: 'hello world' }] } }],
			});

			provider.commit(42);

			await vi.waitFor(() => {
				expect(onTranscript).toHaveBeenCalledWith('hello world', 42);
			});
		});

		it('clears buffer after commit', () => {
			provider.feedAudio(toneChunk);
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: 'first' }] } }],
			});

			provider.commit(0);
			mockGenerateContent.mockClear();

			// Second commit should have empty buffer
			provider.commit(1);
			expect(mockGenerateContent).not.toHaveBeenCalled();
		});

		it('does nothing with empty buffer', () => {
			provider.commit(0);
			expect(mockGenerateContent).not.toHaveBeenCalled();
		});

		it('sends correct model name', () => {
			provider.feedAudio(toneChunk);
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: 'test' }] } }],
			});

			provider.commit(0);

			expect(mockGenerateContent.mock.calls[0][0].model).toBe('gemini-3-flash-preview');
		});

		it('sends WAV format', () => {
			provider.feedAudio(toneChunk);
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: 'test' }] } }],
			});

			provider.commit(0);

			const mimeType =
				mockGenerateContent.mock.calls[0][0].contents[0].parts[0].inlineData.mimeType;
			expect(mimeType).toBe('audio/wav');
		});
	});

	describe('silence and short audio filtering', () => {
		it('skips STT for silence audio (low RMS)', () => {
			provider.feedAudio(silenceChunk);
			provider.commit(0);
			expect(mockGenerateContent).not.toHaveBeenCalled();
		});

		it('skips STT for very short audio (<0.3s)', () => {
			provider.feedAudio(shortTone);
			provider.commit(0);
			expect(mockGenerateContent).not.toHaveBeenCalled();
		});
	});

	describe('[SILENCE] response filtering', () => {
		it('filters [SILENCE] responses', async () => {
			const onTranscript = vi.fn();
			provider.onTranscript = onTranscript;

			provider.feedAudio(toneChunk);
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: '[SILENCE]' }] } }],
			});

			provider.commit(0);
			await new Promise((r) => setTimeout(r, 10));

			expect(onTranscript).not.toHaveBeenCalled();
		});
	});

	describe('STT failure handling', () => {
		it('handles generateContent rejection gracefully', async () => {
			const onTranscript = vi.fn();
			provider.onTranscript = onTranscript;

			provider.feedAudio(toneChunk);
			mockGenerateContent.mockRejectedValue(new Error('API error'));

			provider.commit(0);
			await new Promise((r) => setTimeout(r, 10));

			expect(onTranscript).not.toHaveBeenCalled();
		});
	});

	describe('handleInterrupted / handleTurnComplete', () => {
		it('preserves buffer when turn is interrupted', () => {
			provider.feedAudio(toneChunk);

			provider.handleInterrupted();
			provider.handleTurnComplete();

			// Buffer should be preserved — commit should find audio
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: 'hello' }] } }],
			});
			provider.commit(0);
			expect(mockGenerateContent).toHaveBeenCalledOnce();
		});

		it('clears buffer on natural turn completion', () => {
			provider.feedAudio(toneChunk);

			provider.handleTurnComplete();

			// Buffer should be cleared — commit should be a no-op
			provider.commit(0);
			expect(mockGenerateContent).not.toHaveBeenCalled();
		});

		it('resets interrupted flag after handleTurnComplete', () => {
			provider.handleInterrupted();
			provider.handleTurnComplete();

			// Next turn: feed audio, then natural completion should clear
			provider.feedAudio(toneChunk);
			provider.handleTurnComplete();

			provider.commit(0);
			expect(mockGenerateContent).not.toHaveBeenCalled();
		});
	});

	describe('start / stop', () => {
		it('start is a no-op', async () => {
			await provider.start();
			// No error means success
		});

		it('stop clears buffer', async () => {
			provider.feedAudio(toneChunk);
			await provider.stop();

			provider.commit(0);
			expect(mockGenerateContent).not.toHaveBeenCalled();
		});
	});

	describe('onPartialTranscript', () => {
		it('never fires (batch provider)', async () => {
			const onPartial = vi.fn();
			const onTranscript = vi.fn();
			provider.onPartialTranscript = onPartial;
			provider.onTranscript = onTranscript;

			provider.feedAudio(toneChunk);
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: 'hello' }] } }],
			});
			provider.commit(0);

			await vi.waitFor(() => {
				expect(onTranscript).toHaveBeenCalled();
			});
			expect(onPartial).not.toHaveBeenCalled();
		});
	});

	describe('prompt + system instruction', () => {
		it('passes a systemInstruction with strict output rules', () => {
			provider.feedAudio(toneChunk);
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: 'hello' }] } }],
			});
			provider.commit(0);

			const callArgs = mockGenerateContent.mock.calls[0][0];
			const sys = callArgs.config?.systemInstruction;
			expect(typeof sys).toBe('string');
			expect(sys).toMatch(/verbatim/i);
			expect(sys).toMatch(/no preamble|forbidden/i);
			expect(sys).toMatch(/\[SILENCE\]/);
		});

		it('keeps the user-facing text minimal (no embedded rules)', () => {
			provider.feedAudio(toneChunk);
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: 'hello' }] } }],
			});
			provider.commit(0);

			const userText = mockGenerateContent.mock.calls[0][0].contents[0].parts[1].text as string;
			expect(userText.length).toBeLessThan(40);
		});
	});

	describe('meta-envelope stripping', () => {
		it('strips "The transcription for the audio provided is as follows: …" + surrounding quotes', async () => {
			const onTranscript = vi.fn();
			provider.onTranscript = onTranscript;
			provider.feedAudio(toneChunk);
			mockGenerateContent.mockResolvedValue({
				candidates: [
					{
						content: {
							parts: [
								{
									text: 'The transcription for the audio provided is as follows: \n\n"Uh, sounds great. Can you send me an email?"',
								},
							],
						},
					},
				],
			});
			provider.commit(7);

			await vi.waitFor(() => expect(onTranscript).toHaveBeenCalled());
			expect(onTranscript).toHaveBeenCalledWith('Uh, sounds great. Can you send me an email?', 7);
		});

		it('strips a leading "Sure," + transcription envelope', async () => {
			const onTranscript = vi.fn();
			provider.onTranscript = onTranscript;
			provider.feedAudio(toneChunk);
			mockGenerateContent.mockResolvedValue({
				candidates: [
					{
						content: {
							parts: [{ text: 'Sure, the transcription is: hello world' }],
						},
					},
				],
			});
			provider.commit(0);

			await vi.waitFor(() => expect(onTranscript).toHaveBeenCalled());
			expect(onTranscript).toHaveBeenCalledWith('hello world', 0);
		});

		it('strips "Here is the transcription:" + outer quotes', async () => {
			const onTranscript = vi.fn();
			provider.onTranscript = onTranscript;
			provider.feedAudio(toneChunk);
			mockGenerateContent.mockResolvedValue({
				candidates: [
					{
						content: { parts: [{ text: 'Here is the transcription: "what time is it"' }] },
					},
				],
			});
			provider.commit(0);

			await vi.waitFor(() => expect(onTranscript).toHaveBeenCalled());
			expect(onTranscript).toHaveBeenCalledWith('what time is it', 0);
		});

		it('filters [SILENCE] even when wrapped in an envelope', async () => {
			const onTranscript = vi.fn();
			provider.onTranscript = onTranscript;
			provider.feedAudio(toneChunk);
			mockGenerateContent.mockResolvedValue({
				candidates: [{ content: { parts: [{ text: 'The transcription is: [SILENCE]' }] } }],
			});
			provider.commit(0);

			await new Promise((r) => setTimeout(r, 10));
			expect(onTranscript).not.toHaveBeenCalled();
		});

		it('does not strip phrases that legitimately start an utterance', () => {
			// User actually says: "the transcription tool I'm building" — no colon, must not match.
			expect(stripMetaEnvelope("the transcription tool I'm building")).toBe(
				"the transcription tool I'm building",
			);
			// User says: "Here is what I think" — no transcription/transcribed reference, must not match.
			expect(stripMetaEnvelope('Here is what I think')).toBe('Here is what I think');
		});

		it('handles nested layered envelopes', () => {
			expect(
				stripMetaEnvelope('Sure, the transcription is: "Here is the transcription: actual words"'),
			).toBe('actual words');
		});

		it('preserves unaffected output unchanged', () => {
			expect(stripMetaEnvelope('hello world')).toBe('hello world');
			expect(stripMetaEnvelope('  hello world  ')).toBe('hello world');
			expect(stripMetaEnvelope('[SILENCE]')).toBe('[SILENCE]');
		});

		it('strips a single layer of surrounding curly quotes', () => {
			expect(stripMetaEnvelope('“actual words”')).toBe('actual words');
			expect(stripMetaEnvelope('"actual words"')).toBe('actual words');
		});
	});
});

describe('contextHint (deck vocabulary bias)', () => {
	const okResponse = { candidates: [{ content: { parts: [{ text: 'hello' }] } }] };

	/** The user-part prompt text and systemInstruction of the n-th generateContent request. */
	function request(n: number): { prompt: string; systemInstruction: unknown } {
		const args = mockGenerateContent.mock.calls[n][0];
		return {
			prompt: args.contents[0].parts[1].text as string,
			systemInstruction: args.config?.systemInstruction,
		};
	}

	beforeEach(() => {
		mockGenerateContent.mockReset();
		mockGenerateContent.mockResolvedValue(okResponse);
	});

	it('base prompt without a hint is exactly the minimal user prompt', () => {
		const p = new GeminiBatchSTTProvider({ apiKey: 'k', model: 'm' });
		expect(p.buildPrompt()).toBe('Transcribe.');
	});

	it('static hint is embedded with prefer-exact-spelling instruction', () => {
		const p = new GeminiBatchSTTProvider({
			apiKey: 'k',
			model: 'm',
			contextHint: 'KDA, math derivation, delta rule',
		});
		const prompt = p.buildPrompt();
		expect(prompt.startsWith('Transcribe.\n')).toBe(true);
		expect(prompt).toContain('math derivation');
		expect(prompt).toContain('exact spelling');
		expect(prompt).toContain('Do NOT force a match');
	});

	it('function hint is re-read per call — deck can load after construction', () => {
		const holder: { deck?: string } = {};
		const p = new GeminiBatchSTTProvider({
			apiKey: 'k',
			model: 'm',
			contextHint: () => holder.deck,
		});
		expect(p.buildPrompt()).toBe('Transcribe.');
		holder.deck = 'MoonViT, LatentMoE';
		expect(p.buildPrompt()).toContain('MoonViT');
		holder.deck = 'RoPE';
		expect(p.buildPrompt()).toContain('RoPE');
		expect(p.buildPrompt()).not.toContain('MoonViT');
	});

	it('setContextHint replaces the hint; empty/whitespace hint falls back to base', () => {
		const p = new GeminiBatchSTTProvider({ apiKey: 'k', model: 'm', contextHint: 'KDA' });
		p.setContextHint('   ');
		expect(p.buildPrompt()).toBe('Transcribe.');
		p.setContextHint('');
		expect(p.buildPrompt()).toBe('Transcribe.');
		p.setContextHint(() => ' \n ');
		expect(p.buildPrompt()).toBe('Transcribe.');
		p.setContextHint('RoPE, NoPE');
		expect(p.buildPrompt()).toContain('NoPE');
		expect(p.buildPrompt()).not.toContain('KDA');
		p.setContextHint(undefined);
		expect(p.buildPrompt()).toBe('Transcribe.');
	});

	it('commit() sends the hinted prompt in the user part and leaves systemInstruction unchanged', () => {
		const plain = new GeminiBatchSTTProvider({ apiKey: 'k', model: 'm' });
		plain.configure({ sampleRate: 16000, bitDepth: 16, channels: 1 });
		plain.feedAudio(toneChunk);
		plain.commit(0);

		const hinted = new GeminiBatchSTTProvider({
			apiKey: 'k',
			model: 'm',
			contextHint: 'KDA, math derivation',
		});
		hinted.configure({ sampleRate: 16000, bitDepth: 16, channels: 1 });
		hinted.feedAudio(toneChunk);
		hinted.commit(1);

		expect(mockGenerateContent).toHaveBeenCalledTimes(2);
		const base = request(0);
		const withHint = request(1);
		expect(base.prompt).toBe('Transcribe.');
		expect(withHint.prompt).toBe(hinted.buildPrompt());
		expect(withHint.prompt).toContain('math derivation');
		expect(typeof withHint.systemInstruction).toBe('string');
		expect(withHint.systemInstruction).toBe(base.systemInstruction);
		expect(withHint.systemInstruction).not.toContain('math derivation');
	});

	it('changing the hint between commits changes only the next request', () => {
		const holder: { deck?: string } = { deck: 'KDA' };
		const p = new GeminiBatchSTTProvider({
			apiKey: 'k',
			model: 'm',
			contextHint: () => holder.deck,
		});
		p.configure({ sampleRate: 16000, bitDepth: 16, channels: 1 });

		p.feedAudio(toneChunk);
		p.commit(1);
		// The deck changes after the first request was sent and before the next commit.
		p.feedAudio(toneChunk);
		holder.deck = 'MoonViT';
		p.commit(2);
		p.setContextHint('LatentMoE');
		p.feedAudio(toneChunk);
		p.commit(3);

		expect(mockGenerateContent).toHaveBeenCalledTimes(3);
		expect(request(0).prompt).toContain('KDA');
		expect(request(0).prompt).not.toContain('MoonViT');
		expect(request(1).prompt).toContain('MoonViT');
		expect(request(1).prompt).not.toContain('KDA');
		expect(request(2).prompt).toContain('LatentMoE');
		expect(request(2).prompt).not.toContain('MoonViT');
		expect(request(1).systemInstruction).toBe(request(0).systemInstruction);
		expect(request(2).systemInstruction).toBe(request(0).systemInstruction);
	});

	it('a throwing hint function falls back to the base prompt and never escapes commit()', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const hintError = new Error('deck lookup failed');
		const p = new GeminiBatchSTTProvider({
			apiKey: 'k',
			model: 'm',
			contextHint: () => {
				throw hintError;
			},
		});
		p.configure({ sampleRate: 16000, bitDepth: 16, channels: 1 });

		expect(p.buildPrompt()).toBe('Transcribe.');

		p.feedAudio(toneChunk);
		expect(() => p.commit(1)).not.toThrow();

		expect(mockGenerateContent).toHaveBeenCalledOnce();
		expect(request(0).prompt).toBe('Transcribe.');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('contextHint'), hintError);
		warn.mockRestore();
	});
});
