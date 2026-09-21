import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ArtifactSource = 'generated' | 'uploaded' | 'received';

export interface Artifact {
	id: string;
	base64: string;
	mimeType: string;
	description: string;
	fileName?: string;
	source: ArtifactSource;
	createdAt: number;
	sizeBytes: number;
}

export interface ArtifactSummary {
	id: string;
	description: string;
	mimeType: string;
	source: ArtifactSource;
	fileName?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const DEFAULT_MAX_COUNT = 20;
const DEFAULT_MAX_BUDGET_BYTES = 50 * 1024 * 1024; // 50 MB decoded
const DEFAULT_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024; // 5 MB decoded
const DEFAULT_TTL_MS = Number.POSITIVE_INFINITY; // Session lifetime by default

// ---------------------------------------------------------------------------
// ArtifactRegistry
// ---------------------------------------------------------------------------

export interface ArtifactRegistryOptions {
	maxCount?: number;
	maxBudgetBytes?: number;
	maxArtifactBytes?: number;
	ttlMs?: number;
	/** Override for testing — returns current time in ms. */
	now?: () => number;
}

/**
 * Per-session in-memory store for binary artifacts (images, documents).
 *
 * Supports FIFO eviction, memory budget, per-artifact size limits,
 * MIME whitelist, and TTL-based expiry.
 */
export class ArtifactRegistry {
	private artifacts = new Map<string, Artifact>();
	private insertionOrder: string[] = [];
	private totalBytes = 0;
	private readonly maxCount: number;
	private readonly maxBudgetBytes: number;
	private readonly maxArtifactBytes: number;
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(options?: ArtifactRegistryOptions) {
		this.maxCount = options?.maxCount ?? DEFAULT_MAX_COUNT;
		this.maxBudgetBytes = options?.maxBudgetBytes ?? DEFAULT_MAX_BUDGET_BYTES;
		this.maxArtifactBytes = options?.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
		this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
		this.now = options?.now ?? (() => Date.now());
	}

	/**
	 * Store a binary artifact. Returns its ID.
	 * @throws Error if MIME type is not allowed or artifact exceeds size limit.
	 */
	store(
		base64: string,
		mimeType: string,
		description: string,
		source: ArtifactSource = 'generated',
		fileName?: string,
	): string {
		if (!ALLOWED_MIME_TYPES.has(mimeType)) {
			const allowed = [...ALLOWED_MIME_TYPES].join(', ');
			throw new Error(`Unsupported MIME type "${mimeType}". Supported: ${allowed}.`);
		}

		const sizeBytes = Math.ceil((base64.length * 3) / 4);
		if (sizeBytes > this.maxArtifactBytes) {
			const limitMB = (this.maxArtifactBytes / (1024 * 1024)).toFixed(0);
			throw new Error(
				`Artifact exceeds ${limitMB} MB limit (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB).`,
			);
		}

		// Evict until we have room
		while (
			this.insertionOrder.length >= this.maxCount ||
			this.totalBytes + sizeBytes > this.maxBudgetBytes
		) {
			if (this.insertionOrder.length === 0) break;
			this.evictOldest();
		}

		const id = `art_${this.now()}_${randomBytes(3).toString('hex')}`;
		const artifact: Artifact = {
			id,
			base64,
			mimeType,
			description,
			fileName,
			source,
			createdAt: this.now(),
			sizeBytes,
		};

		this.artifacts.set(id, artifact);
		this.insertionOrder.push(id);
		this.totalBytes += sizeBytes;

		return id;
	}

	/** Retrieve an artifact by ID. Returns undefined if not found or expired. */
	get(id: string): Artifact | undefined {
		const artifact = this.artifacts.get(id);
		if (!artifact) return undefined;

		if (this.isExpired(artifact)) {
			this.remove(id);
			return undefined;
		}

		return artifact;
	}

	/** List all non-expired artifacts (summaries only, no base64). */
	list(): ArtifactSummary[] {
		this.cleanup();
		const summaries: ArtifactSummary[] = [];
		for (const artifact of this.artifacts.values()) {
			summaries.push({
				id: artifact.id,
				description: artifact.description,
				mimeType: artifact.mimeType,
				source: artifact.source,
				fileName: artifact.fileName,
			});
		}
		return summaries;
	}

	/** Remove expired artifacts. */
	cleanup(): void {
		for (const id of [...this.insertionOrder]) {
			const artifact = this.artifacts.get(id);
			if (artifact && this.isExpired(artifact)) {
				this.remove(id);
			}
		}
	}

	/** Clear all artifacts and reset budget. */
	dispose(): void {
		this.artifacts.clear();
		this.insertionOrder = [];
		this.totalBytes = 0;
	}

	/** Number of stored artifacts. */
	get size(): number {
		return this.artifacts.size;
	}

	/** Total decoded bytes used. */
	get usedBytes(): number {
		return this.totalBytes;
	}

	// -- Private -------------------------------------------------------------

	private isExpired(artifact: Artifact): boolean {
		if (this.ttlMs === Number.POSITIVE_INFINITY) return false;
		return this.now() - artifact.createdAt > this.ttlMs;
	}

	private evictOldest(): void {
		const oldestId = this.insertionOrder[0];
		if (oldestId) {
			this.remove(oldestId);
		}
	}

	private remove(id: string): void {
		const artifact = this.artifacts.get(id);
		if (!artifact) return;

		this.totalBytes -= artifact.sizeBytes;
		this.artifacts.delete(id);
		this.insertionOrder = this.insertionOrder.filter((i) => i !== id);
	}
}
