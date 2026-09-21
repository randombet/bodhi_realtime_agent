/**
 * SutandoSubagentInstance — a PersistentSubagentInstance wrapping one logical
 * conversation with the user's Sutando core, transported through a
 * SutandoRelayServer (the Mac's bridge long-polls the relay; see
 * sutando-relay-server.ts).
 *
 * Design contracts implemented here (design-sutando-persistent-subagent.md):
 *  - FIFO invoke serialization (overlapping delegations would race continuity
 *    state; the single-consumer core serializes downstream anyway)
 *  - per-invoke watchdog with offline pause (offline-queued tasks start their
 *    watchdog at delivery, not submission)
 *  - abort/dispose state-split via relay.cancel()
 *  - canonical envelope: headers from config only, model text goes body-only,
 *    task IDs validated against the bridge's [A-Za-z0-9._-]{1,64} rule
 *  - result normalization: bounded voice brief; [needs-input] marker preserved
 *    at the front so the persona relays the question; raw output only to the
 *    recordRaw hook (dropped, never logged, when the hook is absent)
 *  - adapter-supplied continuity: rolling digest of prior briefs, prepended to
 *    each task body with a stable session marker
 */

import type { PersistentSubagentInstance } from '../../src/agent/persistent-subagent-types.js';
import type { SutandoRelayServer, SutandoTaskFields } from './sutando-relay-server.js';
import { StaleTaskError } from './sutando-relay-server.js';

export interface SutandoInstanceHooks {
	/** Out-of-band notice to the live model (bind to publishSystemNotification). */
	notifySystem?: (text: string) => void;
	/** Sink for full raw result bodies (bind to a transcript/artifact sidecar). */
	recordRaw?: (taskId: string, raw: string) => void;
}

export interface SutandoSubagentInstanceOptions {
	relay: SutandoRelayServer;
	sessionId: string;
	/** Short per-session nonce; also namespaces task IDs. */
	nonce: string;
	userId?: string;
	priority?: string;
	/** Watchdog per invoke, from delivery (or submission when Mac is fresh). Default 5 min. */
	watchdogMs?: number;
	/** Pre-delivery TTL passed to the relay. Default 10 min. */
	taskTtlMs?: number;
	/** Voice-brief cap. Default 1200 chars. */
	briefMaxChars?: number;
	/** Rolling digest entries kept. Default 5. */
	digestMaxEntries?: number;
	/** M3: rendered-digest char budget; older entries fold into a summary line. Default 900. */
	digestCharBudget?: number;
	/** M2: submit a CANCEL_INSTRUCTION task when delivered work is abandoned. Default true. */
	cancelInstructionEnabled?: boolean;
	hooks?: SutandoInstanceHooks;
	now?: () => number;
}

const TASK_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const NEEDS_INPUT_MARKER = '[needs-input]';

/** One-line, header-injection-safe scalar for envelope fields. */
function oneLine(value: string): string {
	return value.replace(/[\r\n]+/g, ' ').trim();
}

export class SutandoSubagentInstance implements PersistentSubagentInstance {
	readonly key: string;
	readonly taskIdPrefix: string;

	private disposed = false;
	private seq = 0;
	/** FIFO chain — each invoke waits for the previous one to reach a terminal state. */
	private chain: Promise<unknown> = Promise.resolve();
	/** Task IDs submitted and not yet resolved (for dispose/abort bookkeeping). */
	private readonly outstanding = new Set<string>();
	/** Orphaned/abandoned task IDs recorded for later recovery. */
	readonly orphanedTaskIds: string[] = [];
	/** M2: confirmations received for CANCEL_INSTRUCTION tasks (observability/tests). */
	readonly cancelConfirmations: Array<{ id: string; confirmation: string }> = [];
	private cancelSeq = 0;
	/** Rolling continuity digest: prior task/result briefs. */
	private readonly digest: Array<{ task: string; result: string }> = [];
	/** M3 digest compression state: entries folded out of the rolling window. */
	private compressedCount = 0;
	private compressedFirstTask: string | null = null;
	private unsubscribePresence: (() => void) | null = null;

