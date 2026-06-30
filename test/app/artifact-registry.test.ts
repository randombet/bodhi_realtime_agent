import { describe, expect, it } from 'vitest';
import { ArtifactRegistry } from '../../app/lib/media/artifact-registry.js';

// Small valid PNG base64 (1x1 pixel) — ~70 bytes decoded
const TINY_PNG_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function makeBase64(sizeBytes: number): string {
	// base64 is ~4/3x the decoded size
	return 'A'.repeat(Math.ceil(sizeBytes * (4 / 3)));
}

describe('ArtifactRegistry', () => {
	it('store/get/list round-trip', () => {
		const reg = new ArtifactRegistry();
		const id = reg.store(TINY_PNG_B64, 'image/png', 'test image', 'generated', 'test.png');

		expect(id).toMatch(/^art_\d+_[0-9a-f]{6}$/);

		const artifact = reg.get(id);
		expect(artifact).toBeDefined();
		expect(artifact?.base64).toBe(TINY_PNG_B64);
		expect(artifact?.mimeType).toBe('image/png');
		expect(artifact?.description).toBe('test image');
		expect(artifact?.source).toBe('generated');
		expect(artifact?.fileName).toBe('test.png');
		expect(artifact?.sizeBytes).toBeGreaterThan(0);

		const list = reg.list();
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe(id);
		expect(list[0].description).toBe('test image');
		expect(list[0].mimeType).toBe('image/png');
		expect(list[0].source).toBe('generated');
		expect(list[0].fileName).toBe('test.png');
		// list() should NOT contain base64
		expect((list[0] as Record<string, unknown>).base64).toBeUndefined();
	});

	it('FIFO eviction at count limit', () => {
		const reg = new ArtifactRegistry({ maxCount: 3 });
		const ids: string[] = [];
		for (let i = 0; i < 4; i++) {
			ids.push(reg.store(TINY_PNG_B64, 'image/png', `img${i}`));
		}

		// First should have been evicted
		expect(reg.get(ids[0])).toBeUndefined();
		expect(reg.get(ids[1])).toBeDefined();
		expect(reg.get(ids[2])).toBeDefined();
		expect(reg.get(ids[3])).toBeDefined();
		expect(reg.size).toBe(3);
	});

	it('memory budget eviction', () => {
		// Each artifact: 12 chars of base64 = 9 bytes decoded
		// Budget of 20 bytes = room for 2 artifacts (18 bytes), 3rd triggers eviction
		const small = 'QUFBQUFBQUFB'; // 12 chars base64 = 9 bytes decoded
		const reg = new ArtifactRegistry({ maxBudgetBytes: 20 });
		const id1 = reg.store(small, 'image/png', 'a');
		const id2 = reg.store(small, 'image/png', 'b');
		expect(reg.size).toBe(2);

		// Third should evict id1 to make room
		const id3 = reg.store(small, 'image/png', 'c');

		expect(reg.get(id1)).toBeUndefined(); // evicted
		expect(reg.get(id2)).toBeDefined();
		expect(reg.get(id3)).toBeDefined();
		expect(reg.size).toBe(2);
	});

	it('rejects artifacts exceeding per-artifact size limit', () => {
		const reg = new ArtifactRegistry({ maxArtifactBytes: 100 });
		expect(() => reg.store(makeBase64(200), 'image/png', 'too big')).toThrow(/exceeds.*limit/i);
	});

	it('rejects unknown MIME types', () => {
		const reg = new ArtifactRegistry();
		expect(() => reg.store(TINY_PNG_B64, 'application/pdf', 'doc')).toThrow(
			/unsupported mime type/i,
		);
		expect(() => reg.store(TINY_PNG_B64, 'text/plain', 'text')).toThrow(/unsupported mime type/i);
	});

	it('accepts all image MIME types in whitelist', () => {
		const reg = new ArtifactRegistry();
		for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
			const id = reg.store(TINY_PNG_B64, mime, `test ${mime}`);
			expect(reg.get(id)).toBeDefined();
		}
		expect(reg.size).toBe(4);
	});

	it('TTL expiry: store, advance clock, get returns undefined', () => {
		let currentTime = 1000;
		const reg = new ArtifactRegistry({
			ttlMs: 5000,
			now: () => currentTime,
		});

		const id = reg.store(TINY_PNG_B64, 'image/png', 'ephemeral');
		expect(reg.get(id)).toBeDefined();

		// Advance past TTL
		currentTime = 7000;
		expect(reg.get(id)).toBeUndefined();
	});

	it('cleanup() removes expired artifacts', () => {
		let currentTime = 1000;
		const reg = new ArtifactRegistry({
			ttlMs: 5000,
			now: () => currentTime,
		});

		reg.store(TINY_PNG_B64, 'image/png', 'a');
		reg.store(TINY_PNG_B64, 'image/png', 'b');
		expect(reg.size).toBe(2);

		currentTime = 7000;
		reg.cleanup();
		expect(reg.size).toBe(0);
		expect(reg.list()).toHaveLength(0);
	});

	it('dispose() clears everything', () => {
		const reg = new ArtifactRegistry();
		reg.store(TINY_PNG_B64, 'image/png', 'a');
		reg.store(TINY_PNG_B64, 'image/png', 'b');
		expect(reg.size).toBe(2);

		reg.dispose();
		expect(reg.size).toBe(0);
		expect(reg.usedBytes).toBe(0);
		expect(reg.list()).toHaveLength(0);
	});

	it('tracks source and fileName', () => {
		const reg = new ArtifactRegistry();
		const id1 = reg.store(TINY_PNG_B64, 'image/png', 'upload', 'uploaded', 'photo.png');
		const id2 = reg.store(TINY_PNG_B64, 'image/jpeg', 'received', 'received');

		expect(reg.get(id1)?.source).toBe('uploaded');
		expect(reg.get(id1)?.fileName).toBe('photo.png');
		expect(reg.get(id2)?.source).toBe('received');
		expect(reg.get(id2)?.fileName).toBeUndefined();
	});

	it('defaults source to generated', () => {
		const reg = new ArtifactRegistry();
		const id = reg.store(TINY_PNG_B64, 'image/png', 'gen');
		expect(reg.get(id)?.source).toBe('generated');
	});

	it('get returns undefined for unknown ID', () => {
		const reg = new ArtifactRegistry();
		expect(reg.get('nonexistent')).toBeUndefined();
	});
});
