/**
 * Response-trigger coordinator (design-speech-evidence-architecture.md §2,
 * Phase 3) — the enforcement boundary for framework-owned generation
 * triggers. In Phase 3 it is INVALIDATION-ONLY: competing triggers
 * (direct input, notifications, watchdog recovery) synchronously invalidate
 * the H1 greeting token before dispatch, so a model turn they cause can
 * never bind as the greeting; they still DISPATCH exactly as today.
 *
 * The contention matrix's queue/hold cells are deliberately NOT active in
 * this phase: Phase-3 expected divergences are limited to the H1 hardening
 * cases, and queueing notifications/recovery would change user-visible
 * timing beyond that list. Hold semantics land with the Phase-4 recovery
 * state machine (H4), which owns the `held-gate` state this coordinator
 * merely seams into. Same-response operations (`tool-result` continuations)
 * and greeting/transfer-greeting registrations are NOT competing triggers.
 *
 * Actor-runtime notification deliveries reach this coordinator through the
 * `RuntimeOrchestrator.notification.onTransportDeliver` hook (TransportActor
 * invokes it before its `adapter.sendContent` wire-out), closing the
 * enforcement residual the Phase-3 audit tracked. `assistant-initiated`
 * covers `VoiceSession.guardedTriggerGeneration` — any framework-owned
 * proactive generation trigger.
 *
 * Internal — not exported from the package index.
 */

export type TriggerClass =
	| 'greeting'
	| 'transfer-greeting'
	| 'direct-input'
	| 'notification'
	| 'watchdog-recovery'
	| 'assistant-initiated'
	| 'tool-result';

const COMPETING: ReadonlySet<TriggerClass> = new Set([
	'direct-input',
	'notification',
	'watchdog-recovery',
	'assistant-initiated',
]);

export class ResponseTriggerCoordinator {
	constructor(
		private readonly deps: {
			/** Invalidate the greeting token (and release the gate) BEFORE the
			 *  competing trigger dispatches. */
			onCompetingTrigger(cls: TriggerClass): void;
		},
	) {}

	/** Announce a framework-owned generation trigger about to dispatch. */
	dispatch(cls: TriggerClass): void {
		if (!COMPETING.has(cls)) return; // greeting/transfer register; tool-result continues
		this.deps.onCompetingTrigger(cls);
	}
}