	private readonly relay: SutandoRelayServer;
	private readonly sessionId: string;
	private readonly nonce: string;
	private readonly userId: string;
	private readonly priority: string;
	private readonly watchdogMs: number;
	private readonly taskTtlMs: number;
	private readonly briefMaxChars: number;
	private readonly digestMaxEntries: number;
	private readonly digestCharBudget: number;
	private readonly cancelInstructionEnabled: boolean;
	private readonly hooks: SutandoInstanceHooks;
	private readonly now: () => number;

	constructor(key: string, options: SutandoSubagentInstanceOptions) {
		this.key = key;
		this.relay = options.relay;
		this.sessionId = options.sessionId;
		this.nonce = options.nonce.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 12) || 'session';
		this.userId = options.userId ?? 'bodhi-user';
		this.priority = options.priority ?? 'normal';
		this.watchdogMs = options.watchdogMs ?? 300_000;
		this.taskTtlMs = options.taskTtlMs ?? 600_000;
		this.briefMaxChars = options.briefMaxChars ?? 1_200;
		this.digestMaxEntries = options.digestMaxEntries ?? 5;
		this.digestCharBudget = options.digestCharBudget ?? 900;
		this.cancelInstructionEnabled = options.cancelInstructionEnabled ?? true;
		this.hooks = options.hooks ?? {};
		this.now = options.now ?? Date.now;
		this.taskIdPrefix = `task-bodhi-${this.nonce}`;

