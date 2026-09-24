import type { AnyServerToClientMessage } from './client-protocol.js';

/**
 * Contract for sending data to one client. The server owns the socket and implements this;
 * VoiceSession sends audio and JSON through it. Input is fed via feedAudioFromClient / feedJsonFromClient.
 *
 * Messages are typed against the client-protocol contract: core frames plus
 * any extension frames registered via `ClientProtocolServerExtensions`
 * (module augmentation in app or peer code). An unregistered frame fails to
 * compile at the call site.
 */
export interface SessionClientSender {
	sendAudio(data: Buffer): void;
	sendJson(message: AnyServerToClientMessage): void;
	/** Send a JSON message in delivery order **after** the turn's audio bytes —
	 *  used by the playback-state protocol so `audio.done` cannot overtake
	 *  buffered audio. Optional; a sender that omits it does not participate. */
	sendJsonAfterAudio?(message: AnyServerToClientMessage): void;
	/** True only when this sender implements ordered `sendJsonAfterAudio` AND
	 *  renders assistant audio through the buffered-PCM path. Absent = false. */
	supportsPlaybackStateProtocol?: boolean;
}

/** Point-in-time state of the attached client socket, read from the WebSocket itself. */
export interface ClientSocketHealth {
	/** WebSocket `readyState`: 0 connecting, 1 open, 2 closing, 3 closed. */
	readyState: number;
	/** Bytes queued on the socket that have not been written to the network yet. */
	bufferedAmount: number;
}

/** Internal channel used by VoiceSession (send + buffering). Implemented by ClientSenderAdapter. */
export interface IClientChannel {
	start(): Promise<void>;
	stop(): Promise<void>;
	sendAudioToClient(data: Buffer): void;
	sendJsonToClient(message: AnyServerToClientMessage): void;
	startBuffering(): void;
	stopBuffering(): Buffer[];
	/** Leave buffering mode and DROP the pending frames: nothing is returned
	 *  and nothing is forwarded, unlike `stopBuffering()`, which hands them on
	 *  (the owned socket returns buffered microphone frames for the reconnect
	 *  drain; hosted channels flush buffered assistant audio to the client).
	 *  Optional; a caller falls back to `stopBuffering()` when it is absent. */
	discardBuffered?(): void;
	/** Send JSON in delivery order after the turn's audio — playback-state
	 *  protocol. Optional; absent ⇒ the channel does not participate. */
	sendJsonAfterAudio?(message: AnyServerToClientMessage): void;
	/** Whether this channel supports the playback-state protocol. */
	supportsPlaybackStateProtocol?: boolean;
	/** State of the attached client socket, or `null` when none is attached.
	 *  Optional: only a channel that owns the client socket (the local
	 *  `ClientTransport`) can report it. */
	getSocketHealth?(): ClientSocketHealth | null;
	/** Close the attached client socket and nothing else; the channel keeps
	 *  accepting connections. Returns `false` when no socket was attached.
	 *  Optional: only a channel that owns the client socket (the local
	 *  `ClientTransport`) can close it. */
	closeClient?(code?: number, reason?: string): boolean;
}
