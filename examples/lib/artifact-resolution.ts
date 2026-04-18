// SPDX-License-Identifier: MIT

/**
 * Shared artifact resolution logic for OpenClaw tool and persistent subagent paths.
 *
 * Resolves artifact IDs to ChatAttachments, enforcing size/count limits.
 * Both the relay (openclaw_chat tool) and persistent (PersistentOpenClawSubagent)
 * paths use this same logic — the difference is only in error transport:
 * relay returns structured { status: 'error' }, persistent throws.
 */

import type { ArtifactRegistry } from '../../app/lib/media/artifact-registry.js';
import type { ChatAttachment } from './openclaw-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdapterLimits {
	maxAttachments?: number;
	maxAggregateBytes?: number;
}

export interface ResolvedAttachments {
	attachments: ChatAttachment[];
	warning?: string;
}

// ---------------------------------------------------------------------------
// Intent-aware fallback
// ---------------------------------------------------------------------------

const IMAGE_REFERENCE_RE =
	/\b(image|picture|photo|screenshot|graphic|chart|diagram|snapshot)\b/i;
const SEND_INTENT_RE = /\b(email|send|forward|attach|share)\b/i;

/**
 * Determine which artifact IDs to resolve.
 *
 * Priority:
 * 1. Explicit artifactIds from tool args.
 * 2. Deterministic fallback for image-send intents:
 *    if the message clearly references sending an image and no explicit IDs were
 *    provided, use the most recent image artifact in the registry.
 */
export function resolveRequestedArtifactIds(
	message: string,
	artifactIds: string[] | undefined,
	registry: ArtifactRegistry | undefined,
): string[] {
	if (artifactIds?.length) return artifactIds;
	if (!registry) return [];

	const isImageSendIntent = IMAGE_REFERENCE_RE.test(message) && SEND_INTENT_RE.test(message);
	if (!isImageSendIntent) return [];

	const artifacts = registry
		.list()
		.filter((artifact) => artifact.mimeType.startsWith('image/'));
	if (artifacts.length === 0) return [];

	const latest = artifacts[artifacts.length - 1];
	console.warn(
		`[ArtifactResolution] No artifactIds provided; auto-attaching latest image artifact ${latest.id}`,
	);
	return [latest.id];
}

// ---------------------------------------------------------------------------
// Constants (framework defaults)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ATTACHMENTS = 5;
const DEFAULT_MAX_AGGREGATE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024; // 5 MB per artifact (gateway limit)

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve artifact IDs to ChatAttachments.
 *
 * @throws Error if artifactIds is non-empty but no registry is configured,
 *         or if ALL requested artifacts are missing/oversized.
 */
export function resolveArtifacts(
	artifactIds: string[],
	registry: ArtifactRegistry | undefined,
	adapterLimits?: AdapterLimits,
): ResolvedAttachments {
	if (artifactIds.length === 0) {
		return { attachments: [] };
	}

	if (!registry) {
		throw new ArtifactResolutionError(
			'File attachments not configured for this session.',
		);
	}

	const maxAttachments = Math.min(
		DEFAULT_MAX_ATTACHMENTS,
		adapterLimits?.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS,
	);
	const maxAggregateBytes = Math.min(
		DEFAULT_MAX_AGGREGATE_BYTES,
		adapterLimits?.maxAggregateBytes ?? DEFAULT_MAX_AGGREGATE_BYTES,
	);

	const attachments: ChatAttachment[] = [];
	const missingIds: string[] = [];
	const oversizedIds: string[] = [];
	let aggregateBytes = 0;

	for (const id of artifactIds) {
		if (attachments.length >= maxAttachments) {
			console.warn(
				`[ArtifactResolution] Reached ${maxAttachments} attachment limit, skipping remaining`,
			);
			break;
		}

		const artifact = registry.get(id);
		if (!artifact) {
			missingIds.push(id);
			continue;
		}

		if (artifact.sizeBytes > MAX_ARTIFACT_BYTES) {
			console.warn(
				`[ArtifactResolution] Artifact ${id} exceeds 5 MB gateway limit, skipping`,
			);
			oversizedIds.push(id);
			continue;
		}

		if (aggregateBytes + artifact.sizeBytes > maxAggregateBytes) {
			console.warn(
				`[ArtifactResolution] Aggregate size would exceed ${(maxAggregateBytes / 1_000_000).toFixed(0)} MB, skipping ${id}`,
			);
			oversizedIds.push(id);
			continue;
		}

		aggregateBytes += artifact.sizeBytes;
		const ext = artifact.mimeType.split('/')[1] ?? 'bin';
		attachments.push({
			type: 'image', // Gateway only supports 'image' type
			mimeType: artifact.mimeType,
			fileName: artifact.fileName ?? `artifact.${ext}`,
			content: artifact.base64,
		});
	}

	// Fail-fast if NONE of the requested artifacts could be resolved
	if (attachments.length === 0) {
		const reasons: string[] = [];
		if (missingIds.length > 0) reasons.push(`expired/missing: ${missingIds.join(', ')}`);
		if (oversizedIds.length > 0) reasons.push(`too large (>5 MB): ${oversizedIds.join(', ')}`);
		throw new ArtifactResolutionError(
			`Could not attach any of the requested file(s). ${reasons.join('; ')}. Please re-upload or regenerate and try again.`,
		);
	}

	// Build warning for partial drops
	let warning: string | undefined;
	if (missingIds.length > 0 || oversizedIds.length > 0) {
		const parts: string[] = [];
		if (missingIds.length > 0) parts.push(`${missingIds.length} file(s) expired/missing`);
		if (oversizedIds.length > 0) parts.push(`${oversizedIds.length} file(s) too large`);
		warning = `Note: ${parts.join(', ')}. Proceeding with ${attachments.length} attachment(s).`;
		console.warn(`[ArtifactResolution] ${warning}`);
	}

	return { attachments, warning };
}

/** Typed error for artifact resolution failures. */
export class ArtifactResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ArtifactResolutionError';
	}
}
