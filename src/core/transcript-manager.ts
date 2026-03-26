// SPDX-License-Identifier: MIT

/** Callbacks fired by TranscriptManager when transcript state changes. */
export interface TranscriptSink {
	/** Send a JSON message to the connected client (partial or final transcript). */
	sendToClient(msg: Record<string, unknown>): void;
	/** Record a finalized user message in conversation context. */
	addUserMessage(text: string): void;
	/** Record a finalized assistant message in conversation context. */
	addAssistantMessage(text: string): void;
}

/**
 * Manages input/output transcription buffering, deduplication, and flushing.
 *
 * Extracted from VoiceSession to isolate transcript accumulation from session
 * orchestration. Callers feed in transcription events; the manager buffers,
 * deduplicates across tool-call boundaries, and flushes finalized text to
 * the provided sink.
 */
export class TranscriptManager {
	private inputBuffer = '';
	private outputBuffer = '';
	/** Pre-tool-call output text, saved when a tool call splits a turn. */
	private outputPrefix = '';

	/**
	 * Optional callback fired when user input is finalized (committed as a non-partial message).
	 * Triggers from both `flushInput()` and the input-flushing section of `flush()`.
	 * Used by VoiceSession to relay finalized user text to interactive subagent sessions.
	 */
	onInputFinalized?: (text: string) => void;

	constructor(private sink: TranscriptSink) {}

	/** Handle a partial/interim transcript from a streaming STT provider.
	 *  Sends to client for live display but does NOT accumulate in inputBuffer.
	 *  The streaming provider manages its own partial state — each partial
	 *  replaces the previous one on the client. */
	handleInputPartial(text: string): void {
		if (text.trim()) {
			this.sink.sendToClient({
				type: 'transcript',
				role: 'user',
				text: text.trim(),
				partial: true,
			});
		}
	}

	/**
	 * Replace the current input buffer with an authoritative transcript
	 * (e.g. from Gemini's built-in inputAudioTranscription).
	 * Sends a corrected partial to the client so the UI updates.
	 * No-op if the correction is empty.
	 */
	correctInput(text: string): void {
		if (!text.trim()) return;
		this.inputBuffer = text;
		this.sink.sendToClient({
			type: 'transcript',
			role: 'user',
			text: text.trim(),
			partial: true,
			corrected: true,
		});
	}

	/** Accumulate incoming user speech transcription and emit a partial transcript. */
	handleInput(text: string): void {
		if (text.trim()) {
			this.inputBuffer += text;
			this.sink.sendToClient({
				type: 'transcript',
				role: 'user',
				text: this.inputBuffer.trim(),
				partial: true,
			});
		}
	}

	/** Accumulate incoming model speech transcription and emit a partial transcript. */
	handleOutput(text: string): void {
		if (text.trim()) {
			this.outputBuffer += text;
			const combined = this.combineOutput();
			this.sink.sendToClient({
				type: 'transcript',
				role: 'assistant',
				text: combined,
				partial: true,
			});
		}
	}

	/**
	 * Save current output buffer as prefix and reset buffer.
	 * Called before tool execution so post-tool transcription can be deduplicated.
	 */
	saveOutputPrefix(): void {
		if (this.outputBuffer.trim()) {
			this.outputPrefix += this.outputBuffer;
			this.outputBuffer = '';
		}
	}

	/**
	 * Flush only the input transcript buffer — finalize as a user message and
	 * send a non-partial transcript to the client. Used before tool calls so
	 * the user utterance appears in context before tool results.
	 */
	flushInput(): void {
		if (this.inputBuffer.trim()) {
			const text = this.inputBuffer.trim();
			this.sink.addUserMessage(text);
			this.sink.sendToClient({
				type: 'transcript',
				role: 'user',
				text,
				partial: false,
			});
			this.inputBuffer = '';
			this.onInputFinalized?.(text);
		}
	}

	/** Flush all transcript buffers — finalize user and assistant messages. */
	flush(): void {
		if (this.inputBuffer.trim()) {
			const text = this.inputBuffer.trim();
			this.sink.addUserMessage(text);
			this.sink.sendToClient({
				type: 'transcript',
				role: 'user',
				text,
				partial: false,
			});
			this.onInputFinalized?.(text);
		}
		const outputText = this.combineOutput();
		if (outputText) {
			this.sink.addAssistantMessage(outputText);
			this.sink.sendToClient({
				type: 'transcript',
				role: 'assistant',
				text: outputText,
				partial: false,
			});
		}
		this.inputBuffer = '';
		this.outputBuffer = '';
		this.outputPrefix = '';
	}

	/**
	 * Combine pre-tool prefix and post-tool buffer, deduplicating any overlap.
	 *
	 * Gemini's outputTranscription can "leak" post-tool text into the pre-tool
	 * stream, then re-send it after the tool result. This finds the longest
	 * suffix of prefix that matches a prefix of buffer and removes the overlap.
	 */
	private combineOutput(): string {
		const prefix = this.outputPrefix.trim();
		const buffer = this.outputBuffer.trim();

		if (!prefix) return buffer;
		if (!buffer) return prefix;

		// If post-tool buffer is entirely contained in the prefix tail, skip it
		if (prefix.endsWith(buffer)) return prefix;

		// Find the longest suffix of prefix that matches a prefix of buffer
		const maxOverlap = Math.min(prefix.length, buffer.length);
		let overlap = 0;
		for (let i = 1; i <= maxOverlap; i++) {
			if (prefix.slice(-i) === buffer.slice(0, i)) {
				overlap = i;
			}
		}

		if (overlap > 0) {
			return prefix + buffer.slice(overlap);
		}
		return `${prefix} ${buffer}`;
	}
}
