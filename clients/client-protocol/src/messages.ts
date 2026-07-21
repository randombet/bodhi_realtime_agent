/**
 * Core client-plane message unions, split by direction and composed with
 * open extension registries (module augmentation).
 *
 * Shapes mirror the actual emit/dispatch sites recorded in
 * dev_docs/framework/client-protocol-audit.md — do not add fields here that
 * no emitter sends. App-server frames (`session.error`, `sessions_list`, …)
 * live in `app/lib/client/`; peer frames (`peer.*`) in peer code; both
 * register via the extension interfaces below.
 */

import type {
	AudioFormatSpec,
	ClientAudioSource,
	ClientMediaProfile,
	ClientSignalSource,
} from './client-media.js';
import type { RtcClientSignalingMessage, RtcServerSignalingMessage } from './rtc.js';

// ─── Shared payload shapes ──────────────────────────────────────────────────

/** Structured UI payload for dual-channel delivery (voice + UI). Rides in
 *  `ui.payload` (server→client); `ui.response.payload.requestId` correlates. */
export interface UIPayload {
	/** The kind of UI element to render on the client. */
	type: 'choice' | 'confirmation' | 'status' | 'form' | 'image';
	/** Identifier for correlating UI responses back to the originating request. */
	requestId?: string;
	/** Type-specific data for rendering the UI element. */
	data: Record<string, unknown>;
}

/** One category row in `behavior.catalog` (wire projection of a
 *  BehaviorCategory — directives never cross the wire). */
export interface BehaviorCatalogCategory {
	key: string;
	toolName: string;
	presets: Array<{ name: string; label: string }>;
	/** Currently active preset name, when one has been applied. */
	active?: string;
}

// ─── Core server → client ───────────────────────────────────────────────────

export interface SessionConfigMessage {
	type: 'session.config';
	audioFormat: AudioFormatSpec;
	clientMedia: ClientMediaProfile;
	clientSignalSource: ClientSignalSource;
	clientAudioSource: ClientAudioSource;
}

/** Core `session.ready` as emitted by `VoiceSession` when it owns the client
 *  channel. The app server emits an enriched variant — typed app-side as an
 *  intersection/extension, not here. */
export interface SessionReadyMessage {
	type: 'session.ready';
	userId: string;
	sessionId: string;
	agentProfile: string;
	clientMedia: ClientMediaProfile;
	clientSignalSource: ClientSignalSource;
	clientAudioSource: ClientAudioSource;
}

export interface TranscriptMessage {
	type: 'transcript';
	role: 'user' | 'assistant';
	text: string;
	/** True while the utterance/turn is still accumulating. */
	partial?: boolean;
	/** True when this frame replaces earlier partial text with a provider
	 *  correction (client should overwrite, not append). */
	corrected?: boolean;
	/** True when this text was recovered after a reconnect (replayed from
	 *  retained context rather than transcribed live). */
	recovered?: boolean;
}

export interface TurnEndMessage {
	type: 'turn.end';
	turnId?: string;
}

export interface TurnInterruptedMessage {
	type: 'turn.interrupted';
}

/** Playback-state protocol: the turn's assistant audio has been fully sent;
 *  the client acknowledges with `playback.ended` when it finishes playing. */
export interface AudioDoneMessage {
	type: 'audio.done';
	playbackId: number;
}

export interface GuiUpdateMessage {
	type: 'gui.update';
	payload: { sessionId: string; data: Record<string, unknown> };
}

export interface GuiNotificationMessage {
	type: 'gui.notification';
	payload: { sessionId: string; message: string };
}

export interface UiPayloadMessage {
	type: 'ui.payload';
	payload: UIPayload;
}

/** TTS-mode word timing for caption/karaoke display. */
export interface WordBoundaryMessage {
	type: 'word_boundary';
	word: string;
	offsetMs: number;
	requestId: number;
}

/** Search-grounding metadata forwarded from the model. */
export interface GroundingMessage {
	type: 'grounding';
	payload: Record<string, unknown>;
}

