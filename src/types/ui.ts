// SPDX-License-Identifier: MIT

/**
 * A UI response sent by the client in reply to a UIPayload request.
 * Correlates back to the original request via requestId.
 */
export interface UIResponse {
	/** Matches the requestId from the originating UIPayload. */
	requestId: string;
	/** The option the user selected (for 'choice' / 'confirmation' payloads). */
	selectedOptionId?: string;
	/** Form field values (for 'form' payloads). */
	formData?: Record<string, unknown>;
}
