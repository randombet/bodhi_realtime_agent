/**
 * SutandoTaskLedger — the M2 durable submitted-task ledger from
 * dev_docs/design-sutando-persistent-subagent.md.
 *
 * Append-only JSONL, one file per session nonce, every append fsync'd —
 * "acked on the Mac" must imply "recorded on the bodhi host" (the ack commit
 * point), so durability is per-write, not best-effort.
 *
 * State transitions recorded: `submitted` → `acked` → `completed`, plus
 * abandonment intents written BEFORE local waiters are removed —
 * `cancelled`, `watchdog_expired`, `session_closed` — so a post-restart
 * reaper can tell recoverable unclaimed work from work the user walked away
 * from. The transient leased/unacked relay state is deliberately NOT
 * persisted: only a durably recorded ack counts as delivery.
 *
 * Retention (the narrow carve-out from Resolved Decisions): task IDs, states,
 * timestamps, and one-line task descriptions only — never result content,
 * never raw bodies. Pruning distinguishes *reconciled* from *consumed*:
 * notice-eligible entries survive until their single recovery notice is
 * emitted (`notice_consumed`), dismissed, or the TTL expires; log-only orphan
 * classes prune after TTL.
 */

import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeSync,
} from 'node:fs';
import { join } from 'node:path';

export type LedgerState =
	| 'submitted'
	| 'acked'
	| 'completed'
	| 'cancelled'
	| 'watchdog_expired'
	| 'session_closed'
	| 'notice_consumed';

export interface LedgerEntry {
	id: string;
	nonce: string;
	state: LedgerState;
	at: number;
	/** One-line task description (≤120 chars), present on `submitted` only. */
	desc?: string;
}

/** Reduced per-task view after replaying a ledger. */
export interface LedgerTaskView {
	id: string;
	nonce: string;
	desc: string;
	submittedAt: number;
	acked: boolean;
	completed: boolean;
	/** First abandonment intent recorded, if any. */
	intent: 'cancelled' | 'watchdog_expired' | 'session_closed' | null;
	noticeConsumed: boolean;
	lastAt: number;
}

export interface RecoveryNotice {
	id: string;
	kind: 'dropped_before_delivery' | 'unclaimed_after_restart';
	/** Class-appropriate wording per design §M2.3 — never suggests redoing
	 * possibly-completed side-effectful work. */
	text: string;
}

export interface SutandoTaskLedgerOptions {
	/** Directory for per-session ledger files (created if missing). */
	dir: string;
	/** Entry TTL for pruning. Default 7 days. */
	ttlMs?: number;
	now?: () => number;
	log?: (line: string) => void;
}

const INTENTS = new Set(['cancelled', 'watchdog_expired', 'session_closed']);

export class SutandoTaskLedger {
	private readonly dir: string;
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly log: (line: string) => void;

	constructor(options: SutandoTaskLedgerOptions) {
		this.dir = options.dir;
		this.ttlMs = options.ttlMs ?? 7 * 24 * 3600_000;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
	}

	/**
	 * Durably append one transition. Throws on write failure — callers on the
	 * ack commit path MUST propagate the failure (reject the ack, let the
	 * lease expire into redelivery) rather than swallow it.
	 */
	append(entry: { id: string; nonce: string; state: LedgerState; desc?: string }): void {
		const record: LedgerEntry = {
			id: entry.id,
			nonce: entry.nonce.replace(/[^A-Za-z0-9._-]/g, '') || 'unknown',
			state: entry.state,
			at: this.now(),
			...(entry.desc !== undefined
				? {
						desc: entry.desc
							.replace(/[\r\n]+/g, ' ')
							.trim()
							.slice(0, 120),
					}
				: {}),
		};
		const line = `${JSON.stringify(record)}\n`;
		const path = join(this.dir, `${record.nonce}.jsonl`);
		// Filesystem hardening (design G10): entries are task descriptions derived
		// from user requests. O_NOFOLLOW rejects a symlink at open time, and the
		// fstat on the OPENED descriptor (not a pre-open lstat, which would be a
		// TOCTOU gap) rejects FIFOs/devices swapped in before writing.
		// O_NOFOLLOW covers the final component only; ancestor-swap races are
		// out of scope (they need write access to the ledger root's parents,
		// which deployment reserves to the service user — no portable openat2).
		const fd = openSync(
			path,
			constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			if (!fstatSync(fd).isFile()) {
				throw new Error(`ledger target ${path} is not a regular file — refusing to append`);
			}
			writeSync(fd, line);
			fsyncSync(fd); // the durability that makes "acked" mean "recorded"
		} finally {
			closeSync(fd);
		}
	}

