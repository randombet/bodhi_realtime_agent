import type { ConnectFailure, ConnectionLifecycleEvent } from '../types/transport.js';

/**
 * Attempt-versus-generation identity for one transport's connection lifecycle.
 *
 * An attempt is one dial (`att_<seq>`, from the transport's dial counter); a
 * generation is minted only when an attempt completes setup. The ledger turns
 * the transport's raw facts into `ConnectionLifecycleEvent`s: a close before
 * setup is an `attempt-close` without a generation, a close after it is a
 * `generation-close` carrying one, and each attempt closes at most once however
 * many close signals (socket close, local disconnect) arrive.
 *
 * An attempt authenticated by a credential provider carries the provider's
 * opaque `meta` on every event after the provider returned
 * ({@link credentialIssued}); without one, no event has a `meta` key.
 *
 * Internal: not exported from any barrel. The transport keeps stale sockets
 * away from it (Gemini's `dialGen` fence), so every call describes the current
 * attempt. Observer failures are caught and reported through `warn`; they never
 * reach the transport's state machine.
 */
export class ConnectionLifecycleLedger {
	private attemptId = '';
	private attemptSetupDone = false;
	private closeEmittedFor = '';
	private transportGeneration = 0;
	/** The current attempt's credential, once its provider returned. */
	private credential: { meta: unknown } | null = null;

	constructor(
		private readonly emit: (event: ConnectionLifecycleEvent) => void,
		private readonly warn: (msg: string, err: unknown) => void = (msg, err) =>
			console.warn(msg, err),
	) {}

	/** Start attempt `att_<seq>` and emit `attempt`. Returns the attempt id. */
	beginAttempt(seq: number, handleSupplied: boolean): string {
		this.attemptId = `att_${seq}`;
		this.attemptSetupDone = false;
		this.credential = null;
		this.notify({ kind: 'attempt', connectAttemptId: this.attemptId, handleSupplied });
		return this.attemptId;
	}

	/** The current attempt's credential provider returned: its `meta` rides on
	 *  every later event of this attempt. */
	credentialIssued(meta: unknown): void {
		this.credential = { meta };
	}

	/** The current attempt completed setup: mint the next generation, emit `setup-ok`. */
	setupOk(): number {
		this.transportGeneration++;
		this.attemptSetupDone = true;
		this.notify({
			kind: 'setup-ok',
			connectAttemptId: this.attemptId,
			transportGeneration: this.transportGeneration,
			...this.metaField(),
		});
		return this.transportGeneration;
	}

	/** The current attempt failed before (or instead of) completing setup. */
	setupFailed(reason?: string, failure?: ConnectFailure): void {
		this.notify({
			kind: 'setup-failed',
			connectAttemptId: this.attemptId,
			reason,
			...this.metaField(),
			...(failure ? { failure } : {}),
		});
	}

	/** The current attempt's socket closed: `attempt-close` before setup,
	 *  `generation-close` after it; once per attempt. `failure` describes a
	 *  close before setup. */
	socketClosed(code?: number, reason?: string, failure?: ConnectFailure): void {
		if (!this.claimClose()) return;
		this.notify(
			this.attemptSetupDone
				? {
						kind: 'generation-close',
						connectAttemptId: this.attemptId,
						transportGeneration: this.transportGeneration,
						code,
						reason,
						...this.metaField(),
					}
				: {
						kind: 'attempt-close',
						connectAttemptId: this.attemptId,
						code,
						reason,
						...this.metaField(),
						...(failure ? { failure } : {}),
					},
		);
	}

	/** The current attempt ended before it had a socket (its credential
	 *  provider failed): an `attempt-close` carrying the failure, once per
	 *  attempt, like a socket that closed before setup. */
	closedBeforeDial(failure: ConnectFailure): void {
		this.socketClosed(undefined, failure.message, failure);
	}

	/** A locally initiated close of a set-up connection. The socket's own close
	 *  usually lands after the next dial has fenced it off, so the close is
	 *  emitted here deterministically (`1000 'local disconnect'` unless another
	 *  reason is given); a later socket close for the same attempt is dropped.
	 *  No-op before setup. */
	localDisconnect(reason = 'local disconnect'): void {
		if (!this.attemptSetupDone || !this.claimClose()) return;
		this.notify({
			kind: 'generation-close',
			connectAttemptId: this.attemptId,
			transportGeneration: this.transportGeneration,
			code: 1000,
			reason,
			...this.metaField(),
		});
	}

	/** `{ meta }` once this attempt has a credential; nothing otherwise, so an
	 *  attempt without a provider emits exactly the events it always did. */
	private metaField(): { meta?: unknown } {
		return this.credential ? { meta: this.credential.meta } : {};
	}

	/** True the first time the current attempt closes. */
	private claimClose(): boolean {
		if (this.attemptId === '' || this.closeEmittedFor === this.attemptId) return false;
		this.closeEmittedFor = this.attemptId;
		return true;
	}

	private notify(event: ConnectionLifecycleEvent): void {
		try {
			this.emit(event);
		} catch (err) {
			this.warn(
				'[ConnectionLifecycleLedger] onConnectionLifecycle observer threw; lifecycle continues:',
				err,
			);
		}
	}
}
