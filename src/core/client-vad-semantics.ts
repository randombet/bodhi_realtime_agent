/**
 * Versioned detector-semantics contract (G4,
 * design-speech-evidence-architecture.md §1). Split in two so the contract
 * enables the planned client-VAD redesign instead of freezing it:
 *
 * - STRUCTURAL compatibility (mandatory, invariant for any implementation):
 *   the `VAD_FRAME` bitflag lifecycle and per-frame ordering, monotonic
 *   `activeSegmentId`, the terminal-descriptor shape below, and the
 *   dual-track terminal rule (legacy `VadEvents` fire synchronously inside
 *   `process()`; the TERMINAL flag + `takeTerminal()` carry the ledger
 *   track after routing). Pinned by
 *   `test/core/client-vad-detector-semantics.test.ts` (structural suite).
 *
 * - CALIBRATION behavior (expected to change across detector versions):
 *   which frames classify as voiced and where segment boundaries fall.
 *   Pinned by `test/fixtures/client-vad/baseline-segments.json`; a
 *   replacement detector lands as an explicit, reviewed delta to that
 *   fixture (with expected-rate impact stated), never by silently weakening
 *   the structural suite.
 *
 * Bump `CLIENT_VAD_SEMANTICS_VERSION` when either half changes shape.
 * Internal contract — not exported from the package index.
 */

export const CLIENT_VAD_SEMANTICS_VERSION = 1;

/** Why a segment terminated. Ledger vocabulary is honest about what the
 *  signal IS: a `complete('provider-recognition')` forced by generic model
 *  activity is `'model-activity-forced'`, not proof of recognition. */
export type VadTerminalCause = 'silence' | 'model-activity-forced' | 'forced-reset';

export type VadTerminalOutcome = 'completed' | 'ignored' | 'aborted';

/** Allocation-free terminal descriptor: the detector reuses ONE mutable
 *  record, valid until the next terminal — consume (or copy) immediately.
 *  Three timestamps because they answer different questions: provider
 *  correlation matches the VOICED interval [firstVoicedAtMs, lastVoicedAtMs];
 *  ordering assertions and metrics use `resolvedAtMs` (silence completion
 *  resolves ~500 ms after the last voiced frame). */
export interface VadTerminalDescriptor {
	segmentId: number;
	outcome: VadTerminalOutcome;
	terminalCause: VadTerminalCause;
	startedAtMs: number;
	firstVoicedAtMs: number | null;
	lastVoicedAtMs: number | null;
	resolvedAtMs: number;
}
