// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { getIngestionProvider } from '../../app/agents/kb/ingestion-providers.js';

const provider = getIngestionProvider('none');

describe('ingestion-providers / none', () => {
	it('returns null for empty input', async () => {
		const out = await provider.parse({ bytes: new Uint8Array() });
		expect(out).toBeNull();
	});

	it('decodes plain UTF-8 text/markdown', async () => {
		const text = '# Title\n\nHello world.';
		const bytes = new TextEncoder().encode(text);
		const out = await provider.parse({
			bytes,
			mimeType: 'text/markdown',
			filename: 'note.md',
		});
		expect(out).not.toBeNull();
		expect(out?.text).toBe(text);
		expect(out?.markdown).toBe(text);
		expect(out?.mimeType).toBe('text/markdown');
	});

	it('rejects known binary mime types (PDF) without parsing', async () => {
		const bytes = new TextEncoder().encode('%PDF-1.7\nbinary');
		const out = await provider.parse({
			bytes,
			mimeType: 'application/pdf',
			filename: 'doc.pdf',
		});
		expect(out).toBeNull();
	});

	it('rejects binary file extensions even without mime type', async () => {
		const bytes = new TextEncoder().encode('PK\u0003\u0004 garbage');
		const out = await provider.parse({
			bytes,
			filename: 'archive.docx',
		});
		expect(out).toBeNull();
	});

	it('rejects content with too many replacement characters', async () => {
		const bytes = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0x00, 0x01, 0x02, 0x03, 0xff, 0xff]);
		const out = await provider.parse({
			bytes,
			mimeType: 'text/plain',
		});
		expect(out).toBeNull();
	});
});
