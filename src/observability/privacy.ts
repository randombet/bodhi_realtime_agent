// SPDX-License-Identifier: MIT

/**
 * Privacy / cardinality / sampling controls for the metrics collector.
 *
 * The collector already stores no transcript text and no per-entity (session/
 * user) labels; this formalizes the configurable hardening: a label-key
 * allowlist, a per-dimension cardinality cap (fold to `"other"`), and
 * session-level sampling with event-biased keep-all.
 */
export interface PrivacyConfig {
	/** Max distinct values per capped label dimension before folding to "other". */
	maxLabelCardinality: number;
	/** When set, only these label keys may be emitted; others are dropped. */
	labelAllowlist?: string[];
	/** Fraction of sessions whose high-volume observations are recorded (0..1).
	 *  Errors, barge-ins, turn counts, jump-ins, re-entries, and slow turns are
	 *  always kept regardless (event-biased — rare/interesting events survive). */
	sessionSamplingRate: number;
	/** A turn at/above this end-to-end latency (ms) is always kept. */
	slowTurnMs: number;
}

export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
	maxLabelCardinality: 50,
	sessionSamplingRate: 1,
	slowTurnMs: 1500,
};

/** Deterministic [0,1) hash of a string (FNV-1a) — stable per session id. */
export function hashUnit(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0) / 0xffffffff;
}

/**
 * Bounds label cardinality per dimension: tracks distinct values and folds any
 * beyond `max` into `"other"`, logging once per dimension so truncation is never
 * silent.
 */
export class LabelGuard {
	private readonly seen = new Map<string, Set<string>>();
	private readonly logged = new Set<string>();

	constructor(
		private readonly max: number,
		private readonly log?: (msg: string) => void,
	) {}

	/** Cap one dimension's value, folding + logging once on overflow. */
	cap(dimension: string, value: string): string {
		let s = this.seen.get(dimension);
		if (!s) {
			s = new Set();
			this.seen.set(dimension, s);
		}
		if (s.has(value)) return value;
		if (s.size < this.max) {
			s.add(value);
			return value;
		}
		if (!this.logged.has(dimension)) {
			this.logged.add(dimension);
			this.log?.(
				`[metrics] cardinality cap (${this.max}) reached for label "${dimension}"; folding new values to "other"`,
			);
		}
		return 'other';
	}
}