		// M3 presence UX: exactly one notice per offline→online transition (the
		// relay dedupes transitions), and only when this session actually has
		// work waiting — a Mac that was always online never triggers it.
		this.unsubscribePresence = this.relay.onPresenceChange((fresh) => {
			if (fresh && this.outstanding.size > 0) {
				this.hooks.notifySystem?.('Your Mac came back online — running your queued task now.');
			}
		});
	}

	// -------------------------------------------------------------------------
	// PersistentSubagentInstance
	// -------------------------------------------------------------------------

	async invoke(
		taskDescription: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<string> {
		if (this.disposed) {
			throw new Error(`SutandoSubagentInstance "${this.key}" is disposed`);
		}
		const message = args.task ? String(args.task) : taskDescription;

		// FIFO: chain after the previous invoke regardless of its outcome; a
		// failure there must not wedge this one (bounded-failure contract).
		const run = this.chain.then(
			() => this.runOne(message, signal),
			() => this.runOne(message, signal),
		);
		this.chain = run.catch(() => {});
		return run;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribePresence?.();
		this.unsubscribePresence = null;
		// State-split cleanup: undelivered removed, leased revoked, delivered
		// orphaned — relay.cancel() implements the split; late results for
		// orphaned IDs land in the relay's orphan log, never a conversation.
		// Intent 'session_closed' is ledger-recorded before waiters drop (M2).
		for (const id of this.outstanding) {
			const outcome = this.relay.cancel(id, 'session_closed');
			if (outcome === 'orphaned') {
				this.orphanedTaskIds.push(id);
				// M2: delivered work gets a real Sutando-side cancel — not
				// preemptive (same queue as the work); a raced-and-lost cancel
				// just means the original result lands in the orphan log.
				this.submitCancelInstruction(id);
			}
		}
		this.outstanding.clear();
	}

	/**
	 * Submit Sutando's CANCEL_INSTRUCTION task for abandoned delivered work.
	 * Bypasses the FIFO (a cancel must not queue behind the work it cancels)
	 * and never routes its confirmation into the conversation.
	 */
	private submitCancelInstruction(origId: string): void {
		if (!this.cancelInstructionEnabled) return;
		const cancelId = `${this.taskIdPrefix}-c${++this.cancelSeq}`;
		if (!TASK_ID_RE.test(cancelId)) return;
		this.relay
			.submit(
				{
					id: cancelId,
					timestamp: new Date(this.now()).toISOString(),
					task: `CANCEL_INSTRUCTION: ${origId} — the voice session abandoned this task; stop any in-flight work on it.`,
					source: 'bodhi',
					channel_id: oneLine(`bodhi-${this.nonce}`),
					user_id: oneLine(this.userId),
					priority: 'urgent',
					interaction_type: 'message',
				},
				{ nonce: this.nonce, desc: `cancel ${origId}` },
			)
			.then((confirmation) => {
				this.cancelConfirmations.push({ id: origId, confirmation });
			})
			.catch(() => {
				// Cancel task expired/undeliverable — the original stays orphaned
				// either way; nothing to surface.
			});
	}

	// -------------------------------------------------------------------------
	// Single delegation round-trip
	// -------------------------------------------------------------------------

	private async runOne(message: string, signal?: AbortSignal): Promise<string> {
		if (this.disposed) {
			throw new Error(`SutandoSubagentInstance "${this.key}" is disposed`);
		}
		// Abort before submission → never submit.
		if (signal?.aborted) {
			throw new Error('delegation aborted before submission');
		}

		const id = this.nextTaskId();
		const fields = this.buildEnvelope(id, message);

		// Offline-aware messaging: pendingMessage is static, so the offline
		// notice goes out-of-band through the injected hook (or rides the
		// eventual brief when no hook is configured).
		const presence = this.relay.presence();
		let offlineNotePendingForBrief = false;
		if (!presence.fresh) {
			const note =
				"The user's Mac looks offline right now — the task is queued and will run when it reconnects.";
			if (this.hooks.notifySystem) {
				this.hooks.notifySystem(note);
			} else {
				offlineNotePendingForBrief = true;
			}
		}

		// Watchdog starts now when the Mac is fresh; when offline-queued, it
		// starts at delivery (ack) so deliberate queuing never "times out".
		let watchdogTimer: NodeJS.Timeout | null = null;
		let watchdogFire: (() => void) | null = null;
		const watchdog = new Promise<never>((_, reject) => {
			watchdogFire = () => {
				reject(new Error(`Sutando did not return a result within ${this.watchdogMs / 1000}s`));
			};
		});
		const armWatchdog = () => {
			if (watchdogTimer) return;
			watchdogTimer = setTimeout(() => watchdogFire?.(), this.watchdogMs);
			watchdogTimer.unref?.();
		};

		const resultPromise = this.relay.submit(fields, {
			ttlMs: this.taskTtlMs,
			onDelivered: () => armWatchdog(),
			// M2 ledger metadata: session file key + one-line description only.
			nonce: this.nonce,
			desc: message,
		});
		this.outstanding.add(id);
		if (presence.fresh) armWatchdog();

		// Abort after submission: state-split via relay.cancel(); delivered work
		// additionally gets a Sutando-side CANCEL_INSTRUCTION (M2).
		const onAbort = () => {
			const outcome = this.relay.cancel(id, 'cancelled');
			if (outcome === 'orphaned') {
				this.orphanedTaskIds.push(id);
				this.submitCancelInstruction(id);
			}
		};
		signal?.addEventListener('abort', onAbort, { once: true });

		let watchdogFired = false;
		try {
			const raw = await Promise.race([
				resultPromise,
				watchdog.catch((err) => {
					watchdogFired = true;
					throw err;
				}),
			]);
			return this.normalizeResult(id, message, raw, offlineNotePendingForBrief);
		} catch (err) {
			if (err instanceof StaleTaskError) {
				throw new Error(
					"The task expired before the user's Mac came back online — ask whether to send it again.",
				);
			}
			// Watchdog fired or task was cancelled: make sure the relay-side task
			// is cleaned up per state-split (with the true intent recorded), then
			// record for later recovery.
			const outcome = this.relay.cancel(id, watchdogFired ? 'watchdog_expired' : 'cancelled');
			if (outcome === 'orphaned') {
				this.orphanedTaskIds.push(id);
				this.submitCancelInstruction(id);
			}
			throw err;
		} finally {
			signal?.removeEventListener('abort', onAbort);
			if (watchdogTimer) clearTimeout(watchdogTimer);
			this.outstanding.delete(id);
		}
	}

	// -------------------------------------------------------------------------
	// Envelope + normalization
	// -------------------------------------------------------------------------

	private nextTaskId(): string {
		const id = `${this.taskIdPrefix}-${++this.seq}`;
		if (!TASK_ID_RE.test(id)) {
			throw new Error(`generated task id "${id}" fails the bridge's ID rule`);
		}
		return id;
	}

	/** Headers from config only; free-form text goes into the task body. */
	private buildEnvelope(id: string, message: string): SutandoTaskFields {
		const parts: string[] = [];
		parts.push(`[bodhi session ${this.nonce}]`);
		const digestBlock = this.renderDigest();
		if (digestBlock) parts.push(digestBlock);
		// Best-effort delivered-side staleness guard (prompt-level convention).
		const deadline = new Date(this.now() + this.taskTtlMs).toISOString();
		parts.push(
			`If executing after ${deadline}, ask for confirmation before any irreversible action.`,
		);
		parts.push(message);

		return {
			id,
			timestamp: new Date(this.now()).toISOString(),
			task: parts.join('\n\n'),
			source: 'bodhi',
			channel_id: oneLine(`bodhi-${this.nonce}`),
			user_id: oneLine(this.userId),
			priority: oneLine(this.priority),
			interaction_type: 'message',
		};
	}

	/**
	 * Bounded, voice-safe brief. Raw goes to recordRaw only (dropped when the
	 * hook is absent — never silently logged). [needs-input] stays at the front
	 * so the persona's relay rule fires.
	 */
	private normalizeResult(
		id: string,
		taskMessage: string,
		raw: string,
		prependOfflineNote: boolean,
	): string {
		this.hooks.recordRaw?.(id, raw);

		const trimmed = raw.trim();
		const needsInput = trimmed.startsWith(NEEDS_INPUT_MARKER);
		let brief = trimmed;
		if (brief.length > this.briefMaxChars) {
			brief = `${brief.slice(0, this.briefMaxChars)}… (full output archived on the Mac${this.hooks.recordRaw ? ' and in the session sidecar' : ''})`;
		}
		if (needsInput && !brief.startsWith(NEEDS_INPUT_MARKER)) {
			brief = `${NEEDS_INPUT_MARKER} ${brief}`;
		}
		if (prependOfflineNote) {
			const note = '(Note: the Mac was offline when this was submitted; it has completed now.)';
			// The [needs-input] marker must stay at the very front — the persona's
			// relay rule keys off it — so the note trails in that case.
			brief = needsInput ? `${brief}\n${note}` : `${note}\n${brief}`;
		}

		this.digest.push({
			task: oneLine(taskMessage).slice(0, 120),
			result: oneLine(
				needsInput ? `asked: ${brief.slice(NEEDS_INPUT_MARKER.length, 160)}` : brief,
			).slice(0, 160),
		});
		while (this.digest.length > this.digestMaxEntries) this.digest.shift();
		this.compressDigest();

		return brief;
	}

	// -------------------------------------------------------------------------
	// M3 digest compression — long sessions keep a bounded context block
	// -------------------------------------------------------------------------

	/** Render the continuity block; null when there is no history at all. */
	private renderDigest(): string | null {
		if (this.digest.length === 0 && this.compressedCount === 0) return null;
		const header =
			this.compressedCount > 0
				? `Earlier in this conversation (${this.compressedCount} older exchange(s) summarized away; the first was: "${this.compressedFirstTask ?? ''}"):`
				: 'Earlier in this conversation:';
		const lines = this.digest.map((d, i) => `${i + 1}. asked: ${d.task} -> ${d.result}`);
		return lines.length > 0 ? `${header}\n${lines.join('\n')}` : header;
	}

	/**
	 * Deterministic compression: fold the oldest entries into a one-line
	 * summary until the rendered block fits the char budget. No LLM — the
	 * adapter must stay dependency-free; a smarter summary is welcome later.
	 */
	private compressDigest(): void {
		while (this.digest.length > 1 && (this.renderDigest()?.length ?? 0) > this.digestCharBudget) {
			const removed = this.digest.shift();
			this.compressedCount++;
			if (removed && this.compressedFirstTask === null) {
				this.compressedFirstTask = removed.task.slice(0, 80);
			}
		}
	}
}
