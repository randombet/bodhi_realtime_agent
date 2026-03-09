/**
 * Send email via macOS Mail.app using AppleScript (osascript).
 *
 * Requires macOS with Mail.app configured with at least one account.
 * First use triggers a system dialog: "Allow [terminal] to control Mail.app?"
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SendEmailOptions {
	to: string[];
	subject: string;
	body: string;
	cc?: string[];
	bcc?: string[];
	/** If true, create a draft instead of sending. */
	draftOnly?: boolean;
}

export interface SendEmailResult {
	success: boolean;
	action: 'sent' | 'drafted';
	error?: string;
}

// ---------------------------------------------------------------------------
// Platform guard
// ---------------------------------------------------------------------------

/** Throws if not running on macOS. */
export function assertMacOS(): void {
	if (process.platform !== 'darwin') {
		throw new Error('Apple Mail email sending is only available on macOS');
	}
}

// ---------------------------------------------------------------------------
// AppleScript helpers
// ---------------------------------------------------------------------------

/** Escape a string for use inside AppleScript double-quoted literals. */
export function escapeAppleScript(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Build the AppleScript that sends or drafts an email via Mail.app. */
export function buildEmailScript(options: SendEmailOptions): string {
	const safe = (s: string) => escapeAppleScript(s);
	const visible = options.draftOnly ? 'true' : 'false';

	const toRecips = options.to
		.map(
			(a) =>
				`make new to recipient at end of to recipients with properties {address:"${safe(a)}"}`,
		)
		.join('\n        ');

	const ccRecips = (options.cc ?? [])
		.map(
			(a) =>
				`make new cc recipient at end of cc recipients with properties {address:"${safe(a)}"}`,
		)
		.join('\n        ');

	const bccRecips = (options.bcc ?? [])
		.map(
			(a) =>
				`make new bcc recipient at end of bcc recipients with properties {address:"${safe(a)}"}`,
		)
		.join('\n        ');

	const sendLine = options.draftOnly ? '' : '    send theMessage';

	return `tell application "Mail"
    set theMessage to make new outgoing message with properties {subject:"${safe(options.subject)}", content:"${safe(options.body)}", visible:${visible}}
    tell theMessage
        ${toRecips}
        ${ccRecips}
        ${bccRecips}
    end tell
${sendLine}
end tell`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send an email via macOS Mail.app using osascript.
 *
 * Uses `execFile` (not `exec`) to avoid shell injection.
 * Throws on non-macOS or if osascript fails.
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
	assertMacOS();

	const script = buildEmailScript(options);
	console.log('[sendEmail] to:', options.to, 'subject:', options.subject, 'draftOnly:', options.draftOnly ?? false);
	console.log('[sendEmail] AppleScript:\n' + script);

	try {
		const { stdout, stderr } = await execFileAsync('osascript', ['-e', script], {
			encoding: 'utf8',
			timeout: 30_000,
		});
		if (stdout) console.log('[sendEmail] osascript stdout:', stdout);
		if (stderr) console.log('[sendEmail] osascript stderr:', stderr);
		console.log('[sendEmail] success');
		return {
			success: true,
			action: options.draftOnly ? 'drafted' : 'sent',
		};
	} catch (error) {
		console.error('[sendEmail] osascript error:', error);
		return {
			success: false,
			action: options.draftOnly ? 'drafted' : 'sent',
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
