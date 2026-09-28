/**
 * Framework-side door to the client-plane wire contract.
 *
 * The canonical definitions live in `@bodhi/client-protocol`
 * (`clients/client-protocol/` — zero-dep, browser-safe, built before every
 * framework build/typecheck). Server-side code imports from
 * here; browser packages import `@bodhi/client-protocol` directly.
 */

import type { CoreServerToClientMessage as CoreServerFrame } from '@bodhi/client-protocol';

export type {
	AnyClientToServerMessage,
	AnyServerToClientMessage,
	AudioDoneMessage,
	BehaviorCatalogCategory,
	BehaviorCatalogMessage,
	BehaviorChangedMessage,
	BehaviorSetMessage,
	ClientExtensionMessage,
	ClientProtocolClientExtensions,
	ClientProtocolServerExtensions,
	CoreClientToServerMessage,
	CoreServerToClientMessage,
	FileUploadMessage,
	GroundingMessage,
	GuiNotificationMessage,
	GuiUpdateMessage,
	PlaybackEndedMessage,
	ServerExtensionMessage,
	SessionConfigMessage,
	SessionReadyMessage,
	TextInputMessage,
	TranscriptMessage,
	TurnEndMessage,
	TurnInterruptedMessage,
	UiPayloadMessage,
	UiResponseMessage,
	UIPayload,
	WordBoundaryMessage,
} from '@bodhi/client-protocol';
export { MIN_PLAYBACK_RATE, PACING_KEY, PACING_PRESET_RATES } from '@bodhi/client-protocol';

/** Every core server→client frame `type`. Internal: not root-exported. */
export type CoreServerFrameType = CoreServerFrame['type'];

/**
 * Application frame sent verbatim to the client. Any JSON object; a declared
 * `type` must not collide with a core frame type, so a malformed core frame
 * (e.g. `audio.done` without `playbackId`) still fails to compile.
 *
 * Accepted only by the host-facing `sendJsonToClient` methods
 * (`VoiceSession`, `ToolContext`, `ClientTransport`); the internal
 * `IClientChannel` / `SessionClientSender` contracts stay strict.
 */
export type HostClientFrame<T extends string = string> = {
	readonly type?: T & (T extends CoreServerFrameType ? never : T);
	readonly [key: string]: unknown;
};
