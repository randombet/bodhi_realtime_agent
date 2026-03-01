// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiBatchSTTProvider } from '../../src/transport/gemini-batch-stt-provider.js';
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
});
