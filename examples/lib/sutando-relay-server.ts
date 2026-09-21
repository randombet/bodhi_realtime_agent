/**
 * SutandoRelayServer — in-process implementation of Sutando's provider-neutral
 * remote-gateway relay contract (four endpoints), hosted wherever the bodhi
 * app runs. The user's Sutando Mac dials OUT to this server via its shipping
 * bridge client (`remote-gateway-bridge.py`); bodhi never connects to the Mac.
 *
 * Endpoints (all bearer-authenticated):
 *   GET  /v1/tasks?wait=<sec>   — long-poll; leases queued tasks to the poller
 *   POST /v1/tasks/<id>/ack     — leased → acked (durable-on-Mac commit point)
 *   POST /v1/results            — { id, body } resolves the awaiting invoke
 *   POST /v1/heartbeat          — presence + inflight count
 *
 * Task state machine: queued → leased → acked → completed | orphaned
 *   - lease timeout        → back to queued (redeliver; ack-gated at-least-once)
 *   - TTL expiry (pre-ack) → expired (waiter rejected with a stale-task error)
 *   - cancel               → state-split per design: queued = removed,
 *                            leased = revoked (late ack/result rejected, never
 *                            redelivered), acked = orphaned (late result goes
 *                            to the orphan log, never to a waiter)
 *
 * Result auth invariant: a result is accepted only for an ID this server
 * actually delivered (acked, or orphaned-after-ack). Unknown, duplicate, or
 * pre-ack results are rejected and logged.
 *
 * M1 scope: in-memory only; a bodhi restart drops queue + waiters (the design
 * doc's accepted trade until the M2 ledger).
 */

import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { LedgerTaskView, RecoveryNotice, SutandoTaskLedger } from './sutando-task-ledger.js';

export type RelayTaskState =
	| 'queued'
	| 'leased'
	| 'acked'
	| 'completed'
	| 'orphaned'
	| 'expired'
	| 'cancelled';

/** Allowlisted task-object fields the Sutando bridge serializes verbatim. */
export interface SutandoTaskFields {
	id: string;
	timestamp: string;
	task: string;
	source: string;
	channel_id?: string;
	user_id?: string;
	priority?: string;
	interaction_type?: string;
}

export interface RelayOrphanEntry {
	id: string;
	/** Bounded preview only — full bodies go to the orphan sink, never memory. */
	preview: string;
	/** Byte length of the full (UTF-8) body handed to the sink. */
	bytes: number;
	at: number;
	reason: string;
}

export interface RelaySubmitOptions {
	/** TTL for the pre-delivery window; past it an undelivered task expires. */
	ttlMs?: number;
	/** Fired when the bridge acks the task (delivered durably on the Mac). */
	onDelivered?: () => void;
	/** Session nonce for the ledger (per-session file key). */
	nonce?: string;
	/** One-line task description for the ledger (never the full body). */
	desc?: string;
}

/** Abandonment intents (M2): recorded in the ledger BEFORE waiters are removed. */
export type RelayCancelReason = 'cancelled' | 'watchdog_expired' | 'session_closed';

