import type { IncomingMessage } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import type { AnyServerToClientMessage, HostClientFrame } from '../types/client-protocol.js';
import { AudioBuffer } from './audio-buffer.js';

/** Callbacks fired by ClientTransport when client events occur. */
export interface ClientTransportCallbacks {
	/** Raw PCM audio data received from the client WebSocket (binary frames). */
	onAudioFromClient?(data: Buffer): void;
	/** A JSON message received from the client WebSocket (text frames). */
	onJsonFromClient?(message: Record<string, unknown>): void;
	/** A REAL client WebSocket connection was established (never fired for probe or verifier connections). */
	onClientConnected?(): void;
	/** The REAL client WebSocket disconnected (never fired for probe or verifier connections). */
	onClientDisconnected?(): void;
	/** An image was uploaded by the client (base64-encoded). */
	onImageUpload?(imageBase64: string, mimeType: string): void;
	/** A verification-role connection (`?verify=1`) attached. A narrow hook the
	 *  embedder may use to wake the upstream; it MUST NOT run real-client connect
	 *  side effects here, because a verifier is isolated from the user session. */
	onVerifierConnected?(): void;
	/** The verification-role connection detached (clean close or preemption). */
	onVerifierDisconnected?(): void;
}

/** Optional constructor behavior for ClientTransport. */
export interface ClientTransportOptions {
	/** Supplies the JSON state frame sent to `?probe=1` connections. When absent,
	 *  probes are upgraded and closed (code 1000) without a frame, so the probe
	 *  learns only that the server accepts connections. */
	probeState?: () => object;
}

/** Connection roles recognized from the request URL query. */
export type ClientConnectionRole = 'real' | 'verify';

/** Application close code: a second real client (or a verifier) was rejected
 *  because a real client is attached. */
export const CLOSE_CODE_CLIENT_BUSY = 4409;
/** Close reason paired with {@link CLOSE_CODE_CLIENT_BUSY}. */
export const CLOSE_REASON_CLIENT_BUSY = 'client-busy';

/** Application close code: the incumbent real client was closed because a
 *  `?takeover=1` challenger completed the user-confirmed takeover handshake. */
export const CLOSE_CODE_SUPERSEDED_BY_TAKEOVER = 4410;
/** Close reason paired with {@link CLOSE_CODE_SUPERSEDED_BY_TAKEOVER}. */
export const CLOSE_REASON_SUPERSEDED_BY_TAKEOVER = 'superseded-by-takeover';

/** Application close code: an incumbent verification-role connection was
 *  preempted by an arriving real client; the verifier's owner requeues. */
export const CLOSE_CODE_VERIFIER_PREEMPTED = 4411;
/** Close reason paired with {@link CLOSE_CODE_VERIFIER_PREEMPTED}. */
export const CLOSE_REASON_VERIFIER_PREEMPTED = 'verifier-preempted';

/**
 * WebSocket server that bridges a client audio app to the framework.
 *
 * Multiplexes two message types on the same WebSocket connection:
 * - **Binary frames**: Raw PCM audio (forwarded via `onAudioFromClient` or buffered during transfers).
 * - **Text frames**: JSON messages for GUI events (`onJsonFromClient`).
 *
 * Buffering mode (`startBuffering`/`stopBuffering`) only affects binary audio frames.
 * Text frames are always delivered immediately.
 *
 * Pre-client interception, recognized from the upgrade request URL query BEFORE
 * any connection is attached as the client:
 * - `?probe=1` — health probe: the upgrade completes, one JSON text frame from
 *   `options.probeState` is sent (if provided), then the socket closes with 1000.
 *   Probe sockets never touch the attached client, never fire connect/disconnect
 *   callbacks, and are excluded from all client accounting.
 * - `?takeover=1` — user-confirmed takeover: an incumbent real client is closed
 *   with 4410 `superseded-by-takeover`, then the challenger attaches as real.
 * - `?verify=1` — low-priority verification role: rejected with 4409
 *   `client-busy` while a real client is attached; preempted with 4411
 *   `verifier-preempted` when a real client arrives. Fires
 *   `onVerifierConnected`/`onVerifierDisconnected` only — never the real-client
 *   callbacks — and never counts as attached.
 *
 * Any other connection is a real client. A second real client is rejected with
 * 4409 `client-busy` while one is attached.
 */
export class ClientTransport {
	private wss: WebSocketServer | null = null;
	private client: WebSocket | null = null;
	private clientRole: ClientConnectionRole | null = null;
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
		private options: ClientTransportOptions = {},
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

