// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { PersistentSubagentInstance } from '../../src/agent/persistent-subagent-types.js';
import type { ArtifactRegistry } from '../../app/lib/media/artifact-registry.js';
import {
	type AdapterLimits,
	resolveArtifacts,
	resolveRequestedArtifactIds,
} from './artifact-resolution.js';
import type { ChatSendOptions, ContentBlock } from './openclaw-client.js';
import { mergeText } from './openclaw-client.js';
import type { OpenClawTransport } from '../../app/lib/integrations/openclaw/openclaw-transport.js';

/**
 * A persistent OpenClaw subagent instance.
 *
 * Retains the OpenClaw session key across multiple invocations.
 * The gateway maintains conversation context server-side per session key,
 * so each invoke() sends a new message to the same persistent session.
 *
 * Error contract: invoke() throws on artifact resolution failures
 * (PersistentSubagentInstance returns Promise<string>, not structured errors).
 * The error content matches the relay path's structured errors for consistency.
 */
export class PersistentOpenClawSubagent implements PersistentSubagentInstance {
	readonly key: string;
	private disposed = false;
	private activeRunId: string | null = null;
	private static readonly MAX_INBOUND_BLOCK_BYTES = 10 * 1024 * 1024;

	constructor(
		key: string,
		private readonly client: OpenClawTransport,
		private readonly sessionKey: string,
		private readonly artifactRegistry?: ArtifactRegistry,
		private readonly adapterLimits?: AdapterLimits,
		private readonly eventBus?: { publish(event: string, payload: unknown): void },
		private readonly sessionId?: string,
	) {
		this.key = key;
	}

