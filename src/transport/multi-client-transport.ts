/**
 * Multi-Client Transport
 *
 * WebSocket server that handles multiple concurrent client connections.
 * Routes messages to the correct VoiceSession based on connection mapping.
 * Can run standalone (start) or attached to an HTTP server (attachToHttpServer).
 *
 * Two lifecycles (reuse plan S3/C1):
 *
 * - **Legacy** (no `guarded` option): the historical flow — handlers are
 *   registered immediately and `onConnection` runs afterwards. Preserved
 *   byte-compatible for existing consumers, with one global
 *   bug fix: `onDisconnection` now fires exactly once per connection
 *   (previously `stop()` invoked it directly AND the socket's close handler
 *   fired it again).
 *
 * - **Guarded** (opt-in via `guarded`): a staged lifecycle for peer servers —
 *   `validateUpgrade` (async, may acquire app resources) → `setup` (build the
 *   session) → live dispatch → exactly-once awaited `teardown` with a
 *   discriminated cause. Rules:
 *   - Rejected/thrown validation produces ZERO app callbacks (accept the
 *     upgrade, close with the given code — nothing to tear down).
 *   - A validated context that never enters setup (client vanished, server
 *     stopping) is released via `disposeValidatedContext`, exactly once.
 *   - Once setup is entered, EVERY termination — disconnect, error,
 *     structured setup rejection, shutdown — produces exactly one `teardown`
 *     call; `stop()` awaits all pending validations, disposals, and
 *     teardowns before resolving.
 *   - No inbound frame reaches app callbacks before setup succeeds.
 */

import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';
import type { AnyServerToClientMessage } from '../types/client-protocol.js';

export interface ConnectionContext<TAppContext = unknown> {
	webSocketId: string;
	sessionId: string | null;
	userId: string | null;
	connectedAt: number;
	lastActivityAt: number;
	/** HTTP upgrade request (for auth to read URL query, e.g. ?userId=). */
	request?: IncomingMessage;
	/** Guarded lifecycle only: what `validateUpgrade` returned. */
	appContext?: TAppContext;
}

export interface MultiClientTransportCallbacks<TAppContext = unknown> {
	/** Called when a new WebSocket connection is established (legacy) or after
	 *  guarded setup succeeds. */
	onConnection?(ws: WebSocket, context: ConnectionContext<TAppContext>): void | Promise<void>;
	/** Called when a WebSocket connection is closed. Exactly once per
	 *  connection (legacy lifecycle). Guarded consumers use `teardown`. */
	onDisconnection?(ws: WebSocket, context: ConnectionContext<TAppContext>): void | Promise<void>;
	/** Called when binary audio data is received from a client */
	onAudioFromClient?(ws: WebSocket, data: Buffer, context: ConnectionContext<TAppContext>): void;
	/** Called when a JSON message is received from a client */
	onJsonFromClient?(
		ws: WebSocket,
		message: Record<string, unknown>,
		context: ConnectionContext<TAppContext>,
	): void;
	/** Called when a WebSocket error occurs */
	onError?(ws: WebSocket, error: Error, context: ConnectionContext<TAppContext>): void;
}

/** Why a guarded connection ended (drives app-side persistence transitions). */
export type TeardownCause =
	| { kind: 'disconnect' }
	| { kind: 'error'; error: Error }
	| { kind: 'shutdown' }
	| { kind: 'setup_rejected'; closeCode: number; reason: string };

export type ValidateResult<TAppContext> =
	| { ok: true; appContext: TAppContext }
	| { ok: false; closeCode: number; reason: string };

export type SetupResult = { ok: true } | { ok: false; closeCode: number; reason: string };

