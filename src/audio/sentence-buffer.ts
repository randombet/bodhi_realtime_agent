// SPDX-License-Identifier: MIT

/** Maximum characters to buffer before forcing a flush, even without a sentence boundary. */
const MAX_BUFFER_CHARS = 200;

/**
 * Buffers LLM text tokens and emits at sentence boundaries.
 * Used internally by TTSProvider implementations that prefer sentence-level input.
 *
 * Handles Latin scripts (sentence-ending punctuation + whitespace),
 * CJK scripts (sentence-ending punctuation without requiring trailing space),
 * and multi-sentence token batches (returns all complete sentences).
 */
export class SentenceBuffer {
	private buffer = '';

	// Matches sentence-ending punctuation:
	// - Latin (.!?) followed by whitespace
	// - CJK (。！？) with no trailing space required
	private readonly sentencePattern = /[.!?]\s|[。！？]/g;

	/**
	 * Add a text token. Returns flushed sentence(s) as an array,
	 * or empty array if still buffering.
	 */
	add(token: string): string[] {
		this.buffer += token;
		const results: string[] = [];
		let lastIndex = 0;

		for (const match of this.buffer.matchAll(this.sentencePattern)) {
			if (match.index === undefined) continue;
			const breakpoint = match.index + match[0].length;
			results.push(this.buffer.slice(lastIndex, breakpoint));
			lastIndex = breakpoint;
		}

		if (results.length > 0) {
			this.buffer = this.buffer.slice(lastIndex);
		}

		// Max-chars fallback: emit buffered text even without sentence boundary
		if (results.length === 0 && this.buffer.length >= MAX_BUFFER_CHARS) {
			results.push(this.buffer);
			this.buffer = '';
		}

		return results;
	}

	/** Flush remaining buffer (end of response). Returns empty string if buffer is empty. */
	flush(): string {
		const remaining = this.buffer.trim();
		this.buffer = '';
		return remaining;
	}

	/** Clear without emitting (interruption). */
	clear(): void {
		this.buffer = '';
	}
}