export interface BehaviorCatalogMessage {
	type: 'behavior.catalog';
	categories: BehaviorCatalogCategory[];
}

export interface BehaviorChangedMessage {
	type: 'behavior.changed';
	key: string;
	preset: string;
}

/** Interactive subagent asks the user a question (actor mode). */
export interface SubagentQuestionMessage {
	type: 'subagent.question';
	toolCallId: string;
	workflowId: string;
	question?: string;
	requestId?: string;
}

/** Terminal notification for a background subagent workflow (actor mode).
 *  Both emit paths send `failure` for a failed workflow (unified — audit
 *  issue #2). `failed` remains in the union as a DEPRECATED member for one
 *  release so consumers compiled against the historical wire value keep
 *  building; no emitter sends it anymore — remove next release. */
export interface SubagentCompletionMessage {
	type: 'subagent.completion';
	toolCallId: string;
	status: 'success' | 'failure' | /** @deprecated no longer emitted; use 'failure' */ 'failed' | 'cancelled';
	summaryText?: string;
	uiPayload?: Record<string, unknown>;
	artifacts?: unknown[];
	metadata?: unknown;
}

/** Progress update from a background subagent workflow (actor mode). */
export interface SubagentProgressMessage {
	type: 'subagent.progress';
	toolCallId: string;
	workflowId: string;
	text: string;
}

export type CoreServerToClientMessage =
	| SessionConfigMessage
	| SessionReadyMessage
	| SubagentQuestionMessage
	| SubagentCompletionMessage
	| SubagentProgressMessage
	| TranscriptMessage
	| TurnEndMessage
	| TurnInterruptedMessage
	| AudioDoneMessage
	| GuiUpdateMessage
	| GuiNotificationMessage
	| UiPayloadMessage
	| WordBoundaryMessage
	| GroundingMessage
	| BehaviorCatalogMessage
	| BehaviorChangedMessage
	| RtcServerSignalingMessage;

// ─── Core client → server ───────────────────────────────────────────────────

export interface TextInputMessage {
	type: 'text_input';
	text: string;
}

export interface PlaybackEndedMessage {
	type: 'playback.ended';
	playbackId: number;
}

export interface BehaviorSetMessage {
	type: 'behavior.set';
	key: string;
	preset: string;
}

export interface UiResponseMessage {
	type: 'ui.response';
	payload: {
		requestId: string;
		selectedOptionId?: string;
		formData?: Record<string, unknown>;
	};
}

export interface FileUploadMessage {
	type: 'file_upload';
	data: { base64: string; mimeType: string; fileName?: string };
}

export type CoreClientToServerMessage =
	| TextInputMessage
	| PlaybackEndedMessage
	| BehaviorSetMessage
	| UiResponseMessage
	| FileUploadMessage
	| RtcClientSignalingMessage;

// ─── Extension registries (module augmentation) ─────────────────────────────
//
// Apps and peers register their frames without editing this file:
//
//   declare module '@bodhi/client-protocol' {
//     interface ClientProtocolServerExtensions {
//       peerSessionEnded: { type: 'peer.session_ended'; reason: string };
//     }
//   }
//
// Typed send/dispatch surfaces accept `Core… | …ExtensionMessage`, so an
// unregistered frame fails to compile while registered ones flow through.

/** Server→client extension frames. Augment to register. */
// biome-ignore lint/suspicious/noEmptyInterface: open registry by design
export interface ClientProtocolServerExtensions {}

/** Client→server extension frames. Augment to register. */
// biome-ignore lint/suspicious/noEmptyInterface: open registry by design
export interface ClientProtocolClientExtensions {}

export type ServerExtensionMessage =
	ClientProtocolServerExtensions[keyof ClientProtocolServerExtensions];
export type ClientExtensionMessage =
	ClientProtocolClientExtensions[keyof ClientProtocolClientExtensions];

/** Everything a server may legally send to a client. */
export type AnyServerToClientMessage = CoreServerToClientMessage | ServerExtensionMessage;
/** Everything a client may legally send to a server. */
export type AnyClientToServerMessage = CoreClientToServerMessage | ClientExtensionMessage;
