// Post-Session Processor — email a session summary to a specific address.
//
// A runnable example of the `EmailSender` capability: it builds a
// PostSessionSnapshot for a (sample) ended session, runs it through the REAL
// `InMemoryPostSessionPipeline` from `src/post-session/`, and an
// `EmailSummaryProcessor` composes a summary + transcript and sends it to a
// chosen recipient via a pluggable `EmailSender`.
//
// Senders:
//   - console (default) — prints the composed email; no keys, no network, safe.
//   - apple             — sends (or drafts) via macOS Mail.app (examples/lib/apple-mail-sender).
//
// Run:
//   pnpm tsx examples/post-session-processor/email-summary.ts you@example.com
//   POST_SESSION_EMAIL_TO=you@example.com pnpm tsx examples/post-session-processor/email-summary.ts
//   pnpm tsx examples/post-session-processor/email-summary.ts you@example.com --apple --draft   # macOS: create a Mail draft
//   pnpm tsx examples/post-session-processor/email-summary.ts you@example.com --apple            # macOS: actually send
//
// Exit code is non-zero if the email fails to send.

import { InMemoryPostSessionPipeline } from '../../src/post-session/pipeline.js';
import { PostSessionProcessor } from '../../src/post-session/types.js';
import type {
	PostSessionContext,
	PostSessionSnapshot,
	PostSessionSnapshotBuilder,
} from '../../src/post-session/types.js';
import type { ConversationItem } from '../../src/types/conversation.js';
import { sendEmail } from '../lib/apple-mail-sender.js';

// ───────────────────────────────────────────────────────────────────────────
// EmailSender capability (pluggable)
// ───────────────────────────────────────────────────────────────────────────

interface EmailMessage {
	to: string;
	subject: string;
	body: string;
}

interface EmailSender {
	readonly label: string;
	send(message: EmailMessage): Promise<void>;
}

/** Prints the composed email — safe default, no network. */
class ConsoleEmailSender implements EmailSender {
	readonly label = 'console';
	async send(message: EmailMessage): Promise<void> {
		console.log('\n──────── EMAIL (console sender) ────────');
		console.log(`To:      ${message.to}`);
		console.log(`Subject: ${message.subject}`);
		console.log('');
		console.log(message.body);
		console.log('────────────────────────────────────────\n');
	}
}

