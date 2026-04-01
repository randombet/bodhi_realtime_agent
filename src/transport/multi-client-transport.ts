/**
 * Multi-Client Transport
 *
 * WebSocket server that handles multiple concurrent client connections.
 * Routes messages to the correct VoiceSession based on connection mapping.
 * Can run standalone (start) or attached to an HTTP server (attachToHttpServer).
 */

import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';

export interface ConnectionContext {
	webSocketId: string;
	sessionId: string | null;
	userId: string | null;
	connectedAt: number;
	lastActivityAt: number;
	/** HTTP upgrade request (for auth to read URL query, e.g. ?userId=). */
	request?: IncomingMessage;
}

export interface MultiClientTransportCallbacks {
	/** Called when a new WebSocket connection is established */
	onConnection?(ws: WebSocket, context: ConnectionContext): void | Promise<void>;
	/** Called when a WebSocket connection is closed */
	onDisconnection?(ws: WebSocket, context: ConnectionContext): void | Promise<void>;
	/** Called when binary audio data is received from a client */
	onAudioFromClient?(ws: WebSocket, data: Buffer, context: ConnectionContext): void;
	/** Called when a JSON message is received from a client */
	onJsonFromClient?(
		ws: WebSocket,
		message: Record<string, unknown>,
		context: ConnectionContext,
	): void;
	/** Called when a WebSocket error occurs */
	onError?(ws: WebSocket, error: Error, context: ConnectionContext): void;
}

/**
 * WebSocket server that manages multiple concurrent client connections.
 * Each connection can be associated with a VoiceSession.
 */
export class MultiClientTransport {
	private wss: WebSocketServer | null = null;
	private connections = new Map<WebSocket, ConnectionContext>();
	private connectionCounter = 0;

	constructor(
		private port: number,
		private callbacks: MultiClientTransportCallbacks,
		private host = '0.0.0.0',
	) {}

