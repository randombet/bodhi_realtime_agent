// SPDX-License-Identifier: MIT

/**
 * Contract for sending data to one client. The server owns the socket and implements this;
 * VoiceSession sends audio and JSON through it. Input is fed via feedAudioFromClient / feedJsonFromClient.
 */
export interface SessionClientSender {
	sendAudio(data: Buffer): void;
	sendJson(message: Record<string, unknown>): void;
}

/** Internal channel used by VoiceSession (send + buffering). Implemented by ClientSenderAdapter. */
export interface IClientChannel {
	start(): Promise<void>;
	stop(): Promise<void>;
	sendAudioToClient(data: Buffer): void;
	sendJsonToClient(message: Record<string, unknown>): void;
	startBuffering(): void;
	stopBuffering(): Buffer[];
}
