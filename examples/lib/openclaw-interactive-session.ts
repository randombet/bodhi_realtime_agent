// SPDX-License-Identifier: MIT

import { FrameworkError } from '../../src/core/errors.js';
import { CancelledError } from '../../src/agent/subagent-session.js';
import type { SubagentSession } from '../../src/agent/subagent-session.js';
import type { SubagentResult } from '../../src/types/conversation.js';
import { mergeText, type ChatEvent } from './openclaw-client.js';
import type { OpenClawTransport } from './openclaw-transport.js';

/** Tagged user input for Promise.race() discriminated union. */
type TaggedUserInput = { source: 'user_input'; text: string };
type RaceResult = ChatEvent | TaggedUserInput;

/**
 * Interactive relay loop between an OpenClaw Gateway session and a
 * SubagentSession. Implements multi-turn communication where OpenClaw
 * can request user input via `needs_input` disposition.
 *
 * **Ownership:** This function ONLY returns `SubagentResult` or throws.
 * It does NOT call `session.complete()` or `session.cancel()` — terminal
 * state transitions are owned exclusively by `runSubagent()` (the caller).
 */
export async function runOpenClawInteractiveSession(
	client: OpenClawTransport,
	session: SubagentSession,
	sessionKey: string,
	task: string,
): Promise<SubagentResult> {
	let { runId } = await client.chatSend(sessionKey, task);
	let accumulatedText = '';

	// Create long-lived promises outside the loop. SubagentSession enforces
	// "one pending at a time" for nextUserInput(), so we create it once and
	// only recreate after it resolves. cancellation() is created once and
	// reused — it only ever rejects.
	let userInputPromise: Promise<TaggedUserInput> = session
		.nextUserInput()
		.then((text): TaggedUserInput => ({ source: 'user_input', text }));
	const cancelPromise: Promise<never> = session.cancellation();

	try {
		while (true) {
			const event: RaceResult = await Promise.race([
				client.nextChatEvent(runId),
				userInputPromise,
				cancelPromise,
			]);

			if (event.source === 'chat') {
				if (event.state === 'delta') {
					accumulatedText = mergeText(accumulatedText, event.text);
				} else if (event.state === 'final') {
					accumulatedText = mergeText(accumulatedText, event.text);

					if (event.finalDisposition === 'completed') {
						if (accumulatedText.trim().length === 0) {
							throw new FrameworkError('OpenClaw completed with empty response text', {
								component: 'openclaw-relay',
							});
						}
						return { text: accumulatedText, stepCount: 0 };
					}
					if (event.finalDisposition === 'needs_input') {
						session.sendToUser({
							type: 'question',
							text: accumulatedText,
							blocking: true,
						});
						// Loop continues — userInputPromise will resolve when user responds
					}
					if (event.finalDisposition === 'protocol_error') {
						throw new FrameworkError(
							'OpenClaw final event missing disposition metadata',
							{ component: 'openclaw-relay' },
						);
					}
				} else if (event.state === 'error' || event.state === 'aborted') {
					throw new FrameworkError(
						`OpenClaw run ${event.state}: ${event.error ?? 'unknown'}`,
						{ component: 'openclaw-relay' },
					);
				}
			}

			if (event.source === 'user_input') {
				// User responded — send as new turn to OpenClaw
				const result = await client.chatSend(sessionKey, event.text);
				runId = result.runId;
				accumulatedText = '';

				// Create a fresh nextUserInput() promise for the next iteration
				userInputPromise = session
					.nextUserInput()
					.then((text): TaggedUserInput => ({ source: 'user_input', text }));
			}
		}
	} catch (err) {
		if (err instanceof CancelledError) {
			await client.chatAbort(runId).catch(() => {});
		}
		throw err;
	}
}
