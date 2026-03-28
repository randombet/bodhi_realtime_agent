// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { SentenceBuffer } from '../../src/audio/sentence-buffer.js';

describe('SentenceBuffer', () => {
	it('buffers partial sentence and returns empty array', () => {
		const sb = new SentenceBuffer();
		expect(sb.add('Hello')).toEqual([]);
		expect(sb.add(' world')).toEqual([]);
	});

	it('emits sentence on period + whitespace', () => {
		const sb = new SentenceBuffer();
		sb.add('Hello');
		const result = sb.add(' world. ');
		expect(result).toEqual(['Hello world. ']);
	});

	it('emits sentence on exclamation + whitespace', () => {
		const sb = new SentenceBuffer();
		const result = sb.add('Wow! Great');
		expect(result).toEqual(['Wow! ']);
		// "Great" remains in buffer
		expect(sb.flush()).toBe('Great');
	});

	it('emits sentence on question mark + whitespace', () => {
		const sb = new SentenceBuffer();
		const result = sb.add('Really? Yes');
		expect(result).toEqual(['Really? ']);
		expect(sb.flush()).toBe('Yes');
	});

	it('emits multiple sentences from a single token', () => {
		const sb = new SentenceBuffer();
		const result = sb.add('First. Second! Third? Rest');
		expect(result).toEqual(['First. ', 'Second! ', 'Third? ']);
		expect(sb.flush()).toBe('Rest');
	});

	it('handles CJK period without trailing space', () => {
		const sb = new SentenceBuffer();
		const result = sb.add('こんにちは。世界');
		expect(result).toEqual(['こんにちは。']);
		expect(sb.flush()).toBe('世界');
	});

	it('handles CJK exclamation and question marks', () => {
		const sb = new SentenceBuffer();
		const result = sb.add('すごい！本当？はい');
		expect(result).toEqual(['すごい！', '本当？']);
		expect(sb.flush()).toBe('はい');
	});

	it('flush returns remaining buffer', () => {
		const sb = new SentenceBuffer();
		sb.add('incomplete sentence');
		expect(sb.flush()).toBe('incomplete sentence');
		// After flush, buffer is empty
		expect(sb.flush()).toBe('');
	});

	it('flush trims whitespace', () => {
		const sb = new SentenceBuffer();
		sb.add('  trailing whitespace  ');
		expect(sb.flush()).toBe('trailing whitespace');
	});

	it('clear discards buffer without emitting', () => {
		const sb = new SentenceBuffer();
		sb.add('some text');
		sb.clear();
		expect(sb.flush()).toBe('');
	});

	it('returns empty array for empty input', () => {
		const sb = new SentenceBuffer();
		expect(sb.add('')).toEqual([]);
	});

	it('accumulates across multiple add calls', () => {
		const sb = new SentenceBuffer();
		expect(sb.add('Hel')).toEqual([]);
		expect(sb.add('lo ')).toEqual([]);
		expect(sb.add('wor')).toEqual([]);
		const result = sb.add('ld. Next');
		expect(result).toEqual(['Hello world. ']);
		expect(sb.flush()).toBe('Next');
	});

	it('max-chars fallback emits after 200 chars without sentence boundary', () => {
		const sb = new SentenceBuffer();
		const longText = 'a'.repeat(200);
		const result = sb.add(longText);
		expect(result).toEqual([longText]);
		expect(sb.flush()).toBe('');
	});

	it('max-chars fallback does not trigger below 200 chars', () => {
		const sb = new SentenceBuffer();
		const text = 'a'.repeat(199);
		expect(sb.add(text)).toEqual([]);
		expect(sb.flush()).toBe(text);
	});

	it('max-chars fallback clears buffer after emit', () => {
		const sb = new SentenceBuffer();
		sb.add('a'.repeat(200));
		// Buffer should be cleared after max-chars emit
		// "more text, and done" has no sentence boundary
		expect(sb.add('more text, and done')).toEqual([]);
		expect(sb.flush()).toBe('more text, and done');
	});

	it('works correctly after clear and reuse', () => {
		const sb = new SentenceBuffer();
		sb.add('first. ');
		sb.clear();
		const result = sb.add('second. Third');
		expect(result).toEqual(['second. ']);
		expect(sb.flush()).toBe('Third');
	});
});
