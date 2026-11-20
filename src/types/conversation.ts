import type { MemoryFact } from './memory.js';

/** The role of a conversation item, used to distinguish message types in the context. */
export type ConversationItemRole = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'transfer';

/**
 * When bodhi received the input transcription text that went into a user item from speech.
 * These are receipt times of input transcription text; they are NOT the times the speech
 * started or stopped.
 *
 * Clock: both are Unix milliseconds from `Date.now()`, the clock of
 * `ConversationItem.timestamp`, never `VoiceSessionConfig.nowMs`. The `atMs` values of the
 * `speech.user_*` events are on `nowMs`, so a host that injects `nowMs` must not compare the
 * two. Those events, not these times, are the voice-activity facts.
 *
 * Lag: text arrives after the speech it transcribes, by the provider's transcription delay;
 * for live input it is never earlier than the audio. A batch or streaming STT final makes
 * `firstAt` ≈ `lastAt` ≈ the time the final arrived. A host that matches these times against
 * its own speech evidence must widen the window backwards by that delay.
 *
 * What counts (TranscriptManager):
 * - every fragment `handleInput` or `correctInput` accepts into the utterance: non-empty,
 *   before the turn's input is locked, and for `correctInput` only until the authoritative
 *   transcript lands. An authoritative transcript that replaces the provider's own text
 *   keeps the earlier `firstAt`;
 * - display-only deltas of an interrupted turn (`showInterruptedInputPartial`) only when
 *   their text is the text committed (`finalizeInterruptedInputPartial` with nothing else
 *   buffered);
 * - when a new STT turn id ends the previous utterance, the fragment that ends it belongs to
 *   the next one.
 *
 * Never counted: streaming partials (`handleInputPartial`), dropped fragments, and text that
 * arrives after the item was committed or reserved. Only a fragment received before commit
 * or reserve counts; `sealUserMessage` never changes the field.
 *
 * Invariants: `firstAt` ≤ `lastAt` ≤ the item's `timestamp`, unless the wall clock steps.
 * Two plain numbers and no other payload, so it is JSON-serializable.
 *
 * Not guaranteed: that the field is present at all, a monotonic clock, speech-level
 * accuracy, or one sentence per item (without STT turn ids, one item can hold several
 * utterances).
 */
export interface InputTextReceipt {
	/** When the first counted fragment of the item's input text arrived (Unix ms, `Date.now()`). */
	readonly firstAt: number;
	/** When the last counted fragment of the item's input text arrived (Unix ms, `Date.now()`). */
	readonly lastAt: number;
}

/** A single entry in the conversation timeline (message, tool call, or agent transfer). */
export interface ConversationItem {
	/** Who produced this item. */
	role: ConversationItemRole;
	/** The textual content (or JSON-serialized data for tool_call/tool_result). */
	content: string;
	/** Unix timestamp in milliseconds when this item was created. */
	timestamp: number;
	/** Optional application-specific metadata. */
	metadata?: Record<string, unknown>;
	/** Stable handle for items whose content is revised after insertion — set
	 *  only by `ConversationContext.reserveUserMessage`, which holds an ordered
	 *  slot for a user turn while its authoritative transcript is still in
	 *  flight. Absent on ordinary append-only items. */
	id?: string;
	/**
	 * When bodhi received the input text of a `user` item from speech: receipt times of the
	 * input transcription text, not speech start or stop (see {@link InputTextReceipt}).
	 * Present only on user items that TranscriptManager commits or reserves. Absent on typed
	 * or injected user text, file uploads, other roles, items from older versions, and
	 * loaded items unless their store kept it. Set once, when the item is inserted, as a
	 * frozen copy; never changed afterwards. Not replayed to the model.
	 */
	inputTextReceived?: InputTextReceipt;
}

/** A tool invocation request from the model. */
export interface ToolCall {
	/** Unique ID assigned by Gemini for correlating call → result. */
	toolCallId: string;
	/** Name of the tool being invoked. */
	toolName: string;
	/** Parsed arguments for the tool. */
	args: Record<string, unknown>;
}

/** The result of executing a tool, sent back to Gemini. */
export interface ToolResult {
	/** Correlates back to the originating ToolCall. */
	toolCallId: string;
	/** Name of the tool that was executed. */
	toolName: string;
	/** The successful return value (null when error is set). */
	result: unknown;
	/** Error message if execution failed. */
	error?: string;
}

/** Describes the work a subagent should perform (derived from a background tool call). */
export interface SubagentTask {
	/** Human-readable description of what the subagent should do. */
	description: string;
	/** Correlates back to the originating background tool call. */
	toolCallId: string;
	/** Name of the background tool that triggered this task. */
	toolName: string;
	/** Arguments originally passed to the tool. */
	args: Record<string, unknown>;
}

/** The output produced by a subagent after completing its task. */
export interface SubagentResult {
	/** The textual result to relay back to Gemini as a tool response. */
	text: string;
	/** How many LLM steps the subagent took. */
	stepCount: number;
	/** Optional structured UI payload for dual-channel (voice + screen) delivery. */
	uiPayload?: UIPayload;
}

/**
 * Everything a subagent needs to understand the current conversation state.
 * Built by ConversationContext and passed to the subagent runner.
 */
export interface SubagentContextSnapshot {
	/** The task the subagent should execute. */
	task: SubagentTask;
	/** Compressed summary of earlier conversation (null if no summarization has occurred). */
	conversationSummary: string | null;
	/** The most recent conversation items for immediate context. */
	recentTurns: ConversationItem[];
	/** User-specific memory facts relevant to the task. */
	relevantMemoryFacts: MemoryFact[];
	/** The subagent's own system instructions. */
	agentInstructions: string;
	/**
	 * Prompt-injected knowledge base text for the active main agent (same slice as
	 * appended to realtime system instructions). Lets background subagents align with domain docs.
	 */
	knowledgeBaseContext?: string;
}

/** Structured UI payload for dual-channel delivery (voice + UI).
 *  Canonically owned by `@bodhi/client-protocol` (it rides in the
 *  `ui.payload` wire frame); re-exported here for framework importers. */
export type { UIPayload } from '@bodhi/client-protocol';
import type { UIPayload } from '@bodhi/client-protocol';
