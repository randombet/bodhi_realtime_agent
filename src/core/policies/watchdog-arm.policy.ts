/**
 * Watchdog-arm policy (B1) — pure, unit-tested in isolation; the session
 * invokes it and actuates the verdict (design-speech-evidence-architecture.md
 * §2). Phase 2 ships `arm` / `skip-no-eligible-route` / `skip-non-agent`,
 * exactly matching today's behavior plus the approved Phase-0 fully-gated
 * skip: a routed provider-forced segment still arms (self-healed by the
 * disarm chain as now). `skip-already-answered` exists in the verdict type
 * but activates only when the transport correlation-ID contract lands —
 * epochs alone are ordering facts, not causal proof.
 *
 * Internal — not exported from the package index.
 */

import type { SegmentEvidence } from '../user-turn-evidence.js';

export type WatchdogArmVerdict =
	| 'arm'
	| 'skip-no-eligible-route'
	| 'skip-non-agent'
	| 'skip-already-answered';

export function decideWatchdogArm(
	ev: Readonly<SegmentEvidence>,
	mode: { agentMode: boolean },
): WatchdogArmVerdict {
	if (ev.outcome !== 'completed') return 'skip-no-eligible-route';
	if (!mode.agentMode) return 'skip-non-agent';
	// Watchdog eligibility: the model (or an external agent) can only owe a
	// reply for audio that was admitted onto its route (§1 route-outcome
	// table). STT-only routing never arms — transcription output is not a
	// model reply.
	if (!ev.routed.llm && !ev.routed.external) return 'skip-no-eligible-route';
	return 'arm';
}
