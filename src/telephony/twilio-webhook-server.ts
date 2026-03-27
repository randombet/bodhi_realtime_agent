// SPDX-License-Identifier: MIT

/**
 * HTTP + WebSocket server for Twilio voice webhooks and Media Streams.
 *
 * Endpoints:
 *   POST /twilio/voice   — Returns TwiML to open a bidirectional Media Stream.
 *   POST /twilio/status  — Receives call status callbacks.
 *   WSS  /twilio/media   — Bidirectional Media Streams WebSocket.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { type WebSocket, WebSocketServer } from 'ws';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TwilioWebhookServerConfig {
	/** Port to listen on. */
	port: number;
	/** Twilio Auth Token for signature validation (future use). */
	authToken: string;
	/** Per-call nonce token for WS auth. */
	wsAuthToken: string;
	/** Called when audio media is received from the human. */
	onMediaReceived: (base64Audio: string) => void;
	/** Called when the Media Stream starts. */
	onStreamStarted: (streamSid: string, callSid: string) => void;
	/** Called when the Media Stream stops. */
	onStreamStopped: () => void;
	/** Optional: called on Twilio status callbacks. */
	onStatusCallback?: (callSid: string, callStatus: string, answeredBy?: string) => void;
}

// ---------------------------------------------------------------------------
// TwilioWebhookServer
// ---------------------------------------------------------------------------

export class TwilioWebhookServer {
	private httpServer: Server | null = null;
	private wss: WebSocketServer | null = null;
	private activeWs: WebSocket | null = null;

	constructor(private readonly config: TwilioWebhookServerConfig) {}

	/** Start the HTTP + WebSocket server. */
	async start(): Promise<void> {
		if (this.httpServer) return;

		this.httpServer = createServer((req, res) => this.handleHttp(req, res));

		this.wss = new WebSocketServer({ server: this.httpServer, path: '/twilio/media' });
		this.wss.on('connection', (ws, req) => this.handleWsConnection(ws, req));

		return new Promise<void>((resolve) => {
			this.httpServer?.listen(this.config.port, () => resolve());
		});
	}

	/** Stop the server and close all connections. */
	async stop(): Promise<void> {
		if (this.activeWs) {
			this.activeWs.close();
			this.activeWs = null;
		}
		if (this.wss) {
			this.wss.close();
			this.wss = null;
		}
		if (this.httpServer) {
			return new Promise<void>((resolve) => {
				this.httpServer?.close(() => {
					this.httpServer = null;
					resolve();
				});
			});
		}
	}

	/** Send mulaw audio to Twilio via the active Media Stream. */
	sendMedia(mulawBase64: string, streamSid?: string): void {
		if (!this.activeWs || this.activeWs.readyState !== 1) return;

		const message = JSON.stringify({
			event: 'media',
			streamSid: streamSid ?? '',
			media: {
				payload: mulawBase64,
			},
		});
		this.activeWs.send(message);
	}

	// -----------------------------------------------------------------------
	// HTTP handler
	// -----------------------------------------------------------------------

	private handleHttp(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

		if (req.method === 'POST' && url.pathname === '/twilio/voice') {
			this.handleVoiceWebhook(url, res);
			return;
		}

		if (req.method === 'POST' && url.pathname === '/twilio/status') {
			this.handleStatusCallback(req, res);
			return;
		}

		res.writeHead(404);
		res.end('Not Found');
	}

	private handleVoiceWebhook(url: URL, res: ServerResponse): void {
		const authParam = url.searchParams.get('auth');
		const wsUrl = `${this.config.port ? 'wss' : 'ws'}://${url.host}/twilio/media`;

		const twiml = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<Response>',
			'  <Connect>',
			`    <Stream url="${wsUrl}">`,
			`      <Parameter name="auth" value="${authParam ?? ''}" />`,
			'    </Stream>',
			'  </Connect>',
			'</Response>',
		].join('\n');

		res.writeHead(200, { 'Content-Type': 'text/xml' });
		res.end(twiml);
	}

	private handleStatusCallback(req: IncomingMessage, res: ServerResponse): void {
		let body = '';
		req.on('data', (chunk) => {
			body += chunk;
		});
		req.on('end', () => {
			const params = new URLSearchParams(body);
			const callSid = params.get('CallSid') ?? '';
			const callStatus = params.get('CallStatus') ?? '';
			const answeredBy = params.get('AnsweredBy') ?? undefined;

			this.config.onStatusCallback?.(callSid, callStatus, answeredBy);

			res.writeHead(200);
			res.end();
		});
	}

	// -----------------------------------------------------------------------
	// WebSocket handler (Twilio Media Streams)
	// -----------------------------------------------------------------------

	private handleWsConnection(ws: WebSocket, _req: IncomingMessage): void {
		let authenticated = false;

		ws.on('message', (data) => {
			try {
				const msg = JSON.parse(data.toString());
				this.handleWsMessage(ws, msg, authenticated, (auth) => {
					authenticated = auth;
				});
			} catch {
				// Ignore malformed messages
			}
		});

		ws.on('close', () => {
			if (ws === this.activeWs) {
				this.activeWs = null;
				this.config.onStreamStopped();
			}
		});
	}

	private handleWsMessage(
		ws: WebSocket,
		msg: Record<string, unknown>,
		authenticated: boolean,
		setAuth: (val: boolean) => void,
	): void {
		switch (msg.event) {
			case 'connected':
				// Initial handshake — wait for 'start' with auth
				break;

			case 'start': {
				const startMsg = msg.start as Record<string, unknown> | undefined;
				const customParams = startMsg?.customParameters as Record<string, string> | undefined;
				const authToken = customParams?.auth;

				if (authToken !== this.config.wsAuthToken) {
					ws.close(4001, 'Unauthorized');
					return;
				}

				setAuth(true);
				this.activeWs = ws;

				const streamSid = (startMsg?.streamSid as string) ?? '';
				const callSid = (startMsg?.callSid as string) ?? '';
				this.config.onStreamStarted(streamSid, callSid);
				break;
			}

			case 'media': {
				if (!authenticated) return;
				const media = msg.media as Record<string, unknown> | undefined;
				const payload = media?.payload;
				if (typeof payload === 'string') {
					this.config.onMediaReceived(payload);
				}
				break;
			}

			case 'stop':
				if (ws === this.activeWs) {
					this.activeWs = null;
					this.config.onStreamStopped();
				}
				break;
		}
	}
}
