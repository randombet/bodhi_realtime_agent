import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createGoogleDriveConnector,
	exportMimeForGoogleType,
	pickFileIdFromReference,
} from '../../app/agents/kb/connectors/google-drive-connector.js';

describe('pickFileIdFromReference', () => {
	it('extracts id from a Docs URL', () => {
		expect(
			pickFileIdFromReference(
				'https://docs.google.com/document/d/1AbCDeFgHIjKlMnOPQRSTUvwXYZ/edit',
			),
		).toBe('1AbCDeFgHIjKlMnOPQRSTUvwXYZ');
	});
	it('extracts id from a Drive file URL', () => {
		expect(pickFileIdFromReference('https://drive.google.com/file/d/1A2B3C4D5E6F/view')).toBe(
			'1A2B3C4D5E6F',
		);
	});
	it('returns plain id as-is', () => {
		expect(pickFileIdFromReference('1A2B3C4D5E6F_xyz')).toBe('1A2B3C4D5E6F_xyz');
	});
	it('throws on garbage input', () => {
		expect(() => pickFileIdFromReference('https://example.com/random')).toThrow(/Unrecognized/);
	});
});

describe('exportMimeForGoogleType', () => {
	it('maps Docs to markdown', () => {
		expect(exportMimeForGoogleType('application/vnd.google-apps.document')).toBe('text/markdown');
	});
	it('maps Sheets to csv', () => {
		expect(exportMimeForGoogleType('application/vnd.google-apps.spreadsheet')).toBe('text/csv');
	});
	it('returns null for non-Google types', () => {
		expect(exportMimeForGoogleType('application/pdf')).toBeNull();
	});
});

describe('createGoogleDriveConnector', () => {
	const realFetch = global.fetch;
	beforeEach(() => {
		global.fetch = vi.fn() as typeof fetch;
	});
	afterEach(() => {
		global.fetch = realFetch;
	});

	it('exports Google Docs as markdown via /export', async () => {
		const connector = createGoogleDriveConnector({ accessToken: 'tkn-1' });
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			if (calls.length === 1) {
				return new Response(
					JSON.stringify({
						name: 'Sales Manual',
						mimeType: 'application/vnd.google-apps.document',
						webViewLink: 'https://docs.google.com/document/d/abc/view',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return new Response('# Sales Manual\n\nHello.', {
				status: 200,
				headers: { 'content-type': 'text/markdown' },
			});
		}) as typeof fetch;

		const out = await connector.fetch({
			reference: 'https://docs.google.com/document/d/abcdef1234/edit',
		});
		expect(out).not.toBeNull();
		expect(out?.title).toBe('Sales Manual');
		expect(out?.mimeType).toBe('text/markdown');
		expect(out?.externalId).toBe('abcdef1234');
		expect(out?.sourceUrl).toMatch(/docs\.google\.com/);
		expect(calls[1]?.url).toContain('/export');
		expect(calls[1]?.url).toContain('mimeType=text%2Fmarkdown');
		expect((calls[1]?.init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
			'Bearer tkn-1',
		);
	});

	it('downloads non-Google files with alt=media', async () => {
		const connector = createGoogleDriveConnector({ apiKey: 'KEY' });
		const calls: string[] = [];
		global.fetch = vi.fn(async (url: string | URL | Request) => {
			calls.push(String(url));
			if (calls.length === 1) {
				return new Response(
					JSON.stringify({
						name: 'resume.pdf',
						mimeType: 'application/pdf',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
				status: 200,
				headers: { 'content-type': 'application/pdf' },
			});
		}) as typeof fetch;

		const out = await connector.fetch({ reference: 'fileid_1234567' });
		expect(out?.mimeType).toBe('application/pdf');
		expect(calls[1]).toContain('alt=media');
		expect(calls[1]).toContain('key=KEY');
	});
});
