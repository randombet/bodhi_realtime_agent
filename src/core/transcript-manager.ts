import type { CoreServerToClientMessage } from '../types/client-protocol.js';

/** Callbacks fired by TranscriptManager when transcript state changes. */
export interface TranscriptSink {
	/** Send a JSON message to the connected client (partial or final transcript). */
	sendToClient(msg: CoreServerToClientMessage): void;
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
	/** True after the user transcript was finalized early for a tool call. */
	private inputFinalizedThisTurn = false;
	/** Display-only accumulation of realtime input deltas on interrupted turns. */
	private interruptedInputDisplay = '';
	/** STT turn id of the utterance currently in `inputBuffer` (set by the
	 *  turn-aware `handleInput`). A change marks a new user utterance so the
	 *  prior one can be finalized instead of concatenated. `undefined` for
	 *  id-less providers, which keep the plain-append behavior. */
	private inputTurnId: number | undefined;

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
	 * Show realtime input transcription deltas immediately on an interrupted turn,
	 * as a display-only partial. Accumulates deltas for the running line but never
	 * writes `inputBuffer`, so the slower batch STT (`handleInput`) stays
	 * authoritative for the finalized user message and corrects this display. The
	 * buffer is reset on `flush()`/`flushInput()`.
	 */
	showInterruptedInputPartial(textDelta: string): void {
		if (this.inputFinalizedThisTurn) return;
		if (!textDelta.trim()) return;
		this.interruptedInputDisplay += textDelta;
		this.sink.sendToClient({
			type: 'transcript',
			role: 'user',
			text: this.interruptedInputDisplay.trim(),
			partial: true,
		});
	}

	/**
	 * Replace the current input buffer with an authoritative transcript
	 * (e.g. from Gemini's built-in inputAudioTranscription).
	 * Sends a corrected partial to the client so the UI updates.
	 * No-op if the correction is empty.
	 */
	correctInput(text: string): void {
		if (!text.trim()) return;
		if (this.inputFinalizedThisTurn) return;
		this.inputBuffer = text;
		this.sink.sendToClient({
			type: 'transcript',
			role: 'user',
			text: text.trim(),
			partial: true,
			corrected: true,
		});
	}

	/**
	 * Accumulate incoming user speech transcription and emit a partial transcript.
	 *
	 * `turnId` (when the STT provider supplies one) identifies the utterance. A
	 * change of `turnId` means a *new* user utterance arrived: if the previous
	 * one is still buffered (e.g. its barge-in was rejected so no turn finalized
	 * and flushed it), finalize it as its own message instead of concatenating
	 * the two into one user turn. A batch transcript that merely re-states what a
	 * provider correction already wrote (same text) is also deduplicated, so the
	 * text does not double ("X" + "X" → "XX"). Id-less providers keep the plain
	 * delta-append behavior.
	 */
	handleInput(text: string, turnId?: number): void {
		if (this.inputFinalizedThisTurn) return;
		if (!text.trim()) return;

		if (
			turnId !== undefined &&
			this.inputTurnId !== undefined &&
			turnId !== this.inputTurnId &&
			this.inputBuffer.trim()
		) {
			this.commitInputUtterance();
		}
		if (turnId !== undefined) this.inputTurnId = turnId;

		// Skip a turn-bearing transcript that exactly restates the current buffer
		// (a provider correction already wrote it); otherwise accumulate.
		if (!(turnId !== undefined && this.inputBuffer.trim() === text.trim())) {
			this.inputBuffer += text;
		}
		this.sink.sendToClient({
			type: 'transcript',
			role: 'user',
			text: this.inputBuffer.trim(),
			partial: true,
		});
	}

	/**
	 * Finalize the current input buffer as a user message at a per-utterance
	 * boundary, WITHOUT locking the turn (unlike `flushInput`, which suppresses
	 * further input for the rest of the turn). Lets the next utterance accumulate
	 * into a clean buffer. No-op on an empty buffer.
	 */
	private commitInputUtterance(): void {
		const text = this.inputBuffer.trim();
		if (!text) return;
		this.sink.addUserMessage(text);
		this.sink.sendToClient({ type: 'transcript', role: 'user', text, partial: false });
		this.inputBuffer = '';
		this.interruptedInputDisplay = '';
		this.onInputFinalized?.(text);
	}

	/**
	 * R7b (replayed-turn transcript): promote the pending input text to a
	 * finalized user message. Used when a watchdog replay re-sends the retained
	 * utterance — inline-audio replay turns emit NO input transcription, so
	 * without this the user would see an answer to an invisible question.
	 * Prefers the authoritative batch-STT `inputBuffer` when present; falls
	 * back to the interrupted-turn display partial. Locks the turn (like
	 * `flushInput`) so a trailing transcript for the same utterance cannot
	 * duplicate the message. Returns false when nothing is pending.
	 */
	finalizeInterruptedInputPartial(): boolean {
		if (this.inputFinalizedThisTurn) return false;
		const text = this.inputBuffer.trim() || this.interruptedInputDisplay.trim();
		if (!text) return false;
		this.sink.addUserMessage(text);
		this.sink.sendToClient({
			type: 'transcript',
			role: 'user',
			text,
			partial: false,
			recovered: true,
		});
		this.inputBuffer = '';
		this.interruptedInputDisplay = '';
		this.inputTurnId = undefined;
		this.inputFinalizedThisTurn = true;
		this.onInputFinalized?.(text);
		return true;
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
			this.inputFinalizedThisTurn = true;
			this.onInputFinalized?.(text);
		}
		this.interruptedInputDisplay = '';
		this.inputTurnId = undefined;
	}

	/** Flush all transcript buffers — finalize user and assistant messages. */
	flush(): void {
		if (!this.inputFinalizedThisTurn && this.inputBuffer.trim()) {
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
		this.inputFinalizedThisTurn = false;
		this.interruptedInputDisplay = '';
		this.inputTurnId = undefined;
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
