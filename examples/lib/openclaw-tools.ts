// SPDX-License-Identifier: MIT

import { tool } from 'ai';
import { z } from 'zod';
import type { SubagentConfig } from '../../src/types/agent.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import type { ArtifactRegistry } from '../../app/lib/media/artifact-registry.js';
import {
	type AdapterLimits,
	ArtifactResolutionError,
	resolveArtifacts,
	resolveRequestedArtifactIds,
} from './artifact-resolution.js';
import { type ContentBlock, mergeText } from './openclaw-client.js';
import type { OpenClawTransport } from '../../app/lib/integrations/openclaw/openclaw-transport.js';
import { PersistentOpenClawSubagent } from './persistent-openclaw-subagent.js';

// ---------------------------------------------------------------------------
// OpenClaw subagent options — injected dependencies for file transfer
// ---------------------------------------------------------------------------

export interface OpenClawSubagentOptions {
	artifactRegistry?: ArtifactRegistry;
	adapterLimits?: AdapterLimits;
	/** EventBus for publishing gui.update events (download path). */
	eventBus?: { publish(event: string, payload: unknown): void };
	/** Session ID for EventBus payloads. Required when eventBus is provided. */
	sessionId?: string;
}

/**
 * Framework ToolDefinition for the main voice agent (declared to Gemini/OpenAI).
 * execution: 'background' — routes to AgentRouter.handoff() when a matching SubagentConfig exists.
 * The execute body is NOT called by the framework; it's a placeholder for the tool router.
 */
export const askOpenClawTool: ToolDefinition = {
	name: 'ask_openclaw',
	description:
		'Delegate a task to the OpenClaw AI agent. ' +
		'ALWAYS use this for any email request (send/draft/reply/forward/rewrite). ' +
		'The agent is general-purpose and can handle coding, research, web browsing, ' +
		'writing, sending emails, and much more. Route any user request here.',
	parameters: z.object({
		task: z.string().describe('The task to delegate to OpenClaw'),
		artifactIds: z
			.array(z.string())
			.optional()
			.describe('IDs of artifacts (images, files) to attach to the task'),
	}),
	execution: 'background',
	pendingMessage: "I'm sending that to my agent now. I'll let you know what it finds.",
	execute: async () => {
		// Placeholder — execution is routed by the orchestration runtime.
		return { text: 'Routed to subagent', stepCount: 0 };
	},
};

/**
 * Work-focused OpenClaw tool — handles email, calendar, Xiaohongshu/XHS,
 * and other productivity/work tasks in its own persistent session.
 */
export const askWorkAgentTool: ToolDefinition = {
	name: 'ask_work_agent',
	description:
		'Delegate a WORK task to the work agent. ' +
		'Use this for: email (send/draft/reply/forward), calendar, scheduling, ' +
		'Xiaohongshu/XHS (小红书) posts, social media, document writing, ' +
		'spreadsheets, and any productivity or business task. ' +
		'This agent remembers past work conversations within the session.',
	parameters: z.object({
		task: z.string().describe('The work task to delegate'),
		artifactIds: z
			.array(z.string())
			.optional()
			.describe('IDs of artifacts (images, files) to attach to the task'),
	}),
	execution: 'background',
	pendingMessage: "I'm sending that to my work agent. I'll update you shortly.",
	execute: async () => {
		return { text: 'Routed to work agent', stepCount: 0 };
	},
};

/**
 * General-purpose OpenClaw tool — handles coding, research, web browsing,
 * and other complex tasks in its own persistent session.
 */
export const askGeneralAgentTool: ToolDefinition = {
	name: 'ask_general_agent',
	description:
		'Delegate a COMPLEX task to the general agent. ' +
		'Use this for: coding, debugging, research, web browsing, data analysis, ' +
		'file operations, multi-step investigations, and any technical or exploratory task. ' +
		'This agent remembers past conversations within the session.',
	parameters: z.object({
		task: z.string().describe('The task to delegate'),
		artifactIds: z
			.array(z.string())
			.optional()
			.describe('IDs of artifacts (images, files) to attach to the task'),
	}),
	execution: 'background',
	pendingMessage: "I'm sending that to my agent. I'll let you know what it finds.",
	execute: async () => {
		return { text: 'Routed to general agent', stepCount: 0 };
	},
};