export interface GuardedLifecycle<TAppContext = unknown> {
	/**
	 * Validate an accepted upgrade. May acquire app resources (e.g. an atomic
	 * session claim) — they travel to `setup` via `appContext`, so there is no
	 * duplicate read. `signal` aborts when the client disconnects or the
	 * server stops while validation is pending. A thrown error is treated as
	 * accept-then-close 4500.
	 */
	validateUpgrade(req: IncomingMessage, signal: AbortSignal): Promise<ValidateResult<TAppContext>>;
	/**
	 * Build the app session for a validated connection. Runs before any
	 * inbound frame is dispatched. Structured rejection closes with the given
	 * code (e.g. capacity 4409 vs failure 4500); a thrown error maps to 4500.
	 * `signal` aborts when the client disconnects or the server stops. Setup
	 * implementations must stop committing app state after abort and release
	 * partially-created resources before resolving; the transport then invokes
	 * `teardown` exactly once for the terminal cause.
	 */
	setup(
		ws: WebSocket,
		context: ConnectionContext<TAppContext>,
		signal: AbortSignal,
	): Promise<SetupResult>;
	/**
	 * Release a validated-but-never-setup context (client closed or server
	 * stopped between claim and setup). Exactly once; awaited by `stop()`.
	 */
	disposeValidatedContext?(
		appContext: TAppContext,
		reason: 'client_closed' | 'stopping',
	): void | Promise<void>;
	/**
	 * Exactly-once cleanup after setup was entered, for every termination
	 * cause (including structured setup rejection). Awaited by `stop()`.
	 */
	teardown(
		ws: WebSocket,
		context: ConnectionContext<TAppContext>,
		cause: TeardownCause,
	): void | Promise<void>;
}

export interface MultiClientTransportOptions<TAppContext = unknown> {
	/** Opt into the staged validate → setup → teardown lifecycle. */
	guarded?: GuardedLifecycle<TAppContext>;
	/** Destroy sockets on upgrade paths this transport doesn't own (default
	 *  false: return and let other upgrade handlers claim them — the
	 *  Twilio-bridge case; a server with no other handler wants true, or the
	 *  socket hangs). */
	destroyUnmatched?: boolean;
	/** Injectable logger (default console). */
	logger?: (message: string, level?: 'info' | 'error') => void;
}

/**
 * WebSocket server that manages multiple concurrent client connections.
 * Each connection can be associated with a VoiceSession.
 */
export class MultiClientTransport<TAppContext = unknown> {
	private wss: WebSocketServer | null = null;
	private connections = new Map<WebSocket, ConnectionContext<TAppContext>>();
	private connectionCounter = 0;
	private stopping = false;
	/** Legacy exactly-once guard for onDisconnection. */
	private disconnectNotified = new WeakSet<WebSocket>();
	/** Guarded exactly-once guard for teardown. */
	private tornDown = new WeakSet<WebSocket>();
	/** Entire guarded pre-live pipelines (validation + setup). */
	private pendingValidations = new Set<Promise<void>>();
	private pendingWork = new Set<Promise<void>>();
	/** Lifecycle cancellation remains armed until setup has finished. */
	private validationAborts = new Set<AbortController>();
	private readonly log: (message: string, level?: 'info' | 'error') => void;

	constructor(
		private port: number,
		private callbacks: MultiClientTransportCallbacks<TAppContext>,
		private host = '0.0.0.0',
		private options: MultiClientTransportOptions<TAppContext> = {},
	) {
		this.log =
			options.logger ??
			((message, level) => {
				if (level === 'error') console.error(`[MultiClientTransport] ${message}`);
				else console.log(`[MultiClientTransport] ${message}`);
			});
	}

