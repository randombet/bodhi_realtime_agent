// SPDX-License-Identifier: MIT

import type { RtcClientSignalingMessage } from '../types/rtc-signaling.js';
import type { IClientChannel, SessionClientSender } from '../types/session-client.js';
import { AudioBuffer } from './audio-buffer.js';

export interface DirectRtcClientChannelOptions {
	readonly sender: SessionClientSender;
}

/**
 * Client media channel: **JSON/control on WebSocket** (`SessionClientSender`), **audio**
 * intended for a direct RTC peer connection once the engine is wired.
 *
 * Until the RTC engine is integrated, outbound assistant PCM is still sent with
 * `sender.sendAudio` so existing browser clients keep working (same wire as today).
 */
export class DirectRtcClientChannel implements IClientChannel {
	private readonly sender: SessionClientSender;
	private readonly audioBuffer = new AudioBuffer();
	private _buffering = false;
	private _lastSignaling: RtcClientSignalingMessage | null = null;

	constructor(options: DirectRtcClientChannelOptions) {
		this.sender = options.sender;
	}

	/** Latest client→server signaling message (for debugging / future engine hook). */
	get lastClientSignaling(): RtcClientSignalingMessage | null {
		return this._lastSignaling;
	}

	/**
	 * Accept SDP / ICE payloads from the client JSON WebSocket.
	 * Today this records the message; a future RTC engine will drive `RTCPeerConnection` here.
	 */
	feedSignaling(message: RtcClientSignalingMessage): void {
		this._lastSignaling = message;
	}

	async start(): Promise<void> {
		// Connection lifecycle is owned by the app WebSocket; RTC engine will attach here later.
	}

	async stop(): Promise<void> {
		this._buffering = false;
		this.audioBuffer.clear();
		this._lastSignaling = null;
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
