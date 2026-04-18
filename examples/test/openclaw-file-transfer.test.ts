// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { ArtifactRegistry } from '../../app/lib/media/artifact-registry.js';
import { resolveArtifacts } from '../../app/lib/artifact-resolution.js';
import type { ChatEvent, OpenClawClient } from '../../app/lib/integrations/openclaw/openclaw-client.js';
import { extractContentBlocks, normalizeEvent } from '../../app/lib/integrations/openclaw/openclaw-client.js';
import { createOpenClawSubagentConfig } from '../../app/lib/openclaw-tools.js';

const TINY_PNG_B64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function createMockClient(events: ChatEvent[]): OpenClawClient {
	let eventIndex = 0;
	let runCounter = 0;

	return {
		sessionKey: vi.fn((_sid: string) => 'bodhi:test'),
		chatSend: vi.fn(async () => ({
			runId: `run-${++runCounter}`,
		})),
		nextChatEvent: vi.fn(async () => events[eventIndex++]),
		chatAbort: vi.fn(),
	} as unknown as OpenClawClient;
}

describe('File Transfer Pipeline — Integration', () => {
	describe('Upload path: store → resolve → attach → chatSend', () => {
		it('full upload pipeline: store artifact, resolve, attach to chatSend', () => {
			const registry = new ArtifactRegistry();
			const artId = registry.store(TINY_PNG_B64, 'image/png', 'test image', 'generated');

			const { attachments } = resolveArtifacts([artId], registry);
			expect(attachments).toHaveLength(1);
			expect(attachments[0].type).toBe('image');
			expect(attachments[0].mimeType).toBe('image/png');
			expect(attachments[0].content).toBe(TINY_PNG_B64);
		});

		it('multiple attachments in single request', () => {
			const registry = new ArtifactRegistry();
			const id1 = registry.store(TINY_PNG_B64, 'image/png', 'img1', 'generated');
			const id2 = registry.store(TINY_PNG_B64, 'image/jpeg', 'img2', 'uploaded');

			const { attachments } = resolveArtifacts([id1, id2], registry);
			expect(attachments).toHaveLength(2);
			expect(attachments[0].mimeType).toBe('image/png');
			expect(attachments[1].mimeType).toBe('image/jpeg');
		});

		it('expired/missing artifact IDs → error', () => {
			const registry = new ArtifactRegistry();
			expect(() => resolveArtifacts(['art_fake_123'], registry)).toThrow(/could not attach/i);
		});

		it('mixed valid/invalid artifact IDs → partial success with warning', () => {
			const registry = new ArtifactRegistry();
			const goodId = registry.store(TINY_PNG_B64, 'image/png', 'good', 'generated');

			const { attachments, warning } = resolveArtifacts([goodId, 'art_missing'], registry);
			expect(attachments).toHaveLength(1);
			expect(warning).toMatch(/expired\/missing/);
		});

		it('no registry configured + artifactIds → error', () => {
			expect(() => resolveArtifacts(['art_123'], undefined)).toThrow(/not configured/i);
		});
	});

	describe('Download path: receive → parse → dedup → display', () => {
		it('multimodal response parsed into text + content blocks', () => {
			const content = [
				{ type: 'text', text: "Here's the chart:" },
				{
					type: 'image',
					source: { type: 'base64', data: 'iVBOR...', media_type: 'image/png' },
				},
			];
			const blocks = extractContentBlocks(content);
			expect(blocks).toHaveLength(2);
			expect(blocks[0].type).toBe('text');
			expect(blocks[1].type).toBe('image');
		});

		it('normalizeEvent populates contentBlocks for non-text content', () => {
			const raw = {
				runId: 'run-1',
				sessionKey: 'bodhi:test',
				seq: 0,
				state: 'final' as const,
				message: {
					role: 'assistant' as const,
					content: [
						{ type: 'text', text: 'Chart attached' },
						{
							type: 'image',
							source: { type: 'base64', data: 'abc', media_type: 'image/png' },
						},
					] as unknown as string,
				},
				stopReason: 'stop',
			};
			const event = normalizeEvent(raw);
			expect(event.text).toBe('Chart attached');
			expect(event.contentBlocks).toHaveLength(1);
			expect(event.contentBlocks?.[0].type).toBe('image');
		});

		it('document content block parsed correctly', () => {
			const content = [
				{
					type: 'document',
					name: 'report.pdf',
					source: {
						type: 'base64',
						data: 'JVBERi0xLjQ=',
						media_type: 'application/pdf',
					},
				},
			];
			const blocks = extractContentBlocks(content);
			expect(blocks).toHaveLength(1);
			expect(blocks[0].type).toBe('document');
			expect(blocks[0].fileName).toBe('report.pdf');
		});
	});

	describe('FIFO eviction safety', () => {
		it('eviction does not break active references', () => {
			const registry = new ArtifactRegistry({ maxCount: 2 });
			const id1 = registry.store(TINY_PNG_B64, 'image/png', 'first', 'generated');
			const id2 = registry.store(TINY_PNG_B64, 'image/png', 'second', 'generated');

			// Get reference before eviction
			const art1 = registry.get(id1);
			expect(art1).toBeDefined();

			// Store a third — evicts id1
			registry.store(TINY_PNG_B64, 'image/png', 'third', 'generated');

			// id1 is gone from registry
			expect(registry.get(id1)).toBeUndefined();
			// But the previously retrieved reference still has the data
			expect(art1?.base64).toBe(TINY_PNG_B64);
		});
	});

	describe('Gateway attachment rejection', () => {
		it('surfaces user-friendly error for attachment-related gateway errors', async () => {
			const client = createMockClient([
				{
					source: 'chat',
					runId: 'run-1',
					state: 'error',
					error: 'Unsupported attachment MIME type',
				},
			]);

			const registry = new ArtifactRegistry();
			const artId = registry.store(TINY_PNG_B64, 'image/png', 'test', 'generated');

			type ToolMap = Record<
				string,
				{
					execute: (args: {
						message: string;
						artifactIds?: string[];
					}) => Promise<Record<string, unknown>>;
				}
			>;

			const config = createOpenClawSubagentConfig(client, 'session-1', {
				artifactRegistry: registry,
			});
			const tools = config.tools as ToolMap;

			const result = await tools.openclaw_chat.execute({
				message: 'Send image',
				artifactIds: [artId],
			});
			expect(result.status).toBe('error');
			expect(result.error).toMatch(/attachment rejected/i);
		});
	});

	describe('Text-file policy', () => {
		it('ArtifactRegistry rejects text MIME types', () => {
			const registry = new ArtifactRegistry();
			expect(() => registry.store('aGVsbG8=', 'text/plain', 'text file')).toThrow(
				/unsupported mime type/i,
			);
			expect(() => registry.store('e30=', 'application/json', 'json')).toThrow(
				/unsupported mime type/i,
			);
		});
	});
});
