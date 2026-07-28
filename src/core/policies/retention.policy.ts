/**
 * Retention policy (D1 + H3) — pure, unit-tested in isolation
 * (design-speech-evidence-architecture.md §2). Load-bearing rule: seal ONLY
 * when the segment completed with `routed.llm` audio AND replay recovery is
 * enabled — the retainer holds LLM-route PCM, so external/STT routing has no
 * replayable audio and retaining it would weaken H3 (stale-candidate
 * guarantees).
 *
 * Provider-forced (`model-activity-forced`) segments abort even when routed:
 * sealing at that terminal would recreate a replay candidate for speech the
 * model has already begun answering — today's latent re-seal bug, fixed
 * knowingly in Phase 2 as an enumerated expected divergence.
 *
 * Internal — not exported from the package index.
 */

import type { SegmentEvidence } from '../user-turn-evidence.js';

export type RetentionVerdict = 'seal' | 'abort';

export function decideRetention(
	ev: Readonly<SegmentEvidence>,
	cfg: { replayRecovery: boolean },
): RetentionVerdict {
	if (ev.outcome !== 'completed') return 'abort';
	if (!cfg.replayRecovery) return 'abort';
	if (!ev.routed.llm) return 'abort';
	if (ev.terminalCause === 'model-activity-forced') return 'abort';
	return 'seal';
}