/** Sends (or drafts) via macOS Mail.app. First send triggers a permission prompt. */
class AppleMailSender implements EmailSender {
	readonly label: string;
	constructor(private readonly draftOnly: boolean) {
		this.label = draftOnly ? 'apple(draft)' : 'apple(send)';
	}
	async send(message: EmailMessage): Promise<void> {
		const result = await sendEmail({
			to: [message.to],
			subject: message.subject,
			body: message.body,
			draftOnly: this.draftOnly,
		});
		if (!result.success) {
			throw new Error(`Apple Mail ${result.action} failed: ${result.error ?? 'unknown error'}`);
		}
		console.log(`[apple-mail] ${result.action} → ${message.to}`);
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Processor: summarize the conversation and email it
// ───────────────────────────────────────────────────────────────────────────

const roleLabel: Record<string, string> = {
	user: 'User',
	assistant: 'Assistant',
	tool_call: 'Tool call',
	tool_result: 'Tool result',
	transfer: 'Transfer',
};

/** Deterministic, no-LLM summary. A production build would swap in a SummaryProcessor. */
function summarize(snapshot: PostSessionSnapshot): string {
	const items = snapshot.conversation.items;
	const userTurns = items.filter((i) => i.role === 'user');
	const assistantTurns = items.filter((i) => i.role === 'assistant');
	const asks = userTurns.slice(0, 3).map((i) => `  • ${i.content}`);
	const durationMin = (snapshot.durationMs / 60000).toFixed(1);
	return [
		`Session ${snapshot.sessionId} ended (${snapshot.reason}) after ${durationMin} min.`,
		`Agent: ${snapshot.transferPath.join(' → ')}`,
		`Turns: ${userTurns.length} user / ${assistantTurns.length} assistant, ${snapshot.metrics.toolCallCount} tool call(s).`,
		'',
		'What the user asked:',
		...(asks.length ? asks : ['  (no user messages)']),
	].join('\n');
}

class EmailSummaryProcessor extends PostSessionProcessor {
	readonly name = 'email-summary';
	// Static config (sender + recipient) is shared across sessions → reentrant.
	constructor(
		private readonly sender: EmailSender,
		private readonly recipient: string,
	) {
		super();
	}

	shouldRun(ctx: PostSessionContext): boolean {
		return ctx.conversation.items.length > 0;
	}

	async run(ctx: PostSessionContext): Promise<Record<string, unknown>> {
		const summary = summarize(ctx);
		const transcript = ctx.conversation.items
			.map((i: ConversationItem) => `${roleLabel[i.role] ?? i.role}: ${i.content}`)
			.join('\n');
		const subject = `Session summary — ${ctx.sessionId} (${ctx.reason})`;
		const body = `${summary}\n\n--- Full transcript ---\n${transcript}\n`;
		await this.sender.send({ to: this.recipient, subject, body });
		return { to: this.recipient, sender: this.sender.label, bodyChars: body.length };
	}
}

// ───────────────────────────────────────────────────────────────────────────
// Sample session + wiring
// ───────────────────────────────────────────────────────────────────────────

function sampleBuilder(): PostSessionSnapshotBuilder {
	const items: ConversationItem[] = [
		{ role: 'user', content: 'What time is my flight tomorrow?', timestamp: 1 },
		{ role: 'assistant', content: 'Your flight BA286 departs SFO at 4:15 PM.', timestamp: 2 },
		{ role: 'user', content: 'Can you set a reminder 3 hours before?', timestamp: 3 },
		{ role: 'tool_call', content: 'set_reminder(at="1:15 PM")', timestamp: 4 },
		{ role: 'assistant', content: "Done — I'll remind you at 1:15 PM.", timestamp: 5 },
	];
	return (reason) => ({
		snapshot: {
			sessionId: 'sess_demo',
			userId: 'user_demo',
			initialAgentName: 'concierge',
			finalAgentName: 'concierge',
			transferPath: ['concierge'],
			reason,
			startedAt: 0,
			endedAt: 240_000,
			durationMs: 240_000,
			conversation: { items },
			metrics: {
				turnCount: items.filter((i) => i.role === 'assistant').length,
				toolCallCount: items.filter((i) => i.role === 'tool_call').length,
				agentTransferCount: 0,
			},
		},
		stores: {},
	});
}

function parseArgs(argv: string[]): { recipient: string; sender: EmailSender } {
	const positional = argv.find((a) => !a.startsWith('--'));
	const recipient = positional ?? process.env.POST_SESSION_EMAIL_TO ?? 'demo@example.com';
	const useApple = argv.includes('--apple') || process.env.POST_SESSION_EMAIL_MODE === 'apple';
	const draftOnly = argv.includes('--draft');
	const sender: EmailSender = useApple ? new AppleMailSender(draftOnly) : new ConsoleEmailSender();
	return { recipient, sender };
}

async function main(): Promise<void> {
	const { recipient, sender } = parseArgs(process.argv.slice(2));
	console.log(`Sending session summary to "${recipient}" via ${sender.label} sender…`);

	const pipeline = new InMemoryPostSessionPipeline();
	pipeline.register(new EmailSummaryProcessor(sender, recipient));
	pipeline.freeze();

	// closeWithReason would call this on session end; here we drive it directly and
	// await the run (drain-style) so the process stays alive until the email is sent.
	const run = pipeline.dispatch({
		sessionId: 'sess_demo',
		reason: 'normal',
		build: sampleBuilder(),
	});
	const report = await run.report;

	const result = report.results.find((r) => r.processor === 'email-summary');
	if (report.outcome !== 'accepted' || result?.status !== 'completed') {
		console.error(
			'FAILED to send summary:',
			result?.error ?? report.failureReason ?? report.outcome,
		);
		process.exit(1);
	}
	console.log(`✓ Summary emailed (${JSON.stringify(result?.detail)})`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
