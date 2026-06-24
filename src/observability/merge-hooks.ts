// SPDX-License-Identifier: MIT

import type { FrameworkHooks } from '../types/hooks.js';

/** Merge multiple FrameworkHooks, invoking each hook for every source that
 *  defines it (e.g. metrics collector + app logging, or metrics + tracing).
 *  Later sources do not overwrite earlier — all registered handlers run, in
 *  source order. */
export function mergeHooks(...sources: FrameworkHooks[]): FrameworkHooks {
	const merged: Record<string, (ev: unknown) => void> = {};
	for (const src of sources) {
		for (const [key, fn] of Object.entries(src)) {
			if (typeof fn !== 'function') continue;
			const prev = merged[key];
			merged[key] = prev
				? (ev) => {
						prev(ev);
						(fn as (e: unknown) => void)(ev);
					}
				: (fn as (e: unknown) => void);
		}
	}
	return merged as FrameworkHooks;
}
