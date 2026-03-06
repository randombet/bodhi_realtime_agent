// SPDX-License-Identifier: MIT

/** Parameters for saving an artifact produced by an agent or tool. */
export interface SaveArtifactParams {
	/** Session that produced the artifact (injected by session.workspace when omitted). */
	sessionId?: string;
	/** User context (injected by session.workspace when omitted). */
	userId?: string;
	/** Name of the agent that produced the artifact. */
	agentName?: string;
	/** Tool call that produced the artifact (for correlation). */
	toolCallId?: string;
	/** MIME type (e.g. image/png, application/pdf). */
	mimeType: string;
	/** Raw bytes. */
	content: Buffer | Uint8Array;
	/** Optional metadata (filename, dimensions, etc.). */
	metadata?: Record<string, unknown>;
}

/** Reference returned after saving an artifact; may include a URL for serving. */
export interface ArtifactRef {
	/** Opaque identifier (store- or app-generated). */
	id: string;
	/** Session that owns the artifact. */
	sessionId: string;
	/** Optional URL for direct access (if the store provides one). */
	url?: string;
	/** MIME type. */
	mimeType: string;
	/** Optional metadata. */
	metadata?: Record<string, unknown>;
}

/**
 * Persistence interface for artifacts produced by agents/subagents (images, videos, docs, etc.).
 * Implementations are provided by the app (e.g. S3, GCS, local FS); framework only calls this interface.
 */
export interface ArtifactStore {
	/** Persist an artifact; returns a reference (id, optional url). */
	saveArtifact(params: SaveArtifactParams): Promise<ArtifactRef>;
}