	/**
	 * Start the WebSocket server on its own port (standalone).
	 */
	async start(): Promise<void> {
		return new Promise((resolve, reject) => {
			try {
				this.wss = new WebSocketServer({ port: this.port, host: this.host });

				this.wss.on('listening', () => {
					this.log(`WebSocket server listening on ws://${this.host}:${this.port}`);
					resolve();
				});

				this.wss.on('error', (error) => {
					this.log(`Server error: ${error.message}`, 'error');
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
					if (this.options.destroyUnmatched) {
						socket.destroy();
						return;
					}
					// Not our websocket path; allow other upgrade handlers (e.g. Twilio bridge) to process it.
					return;
				}
				if (this.stopping) {
					socket.destroy();
					return;
				}
				this.wss?.handleUpgrade(req, socket, head, (ws) => {
					this.wss?.emit('connection', ws, req);
				});
			},
		);

		this.log(`WebSocket attached to HTTP server on path(s) ${paths.join(', ')}`);
	}

	/**
	 * Stop the WebSocket server and close all connections. Awaits pending
	 * guarded validations, disposals, and teardowns so a graceful shutdown
	 * releases every app resource.
	 */
	async stop(): Promise<void> {
		this.stopping = true;
		for (const controller of this.validationAborts) controller.abort();
		// Snapshot first — teardown/disposal mutates the sets.
		await Promise.allSettled([...this.pendingValidations]);

		for (const [ws, context] of [...this.connections.entries()]) {
			try {
				ws.close();
				if (this.options.guarded) {
					this.teardownOnce(ws, context, { kind: 'shutdown' });
				} else if (!this.disconnectNotified.has(ws)) {
					this.disconnectNotified.add(ws);
					this.callbacks.onDisconnection?.(ws, context);
				}
			} catch (error) {
				this.log(
					`Error closing connection: ${error instanceof Error ? error.message : String(error)}`,
					'error',
				);
			}
		}
		this.connections.clear();
		await Promise.allSettled([...this.pendingWork]);

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
	getConnectionContext(ws: WebSocket): ConnectionContext<TAppContext> | null {
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
	sendJsonToClient(ws: WebSocket, message: AnyServerToClientMessage): void {
		if (ws.readyState === 1) {
			// WebSocket.OPEN
			ws.send(JSON.stringify(message));
		}
	}

	/**
	 * Broadcast a message to all connected clients.
	 */
	broadcast(message: AnyServerToClientMessage): void {
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

	private newContext(req: IncomingMessage): ConnectionContext<TAppContext> {
		return {
			webSocketId: `ws_${Date.now()}_${++this.connectionCounter}`,
			sessionId: null,
			userId: null,
			connectedAt: Date.now(),
			lastActivityAt: Date.now(),
			request: req,
		};
	}

	/** Register live message/close/error handlers for an accepted connection. */
	private registerDispatch(ws: WebSocket, context: ConnectionContext<TAppContext>): void {
		ws.on('message', (data: Buffer, isBinary: boolean) => {
			context.lastActivityAt = Date.now();
			if (isBinary) {
				this.callbacks.onAudioFromClient?.(ws, data, context);
			} else {
				try {
					const message = JSON.parse(data.toString()) as Record<string, unknown>;
					this.callbacks.onJsonFromClient?.(ws, message, context);
				} catch {
					this.log('Failed to parse JSON message', 'error');
				}
			}
		});
	}

	/**
	 * Handle a new WebSocket connection.
	 */
	private handleConnection(ws: WebSocket, req: IncomingMessage): void {
		// A standalone WebSocketServer can emit a connection that was already in
		// the accept queue when stop() began. Do not start a lifecycle after the
		// shutdown snapshots have been taken.
		if (this.stopping) {
			try {
				ws.close(1001, 'server stopping');
			} catch {
				// The peer may already have disappeared.
			}
			return;
		}
		if (this.options.guarded) {
			const work = this.handleGuardedConnection(ws, req, this.options.guarded).catch((error) => {
				this.log(
					`Guarded connection error: ${error instanceof Error ? error.message : String(error)}`,
					'error',
				);
			});
			this.pendingValidations.add(work);
			work.finally(() => this.pendingValidations.delete(work));
			return;
		}

		const context = this.newContext(req);
		this.connections.set(ws, context);
		this.registerDispatch(ws, context);

		// Handle connection close (exactly once even when stop() raced it).
		ws.on('close', () => {
			this.connections.delete(ws);
			if (!this.disconnectNotified.has(ws)) {
				this.disconnectNotified.add(ws);
				this.callbacks.onDisconnection?.(ws, context);
			}
		});

		// Handle errors
		ws.on('error', (error) => {
			this.log(`WebSocket error for ${context.webSocketId}: ${error.message}`, 'error');
			this.callbacks.onError?.(ws, error, context);
		});

		// Notify callback
		Promise.resolve(this.callbacks.onConnection?.(ws, context)).catch((error: unknown) => {
			this.log(
				`Connection callback error: ${error instanceof Error ? error.message : String(error)}`,
				'error',
			);
		});
	}

	private async handleGuardedConnection(
		ws: WebSocket,
		req: IncomingMessage,
		guarded: GuardedLifecycle<TAppContext>,
	): Promise<void> {
		const abort = new AbortController();
		this.validationAborts.add(abort);
		let clientGone = false;
		let preLiveCause: TeardownCause | null = null;
		const preClose = () => {
			clientGone = true;
			preLiveCause ??= { kind: 'disconnect' };
			abort.abort();
		};
		const preError = (error: Error) => {
			clientGone = true;
			preLiveCause ??= { kind: 'error', error };
			abort.abort();
		};
		const detachPreLiveHandlers = () => {
			ws.off('close', preClose);
			ws.off('error', preError);
		};
		ws.once('close', preClose);
		ws.once('error', preError);

		let result: ValidateResult<TAppContext>;
		try {
			result = await guarded.validateUpgrade(req, abort.signal);
		} catch (error) {
			this.validationAborts.delete(abort);
			detachPreLiveHandlers();
			this.log(
				`validateUpgrade threw: ${error instanceof Error ? error.message : String(error)}`,
				'error',
			);
			ws.close(4500, 'validation failed');
			return;
		}
		if (!result.ok) {
			// Zero app callbacks for rejected validation.
			this.validationAborts.delete(abort);
			detachPreLiveHandlers();
			ws.close(result.closeCode, result.reason);
			return;
		}

		if (clientGone || this.stopping || ws.readyState !== 1) {
			// Validated but can never enter setup — release what validation acquired.
			this.validationAborts.delete(abort);
			detachPreLiveHandlers();
			const reason = clientGone ? 'client_closed' : 'stopping';
			const disposal = Promise.resolve(
				guarded.disposeValidatedContext?.(result.appContext, reason),
			).catch((error) =>
				this.log(
					`disposeValidatedContext failed: ${error instanceof Error ? error.message : String(error)}`,
					'error',
				),
			);
			this.pendingWork.add(disposal);
			disposal.finally(() => this.pendingWork.delete(disposal));
			await disposal;
			try {
				ws.close(1001, 'gone before setup');
			} catch {
				// already closed
			}
			return;
		}

		const context = this.newContext(req);
		context.appContext = result.appContext;
		this.connections.set(ws, context);

		// Setup phase: still no app dispatch; the close/error listener and the
		// same cancellation signal remain armed until setup has settled.
		let setupResult: SetupResult;
		try {
			setupResult = await guarded.setup(ws, context, abort.signal);
		} catch (error) {
			setupResult = {
				ok: false,
				closeCode: 4500,
				reason: error instanceof Error ? error.message : 'setup failed',
			};
		}
		this.validationAborts.delete(abort);

		if (clientGone || this.stopping || ws.readyState !== 1) {
			detachPreLiveHandlers();
			this.teardownOnce(
				ws,
				context,
				this.stopping ? { kind: 'shutdown' } : (preLiveCause ?? { kind: 'disconnect' }),
			);
			try {
				ws.close(1001, 'gone during setup');
			} catch {
				// already closed
			}
			return;
		}

		if (!setupResult.ok) {
			detachPreLiveHandlers();
			ws.close(setupResult.closeCode, setupResult.reason);
			this.teardownOnce(ws, context, {
				kind: 'setup_rejected',
				closeCode: setupResult.closeCode,
				reason: setupResult.reason,
			});
			return;
		}

		// Live handoff: install terminal handlers before removing the pre-live
		// handlers. If close/error fires during the overlap, teardownOnce makes the
		// duplicate observations harmless; if it fired just before the overlap,
		// the readiness/clientGone check below performs the teardown explicitly.
		const onLiveClose = () => {
			this.teardownOnce(ws, context, { kind: 'disconnect' });
		};
		const onLiveError = (error: Error) => {
			this.log(`WebSocket error for ${context.webSocketId}: ${error.message}`, 'error');
			this.callbacks.onError?.(ws, error, context);
			this.teardownOnce(ws, context, { kind: 'error', error });
		};
		ws.on('close', onLiveClose);
		ws.on('error', onLiveError);
		this.registerDispatch(ws, context);
		detachPreLiveHandlers();

		if (clientGone || this.stopping || ws.readyState !== 1 || this.tornDown.has(ws)) {
			this.teardownOnce(
				ws,
				context,
				this.stopping ? { kind: 'shutdown' } : (preLiveCause ?? { kind: 'disconnect' }),
			);
			return;
		}
		await Promise.resolve(this.callbacks.onConnection?.(ws, context)).catch((error: unknown) => {
			this.log(
				`Connection callback error: ${error instanceof Error ? error.message : String(error)}`,
				'error',
			);
		});
	}

	/** Exactly-once awaited teardown for guarded connections. */
	private teardownOnce(
		ws: WebSocket,
		context: ConnectionContext<TAppContext>,
		cause: TeardownCause,
	): void {
		if (this.tornDown.has(ws)) return;
		this.tornDown.add(ws);
		this.connections.delete(ws);
		const guarded = this.options.guarded;
		if (!guarded) return;
		const work = Promise.resolve(guarded.teardown(ws, context, cause)).catch((error) =>
			this.log(
				`teardown failed: ${error instanceof Error ? error.message : String(error)}`,
				'error',
			),
		);
		this.pendingWork.add(work);
		work.finally(() => this.pendingWork.delete(work));
	}
}