export interface SutandoRelayServerOptions {
	/** Bearer token the bridge authenticates with (REMOTE_TASK_TOKEN). */
	token: string;
	/** Listen port; 0 lets the OS pick (tests). Default 7930. */
	port?: number;
	/** Bind host. Default 127.0.0.1. Non-loopback requires allowNonLoopbackBind. */
	host?: string;
	/** Explicit topology flag per design §6 — without it, non-loopback binds refuse to start. */
	allowNonLoopbackBind?: boolean;
	/** Lease timeout before an unacked delivery is requeued. Default 30s. */
	leaseTimeoutMs?: number;
	/** Default pre-delivery TTL for submitted tasks. Default 10 min. */
	defaultTtlMs?: number;
	/** Heartbeat freshness window. Default 90s (mirrors Sutando's liveness convention). */
	freshnessMs?: number;
	/** Max long-poll hold. Default 30s. */
	longPollCapMs?: number;
	/** Lease/TTL sweep cadence. Default 1s; tests shrink it. */
	sweepIntervalMs?: number;
	/** M2 durable ledger. Without it the relay is M1-in-memory (accepted trade). */
	ledger?: SutandoTaskLedger;
	/** Reaper cadence when a ledger is present. Default 60s. */
	reapIntervalMs?: number;
	/**
	 * Streaming request-body cap (bytes). Exceeding it aborts with 413 before
	 * buffering past the limit. Default 2 MiB (Sutando's result-size envelope).
	 */
	maxBodyBytes?: number;
	/**
	 * Max concurrently parked long-polls; excess polls get 429 immediately.
	 * Single-Mac design, so the default is a small handful.
	 */
	maxParkedPollers?: number;
	/** Orphan-preview length kept in memory (chars). Default 512. */
	orphanPreviewChars?: number;
	/** Recovery-notice claim lease before an unacked claim returns to the pool. Default 60s. */
	noticeLeaseTimeoutMs?: number;
	/**
	 * Process-wide sidecar writer for FULL orphan result bodies (the in-memory
	 * log keeps only previews). Absent → full bodies are dropped after preview.
	 */
	orphanSink?: (id: string, body: string, reason: string) => void;
	log?: (line: string) => void;
	/** Injectable clock for tests. */
	now?: () => number;
}

interface RelayTask {
	fields: SutandoTaskFields;
	state: RelayTaskState;
	nonce: string;
	enqueuedAt: number;
	expiresAt: number;
	leaseExpiresAt: number | null;
	waiter: { resolve: (body: string) => void; reject: (err: Error) => void } | null;
	onDelivered?: () => void;
}

interface ParkedPoller {
	respond: () => void;
	timer: NodeJS.Timeout;
}

/** Lease state for a pending recovery notice (claim → publish → ack). */
interface PendingNoticeEntry {
	notice: RecoveryNotice;
	/** Ledger nonce for markNoticeConsumed. */
	nonce: string;
	/** Session nonce currently holding the lease, or null when available. */
	leasedBy: string | null;
	leaseExpiresAt: number | null;
}

/** Sentinel returned by body() when the streaming size cap is exceeded. */
const BODY_TOO_LARGE = Symbol('body_too_large');

export class StaleTaskError extends Error {
	constructor(id: string) {
		super(`task ${id} expired before the Mac picked it up`);
		this.name = 'StaleTaskError';
	}
}

export class SutandoRelayServer {
	private readonly opts: Required<
		Pick<
			SutandoRelayServerOptions,
			| 'token'
			| 'port'
			| 'host'
			| 'leaseTimeoutMs'
			| 'defaultTtlMs'
			| 'freshnessMs'
			| 'longPollCapMs'
			| 'sweepIntervalMs'
			| 'maxBodyBytes'
			| 'maxParkedPollers'
			| 'orphanPreviewChars'
		>
	> & { allowNonLoopbackBind: boolean };
	private readonly orphanSink: ((id: string, body: string, reason: string) => void) | null;
	private readonly noticeLeaseTimeoutMs: number;
	private readonly log: (line: string) => void;
	private readonly now: () => number;

	private server: Server | null = null;
	private boundPort: number | null = null;
	private sweepTimer: NodeJS.Timeout | null = null;

	private readonly tasks = new Map<string, RelayTask>();
	private readonly parked: ParkedPoller[] = [];

	private lastHeartbeatAt: number | null = null;
	private lastHeartbeat: unknown = null;

	/** Bounded log of results that arrived with no live waiter. */
	readonly orphanLog: RelayOrphanEntry[] = [];
	private static readonly ORPHAN_LOG_MAX = 100;

