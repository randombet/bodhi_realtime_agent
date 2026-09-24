import { type WebSocket, WebSocketServer } from 'ws';
import type { AnyServerToClientMessage, HostClientFrame } from '../types/client-protocol.js';
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
	/** H2 inbound-capture classification (design-speech-evidence-architecture
	 *  §3): the SESSION installs this closure when buffering starts — the
	 *  transport holds only the closure, never a GreetingController reference.
	 *  Tags are captured at INGRESS (a drain-time gate read recreates the
	 *  end-state race the design forbids). */
	private _captureClassifier: ((data: Buffer) => { voiced: boolean; gateActive: boolean }) | null =
		null;
	private _capturedTags: Array<{ voiced: boolean; gateActive: boolean }> = [];
	/** Audio (binary) and JSON (text) share the one WebSocket and are sent
	 *  synchronously in call order, so this transport supports the
	 *  playback-state protocol. */
	readonly supportsPlaybackStateProtocol = true;

	constructor(
		private port: number,
		private callbacks: ClientTransportCallbacks,
		private host = '0.0.0.0',
		private listenTimeoutMs = 10_000,
	) {}

	async start(): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`ClientTransport listen timed out after ${this.listenTimeoutMs}ms`));
			}, this.listenTimeoutMs);

			this.wss = new WebSocketServer({ port: this.port, host: this.host });

			this.wss.on('listening', () => {
				clearTimeout(timer);
				resolve();
			});

			this.wss.on('connection', (ws) => {
				// Attach event handlers BEFORE setting this.client to avoid
				// a race where messages arrive before handlers are registered.
				ws.on('message', (data: Buffer, isBinary: boolean) => {
					if (isBinary) {
						if (this._buffering) {
							if (this._captureClassifier) this._capturedTags.push(this._captureClassifier(data));
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

				ws.on('error', () => {
					// Prevent unhandled error crash — 'close' event will follow
				});

				this.client = ws;
				this.callbacks.onClientConnected?.();
			});
		});
	}

	async stop(): Promise<void> {
		this._buffering = false;
		this.audioBuffer.clear();
		if (this.client) {
			this.client.removeAllListeners();
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

	/** Send a JSON message to the client as a text frame. Accepts core frames,
	 *  registered extensions, or an application `HostClientFrame` whose `type`
	 *  is not a core frame type; the frame is serialized verbatim. */
	sendJsonToClient<T extends string>(message: AnyServerToClientMessage | HostClientFrame<T>): void {
		if (this.client?.readyState === 1) {
			this.client.send(JSON.stringify(message));
		}
	}

	/** Playback-state protocol: deliver JSON in order after the turn's audio.
	 *  Binary and text frames go out on the one socket synchronously in call
	 *  order, so this is `sendJsonToClient` issued after the audio sends. */
	sendJsonAfterAudio(message: AnyServerToClientMessage): void {
		this.sendJsonToClient(message);
	}

	startBuffering(): void {
		this._buffering = true;
		this.audioBuffer.clear();
	}

	stopBuffering(): Buffer[] {
		this._buffering = false;
		this._capturedTags = [];
		return this.audioBuffer.drain();
	}

	/** @internal H2: install the session's frame classifier for the NEXT
	 *  buffering window (gate predicate + lightweight energy check). */
	installInboundCaptureClassifier(
		classifier: (data: Buffer) => { voiced: boolean; gateActive: boolean },
	): void {
		this._captureClassifier = classifier;
	}

	/** @internal H2: drain the captured inbound frames WITH their ingress
	 *  tags. Falls back to untagged frames (treated as ungated by callers)
	 *  when no classifier was installed. Outbound-only channel
	 *  implementations have no equivalent — they structurally cannot return
	 *  captured input. */
	stopInboundCapture(): Array<{ data: Buffer; voiced: boolean; gateActiveAtCapture: boolean }> {
		this._buffering = false;
		const frames = this.audioBuffer.drain();
		const tags = this._capturedTags;
		this._capturedTags = [];
		return frames.map((data, i) => ({
			data,
			voiced: tags[i]?.voiced ?? false,
			gateActiveAtCapture: tags[i]?.gateActive ?? false,
		}));
	}

	get isClientConnected(): boolean {
		return this.client?.readyState === 1;
	}

	get buffering(): boolean {
		return this._buffering;
	}
}
