// SPDX-License-Identifier: MIT

/**
 * OpenAI function call argument assembler.
 *
 * OpenAI Realtime API streams function call arguments incrementally via
 * `response.function_call_arguments.delta` events. This assembler accumulates
 * the deltas and produces complete calls when `done` is received.
 */

/** A completed function call ready for dispatch. */
export interface CompletedFunctionCall {
	callId: string;
	name: string;
	args: Record<string, unknown>;
}

/** Pending function call being assembled. */
interface PendingCall {
	callId: string;
	name: string;
	argFragments: string[];
}

/**
 * Accumulates streamed function call arguments into complete calls.
 */
export class OpenAIFunctionCallAssembler {
	private pending = new Map<string, PendingCall>();

	/** Start tracking a new function call. */
	startCall(callId: string, name: string): void {
		this.pending.set(callId, {
			callId,
			name,
			argFragments: [],
		});
	}

	/** Append an argument delta. */
	appendDelta(callId: string, delta: string): void {
		const call = this.pending.get(callId);
		if (call) {
			call.argFragments.push(delta);
		}
	}

	/** Finalize a call and return the completed result. Returns null if unknown callId. */
	finalize(callId: string): CompletedFunctionCall | null {
		const call = this.pending.get(callId);
		if (!call) return null;

		this.pending.delete(callId);

		const argsString = call.argFragments.join('');
		let args: Record<string, unknown>;
		try {
			args = JSON.parse(argsString) as Record<string, unknown>;
		} catch {
			args = { _raw: argsString };
		}

		return {
			callId: call.callId,
			name: call.name,
			args,
		};
	}

	/** Check if a call is being assembled. */
	hasPendingCall(callId: string): boolean {
		return this.pending.has(callId);
	}

	/** Number of calls currently being assembled. */
	get pendingCount(): number {
		return this.pending.size;
	}

	/** Clear all pending calls (e.g., on disconnect). */
	clear(): void {
		this.pending.clear();
	}
}