	// M2: durable ledger + restart recovery + reaper.
	private readonly ledger: SutandoTaskLedger | null;
	private readonly reapIntervalMs: number;
	private reapTimer: NodeJS.Timeout | null = null;
	/** Pre-restart acked-but-unresolved tasks recovered from the ledger. */
	private recovered = new Map<string, LedgerTaskView>();
	/** Notices produced by the reaper, awaiting lease/ack (or legacy drain). */
	private pendingNotices = new Map<string, PendingNoticeEntry>();

	// M3: presence-transition events.
	private presenceListeners = new Set<(fresh: boolean) => void>();
	private lastFreshState = false;

	constructor(options: SutandoRelayServerOptions) {
		this.opts = {
			token: options.token,
			port: options.port ?? 7930,
			host: options.host ?? '127.0.0.1',
			allowNonLoopbackBind: options.allowNonLoopbackBind ?? false,
			leaseTimeoutMs: options.leaseTimeoutMs ?? 30_000,
			defaultTtlMs: options.defaultTtlMs ?? 600_000,
			freshnessMs: options.freshnessMs ?? 90_000,
			longPollCapMs: options.longPollCapMs ?? 30_000,
			sweepIntervalMs: options.sweepIntervalMs ?? 1_000,
			maxBodyBytes: options.maxBodyBytes ?? 2 * 1024 * 1024,
			maxParkedPollers: options.maxParkedPollers ?? 4,
			orphanPreviewChars: options.orphanPreviewChars ?? 512,
		};
		this.log = options.log ?? ((line) => console.log(`[SutandoRelay] ${line}`));
		this.now = options.now ?? Date.now;
		this.ledger = options.ledger ?? null;
		this.orphanSink = options.orphanSink ?? null;
		this.noticeLeaseTimeoutMs = options.noticeLeaseTimeoutMs ?? 60_000;
		this.reapIntervalMs = options.reapIntervalMs ?? 60_000;
		if (!this.opts.token) {
			throw new Error('SutandoRelayServer requires a non-empty bearer token');
		}
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	async start(): Promise<number> {
		const { host } = this.opts;
		const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
		if (!loopback && !this.opts.allowNonLoopbackBind) {
			throw new Error(
				`SutandoRelayServer refuses non-loopback bind "${host}" without allowNonLoopbackBind — the relay carries task bodies and the bearer token; see the design doc §6 transport policy (tailnet/WireGuard recommended, bare LAN HTTP is explicit opt-in only).`,
			);
		}

		this.server = createServer((req, res) => {
			void this.route(req, res).catch((err) => {
				this.log(`route error: ${err instanceof Error ? err.message : String(err)}`);
				this.json(res, 500, { error: 'internal' });
			});
		});

		await new Promise<void>((resolve, reject) => {
			const server = this.server as Server;
			server.once('error', reject);
			server.listen(this.opts.port, host, () => {
				server.removeListener('error', reject);
				resolve();
			});
		});
		const address = this.server.address();
		this.boundPort = typeof address === 'object' && address ? address.port : this.opts.port;

		// Sweep leases + TTLs at a granularity comfortably under the defaults.
		this.sweepTimer = setInterval(() => this.sweep(), this.opts.sweepIntervalMs);
		this.sweepTimer.unref?.();

		// M2 restart recovery: replay the ledger. A post-restart result is
		// accepted iff the ledger shows a durably recorded ack (mere submission
		// is not enough — §5's forged-result invariant holds across restarts).
		if (this.ledger) {
			for (const view of this.ledger.loadTaskViews().values()) {
				if (view.acked && !view.completed) this.recovered.set(view.id, view);
			}
			if (this.recovered.size > 0) {
				this.log(
					`restart recovery: ${this.recovered.size} acked pre-restart task(s) result-eligible`,
				);
			}
			this.reapNow();
			this.reapTimer = setInterval(() => this.reapNow(), this.reapIntervalMs);
			this.reapTimer.unref?.();
		}

		this.log(`listening on ${host}:${this.boundPort}`);
		return this.boundPort;
	}

	async stop(): Promise<void> {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
		if (this.reapTimer) {
			clearInterval(this.reapTimer);
			this.reapTimer = null;
		}
		for (const poller of this.parked.splice(0)) {
			clearTimeout(poller.timer);
			poller.respond();
		}
		if (this.server) {
			await new Promise<void>((resolve) => this.server?.close(() => resolve()));
			this.server = null;
		}
	}

	get port(): number {
		if (this.boundPort === null) throw new Error('SutandoRelayServer is not started');
		return this.boundPort;
	}

	get url(): string {
		return `http://${this.opts.host}:${this.port}`;
	}

	// -------------------------------------------------------------------------
	// App-facing API (used by SutandoSubagentInstance, same process)
	// -------------------------------------------------------------------------

	/** Enqueue a task for the bridge. Resolves with the result body. */
	submit(fields: SutandoTaskFields, options: RelaySubmitOptions = {}): Promise<string> {
		if (this.tasks.has(fields.id)) {
			return Promise.reject(new Error(`duplicate task id ${fields.id}`));
		}
		const nonce = options.nonce ?? fields.channel_id?.replace(/^bodhi-/, '') ?? 'unknown';
		const task: RelayTask = {
			fields,
			state: 'queued',
			nonce,
			enqueuedAt: this.now(),
			expiresAt: this.now() + (options.ttlMs ?? this.opts.defaultTtlMs),
			leaseExpiresAt: null,
			waiter: null,
			onDelivered: options.onDelivered,
		};
		this.tasks.set(fields.id, task);
		// Ledger `submitted` is best-effort (the hard commit point is the ack):
		// a failed write here only costs a dropped-task notice after a crash.
		try {
			this.ledger?.append({ id: fields.id, nonce, state: 'submitted', desc: options.desc ?? '' });
		} catch (err) {
			this.log(`ledger submit append failed for ${fields.id}: ${String(err)}`);
		}
		const promise = new Promise<string>((resolve, reject) => {
			task.waiter = { resolve, reject };
		});
		this.wakePollers();
		return promise;
	}

	/**
	 * Cancel by task state (abort/dispose state-split from the design doc):
	 * queued → removed (never delivered); leased → revoked (late ack/result
	 * rejected, never redelivered); acked → orphaned (late result to orphan log).
	 *
	 * The abandonment intent is recorded in the ledger BEFORE the waiter is
	 * removed (M2), so a post-restart reaper never mistakes walked-away work
	 * for recoverable work. Ledger failure never blocks the cancel itself —
	 * stopping a side-effectful task outranks bookkeeping.
	 */
	cancel(
		id: string,
		reason: RelayCancelReason = 'cancelled',
	): 'not_found' | 'removed_undelivered' | 'lease_revoked' | 'orphaned' {
		const task = this.tasks.get(id);
		if (!task) return 'not_found';
		if (task.state === 'queued' || task.state === 'leased' || task.state === 'acked') {
			try {
				this.ledger?.append({ id, nonce: task.nonce, state: reason });
			} catch (err) {
				this.log(`ledger intent append failed for ${id}: ${String(err)}`);
			}
		}
		switch (task.state) {
			case 'queued': {
				task.state = 'cancelled';
				task.waiter?.reject(new Error(`task ${id} cancelled before delivery`));
				task.waiter = null;
				return 'removed_undelivered';
			}
			case 'leased': {
				task.state = 'cancelled';
				task.waiter?.reject(new Error(`task ${id} cancelled while leased`));
				task.waiter = null;
				return 'lease_revoked';
			}
			case 'acked': {
				task.state = 'orphaned';
				task.waiter?.reject(new Error(`task ${id} abandoned; late result will be orphan-logged`));
				task.waiter = null;
				return 'orphaned';
			}
			default:
				return 'not_found';
		}
	}

	/** Mac presence per heartbeat freshness. */
	presence(): { fresh: boolean; lastHeartbeatAt: number | null; heartbeat: unknown } {
		const fresh =
			this.lastHeartbeatAt !== null && this.now() - this.lastHeartbeatAt < this.opts.freshnessMs;
		return { fresh, lastHeartbeatAt: this.lastHeartbeatAt, heartbeat: this.lastHeartbeat };
	}

	/** Test/observability hook. */
	taskState(id: string): RelayTaskState | undefined {
		return this.tasks.get(id)?.state;
	}

	/** Currently parked long-polls (test/observability hook). */
	get parkedCount(): number {
		return this.parked.length;
	}

	/** Subscribe to Mac presence transitions (fresh ↔ stale). Returns unsubscribe. */
	onPresenceChange(listener: (fresh: boolean) => void): () => void {
		this.presenceListeners.add(listener);
		return () => this.presenceListeners.delete(listener);
	}

	/**
	 * Run the reaper now: reconcile the ledger against live relay state,
	 * queue any due recovery notices, prune consumed files.
	 */
	reapNow(): void {
		if (!this.ledger) return;
		const { notices } = this.ledger.reap(new Set(this.tasks.keys()));
		if (notices.length === 0) return;
		const views = this.ledger.loadTaskViews();
		for (const notice of notices) {
			if (this.pendingNotices.has(notice.id)) continue;
			this.pendingNotices.set(notice.id, {
				notice,
				nonce: views.get(notice.id)?.nonce ?? 'unknown',
				leasedBy: null,
				leaseExpiresAt: null,
			});
		}
	}

	/** A notice is claimable when unleased or its lease has expired. */
	private noticeAvailable(entry: PendingNoticeEntry): boolean {
		return (
			entry.leasedBy === null ||
			(entry.leaseExpiresAt !== null && this.now() > entry.leaseExpiresAt)
		);
	}

	/**
	 * Lease up to `limit` recovery notices to a session WITHOUT consuming them
	 * (design step 4 — claim → publish → ack). Concurrent sessions get disjoint
	 * claims; an unacked lease expires back into the pool so a wedged session
	 * cannot strand a notice.
	 */
	claimRecoveryNotices(sessionNonce: string, limit = 10): RecoveryNotice[] {
		const claimed: RecoveryNotice[] = [];
		for (const entry of this.pendingNotices.values()) {
			if (claimed.length >= limit) break;
			if (!this.noticeAvailable(entry)) continue;
			entry.leasedBy = sessionNonce;
			entry.leaseExpiresAt = this.now() + this.noticeLeaseTimeoutMs;
			claimed.push(entry.notice);
		}
		return claimed;
	}

	/**
	 * Ack a claimed notice AFTER it was observably enqueued into a started
	 * session — only then is it marked consumed in the ledger and removed.
	 * Returns false (and keeps the notice) when the claim does not match, the
	 * lease has expired (the notice may already belong to another session), or
	 * the durable notice_consumed write fails (without durability, a restart
	 * would redeliver — so an ack that isn't recorded must not report success).
	 */
	ackRecoveryNotice(id: string, sessionNonce: string): boolean {
		const entry = this.pendingNotices.get(id);
		if (!entry || entry.leasedBy !== sessionNonce) return false;
		if (entry.leaseExpiresAt !== null && this.now() > entry.leaseExpiresAt) return false;
		try {
			this.ledger?.markNoticeConsumed(id, entry.nonce);
		} catch (err) {
			this.log(`ledger notice_consumed append failed for ${id} — ack refused: ${String(err)}`);
			return false;
		}
		this.pendingNotices.delete(id);
		return true;
	}

	/**
	 * Release every unacked lease held by a session (idempotent) — called from
	 * the shared teardown path so startup failures, disconnects, time-limit
	 * closes, and goodbye all return undelivered notices to the pool.
	 */
	releaseRecoveryNotices(sessionNonce: string): void {
		for (const entry of this.pendingNotices.values()) {
			if (entry.leasedBy !== sessionNonce) continue;
			entry.leasedBy = null;
			entry.leaseExpiresAt = null;
		}
	}

	/**
	 * Drain available recovery notices for delivery (legacy consume-on-drain
	 * path, kept for the standalone demo). Draining marks them consumed in the
	 * ledger — each notice fires ONCE. Notices under a live unexpired lease are
	 * NOT drained (they belong to a claiming session).
	 */
	drainRecoveryNotices(): RecoveryNotice[] {
		const drained: RecoveryNotice[] = [];
		for (const [id, entry] of [...this.pendingNotices]) {
			if (!this.noticeAvailable(entry)) continue;
			try {
				this.ledger?.markNoticeConsumed(id, entry.nonce);
			} catch (err) {
				this.log(`ledger notice_consumed append failed for ${id}: ${String(err)}`);
			}
			this.pendingNotices.delete(id);
			drained.push(entry.notice);
		}
		return drained;
	}

	// -------------------------------------------------------------------------
	// HTTP surface
	// -------------------------------------------------------------------------

	private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'relay'}`);
		if (!url.pathname.startsWith('/v1/')) {
			this.json(res, 404, { error: 'not found' });
			return;
		}
		if (req.headers.authorization !== `Bearer ${this.opts.token}`) {
			this.json(res, 401, { error: 'unauthorized' });
			return;
		}

		if (req.method === 'GET' && url.pathname === '/v1/tasks') {
			this.handlePoll(url, res);
			return;
		}
		const ackMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)\/ack$/);
		if (req.method === 'POST' && ackMatch) {
			this.handleAck(decodeURIComponent(ackMatch[1]), res);
			return;
		}
		if (req.method === 'POST' && url.pathname === '/v1/results') {
			const payload = await this.body(req);
			if (payload === BODY_TOO_LARGE) {
				this.json(res, 413, { error: 'payload too large' });
				return;
			}
			this.handleResult(payload, res);
			return;
		}
		if (req.method === 'POST' && url.pathname === '/v1/heartbeat') {
			const payload = await this.body(req);
			if (payload === BODY_TOO_LARGE) {
				// An oversized heartbeat must not poison presence state.
				this.json(res, 413, { error: 'payload too large' });
				return;
			}
			this.lastHeartbeatAt = this.now();
			this.lastHeartbeat = payload;
			// M3 presence UX: a heartbeat arriving while stale is the
			// offline→online transition — fire exactly once per transition.
			this.firePresenceTransition();
			this.json(res, 200, {});
			return;
		}
		this.json(res, 404, { error: 'not found' });
		return;
	}

	private handlePoll(url: URL, res: ServerResponse): void {
		const waitSec = Math.max(0, Number(url.searchParams.get('wait') ?? '0') || 0);
		const waitMs = Math.min(waitSec * 1_000, this.opts.longPollCapMs);

		const respond = () => {
			const leased = this.leaseQueued();
			this.json(res, 200, { tasks: leased.map((t) => t.fields) });
		};

		if (this.hasQueued() || waitMs === 0) {
			respond();
			return;
		}

		// Parked long-polls are a bounded resource: each holds an open response
		// and a timer, so excess concurrent polls are refused outright (single-Mac
		// design — one bridge needs one parked poll, a handful covers restarts).
		if (this.parked.length >= this.opts.maxParkedPollers) {
			this.json(res, 429, { error: 'too many concurrent polls' });
			return;
		}

		// Park until a submit wakes us or the window expires.
		const remove = () => {
			const idx = this.parked.indexOf(poller);
			if (idx >= 0) this.parked.splice(idx, 1);
		};
		const poller: ParkedPoller = {
			respond: () => respond(),
			timer: setTimeout(() => {
				remove();
				respond();
			}, waitMs),
		};
		this.parked.push(poller);
		// A client that disconnects mid-park must release its slot and timer.
		res.on('close', () => {
			if (res.writableEnded) return; // normal completion, already removed
			remove();
			clearTimeout(poller.timer);
		});
	}

	private handleAck(id: string, res: ServerResponse): void {
		const task = this.tasks.get(id);
		if (!task) {
			this.log(`rejected ack for unknown id ${id}`);
			this.json(res, 404, { error: `unknown task id ${id}` });
			return;
		}
		switch (task.state) {
			case 'leased': {
				// M2 ack commit point: the `acked` transition is durably flushed
				// BEFORE ack success returns, so "acked on the Mac" always implies
				// "recorded on the bodhi host". If the write fails, reject the ack —
				// the lease expires into redelivery and nothing is lost.
				try {
					this.ledger?.append({ id, nonce: task.nonce, state: 'acked' });
				} catch (err) {
					this.log(`ledger ack append failed for ${id} — rejecting ack: ${String(err)}`);
					this.json(res, 500, { error: 'ledger write failed; retry via redelivery' });
					return;
				}
				task.state = 'acked';
				task.leaseExpiresAt = null;
				task.onDelivered?.();
				this.json(res, 200, {});
				return;
			}
			case 'acked':
				this.log(`rejected duplicate ack for ${id}`);
				this.json(res, 409, { error: `task ${id} already acked` });
				return;
			case 'cancelled':
				this.log(`rejected ack for cancelled/revoked ${id}`);
				this.json(res, 410, { error: `task ${id} cancelled` });
				return;
			default:
				this.log(`rejected ack for ${id} in state ${task.state}`);
				this.json(res, 409, { error: `task ${id} not leased` });
				return;
		}
	}

	private handleResult(payload: unknown, res: ServerResponse): void {
		const { id, body } = (payload ?? {}) as { id?: string; body?: string };
		if (!id || typeof body !== 'string') {
			this.json(res, 400, { error: 'expected { id, body }' });
			return;
		}
		const task = this.tasks.get(id);
		if (!task) {
			// M2 restart recovery: accept iff the ledger shows a durably recorded
			// pre-restart ack; classify by the persisted abandonment intent.
			const view = this.recovered.get(id);
			if (view) {
				this.recovered.delete(id);
				const reason =
					view.intent === null ? 'unclaimed_after_restart' : `orphaned_after_${view.intent}`;
				this.orphan(id, body, reason);
				try {
					this.ledger?.append({ id, nonce: view.nonce, state: 'completed' });
				} catch (err) {
					this.log(`ledger completed append failed for ${id}: ${String(err)}`);
				}
				this.json(res, 200, {});
				return;
			}
			this.log(`rejected result for unknown id ${id}`);
			this.json(res, 404, { error: `unknown task id ${id}` });
			return;
		}
		switch (task.state) {
			case 'acked': {
				if (task.waiter) {
					task.state = 'completed';
					task.waiter.resolve(body);
					task.waiter = null;
					try {
						this.ledger?.append({ id, nonce: task.nonce, state: 'completed' });
					} catch (err) {
						this.log(`ledger completed append failed for ${id}: ${String(err)}`);
					}
				} else {
					task.state = 'orphaned';
					this.orphan(id, body, 'result arrived after waiter was released');
				}
				this.json(res, 200, {});
				return;
			}
			case 'orphaned': {
				this.orphan(id, body, 'result for abandoned task');
				this.json(res, 200, {});
				return;
			}
			case 'leased':
				this.log(`rejected result before ack for ${id}`);
				this.json(res, 409, { error: `task ${id} not acked yet` });
				return;
			case 'cancelled':
				this.log(`rejected result for cancelled/revoked ${id}`);
				this.json(res, 410, { error: `task ${id} cancelled` });
				return;
			default:
				this.log(`rejected result for ${id} in state ${task.state}`);
				this.json(res, 409, { error: `task ${id} not delivered` });
				return;
		}
	}

	// -------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------

	private hasQueued(): boolean {
		for (const task of this.tasks.values()) {
			if (task.state === 'queued') return true;
		}
		return false;
	}

	private leaseQueued(): RelayTask[] {
		const leased: RelayTask[] = [];
		for (const task of this.tasks.values()) {
			if (task.state !== 'queued') continue;
			task.state = 'leased';
			task.leaseExpiresAt = this.now() + this.opts.leaseTimeoutMs;
			leased.push(task);
		}
		return leased;
	}

	private wakePollers(): void {
		for (const poller of this.parked.splice(0)) {
			clearTimeout(poller.timer);
			poller.respond();
		}
	}

	private sweep(): void {
		// M3 presence UX: freshness decays with time — the sweep is where the
		// online→offline transition is observed.
		this.firePresenceTransition();
		const now = this.now();
		for (const [id, task] of this.tasks) {
			if (task.state === 'leased' && task.leaseExpiresAt !== null && now > task.leaseExpiresAt) {
				// Ack never came — redeliver (the bridge's idempotent-write side makes
				// a duplicate delivery safe; ack-gated at-least-once).
				this.log(`lease expired for ${id} — requeueing for redelivery`);
				task.state = 'queued';
				task.leaseExpiresAt = null;
				this.wakePollers();
			}
			if ((task.state === 'queued' || task.state === 'leased') && now > task.expiresAt) {
				this.log(`task ${id} expired before delivery (TTL)`);
				task.state = 'expired';
				task.leaseExpiresAt = null;
				task.waiter?.reject(new StaleTaskError(id));
				task.waiter = null;
			}
		}
	}

	/** Fire presence listeners when the fresh/stale state actually changes. */
	private firePresenceTransition(): void {
		const fresh = this.presence().fresh;
		if (fresh === this.lastFreshState) return;
		this.lastFreshState = fresh;
		for (const listener of this.presenceListeners) {
			try {
				listener(fresh);
			} catch (err) {
				this.log(`presence listener error: ${String(err)}`);
			}
		}
	}

	private orphan(id: string, body: string, reason: string): void {
		this.log(`orphaned result for ${id}: ${reason}`);
		// Full body goes to the sink (protected sidecar) only; memory keeps a
		// bounded preview, so orphan retention is bounded in bytes by construction.
		if (this.orphanSink) {
			try {
				this.orphanSink(id, body, reason);
			} catch (err) {
				const code =
					err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : 'unknown';
				this.log(`orphan sink failed for ${id} (${code}) — body discarded`);
			}
		}
		this.orphanLog.push({
			id,
			preview: body.slice(0, this.opts.orphanPreviewChars),
			bytes: Buffer.byteLength(body, 'utf-8'),
			at: this.now(),
			reason,
		});
		if (this.orphanLog.length > SutandoRelayServer.ORPHAN_LOG_MAX) {
			this.orphanLog.splice(0, this.orphanLog.length - SutandoRelayServer.ORPHAN_LOG_MAX);
		}
	}

	/**
	 * Buffer the request body with a streaming cap: past `maxBodyBytes` the
	 * buffered chunks are released immediately and the remainder is discarded
	 * unbuffered, so an oversized/malicious body cannot grow process memory
	 * (nginx `client_max_body_size` is the outer wall in production).
	 */
	private body(req: IncomingMessage): Promise<unknown> {
		return new Promise((resolve) => {
			let chunks: Buffer[] = [];
			let total = 0;
			let settled = false;
			req.on('data', (chunk: Buffer) => {
				if (settled) return; // discard remainder unbuffered
				total += chunk.length;
				if (total > this.opts.maxBodyBytes) {
					settled = true;
					chunks = [];
					resolve(BODY_TOO_LARGE);
					return;
				}
				chunks.push(chunk);
			});
			req.on('end', () => {
				if (settled) return;
				settled = true;
				const raw = Buffer.concat(chunks).toString('utf-8').trim();
				if (!raw) {
					resolve({});
					return;
				}
				try {
					resolve(JSON.parse(raw));
				} catch {
					resolve({});
				}
			});
			req.on('error', () => {
				if (settled) return;
				settled = true;
				resolve({});
			});
		});
	}

	private json(res: ServerResponse, status: number, payload: unknown): void {
		if (res.writableEnded) return;
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(payload));
	}
}