/**
 * Create a persistent-session OpenClaw subagent config for actor-runtime execution.
 *
 * This path bypasses legacy relay-subagent prompting and invokes OpenClaw directly
 * through PersistentSubagentManager + PersistentOpenClawSubagent.
 */
export function createPersistentOpenClawSubagentConfig(
	client: OpenClawTransport,
	sessionId: string,
	options?: OpenClawSubagentOptions,
): SubagentConfig {
	const sessionKey = client.sessionKey(sessionId);

	return {
		name: 'openclaw-persistent',
		instructions: 'Runtime-managed persistent OpenClaw execution.',
		tools: {},
		lifetime: 'persistent_session',
		persistentFactory: async (key) =>
			new PersistentOpenClawSubagent(
				key,
				client,
				sessionKey,
				options?.artifactRegistry,
				options?.adapterLimits,
				options?.eventBus,
				options?.sessionId,
			),
	};
}

/**
 * Create the OpenClaw SubagentConfig for interactive subagent delegation.
 *
 * The subagent is given an `openclaw_chat` AI SDK tool that sends messages to
 * the OpenClaw gateway and collects the streaming response. When OpenClaw
 * returns `needs_input`, the subagent LLM uses the injected `ask_user` tool
 * (provided by runSubagent when interactive=true) to relay the question to the
 * user via voice, then calls `openclaw_chat` again with the answer.
 */
export function createOpenClawSubagentConfig(
	client: OpenClawTransport,
	sessionId: string,
	options?: OpenClawSubagentOptions,
): SubagentConfig {
	const sessionKey = client.sessionKey(sessionId);

	return {
		name: 'openclaw',
		interactive: true,
		instructions: [
			'You are a relay agent between the user and the OpenClaw AI agent.',
			'OpenClaw is a general-purpose agent — it can handle coding, research,',
			'web browsing, writing, emails, and much more.',
			'',
			'WORKFLOW:',
			'1. Call openclaw_chat with the task from the user.',
			'2. If the result has status "needs_input", OpenClaw is asking a clarifying question.',
			'   - Also treat question-like responses as clarification requests, even when status is "completed".',
			'   - The "text" field contains OpenClaw\'s response including the question.',
			'   - Use ask_user to relay the question to the user via voice.',
			"   - When phrasing the question for ask_user, be concise — extract the key question from OpenClaw's response.",
			"   - Call openclaw_chat with the user's answer to continue.",
			'3. If the result has status "completed", OpenClaw has finished the task.',
			'   - Return a brief voice-friendly summary of what was done.',
			'   - Do NOT read out code verbatim — summarize the outcome.',
			'4. If the result has an error, tell the user what went wrong briefly.',
			'',
			'IMPORTANT:',
			"- Always relay OpenClaw's questions to the user — never answer on their behalf.",
			'- Keep your voice summaries short (2-3 sentences max).',
			'- The user is listening via audio — no markdown, no code blocks in your final answer.',
		].join('\n'),
		tools: {
			openclaw_chat: createOpenClawChatTool(client, sessionKey, options),
		},
		maxSteps: 12, // Allow for multi-turn: chat → ask_user → chat → ask_user → ...
		timeout: 300_000, // 5 min for complex coding tasks
	};
}

/**
 * AI SDK tool that sends a message to the OpenClaw gateway and collects the
 * full streaming response. Returns the accumulated text and final disposition.
 */
