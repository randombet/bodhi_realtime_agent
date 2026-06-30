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
	/** Whether this channel participates in the playback-state protocol. Set by
	 *  the channel producer (the factory) — not inferred here, since the adapter
	 *  only sees a `SessionClientSender` and cannot tell PCM from avatar/RTC. */
	readonly supportsPlaybackStateProtocol: boolean;

	constructor(sender: SessionClientSender, supportsPlaybackStateProtocol = false) {
		this.sender = sender;
		this.supportsPlaybackStateProtocol = supportsPlaybackStateProtocol;
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

	/** Playback-state protocol: deliver JSON in order after the turn's audio.
	 *  The underlying sender writes audio and JSON to the one client socket in
	 *  call order, so this is `sendJsonToClient` after the audio sends. During a
	 *  reconnect-buffering window audio is buffered for replay while JSON would
	 *  send immediately — sending `audio.done` then would let it overtake the
	 *  buffered audio, so it is dropped and the turn falls to the fallback. */
	sendJsonAfterAudio(message: Record<string, unknown>): void {
		if (this._buffering) return;
		this.sendJsonToClient(message);
	}

	startBuffering(): void {
		this._buffering = true;
		this.audioBuffer.clear();
	}

	stopBuffering(): Buffer[] {
		this._buffering = false;
		// This buffer holds OUTBOUND assistant audio — it belongs to the client.
		// Flush it to the sender and return [] so the reconnector's drain loop
		// (which pumps the return value into transport.sendAudio as user input)
		// never receives assistant speech. The inbound-mic semantics of
		// ClientTransport.stopBuffering are intentionally different.
		for (const chunk of this.audioBuffer.drain()) {
			this.sender.sendAudio(chunk);
		}
		return [];
	}
}
