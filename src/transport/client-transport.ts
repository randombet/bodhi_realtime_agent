import { type WebSocket, WebSocketServer } from 'ws';
import { AudioBuffer } from './audio-buffer.js';

/** Callbacks fired by ClientTransport when client events occur. */
export interface ClientTransportCallbacks {
	/** Raw PCM audio data received from the client WebSocket. */
	onAudioFromClient?(data: Buffer): void;
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
 * Accepts a single WebSocket connection on the configured port.
 * Audio from the client is forwarded via callbacks (or buffered during transfers).
 * Audio for the client is sent via `sendAudioToClient()`.
 *
 * Buffering mode (`startBuffering`/`stopBuffering`) captures incoming audio
 * during agent transfers so it can be replayed after reconnection.
 */
export class ClientTransport {
	private wss: WebSocketServer | null = null;
	private client: WebSocket | null = null;
	private audioBuffer = new AudioBuffer();
	private _buffering = false;

	constructor(
		private port: number,
		private callbacks: ClientTransportCallbacks,
	) {}

	async start(): Promise<void> {
		return new Promise((resolve) => {
			this.wss = new WebSocketServer({ port: this.port });

			this.wss.on('listening', () => resolve());

			this.wss.on('connection', (ws) => {
				this.client = ws;
				this.callbacks.onClientConnected?.();

				ws.on('message', (data: Buffer) => {
					if (this._buffering) {
						this.audioBuffer.push(data);
					} else {
						this.callbacks.onAudioFromClient?.(data);
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

	sendAudioToClient(data: Buffer): void {
		if (this.client?.readyState === 1) {
			this.client.send(data);
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