			this.wss.on('connection', (ws, req) => {
				this.handleConnection(ws, req);
			});
		});
	}

	/** Pre-client interception: classify the connection BEFORE any `client` assignment. */
	private handleConnection(ws: WebSocket, req: IncomingMessage): void {
		const params = new URL(req.url ?? '/', 'ws://localhost').searchParams;

		// Probe: upgrade + optional state frame + close 1000. Never attaches,
		// never fires callbacks, excluded from client accounting.
		if (params.get('probe') === '1') {
			this.handleProbe(ws);
			return;
		}

		const takeover = params.get('takeover') === '1';
		const role: ClientConnectionRole = params.get('verify') === '1' ? 'verify' : 'real';

		// A stale incumbent whose socket is no longer OPEN (CLOSING/CLOSED — its
		// own 'close' event has not fired yet) does not actually occupy the slot.
		// Judging occupancy by `this.client` truthiness alone would wrongly reject
		// the same user's immediate reconnect with 4409 client-busy. Quietly
		// release it (role-appropriate disconnect callback, null the slot) so the
		// newcomer attaches normally.
		if (this.client && this.client.readyState !== 1) {
			this.releaseIncumbent();
		}

		if (this.client) {
			if (this.clientRole === 'real') {
				if (role === 'real' && takeover) {
					// Takeover handshake: close the incumbent with a distinct close,
					// then attach the challenger.
					this.detachIncumbent(
						CLOSE_CODE_SUPERSEDED_BY_TAKEOVER,
						CLOSE_REASON_SUPERSEDED_BY_TAKEOVER,
					);
				} else {
					// A real client is attached: reject a second real client and any
					// verifier with the stable client-busy close.
					this.rejectBusy(ws);
					return;
				}
			} else {
				// Incumbent is a verifier (low-priority role).
				if (role === 'real') {
					// Preempt the verifier — distinct close so its owner requeues.
					this.detachIncumbent(CLOSE_CODE_VERIFIER_PREEMPTED, CLOSE_REASON_VERIFIER_PREEMPTED);
				} else {
					// Second verifier: only one connection at a time — requeue.
					this.rejectBusy(ws);
					return;
				}
			}
		}

		this.attach(ws, role);
	}

	private handleProbe(ws: WebSocket): void {
		ws.on('error', () => {
			// Prevent unhandled error crash on the probe socket
		});
		if (this.options.probeState) {
			try {
				ws.send(JSON.stringify(this.options.probeState()));
			} catch {
				// probeState threw or the send failed — still close cleanly (upgrade-only result)
			}
		}
		ws.close(1000);
	}

	private rejectBusy(ws: WebSocket): void {
		ws.on('error', () => {
			// Prevent unhandled error crash on the rejected socket
		});
		ws.close(CLOSE_CODE_CLIENT_BUSY, CLOSE_REASON_CLIENT_BUSY);
	}

	/** Release the incumbent from the slot: strip its 'message' listener so a
	 *  superseded/detached socket can never inject another frame, null the slot,
	 *  and fire its role-appropriate disconnect callback synchronously. Returns
	 *  the released socket so callers may close it with a chosen code. The
	 *  socket's own 'close' handler is a no-op afterwards (client no longer === ws). */
	private releaseIncumbent(): WebSocket | null {
		const incumbent = this.client;
		const incumbentRole = this.clientRole;
		this.client = null;
		this.clientRole = null;
		incumbent?.removeAllListeners('message');
		if (incumbentRole === 'real') {
			this.callbacks.onClientDisconnected?.();
		} else if (incumbentRole === 'verify') {
			this.callbacks.onVerifierDisconnected?.();
		}
		return incumbent;
	}

	/** Detach the incumbent connection deliberately (takeover/preemption): release
	 *  it from the slot, then close its socket with the given application code. */
	private detachIncumbent(code: number, reason: string): void {
		this.releaseIncumbent()?.close(code, reason);
	}

	private attach(ws: WebSocket, role: ClientConnectionRole): void {
		// Attach event handlers BEFORE setting this.client to avoid
		// a race where messages arrive before handlers are registered.
		ws.on('message', (data: Buffer, isBinary: boolean) => {
			// A superseded/detached incumbent (takeover/preemption/stale release)
			// may still have queued frames after it lost the slot: never let a
			// socket that is no longer THE attached client inject into the session
			// or into the inbound capture buffer.
			if (this.client !== ws) return;
			// Verification-role isolation: a verifier observes outbound state
			// only — its inbound frames must never reach user-side callbacks.
			if (role !== 'real') return;
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
			// Already detached deliberately (takeover/preemption) or replaced.
			if (this.client !== ws) return;
			this.client = null;
			this.clientRole = null;
			if (role === 'real') {
				this.callbacks.onClientDisconnected?.();
			} else {
				this.callbacks.onVerifierDisconnected?.();
			}
		});

		ws.on('error', () => {
			// Prevent unhandled error crash — 'close' event will follow
		});

		this.client = ws;
		this.clientRole = role;
		if (role === 'real') {
			this.callbacks.onClientConnected?.();
		} else {
			this.callbacks.onVerifierConnected?.();
		}
	}

	async stop(): Promise<void> {
		this._buffering = false;
		this.audioBuffer.clear();
		if (this.client) {
			this.client.removeAllListeners();
			this.client.close();
			this.client = null;
			this.clientRole = null;
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

	/** Leave buffering mode and drop the buffered microphone frames (and their
	 *  capture tags) without returning them, so none reaches the model. */
	discardBuffered(): void {
		this._buffering = false;
		this._capturedTags = [];
		this.audioBuffer.clear();
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

	/** True when a REAL client is attached and open. Verifier and probe
	 *  connections never count (client accounting is real-clients-only). */
	get isClientConnected(): boolean {
		return this.clientRole === 'real' && this.client?.readyState === 1;
	}

	/** True when a verification-role (`?verify=1`) connection is attached and open. */
	get isVerifierConnected(): boolean {
		return this.clientRole === 'verify' && this.client?.readyState === 1;
	}

	/** Role of the currently attached connection, or null when none. */
	get attachedRole(): ClientConnectionRole | null {
		return this.client ? this.clientRole : null;
	}

	get buffering(): boolean {
		return this._buffering;
	}
}
