// SPDX-License-Identifier: MIT

import type { SessionClientSender } from '../types/session-client.js';
import type { IClientChannel } from '../types/session-client.js';
import { AudioBuffer } from './audio-buffer.js';

/**
 * Adapts a SessionClientSender (e.g. multi-user WebSocket) to the IClientChannel
 * interface expected by VoiceSession. Used when the server owns the client connection
 * and feeds input explicitly via feedAudioFromClient / feedJsonFromClient.
 */
export class ClientSenderAdapter implements IClientChannel {
	private readonly sender: SessionClientSender;
	private readonly audioBuffer = new AudioBuffer();
	private _buffering = false;

	constructor(sender: SessionClientSender) {
		this.sender = sender;
	}

	async start(): Promise<void> {
		// No-op: connection is managed by the server (MultiClientTransport).
	}

	async stop(): Promise<void> {
		this._buffering = false;
		this.audioBuffer.clear();
	}

	sendAudioToClient(data: Buffer): void {
		if (this._buffering) {
			this.audioBuffer.push(data);
		} else {
			this.sender.sendAudio(data);
		}
	}

	sendJsonToClient(message: Record<string, unknown>): void {
		this.sender.sendJson(message);
	}

	startBuffering(): void {
		this._buffering = true;
		this.audioBuffer.clear();
	}

	stopBuffering(): Buffer[] {
		this._buffering = false;
		return this.audioBuffer.drain();
	}
}
