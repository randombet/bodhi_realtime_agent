// SPDX-License-Identifier: MIT

import type { IceServerEntry } from '../types/client-media.js';
import type { RtcClientSignalingMessage } from '../types/rtc-signaling.js';
import type { IClientChannel, SessionClientSender } from '../types/session-client.js';
import { AudioBuffer } from './audio-buffer.js';
import { WeriftOpusRtcEngine } from './werift-opus-rtc-engine.js';

/** When set, mic/assistant audio uses Opus RTP (werift + @evan/opus) instead of WebSocket binary. */
export interface WeriftOpusClientOptions {
	readonly iceServers?: readonly IceServerEntry[];
	readonly inputPcmSampleRate: number;
	readonly outputPcmSampleRate: number;
	readonly onInboundPcm: (pcm: Buffer) => void;
	readonly onLog?: (message: string) => void;
}

export interface DirectRtcClientChannelOptions {
	readonly sender: SessionClientSender;
	/** Enables server-side WebRTC Opus audio (requires `werift` + `@evan/opus` at runtime). */
	readonly weriftOpus?: WeriftOpusClientOptions;
}

const PRE_MEDIA_MAX_BYTES = 96_000;

/**
 * Client media channel: **JSON/control on WebSocket** (`SessionClientSender`), **audio**
 * over **Opus RTP** when `weriftOpus` is configured; otherwise outbound assistant PCM uses
 * `sender.sendAudio` (same wire as legacy WebSocket clients).
 */
export class DirectRtcClientChannel implements IClientChannel {
	private readonly sender: SessionClientSender;
	private readonly audioBuffer = new AudioBuffer();
	private _buffering = false;
	private _lastSignaling: RtcClientSignalingMessage | null = null;
	private readonly engine: WeriftOpusRtcEngine | null;
	private preMediaOutbound = Buffer.alloc(0);

	constructor(options: DirectRtcClientChannelOptions) {
		this.sender = options.sender;
		this.engine = options.weriftOpus
			? new WeriftOpusRtcEngine({
					iceServers: options.weriftOpus.iceServers,
					inputPcmSampleRate: options.weriftOpus.inputPcmSampleRate,
					outputPcmSampleRate: options.weriftOpus.outputPcmSampleRate,
					onInboundPcm: options.weriftOpus.onInboundPcm,
					emitServerJson: (msg) => this.sender.sendJson(msg),
					onLog: options.weriftOpus.onLog,
					onMediaReady: () => this.flushPreMediaOutbound(),
				})
			: null;
	}

	/** Latest client→server signaling message (for debugging / tests). */
	get lastClientSignaling(): RtcClientSignalingMessage | null {
		return this._lastSignaling;
	}

	/** True once Opus RTP outbound is wired (assistant audio should not use WebSocket binary). */
	get isRtcAudioReady(): boolean {
		return this.engine?.mediaReady ?? false;
	}

	/**
	 * Accept SDP / ICE payloads from the client JSON WebSocket.
	 * When `weriftOpus` is enabled, drives the embedded werift peer connection.
	 */
	feedSignaling(message: RtcClientSignalingMessage): void {
		this._lastSignaling = message;
		if (!this.engine) return;
		void this.engine.handleClientSignaling(message).catch((err) => {
			const m = err instanceof Error ? err.message : String(err);
			this.sender.sendJson({ type: 'rtc.error', message: `signaling: ${m}` });
		});
	}

	private flushPreMediaOutbound(): void {
		if (!this.engine || this.preMediaOutbound.length === 0) return;
		const chunk = this.preMediaOutbound;
		this.preMediaOutbound = Buffer.alloc(0);
		this.engine.sendAssistantPcm(chunk);
	}

	async start(): Promise<void> {
		// WebSocket lifecycle is owned by the app; werift engine starts on first `rtc.offer`.
	}

	async stop(): Promise<void> {
		this._buffering = false;
		this.audioBuffer.clear();
		this._lastSignaling = null;
		this.preMediaOutbound = Buffer.alloc(0);
		await this.engine?.dispose();
	}

	sendAudioToClient(data: Buffer): void {
		if (this._buffering) {
			this.audioBuffer.push(data);
			return;
		}
		if (this.engine) {
			if (this.engine.mediaReady) {
				this.engine.sendAssistantPcm(data);
				return;
			}
			const merged = Buffer.concat([this.preMediaOutbound, data]);
			this.preMediaOutbound =
				merged.length > PRE_MEDIA_MAX_BYTES
					? merged.subarray(merged.length - PRE_MEDIA_MAX_BYTES)
					: merged;
			return;
		}
		this.sender.sendAudio(data);
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