	/** Replay all per-session files into per-task views. */
	loadTaskViews(): Map<string, LedgerTaskView> {
		const views = new Map<string, LedgerTaskView>();
		for (const entry of this.loadEntries()) {
			let view = views.get(entry.id);
			if (!view) {
				view = {
					id: entry.id,
					nonce: entry.nonce,
					desc: '',
					submittedAt: entry.at,
					acked: false,
					completed: false,
					intent: null,
					noticeConsumed: false,
					lastAt: entry.at,
				};
				views.set(entry.id, view);
			}
			view.lastAt = Math.max(view.lastAt, entry.at);
			switch (entry.state) {
				case 'submitted':
					view.submittedAt = entry.at;
					if (entry.desc) view.desc = entry.desc;
					break;
				case 'acked':
					view.acked = true;
					break;
				case 'completed':
					view.completed = true;
					break;
				case 'notice_consumed':
					view.noticeConsumed = true;
					break;
				default:
					if (INTENTS.has(entry.state) && view.intent === null) {
						view.intent = entry.state as LedgerTaskView['intent'];
					}
			}
		}
		return views;
	}

	/**
	 * Reconcile the ledger against the relay's live task set.
	 *
	 * Returns the recovery notices that are due — split by user intent:
	 *  - submitted-but-never-acked, not live → `dropped_before_delivery`
	 *    (invites a re-ask; the ledger cannot reconstruct the envelope, so
	 *    there is deliberately no auto-resubmission)
	 *  - acked-but-unclaimed, no intent, not live → `unclaimed_after_restart`
	 *    (states the work may already have completed on the Mac — never
	 *    suggests a redo that could duplicate a side effect)
	 *  - any recorded intent (cancel/watchdog/goodbye) → log-only, NEVER a
	 *    notice; a post-goodbye result must not appear in a later conversation.
	 *
	 * The caller marks a notice consumed only once it was actually delivered.
	 */
	reap(activeIds: ReadonlySet<string>): { notices: RecoveryNotice[]; prunedFiles: number } {
		const notices: RecoveryNotice[] = [];
		const views = this.loadTaskViews();
		for (const view of views.values()) {
			if (activeIds.has(view.id)) continue; // live in the relay — not ours
			if (view.completed || view.noticeConsumed || view.intent !== null) continue;
			if (this.now() - view.lastAt > this.ttlMs) continue; // TTL-expired
			const what = view.desc ? `"${view.desc}"` : `task ${view.id}`;
			if (!view.acked) {
				notices.push({
					id: view.id,
					kind: 'dropped_before_delivery',
					text: `A request (${what}) was dropped during a restart before it reached the Mac — ask the user whether to redo it.`,
				});
			} else {
				notices.push({
					id: view.id,
					kind: 'unclaimed_after_restart',
					text: `An earlier request (${what}) may have already completed on the Mac — its result is archived there. Do not redo it without asking; redoing could duplicate a side effect.`,
				});
			}
		}
		return { notices, prunedFiles: this.prune(views, activeIds) };
	}

	/** Record that a task's single recovery notice was delivered. */
	markNoticeConsumed(id: string, nonce: string): void {
		this.append({ id, nonce, state: 'notice_consumed' });
	}

	/**
	 * Prune per-session files whose every task is terminal (completed, notice
	 * consumed, or intent-recorded) and older than the TTL. Notice-eligible
	 * entries keep their file alive: reconciled ≠ consumed.
	 */
	private prune(views: Map<string, LedgerTaskView>, activeIds: ReadonlySet<string>): number {
		const byNonce = new Map<string, LedgerTaskView[]>();
		for (const view of views.values()) {
			const list = byNonce.get(view.nonce) ?? [];
			list.push(view);
			byNonce.set(view.nonce, list);
		}
		let pruned = 0;
		for (const [nonce, list] of byNonce) {
			const allTerminal = list.every(
				(v) =>
					!activeIds.has(v.id) &&
					(v.completed ||
						v.noticeConsumed ||
						v.intent !== null ||
						this.now() - v.lastAt > this.ttlMs),
			);
			const newest = Math.max(...list.map((v) => v.lastAt));
			if (allTerminal && this.now() - newest > this.ttlMs) {
				try {
					rmSync(join(this.dir, `${nonce}.jsonl`));
					pruned++;
					this.log(`pruned ledger file ${nonce}.jsonl`);
				} catch {
					// Already gone — fine.
				}
			}
		}
		return pruned;
	}

	private loadEntries(): LedgerEntry[] {
		const entries: LedgerEntry[] = [];
		let files: string[] = [];
		try {
			files = readdirSync(this.dir).filter((f) => f.endsWith('.jsonl'));
		} catch {
			return entries;
		}
		for (const file of files) {
			let raw = '';
			try {
				// Same hardening as append: read through an O_NOFOLLOW descriptor and
				// fstat-verify it is a regular file (no lstat-then-read TOCTOU gap).
				const fd = openSync(join(this.dir, file), constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					if (!fstatSync(fd).isFile()) continue;
					raw = readFileSync(fd, 'utf-8');
				} finally {
					closeSync(fd);
				}
			} catch {
				continue;
			}
			for (const line of raw.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const parsed = JSON.parse(trimmed) as LedgerEntry;
					if (parsed.id && parsed.state) entries.push(parsed);
				} catch {
					// A torn tail line from a crash mid-write — skip it; every
					// complete line before it was fsync'd and parses fine.
				}
			}
		}
		return entries;
	}
}