	async invoke(
		taskDescription: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<string> {
		if (this.disposed) {
			throw new Error(`PersistentOpenClawSubagent "${this.key}" is disposed`);
		}

		const message = args.task ? String(args.task) : taskDescription;
		console.log(
			`[OpenClaw] Sending message (sessionKey=${this.sessionKey}, key=${this.key}): ${message.slice(0, 200)}`,
		);

		// Resolve artifact attachments (explicit IDs first, then deterministic fallback)
		let sendOptions: ChatSendOptions | undefined;
		const requestedArtifactIds = resolveRequestedArtifactIds(
			message,
			args.artifactIds as string[] | undefined,
			this.artifactRegistry,
		);
		if (requestedArtifactIds.length > 0) {
			console.log(
				`[OpenClaw] Attachment candidates resolved (persistent): count=${requestedArtifactIds.length} ids=${requestedArtifactIds.join(',')}`,
			);
		}
		if (requestedArtifactIds.length > 0) {
			// resolveArtifacts throws on failure — propagated as invoke() rejection
			const resolved = resolveArtifacts(
				requestedArtifactIds,
				this.artifactRegistry,
				this.adapterLimits,
			);
			if (resolved.warning) {
				console.warn(`[OpenClaw] ${resolved.warning}`);
			}
			if (resolved.attachments.length > 0) {
				sendOptions = { attachments: resolved.attachments };
				const attachmentSummary = resolved.attachments
					.map((attachment) => `${attachment.mimeType}:${attachment.fileName ?? 'unnamed'}`)
					.join(', ');
				console.log(
					`[OpenClaw] Prepared attachments (persistent): count=${resolved.attachments.length} [${attachmentSummary}]`,
				);
			}
		}

		// Keep a stable idempotency key across retries so side-effecting requests
		// (e.g., send email) are de-duplicated by the gateway.
		const retrySafeSendOptions: ChatSendOptions = {
			...sendOptions,
			idempotencyKey: sendOptions?.idempotencyKey ?? randomUUID(),
		};

		const maxAttempts = 2;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			let runId: string;
			const attachmentCount = retrySafeSendOptions.attachments?.length ?? 0;
			console.log(
				`[OpenClaw] Dispatching chatSend (persistent): sessionKey=${this.sessionKey} attachments=${attachmentCount}`,
			);
			try {
				const result = await this.client.chatSend(
					this.sessionKey,
					message,
					retrySafeSendOptions,
				);
				runId = result.runId;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[OpenClaw] chatSend failed (persistent): ${msg}`);
				throw new Error(`OpenClaw chatSend failed: ${msg}`);
			}
			this.activeRunId = runId;
			console.log(`[OpenClaw] Run started: ${runId}`);

			// Wire abort signal to cancel the run
			const onAbort = () => {
				this.client.chatAbort(runId).catch(() => {});
			};
			signal?.addEventListener('abort', onAbort);

			let shouldRetry = false;
			try {
				let text = '';
				const receivedBlocks: ContentBlock[] = [];
				const seenBlockHashes = new Set<string>();

				while (true) {
					const event = await this.client.nextChatEvent(runId);

					if (event.state === 'delta') {
						text = mergeText(text, event.text);
						this.collectBlocks(event.contentBlocks, receivedBlocks, seenBlockHashes);
					} else if (event.state === 'final') {
						text = mergeText(text, event.text);
						this.collectBlocks(event.contentBlocks, receivedBlocks, seenBlockHashes);
						const status = event.finalDisposition ?? 'completed';
						console.log(
							`[OpenClaw] Run ${runId} completed (${status}): ${text.slice(0, 200)}`,
						);

						const hasText = text.trim().length > 0;
						const hasBlocks = receivedBlocks.length > 0;
						if (!hasText && !hasBlocks) {
							if (attempt < maxAttempts) {
								console.warn(
									`[OpenClaw] Run ${runId} completed with empty response text (attempt ${attempt}/${maxAttempts}), retrying once`,
								);
								shouldRetry = true;
								break;
							}
							throw new Error('OpenClaw completed with empty response text');
						}

						// Surface received content blocks to user (side-effect)
						this.surfaceBlocks(receivedBlocks);

						if (hasText) {
							return text;
						}
						return `OpenClaw returned ${receivedBlocks.length} attachment(s).`;
					} else if (event.state === 'error' || event.state === 'aborted') {
						console.log(`[OpenClaw] Run ${runId} ${event.state}: ${event.error}`);
						throw new Error(event.error ?? `OpenClaw run ${event.state}`);
					}
				}
			} finally {
				signal?.removeEventListener('abort', onAbort);
				this.activeRunId = null;
			}

			if (shouldRetry) {
				continue;
			}
		}

		throw new Error('OpenClaw completed with empty response text');
	}

	/** Collect non-text content blocks from event with dedup across delta/final frames. */
	private collectBlocks(
		blocks: ContentBlock[] | undefined,
		target: ContentBlock[],
		seen: Set<string>,
	): void {
		for (const block of blocks ?? []) {
			if (!block.base64 || (block.type !== 'image' && block.type !== 'document')) continue;

			const estimatedBytes = Math.ceil((block.base64.length * 3) / 4);
			if (estimatedBytes > PersistentOpenClawSubagent.MAX_INBOUND_BLOCK_BYTES) {
				console.warn(
					`[OpenClaw] Received content block ~${(estimatedBytes / 1_000_000).toFixed(1)} MB, exceeds 10 MB limit, skipping`,
				);
				continue;
			}

			if (
				block.type === 'image' &&
				typeof block.mimeType === 'string' &&
				!block.mimeType.startsWith('image/')
			) {
				console.warn(`[OpenClaw] Image block has non-image MIME type: ${block.mimeType}, skipping`);
				continue;
			}

			const hash = `${block.type}:${block.mimeType}:${block.base64.length}:${block.base64.slice(0, 64)}:${block.base64.slice(-64)}`;
			if (seen.has(hash)) continue;
			seen.add(hash);
			target.push(block);
		}
	}

	/** Surface content blocks: store in registry + publish gui.update. */
	private surfaceBlocks(blocks: ContentBlock[]): void {
		for (const block of blocks) {
			if (!block.base64) continue;

			let artifactId: string | undefined;
			if (this.artifactRegistry) {
				try {
					artifactId = this.artifactRegistry.store(
						block.base64,
						block.mimeType ?? 'application/octet-stream',
						`openclaw_${block.type}_${Date.now()}`,
						'received',
						block.fileName,
					);
				} catch (err) {
					console.warn(
						`[OpenClaw] Failed to store received ${block.type}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			if (this.eventBus && this.sessionId) {
				this.eventBus.publish('gui.update', {
					sessionId: this.sessionId,
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
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;

		// Cancel any active run
		if (this.activeRunId) {
			await this.client.chatAbort(this.activeRunId).catch(() => {});
			this.activeRunId = null;
		}
	}
}