	/**
	 * Start the WebSocket server on its own port (standalone).
	 */
	async start(): Promise<void> {
		return new Promise((resolve, reject) => {
			try {
				this.wss = new WebSocketServer({ port: this.port, host: this.host });

				this.wss.on('listening', () => {
					console.log(
						`[MultiClientTransport] WebSocket server listening on ws://${this.host}:${this.port}`,
					);
					resolve();
				});

				this.wss.on('error', (error) => {
					console.error('[MultiClientTransport] Server error:', error);
					reject(error);
				});

				this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
					this.handleConnection(ws, req);
				});
			} catch (error) {
				reject(error);
			}
		});
	}

	/**
	 * Attach to an existing HTTP server; handle WebSocket upgrade on the given path(s).
	 * Call this instead of start() when you serve HTTP (e.g. /api) and WS on the same port.
	 * Accepts both '/' and '/ws' so client works with same-origin (/) and reverse-proxy (/ws) setups.
	 */
	attachToHttpServer(httpServer: HttpServer, wsPaths: string | string[] = '/'): void {
		this.wss = new WebSocketServer({ noServer: true });
		const paths = Array.isArray(wsPaths) ? wsPaths : [wsPaths];

		this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
			this.handleConnection(ws, req);
		});

		httpServer.on(
			'upgrade',
			(req: IncomingMessage, socket: import('node:net').Socket, head: Buffer) => {
				const pathname = req.url?.split('?')[0] ?? '';
				if (!paths.includes(pathname)) {
					// Not our websocket path; allow other upgrade handlers (e.g. Twilio bridge) to process it.
					return;
				}
				this.wss?.handleUpgrade(req, socket, head, (ws) => {
					this.wss?.emit('connection', ws, req);
				});
			},
		);

		console.log(
			`[MultiClientTransport] WebSocket attached to HTTP server on path(s) ${paths.join(', ')}`,
		);
	}

	/**
	 * Stop the WebSocket server and close all connections.
	 */
	async stop(): Promise<void> {
		// Close all connections
		for (const [ws, context] of this.connections.entries()) {
			try {
				ws.close();
				this.callbacks.onDisconnection?.(ws, context);
			} catch (error) {
				console.error('[MultiClientTransport] Error closing connection:', error);
			}
		}
		this.connections.clear();

		// Close WebSocket server (do not close HTTP server when attached)
		if (this.wss) {
			return new Promise((resolve) => {
				this.wss?.close(() => {
					this.wss = null;
					resolve();
				});
			});
		}
	}

	/**
	 * Get connection context for a WebSocket.
	 */
	getConnectionContext(ws: WebSocket): ConnectionContext | null {
		return this.connections.get(ws) ?? null;
	}

	/**
	 * Associate a session with a WebSocket connection.
	 */
	associateSession(ws: WebSocket, sessionId: string): void {
		const context = this.connections.get(ws);
		if (context) {
			context.sessionId = sessionId;
			context.lastActivityAt = Date.now();
		}
	}

	/**
	 * Associate a user with a WebSocket connection.
	 */
	associateUser(ws: WebSocket, userId: string): void {
		const context = this.connections.get(ws);
		if (context) {
			context.userId = userId;
			context.lastActivityAt = Date.now();
		}
	}

	/**
	 * Send audio data to a specific WebSocket connection.
	 */
	sendAudioToClient(ws: WebSocket, data: Buffer): void {
		if (ws.readyState === 1) {
			// WebSocket.OPEN
			ws.send(data);
		}
	}

	/**
	 * Send a JSON message to a specific WebSocket connection.
	 */
	sendJsonToClient(ws: WebSocket, message: Record<string, unknown>): void {
		if (ws.readyState === 1) {
			// WebSocket.OPEN
			ws.send(JSON.stringify(message));
		}
	}

	/**
	 * Broadcast a message to all connected clients.
	 */
	broadcast(message: Record<string, unknown>): void {
		const json = JSON.stringify(message);
		for (const [ws] of this.connections.entries()) {
			if (ws.readyState === 1) {
				ws.send(json);
			}
		}
	}

	/**
	 * Get statistics about active connections.
	 */
	getStats(): {
		totalConnections: number;
		connectionsByUser: Record<string, number>;
	} {
		const connectionsByUser: Record<string, number> = {};

		for (const context of this.connections.values()) {
			if (context.userId) {
				connectionsByUser[context.userId] = (connectionsByUser[context.userId] ?? 0) + 1;
			}
		}

		return {
			totalConnections: this.connections.size,
			connectionsByUser,
		};
	}

	/**
	 * Handle a new WebSocket connection.
	 */
	private handleConnection(ws: WebSocket, req: IncomingMessage): void {
		const webSocketId = `ws_${Date.now()}_${++this.connectionCounter}`;
		const context: ConnectionContext = {
			webSocketId,
			sessionId: null,
			userId: null,
			connectedAt: Date.now(),
			lastActivityAt: Date.now(),
			request: req,
		};

		this.connections.set(ws, context);

		// Set up message handlers
		ws.on('message', (data: Buffer, isBinary: boolean) => {
			context.lastActivityAt = Date.now();

			if (isBinary) {
				// Binary audio data
				this.callbacks.onAudioFromClient?.(ws, data, context);
			} else {
				// JSON message
				try {
					const message = JSON.parse(data.toString()) as Record<string, unknown>;
					this.callbacks.onJsonFromClient?.(ws, message, context);
				} catch (error) {
					console.error('[MultiClientTransport] Failed to parse JSON message:', error);
				}
			}
		});

		// Handle connection close
		ws.on('close', () => {
			this.connections.delete(ws);
			this.callbacks.onDisconnection?.(ws, context);
		});

		// Handle errors
		ws.on('error', (error) => {
			console.error('[MultiClientTransport] WebSocket error for', webSocketId, error);
			this.callbacks.onError?.(ws, error, context);
		});

		// Notify callback
		Promise.resolve(this.callbacks.onConnection?.(ws, context)).catch((error: unknown) => {
			console.error('[MultiClientTransport] Connection callback error:', error);
		});
	}
}
