/**
 * Key-aware speech-pacing mapping (plan step B5, client half).
 *
 * The server drives pacing via `behavior.changed { key: 'pacing', preset }`
 * and announces initial state in `behavior.catalog` (`categories[].active`).
 * Several behavior categories share preset names (`pacing` and `verbosity`
 * both have `normal`), so consumers MUST filter by category key before
 * mapping preset → rate — a name-only mapping applies pacing `slow` and then
 * overwrites it with verbosity `normal`, order-dependently.
 */

import {
	type BehaviorCatalogCategory,
	PACING_KEY,
	PACING_PRESET_RATES,
} from '@bodhi/client-protocol';

export type PacingRates = Readonly<Record<string, number>>;

/** Rate for a `behavior.changed` frame; null when it isn't a pacing change
 *  or the preset is unknown to the table. */
export function rateForBehaviorChange(
	key: string,
	preset: string,
	rates: PacingRates = PACING_PRESET_RATES,
): number | null {
	if (key !== PACING_KEY) return null;
	return rates[preset] ?? null;
}

/** Rate for the catalog's active pacing preset; null when absent/unknown. */
export function rateFromCatalog(
	categories: readonly BehaviorCatalogCategory[],
	rates: PacingRates = PACING_PRESET_RATES,
): number | null {
	const pacing = categories.find((c) => c.key === PACING_KEY);
	if (!pacing?.active) return null;
	return rates[pacing.active] ?? null;
}
