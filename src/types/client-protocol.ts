/**
 * Framework-side door to the client-plane wire contract.
 *
 * The canonical definitions live in `@bodhi/client-protocol`
 * (`clients/client-protocol/` — zero-dep, browser-safe, built before every
 * framework build/typecheck; see the audit table in
 * dev_docs/framework/client-protocol-audit.md). Server-side code imports from
 * here; browser packages import `@bodhi/client-protocol` directly.
 */

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
