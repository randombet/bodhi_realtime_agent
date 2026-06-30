/**
 * Contract for sending data to one client. The server owns the socket and implements this;
 * VoiceSession sends audio and JSON through it. Input is fed via feedAudioFromClient / feedJsonFromClient.
 */
export interface SessionClientSender {
	sendAudio(data: Buffer): void;
	sendJson(message: Record<string, unknown>): void;
	/** Send a JSON message in delivery order **after** the turn's audio bytes —
	 *  used by the playback-state protocol so `audio.done` cannot overtake
	 *  buffered audio. Optional; a sender that omits it does not participate.
	 *  See dev_docs/framework/design-playback-state-protocol.md. */
	sendJsonAfterAudio?(message: Record<string, unknown>): void;
	/** True only when this sender implements ordered `sendJsonAfterAudio` AND
	 *  renders assistant audio through the buffered-PCM path. Absent = false. */
	supportsPlaybackStateProtocol?: boolean;
}

/** Internal channel used by VoiceSession (send + buffering). Implemented by ClientSenderAdapter. */
export interface IClientChannel {
	start(): Promise<void>;
	stop(): Promise<void>;
	sendAudioToClient(data: Buffer): void;
	sendJsonToClient(message: Record<string, unknown>): void;
	startBuffering(): void;
	stopBuffering(): Buffer[];
	/** Send JSON in delivery order after the turn's audio — playback-state
	 *  protocol. Optional; absent ⇒ the channel does not participate. */
	sendJsonAfterAudio?(message: Record<string, unknown>): void;
	/** Whether this channel supports the playback-state protocol. */
	supportsPlaybackStateProtocol?: boolean;
}
