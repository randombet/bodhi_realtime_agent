import { describe, expect, it, vi } from 'vitest';
import { runIngestion } from '../../app/agents/kb/ingestion-runner.js';

describe('runIngestion', () => {
	it('inlines small normalized text without uploading to storage', async () => {
		const upload = vi.fn();
		const supabase = {
			storage: { from: () => ({ upload }) },
		} as never;
		const text = 'hello world';
		const out = await runIngestion(
			{
				bytes: new TextEncoder().encode(text),
				mimeType: 'text/plain',
				filename: 'a.txt',
			},
			{
				supabase,
				bucket: 'kb',
				normalizedObjectPath: 'kb/u/a/x.normalized.txt',
			},
		);
		expect(out.status).toBe('ready');
		expect(out.providerId).toBe('none');
		expect(out.inlineText).toBe(text);
		expect(out.normalizedTextBytes).toBe(text.length);
		expect(out.normalizedObjectPath).toBeUndefined();
		expect(upload).not.toHaveBeenCalled();
	});

	it('uploads normalized text to storage when too large to inline', async () => {
		const upload = vi.fn(async () => ({ error: null }));
		const supabase = {
			storage: { from: () => ({ upload }) },
		} as never;
		const text = 'x'.repeat(300_000);
		const out = await runIngestion(
			{
				bytes: new TextEncoder().encode(text),
				mimeType: 'text/plain',
				filename: 'big.txt',
			},
			{
				supabase,
				bucket: 'kb',
				normalizedObjectPath: 'kb/u/a/big.normalized.txt',
			},
		);
		expect(out.status).toBe('ready');
		expect(out.normalizedObjectPath).toBe('kb/u/a/big.normalized.txt');
		expect(out.inlineText).toBeUndefined();
		expect(upload).toHaveBeenCalledOnce();
	});

	it('marks job failed when parser produces no usable text', async () => {
		const out = await runIngestion(
			{
				bytes: new TextEncoder().encode('%PDF-1.7\n... binary ...'),
				mimeType: 'application/pdf',
				filename: 'doc.pdf',
			},
			{
				supabase: null,
				bucket: 'kb',
				normalizedObjectPath: 'kb/u/a/doc.normalized.txt',
			},
		);
		expect(out.status).toBe('failed');
		expect(out.error).toMatch(/no usable text/i);
	});
});
