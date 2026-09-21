/**
 * Transport-agnostic interface for OpenClaw gateway communication.
 *
 * Both `OpenClawClient` (WebSocket) and `OpenClawHttpClient` (HTTP/SSE)
 * implement this interface, allowing consumers to work with either
 * transport without code changes.
 */

import type { ChatEvent, ChatSendOptions } from './openclaw-client.js';

export interface OpenClawTransport {
	/** Establish connection (WebSocket) or no-op (HTTP). */
	connect(): Promise<void>;

	/** Send a chat message and start a new run. Returns { runId }. */
	chatSend(
		sessionKey: string,
		message: string,
		optionsOrKey?: ChatSendOptions | string,
	): Promise<{ runId: string }>;

	/** Returns the next event for a run (streaming). */
	nextChatEvent(runId: string): Promise<ChatEvent>;

	/** Cancel a running task (best-effort). */
	chatAbort(runId: string): Promise<void>;

	/** Set the model for a session. */
	setModel(sessionKey: string, model: string): Promise<void>;

	/** Build a session key from a session ID. */
	sessionKey(sessionId: string): string;

	/** Close the connection and release resources. */
	close(): Promise<void>;
}
