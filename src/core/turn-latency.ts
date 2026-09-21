import type { TurnLatencySegments } from '../types/hooks.js';

/**
 * Re-exported for existing importers; the canonical home is `types/hooks.ts`.
 * The segment computation that used to live here was absorbed by
 * `TurnLatencyTracker` (turn-latency-tracker.ts) — the §11 observability
 * design replaced finalize-time reads + clamps with event-sourced correlation
 * and per-segment plausibility guards.
 */
export type { TurnLatencySegments };
