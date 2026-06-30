/**
 * Offline / out-of-band evaluation metrics (Phase 5): WER, MOS, task success
 * (TSR), first-call resolution (FCR), and sentiment. These are NOT live —
 * they come from post-call evaluation (reference transcripts, human/crowd MOS,
 * labeling, sentiment analysis) and are pushed to a Prometheus **Pushgateway**
 * (or a side table), then rendered on the Layer-2/Layer-4 dashboard panels.
 *
 * This module is pure (dependency-free): a WER harness plus an exposition
 * renderer the ingestion job POSTs to the Pushgateway. Wiring the actual eval
 * pipeline (running ASR over reference audio, collecting MOS, etc.) is the
 * operator's job and out of scope for the framework core.
 */

/**
 * Word Error Rate via word-level Levenshtein distance (substitutions + insertions
 * + deletions) / reference length. Case-insensitive, whitespace-tokenized.
 * Returns 0 when both are empty, 1 when only the reference is empty-but-hyp-isn't.
 */
export function computeWER(reference: string, hypothesis: string): number {
	const ref = reference.toLowerCase().trim().split(/\s+/).filter(Boolean);
	const hyp = hypothesis.toLowerCase().trim().split(/\s+/).filter(Boolean);
	if (ref.length === 0) return hyp.length === 0 ? 0 : 1;

	const m = ref.length;
	const n = hyp.length;
	// Rolling two-row DP edit distance.
	let prev = Array.from({ length: n + 1 }, (_, j) => j);
	let cur = new Array(n + 1).fill(0);
	for (let i = 1; i <= m; i++) {
		cur[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, cur] = [cur, prev];
	}
	return prev[n] / m;
}

/** One call's offline evaluation result. Booleans map to 0/1 gauges. */
export interface OfflineEvalMetrics {
	/** Word Error Rate, 0..1 (lower is better). */
	wer?: number;
	/** Mean Opinion Score, 1..5 (higher is better). */
	mos?: number;
	/** Task Success Rate per call: did the user accomplish their goal. */
	taskSuccess?: boolean;
	/** First-Call Resolution. */
	firstCallResolution?: boolean;
	/** Sentiment score, e.g. -1..1 (higher is better). */
	sentimentScore?: number;
}

function gauge(name: string, help: string, value: number, labels: Record<string, string>): string {
	const ls = Object.keys(labels)
		.sort()
		.map((k) => `${k}="${labels[k].replace(/(["\\])/g, '\\$1')}"`)
		.join(',');
	const suffix = ls ? `{${ls}}` : '';
	return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name}${suffix} ${value}\n`;
}

/**
 * Render offline eval metrics as Prometheus exposition (gauges) for a Pushgateway.
 * The ingestion job POSTs this to `.../metrics/job/<job>/...`. Only provided
 * fields are emitted. `labels` are low-cardinality grouping keys (e.g. agent,
 * eval batch) — never per-call PII.
 */
export function renderOfflineEvalMetrics(
	m: OfflineEvalMetrics,
	labels: Record<string, string> = {},
): string {
	const out: string[] = [];
	if (m.wer !== undefined)
		out.push(gauge('voice_eval_wer', 'Word Error Rate (0..1).', m.wer, labels));
	if (m.mos !== undefined)
		out.push(gauge('voice_eval_mos', 'Mean Opinion Score (1..5).', m.mos, labels));
	if (m.taskSuccess !== undefined)
		out.push(
			gauge('voice_eval_task_success', 'Task success (1=yes).', m.taskSuccess ? 1 : 0, labels),
		);
	if (m.firstCallResolution !== undefined)
		out.push(
			gauge(
				'voice_eval_fcr',
				'First-call resolution (1=yes).',
				m.firstCallResolution ? 1 : 0,
				labels,
			),
		);
	if (m.sentimentScore !== undefined)
		out.push(gauge('voice_eval_sentiment', 'Sentiment score (-1..1).', m.sentimentScore, labels));
	return out.join('\n');
}
