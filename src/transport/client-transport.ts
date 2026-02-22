// SPDX-License-Identifier: MIT

import { type WebSocket, WebSocketServer } from 'ws';
import { AudioBuffer } from './audio-buffer.js';

/** Callbacks fired by ClientTransport when client events occur. */
export interface ClientTransportCallbacks {
	/** Raw PCM audio data received from the client WebSocket (binary frames). */
	onAudioFromClient?(data: Buffer): void;
	/** A JSON message received from the client WebSocket (text frames). */
	onJsonFromClient?(message: Record<string, unknown>): void;
	/** A client WebSocket connection was established. */
	onClientConnected?(): void;
	/** The client WebSocket disconnected. */
	onClientDisconnected?(): void;
	/** An image was uploaded by the client (base64-encoded). */
	onImageUpload?(imageBase64: string, mimeType: string): void;
}

/**
 * WebSocket server that bridges a client audio app to the framework.
 *
 * Multiplexes two message types on the same WebSocket connection:
 * - **Binary frames**: Raw PCM audio (forwarded via `onAudioFromClient` or buffered during transfers).
 * - **Text frames**: JSON messages for GUI events (`onJsonFromClient`).
 *
 * Buffering mode (`startBuffering`/`stopBuffering`) only affects binary audio frames.
 * Text frames are always delivered immediately.
 */
export class ClientTransport {
	private wss: WebSocketServer | null = null;
	private client: WebSocket | null = null;
	private audioBuffer = new AudioBuffer();
	private _buffering = false;

	constructor(
		private port: number,
		private callbacks: ClientTransportCallbacks,
		private host: string = '0.0.0.0',
	) {}

	async start(): Promise<void> {
		return new Promise((resolve) => {
			this.wss = new WebSocketServer({ port: this.port, host: this.host });

			this.wss.on('listening', () => resolve());

			this.wss.on('connection', (ws) => {
				this.client = ws;
				this.callbacks.onClientConnected?.();

				ws.on('message', (data: Buffer, isBinary: boolean) => {
					if (isBinary) {
						if (this._buffering) {
							this.audioBuffer.push(data);
						} else {
							this.callbacks.onAudioFromClient?.(data);
						}
					} else {
						try {
							const message = JSON.parse(data.toString()) as Record<string, unknown>;
							this.callbacks.onJsonFromClient?.(message);
						} catch {
							// Ignore malformed JSON
						}
					}
				});

				ws.on('close', () => {
					this.client = null;
					this.callbacks.onClientDisconnected?.();
				});
			});
		});
	}

	async stop(): Promise<void> {
		if (this.client) {
			this.client.close();
			this.client = null;
		}
		if (this.wss) {
			return new Promise((resolve) => {
				this.wss?.close(() => {
					this.wss = null;
					resolve();
				});
			});
		}
	}

	/** Send raw PCM audio to the client as a binary frame. */
	sendAudioToClient(data: Buffer): void {
		if (this.client?.readyState === 1) {
			this.client.send(data);
		}
	}

	/** Send a JSON message to the client as a text frame. */
	sendJsonToClient(message: Record<string, unknown>): void {
		if (this.client?.readyState === 1) {
			this.client.send(JSON.stringify(message));
		}
	}

	startBuffering(): void {
		this._buffering = true;
		this.audioBuffer.clear();
	}

	stopBuffering(): Buffer[] {
		this._buffering = false;
		return this.audioBuffer.drain();
	}

	get isClientConnected(): boolean {
		return this.client?.readyState === 1;
	}

	get buffering(): boolean {
		return this._buffering;
	}
}
