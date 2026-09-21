/**
 * Dependency-free metric primitives for the observability module.
 *
 * Uses Prometheus-style cumulative histograms (fixed `le` buckets + sum + count)
 * rather than an in-process t-digest: percentiles are computed by Prometheus
 * (`histogram_quantile`) at query time, which keeps the framework dependency-free
 * and the exposition standard. Counters are cumulative and monotonic.
 */

/** Latency buckets (ms) tuned to voice-agent targets: 300ms "feels-instant",
 *  800ms acceptable, 1500ms degraded (see the HAI metrics investigation). */
export const DEFAULT_LATENCY_BUCKETS_MS = [50, 100, 200, 300, 500, 800, 1200, 2000, 5000];

/** Stable key for a label set (sorted, deterministic). */
export function labelKey(labels: Record<string, string>): string {
	return Object.keys(labels)
		.sort()
		.map((k) => `${k}=${labels[k]}`)
		.join(',');
}

/** A single cumulative histogram: fixed `le`-bucket boundaries + sum + count. */
export class Histogram {
	private readonly bounds: number[];
	/** Per-bucket (non-cumulative) counts; length = bounds.length + 1 for +Inf. */
	private readonly counts: number[];
	private _sum = 0;
	private _count = 0;

	constructor(buckets: number[] = DEFAULT_LATENCY_BUCKETS_MS) {
		this.bounds = [...buckets].sort((a, b) => a - b);
		this.counts = new Array(this.bounds.length + 1).fill(0);
	}

	observe(value: number): void {
		this._sum += value;
		this._count += 1;
		let i = 0;
		while (i < this.bounds.length && value > this.bounds[i]) i++;
		this.counts[i] += 1;
	}

	/** Cumulative `le → count` pairs, including the terminal `+Inf` bucket. */
	buckets(): Array<{ le: number; count: number }> {
		const out: Array<{ le: number; count: number }> = [];
		let cum = 0;
		for (let i = 0; i < this.bounds.length; i++) {
			cum += this.counts[i];
			out.push({ le: this.bounds[i], count: cum });
		}
		cum += this.counts[this.bounds.length];
		out.push({ le: Number.POSITIVE_INFINITY, count: cum });
		return out;
	}

	get sum(): number {
		return this._sum;
	}
	get count(): number {
		return this._count;
	}
}

/** A labeled histogram family — one `Histogram` per distinct label set. */
export class HistogramVec {
	private readonly series = new Map<string, { labels: Record<string, string>; hist: Histogram }>();

	constructor(private readonly buckets: number[] = DEFAULT_LATENCY_BUCKETS_MS) {}

	observe(labels: Record<string, string>, value: number): void {
		const key = labelKey(labels);
		let s = this.series.get(key);
		if (!s) {
			s = { labels, hist: new Histogram(this.buckets) };
			this.series.set(key, s);
		}
		s.hist.observe(value);
	}

	/** True if a label set is already tracked (used for cardinality caps). */
	has(labels: Record<string, string>): boolean {
		return this.series.has(labelKey(labels));
	}

	entries(): Array<{ labels: Record<string, string>; hist: Histogram }> {
		return [...this.series.values()];
	}

	get size(): number {
		return this.series.size;
	}
}

/** A labeled cumulative counter. */
export class Counter {
	private readonly series = new Map<string, { labels: Record<string, string>; value: number }>();

	inc(labels: Record<string, string> = {}, by = 1): void {
		const key = labelKey(labels);
		const cur = this.series.get(key);
		if (cur) cur.value += by;
		else this.series.set(key, { labels, value: by });
	}

	has(labels: Record<string, string>): boolean {
		return this.series.has(labelKey(labels));
	}

	entries(): Array<{ labels: Record<string, string>; value: number }> {
		return [...this.series.values()];
	}

	get size(): number {
		return this.series.size;
	}
}