function createOpenClawChatTool(
	client: OpenClawTransport,
	sessionKey: string,
	options?: OpenClawSubagentOptions,
) {
	const maxAttempts = 2;

	function looksLikeClarifyingQuestion(text: string): boolean {
		const normalized = text.trim().toLowerCase();
		if (normalized.length === 0) return false;

		const hasQuestionMark = normalized.includes('?');
		const asksForInfo =
			/\b(what|which|who|when|where|could you|can you|would you|please provide|please share|please confirm|confirm|to:|subject|email|path|file)\b/.test(
				normalized,
			);
		const hasQuestionCue =
			/\b(i need|i have|a couple of questions|before i|to proceed|could you clarify|please clarify)\b/.test(
				normalized,
			);

		return (hasQuestionMark && asksForInfo) || hasQuestionCue;
	}

	return tool({
		description:
			'Send a message to the OpenClaw AI agent and get the response. ' +
			'Returns { status, text } where status is "completed", "needs_input", or "error".',
		parameters: z.object({
			message: z.string().describe('The message to send to OpenClaw'),
			artifactIds: z
				.array(z.string())
				.optional()
				.describe('IDs of artifacts (images, files) to attach to the message'),
		}),
		execute: async ({ message, artifactIds }) => {
			try {
				// Resolve artifacts to attachments (if any)
				let sendOptions:
					| {
							attachments?: {
								type: 'image';
								mimeType: string;
								fileName?: string;
								content: string;
							}[];
					  }
					| undefined;
				let attachmentWarning: string | undefined;

				const requestedArtifactIds = resolveRequestedArtifactIds(
					message,
					artifactIds,
					options?.artifactRegistry,
				);
				if (requestedArtifactIds.length > 0) {
					console.log(
						`[OpenClaw] Attachment candidates resolved: count=${requestedArtifactIds.length} ids=${requestedArtifactIds.join(',')}`,
					);
				}

				if (requestedArtifactIds.length > 0) {
					try {
						const resolved = resolveArtifacts(
							requestedArtifactIds,
							options?.artifactRegistry,
							options?.adapterLimits,
						);
						if (resolved.attachments.length > 0) {
							sendOptions = { attachments: resolved.attachments };
							const attachmentSummary = resolved.attachments
								.map((attachment) => `${attachment.mimeType}:${attachment.fileName ?? 'unnamed'}`)
								.join(', ');
							console.log(
								`[OpenClaw] Prepared attachments: count=${resolved.attachments.length} [${attachmentSummary}]`,
							);
						}
						attachmentWarning = resolved.warning;
					} catch (err) {
						if (err instanceof ArtifactResolutionError) {
							return { status: 'error', error: err.message };
						}
						throw err;
					}
				}

				for (let attempt = 1; attempt <= maxAttempts; attempt++) {
					const attachmentCount = sendOptions?.attachments?.length ?? 0;
					console.log(
						`[OpenClaw] Sending message (sessionKey=${sessionKey}, attempt=${attempt}/${maxAttempts}, attachments=${attachmentCount}): ${message.slice(0, 200)}`,
					);
					const { runId } = await client.chatSend(sessionKey, message, sendOptions);
					console.log(`[OpenClaw] Run started: ${runId}`);
					let text = '';
					const receivedBlocks: ContentBlock[] = [];
					const seenBlockHashes = new Set<string>();

					while (true) {
						const event = await client.nextChatEvent(runId);

						if (event.state === 'delta') {
							text = mergeText(text, event.text);
							collectContentBlocks(event.contentBlocks, receivedBlocks, seenBlockHashes);
						} else if (event.state === 'final') {
							text = mergeText(text, event.text);
							collectContentBlocks(event.contentBlocks, receivedBlocks, seenBlockHashes);
							const status = event.finalDisposition ?? 'completed';
							console.log(`[OpenClaw] Run ${runId} completed (${status}): ${text.slice(0, 200)}`);

							if (status === 'completed' && text.trim().length === 0) {
								if (attempt < maxAttempts) {
									console.warn(
										`[OpenClaw] Run ${runId} completed with empty text (attempt ${attempt}/${maxAttempts}), retrying once`,
									);
									break;
								}
								return {
									status: 'error',
									error: 'OpenClaw completed with empty response text',
								};
							}

							// Surface received content blocks to user
							const receivedArtifactIds = surfaceContentBlocks(receivedBlocks, options);

							if (status === 'completed' && looksLikeClarifyingQuestion(text)) {
								const result: Record<string, unknown> = { status: 'needs_input', text };
								if (attachmentWarning) result.attachmentWarning = attachmentWarning;
								if (receivedArtifactIds.length > 0) result.artifactIds = receivedArtifactIds;
								return result;
							}

							const result: Record<string, unknown> = { status, text };
							if (attachmentWarning) result.attachmentWarning = attachmentWarning;
							if (receivedArtifactIds.length > 0) result.artifactIds = receivedArtifactIds;
							return result;
						} else if (event.state === 'error' || event.state === 'aborted') {
							console.log(`[OpenClaw] Run ${runId} ${event.state}: ${event.error}`);
							const errorText = event.error ?? `OpenClaw run ${event.state}`;
							// Surface attachment-specific gateway errors with context
							if (sendOptions?.attachments && /attachment|mime|unsupported/i.test(errorText)) {
								return {
									status: 'error',
									error: `Attachment rejected by agent gateway: ${errorText}`,
								};
							}
							return { status: 'error', error: errorText };
						}
					}
				}

				return {
					status: 'error',
					error: 'OpenClaw completed with empty response text',
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[OpenClaw] Error sending message: ${msg}`);
				return { status: 'error', error: msg };
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Content block collection helpers (download path)
// ---------------------------------------------------------------------------

const MAX_INBOUND_BLOCK_BYTES = 10 * 1024 * 1024; // 10 MB

/** Collect non-text content blocks with dedup and size validation. */
function collectContentBlocks(
	blocks: ContentBlock[] | undefined,
	target: ContentBlock[],
	seen: Set<string>,
): void {
	for (const block of blocks ?? []) {
		if (!block.base64) continue;

		// Size validation
		const estimatedBytes = Math.ceil((block.base64.length * 3) / 4);
		if (estimatedBytes > MAX_INBOUND_BLOCK_BYTES) {
			console.warn(
				`[OpenClaw] Received content block ~${(estimatedBytes / 1_000_000).toFixed(1)} MB, exceeds 10 MB limit, skipping`,
			);
			continue;
		}

		// MIME type validation
		if (
			block.type === 'image' &&
			typeof block.mimeType === 'string' &&
			!block.mimeType.startsWith('image/')
		) {
			console.warn(`[OpenClaw] Image block has non-image MIME type: ${block.mimeType}, skipping`);
			continue;
		}

		// Dedup by hash: type + mimeType + length + first/last 64 chars
		const hash = `${block.type}:${block.mimeType}:${block.base64.length}:${block.base64.slice(0, 64)}:${block.base64.slice(-64)}`;
		if (seen.has(hash)) continue;
		seen.add(hash);

		target.push(block);
	}
}

/** Surface received content blocks: store in registry + publish gui.update. Returns stored artifactIds. */
function surfaceContentBlocks(blocks: ContentBlock[], options?: OpenClawSubagentOptions): string[] {
	const artifactIds: string[] = [];

	for (const block of blocks) {
		if (!block.base64 || (block.type !== 'image' && block.type !== 'document')) continue;

		// Store in registry if available
		let artifactId: string | undefined;
		if (options?.artifactRegistry) {
			try {
				artifactId = options.artifactRegistry.store(
					block.base64,
					block.mimeType ?? 'application/octet-stream',
					`openclaw_${block.type}_${Date.now()}`,
					'received',
					block.fileName,
				);
				artifactIds.push(artifactId);
			} catch (err) {
				console.warn(
					`[OpenClaw] Failed to store received ${block.type}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// Publish to client via EventBus
		if (options?.eventBus && options.sessionId) {
			options.eventBus.publish('gui.update', {
				sessionId: options.sessionId,
				data: {
					type: block.type,
					base64: block.base64,
					mimeType: block.mimeType,
					fileName: block.fileName,
					artifactId,
					source: 'openclaw',
				},
			});
		}
	}

	return artifactIds;
}
