// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import {
	assertMacOS,
	buildEmailScript,
	escapeAppleScript,
} from '../lib/apple-mail-sender.js';

describe('apple-mail-sender', () => {
	describe('escapeAppleScript', () => {
		it('escapes backslashes', () => {
			expect(escapeAppleScript('path\\to\\file')).toBe('path\\\\to\\\\file');
		});

		it('escapes double quotes', () => {
			expect(escapeAppleScript('He said "hello"')).toBe('He said \\"hello\\"');
		});

		it('escapes both backslashes and quotes', () => {
			expect(escapeAppleScript('C:\\"docs"')).toBe('C:\\\\\\"docs\\"');
		});

		it('returns unchanged string with no special chars', () => {
			expect(escapeAppleScript('plain text')).toBe('plain text');
		});

		it('handles empty string', () => {
			expect(escapeAppleScript('')).toBe('');
		});
	});

	describe('buildEmailScript', () => {
		it('generates script with to recipients', () => {
			const script = buildEmailScript({
				to: ['alice@example.com'],
				subject: 'Test',
				body: 'Hello',
			});
			expect(script).toContain('tell application "Mail"');
			expect(script).toContain('subject:"Test"');
			expect(script).toContain('content:"Hello"');
			expect(script).toContain('address:"alice@example.com"');
			expect(script).toContain('to recipient');
			expect(script).toContain('send theMessage');
		});

		it('generates script with multiple to recipients', () => {
			const script = buildEmailScript({
				to: ['alice@example.com', 'bob@example.com'],
				subject: 'Test',
				body: 'Hello',
			});
			expect(script).toContain('address:"alice@example.com"');
			expect(script).toContain('address:"bob@example.com"');
		});

		it('includes cc recipients', () => {
			const script = buildEmailScript({
				to: ['alice@example.com'],
				subject: 'Test',
				body: 'Hello',
				cc: ['carol@example.com'],
			});
			expect(script).toContain('cc recipient');
			expect(script).toContain('address:"carol@example.com"');
		});

		it('includes bcc recipients', () => {
			const script = buildEmailScript({
				to: ['alice@example.com'],
				subject: 'Test',
				body: 'Hello',
				bcc: ['dave@example.com'],
			});
			expect(script).toContain('bcc recipient');
			expect(script).toContain('address:"dave@example.com"');
		});

		it('sets visible:false for sends', () => {
			const script = buildEmailScript({
				to: ['alice@example.com'],
				subject: 'Test',
				body: 'Hello',
			});
			expect(script).toContain('visible:false');
		});

		it('sets visible:true for drafts', () => {
			const script = buildEmailScript({
				to: ['alice@example.com'],
				subject: 'Test',
				body: 'Hello',
				draftOnly: true,
			});
			expect(script).toContain('visible:true');
		});

		it('omits send line for drafts', () => {
			const script = buildEmailScript({
				to: ['alice@example.com'],
				subject: 'Test',
				body: 'Hello',
				draftOnly: true,
			});
			expect(script).not.toContain('send theMessage');
		});

		it('includes send line when not draft', () => {
			const script = buildEmailScript({
				to: ['alice@example.com'],
				subject: 'Test',
				body: 'Hello',
				draftOnly: false,
			});
			expect(script).toContain('send theMessage');
		});

		it('escapes special characters in subject and body', () => {
			const script = buildEmailScript({
				to: ['alice@example.com'],
				subject: 'He said "hello"',
				body: 'Path: C:\\docs',
			});
			expect(script).toContain('subject:"He said \\"hello\\""');
			expect(script).toContain('content:"Path: C:\\\\docs"');
		});
	});

	describe('assertMacOS', () => {
		it('does not throw on darwin', () => {
			// We're running tests on macOS (darwin), so this should pass
			if (process.platform === 'darwin') {
				expect(() => assertMacOS()).not.toThrow();
			}
		});

		it('throws on non-darwin platform', () => {
			const originalPlatform = process.platform;
			Object.defineProperty(process, 'platform', { value: 'linux' });
			try {
				expect(() => assertMacOS()).toThrow('Apple Mail email sending is only available on macOS');
			} finally {
				Object.defineProperty(process, 'platform', { value: originalPlatform });
			}
		});
	});
});
