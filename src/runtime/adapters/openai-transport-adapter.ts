// SPDX-License-Identifier: MIT

/**
 * OpenAI Realtime API transport adapter.
 *
 * Wraps an OpenAIRealtimeTransport (or any LLMTransport implementing OpenAI's
 * protocol) and exposes the canonical TransportAdapter interface.
 *
 * Audio stays on the fast path — this adapter only handles control events.
 */

import type { LLMTransport, TransportToolResult } from '../../types/transport.js';
import type { AdapterToolCall, TransportAdapter } from './transport-adapter.js';

export class OpenAITransportAdapter implements TransportAdapter {
	// -- Inbound callbacks (set by TransportActor) ---------------------------
	onSessionReady?: () => void;
	onTurnComplete?: (turnId?: string) => void;
	onInterrupted?: () => void;
	onToolCallReceived?: (calls: AdapterToolCall[]) => void;
	onToolCallCancelled?: (ids: string[]) => void;
	onError?: (error: string, recoverable: boolean) => void;
	onClosed?: (reason?: string) => void;

	constructor(private transport: LLMTransport) {
		// Chain existing LLMTransport callbacks so VoiceSession handlers continue to run.
		const prevOnSessionReady = this.transport.onSessionReady;
		const prevOnTurnComplete = this.transport.onTurnComplete;
		const prevOnInterrupted = this.transport.onInterrupted;
		const prevOnToolCall = this.transport.onToolCall;
		const prevOnToolCallCancel = this.transport.onToolCallCancel;
		const prevOnError = this.transport.onError;
		const prevOnClose = this.transport.onClose;

		this.transport.onSessionReady = (sessionId: string) => {
			prevOnSessionReady?.(sessionId);
			this.onSessionReady?.();
		};
		this.transport.onTurnComplete = () => {
			prevOnTurnComplete?.();
			this.onTurnComplete?.();
		};
		this.transport.onInterrupted = () => {
			prevOnInterrupted?.();
			this.onInterrupted?.();
		};
		this.transport.onToolCall = (calls) => {
			prevOnToolCall?.(calls);
			this.onToolCallReceived?.(calls.map((c) => ({ id: c.id, name: c.name, args: c.args })));
		};
		this.transport.onToolCallCancel = (ids) => {
			prevOnToolCallCancel?.(ids);
			this.onToolCallCancelled?.(ids);
		};
		this.transport.onError = (err) => {
			prevOnError?.(err);
			this.onError?.(err.error.message, err.recoverable);
		};
		this.transport.onClose = (code, reason) => {
			prevOnClose?.(code, reason);
			this.onClosed?.(reason);
		};
	}

	// -- Outbound commands ---------------------------------------------------

	sendContent(content: unknown[], turnComplete?: boolean): void {
		const turns = content as Array<{ role: string; parts: Array<{ text: string }> }>;
		for (const turn of turns) {
			const text = turn.parts.map((p) => p.text).join('');
			this.transport.sendContent([{ role: turn.role as 'user' | 'assistant', text }], turnComplete);
		}
	}

	sendToolResult(id: string, name: string, result: unknown, scheduling: string): void {
		const toolResult: TransportToolResult = {
			id,
			name,
			result,
			scheduling: scheduling as TransportToolResult['scheduling'],
		};
		this.transport.sendToolResult(toolResult);
	}

	async transferSession(config: unknown, state: unknown): Promise<void> {
		// OpenAI supports in-place session update for transfers
		await this.transport.transferSession(
			config as Parameters<LLMTransport['transferSession']>[0],
			state as Parameters<LLMTransport['transferSession']>[1],
		);
	}

	cancelGeneration(): void {
		// OpenAI supports explicit response cancellation
		// The transport exposes this via sendContent with empty + turnComplete,
		// or through a dedicated mechanism in the SDK.
		// For now, delegate to transport.
		this.transport.clearAudio();
	}

	triggerGeneration(): void {
		this.transport.triggerGeneration();
	}
}
