// SPDX-License-Identifier: MIT

/**
 * OpenAI response state tracker.
 *
 * Tracks the model's response lifecycle (idle → generating → cancelling → idle)
 * to prevent invalid cancel requests and enforce sequencing invariants.
 */

/** Model response state. */
export type ResponseState = 'idle' | 'generating' | 'cancelling';

/**
 * Tracks the OpenAI model's response state to enforce sequencing.
 *
 * Rules:
 * - Cancel is only valid while generating.
 * - Response.create is only valid while idle.
 * - Audio forwarding should stop after interrupt (until next response starts).
 */
export class OpenAIResponseStateTracker {
	private _state: ResponseState = 'idle';
	private _activeResponseId: string | null = null;

	/** Current response state. */
	get state(): ResponseState {
		return this._state;
	}

	/** Active response ID, or null if idle. */
	get activeResponseId(): string | null {
		return this._activeResponseId;
	}

	/** Whether the model is currently generating. */
	get isGenerating(): boolean {
		return this._state === 'generating';
	}

	/** Whether we are idle (safe to start new response). */
	get isIdle(): boolean {
		return this._state === 'idle';
	}

	/** Model started generating a response. */
	responseCreated(responseId: string): void {
		this._state = 'generating';
		this._activeResponseId = responseId;
	}

	/** Model finished generating (done). */
	responseDone(): void {
		this._state = 'idle';
		this._activeResponseId = null;
	}

	/** Cancel was requested. Returns true if cancel is valid. */
	requestCancel(): boolean {
		if (this._state !== 'generating') {
			return false;
		}
		this._state = 'cancelling';
		return true;
	}

	/** Cancel completed (response.cancelled received). */
	cancelCompleted(): void {
		this._state = 'idle';
		this._activeResponseId = null;
	}

	/** Reset to idle (e.g., on disconnect). */
	reset(): void {
		this._state = 'idle';
		this._activeResponseId = null;
	}
}
