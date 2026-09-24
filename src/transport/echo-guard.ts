// echo-guard.ts — acoustic echo suppression at the audio-ingestion chokepoint.
//
// Problem: when the client plays the assistant's TTS
// through a speaker (speakerphone, laptop speakers), that audio loops back
// into the microphone. Downstream STT then transcribes the assistant's own
// voice — and on noisy phone paths Gemini STT HALLUCINATES complete fake
// user commands from it ("Maddy, can you look up the weather in New York?"),
// fabricated wake flags included. Filtering transcripts downstream is
// symptom-level; the root fix is to stop the echo audio from ever reaching
// the model/STT.
//
// Approach: the session knows exactly what it is playing. Keep a short
// rolling ENERGY ENVELOPE of the outbound audio (the reference); compute the
// same envelope for inbound audio; an inbound window whose envelope
// correlates strongly with the reference at a stable lag IS the assistant's
// own echo — real speech does not track the reference's energy shape.
// Envelope correlation (not raw cross-correlation) on purpose: the echo path
// (codec round-trips, client DSP, room acoustics) destroys phase but keeps
// the energy shape. The math is ported from an echo-match shadow detector
// that calibrated corr 0.6–0.98 on real speaker sessions.
//
// Fail-safe bias: suppression requires a sustained streak of high-correlation
// windows, and only while the reference is fresh (something actually played
// recently). One correlated window never mutes anyone; silence in the
// reference ring disables the guard entirely.

/** One 20ms energy sample of played (reference) audio. */
export type EchoEnvEntry = { rms: number; at: number };

/** Pearson correlation of two equal-length envelopes (0 when degenerate). */
export function envelopePearson(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	if (n < 8) return 0;
	let sa = 0;
	let sb = 0;
	for (let i = 0; i < n; i++) {
		sa += a[i];
		sb += b[i];
	}
	const ma = sa / n;
	const mb = sb / n;
	let num = 0;
	let da = 0;
	let db = 0;
	for (let i = 0; i < n; i++) {
		const xa = a[i] - ma;
		const xb = b[i] - mb;
		num += xa * xb;
		da += xa * xa;
		db += xb * xb;
	}
	const den = Math.sqrt(da * db);
	return den > 1e-6 ? num / den : 0;
}

/** Best (corr, lagMs) of the input envelope vs the played-envelope ring over 0..maxLagMs. */
export function bestEnvelopeLag(
	inputEnv: number[],
	played: EchoEnvEntry[],
	nowMs: number,
	winPts: number,
	maxLagMs: number,
	stepMs: number,
): { corr: number; lagMs: number } {
	let best = { corr: 0, lagMs: -1 };
	if (inputEnv.length < winPts || played.length < winPts) return best;
	const inp = inputEnv.slice(-winPts);
	for (let lag = 0; lag <= maxLagMs; lag += stepMs) {
		// reference window ends at (now - lag), spans winPts*20ms back
		const end = nowMs - lag;
		const start = end - winPts * 20;
		const ref: number[] = [];
		for (const e of played) {
			if (e.at >= start && e.at < end) ref.push(e.rms);
		}
		if (ref.length < winPts * 0.7) continue;
		const c = envelopePearson(inp, ref.slice(-winPts));
		if (c > best.corr) best = { corr: c, lagMs: lag };
	}
	return best;
}

export interface EchoGuardConfig {
	/** Master switch. OPT-IN: default false — set true to activate; env BODHI_ECHO_GUARD=0 hard-disables even then. */
	enabled?: boolean;
	/** Correlation at/above which a window counts as echo. Default 0.75. */
	corrThreshold?: number;
	/** Consecutive echo windows required before suppression starts. Default 2. */
	streakToSuppress?: number;
	/** Max lag drift (ms) between consecutive windows for the streak to continue.
	 *  Real echo sits at a stable lag; spurious correlation peaks wander. Default 60. */
	lagToleranceMs?: number;
	/** Max playback→mic lag searched, ms. Default 1500. */
	maxLagMs?: number;
	/** Lag search step, ms. Default 20 (one envelope frame). */
	stepMs?: number;
	/** Correlation window length in 20ms points. Default 12 (240ms). */
	winPts?: number;
	/** How long the reference stays fresh after playback stops, ms. Default 2000. */
	refFreshMs?: number;
	/** Log callback for suppression events. */
	log?: (msg: string) => void;
}

export interface EchoCheckResult {
	suppress: boolean;
	corr: number;
	lagMs: number;
}

const FRAME_MS = 20;

/**
 * Per-session echo suppressor. Feed every OUTBOUND audio chunk through
 * {@link feedReference} and run every INBOUND chunk through {@link check};
 * a `suppress: true` result means the inbound chunk is (part of) the
 * assistant's own playback echoed back and should not be forwarded to the
 * model or STT.
 */
export class EchoGuard {
	private readonly cfg: Required<Omit<EchoGuardConfig, 'log'>>;
	private readonly log?: (msg: string) => void;
	private played: EchoEnvEntry[] = [];
	private inputEnv: number[] = [];
	private streak = 0;
	private streakLagMs = -1;
	private lastRefAt = 0;
	private refCarrySamples = 0; // partial-frame carry so short chunks still form frames
	private refCarrySumSq = 0;
	private inCarrySamples = 0;
	private inCarrySumSq = 0;
	private suppressedWindows = 0;

	constructor(config?: EchoGuardConfig) {
		this.cfg = {
			// OPT-IN (a deliberate review decision): suppression only runs when the
			// consumer explicitly enables it — the double-talk cost (overlapped
			// user speech on strong-echo paths can be dropped with the echo) must
			// be a deliberate per-deployment choice, not a library default.
			enabled: config?.enabled === true && process.env.BODHI_ECHO_GUARD !== '0',
			corrThreshold: config?.corrThreshold ?? 0.75,
			streakToSuppress: config?.streakToSuppress ?? 2,
			lagToleranceMs: config?.lagToleranceMs ?? 60,
			maxLagMs: config?.maxLagMs ?? 1500,
			stepMs: config?.stepMs ?? 20,
			winPts: config?.winPts ?? 12,
			refFreshMs: config?.refFreshMs ?? 2000,
		};
		this.log = config?.log;
	}

	get enabled(): boolean {
		return this.cfg.enabled;
	}

	/** Total inbound windows suppressed this session (observability). */
	get suppressedCount(): number {
		return this.suppressedWindows;
	}

	/** Feed one outbound (played) PCM chunk — s16le mono at `sampleRate`. */
	feedReference(pcm: Buffer, sampleRate: number, nowMs: number = Date.now()): void {
		if (!this.cfg.enabled) return;
		this.lastRefAt = nowMs;
		const frames = this.pcmToFrames(pcm, sampleRate, true, nowMs);
		for (const f of frames) this.played.push(f);
		// keep ~6s of reference
		const cutoff = nowMs - 6000;
		if (this.played.length > 512) this.played = this.played.filter((e) => e.at >= cutoff);
	}

	/**
	 * Check one inbound (mic) PCM chunk — s16le mono at `sampleRate`.
	 * Returns suppress=true when the chunk correlates with recent playback.
	 */
	check(pcm: Buffer, sampleRate: number, nowMs: number = Date.now()): EchoCheckResult {
		if (!this.cfg.enabled) return { suppress: false, corr: 0, lagMs: -1 };
		const frames = this.pcmToFrames(pcm, sampleRate, false, nowMs);
		for (const f of frames) this.inputEnv.push(f.rms);
		if (this.inputEnv.length > 256) this.inputEnv = this.inputEnv.slice(-256);
		// Guard only while the reference is fresh — nothing playing recently
		// means nothing to echo, so never suppress (fail-open for real speech).
		if (nowMs - this.lastRefAt > this.cfg.refFreshMs) {
			this.streak = 0;
			return { suppress: false, corr: 0, lagMs: -1 };
		}
		const best = bestEnvelopeLag(
			this.inputEnv,
			this.played,
			nowMs,
			this.cfg.winPts,
			this.cfg.maxLagMs,
			this.cfg.stepMs,
		);
		if (best.corr >= this.cfg.corrThreshold) {
			// Real echo sits at a STABLE lag across windows; spurious correlation
			// peaks (a 75-lag search over short windows finds some by chance)
			// wander. Only a lag-consistent window extends the streak.
			if (this.streak > 0 && Math.abs(best.lagMs - this.streakLagMs) <= this.cfg.lagToleranceMs) {
				this.streak++;
			} else {
				this.streak = 1;
			}
			this.streakLagMs = best.lagMs;
		} else {
			this.streak = 0;
			this.streakLagMs = -1;
		}
		const suppress = this.streak >= this.cfg.streakToSuppress;
		if (suppress) {
			this.suppressedWindows++;
			if (this.suppressedWindows === 1 || this.suppressedWindows % 50 === 0) {
				this.log?.(
					`[EchoGuard] suppressing inbound echo (corr=${best.corr.toFixed(2)} lag=${best.lagMs}ms, total=${this.suppressedWindows})`,
				);
			}
		}
		return { suppress, corr: best.corr, lagMs: best.lagMs };
	}

	/** Convert an s16le mono PCM buffer into 20ms RMS envelope frames. */
	private pcmToFrames(
		pcm: Buffer,
		sampleRate: number,
		isRef: boolean,
		nowMs: number,
	): EchoEnvEntry[] {
		const samplesPerFrame = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
		const total = Math.floor(pcm.length / 2);
		const out: EchoEnvEntry[] = [];
		let carrySamples = isRef ? this.refCarrySamples : this.inCarrySamples;
		let carrySumSq = isRef ? this.refCarrySumSq : this.inCarrySumSq;
		// Frames are stamped backwards from `nowMs` (the chunk just arrived/played).
		const framesInChunk = Math.ceil((carrySamples + total) / samplesPerFrame);
		let frameIdx = 0;
		for (let i = 0; i < total; i++) {
			const s = pcm.readInt16LE(i * 2) / 32768;
			carrySumSq += s * s;
			carrySamples++;
			if (carrySamples >= samplesPerFrame) {
				const rms = Math.sqrt(carrySumSq / carrySamples);
				const at = nowMs - (framesInChunk - 1 - frameIdx) * FRAME_MS;
				out.push({ rms, at });
				frameIdx++;
				carrySamples = 0;
				carrySumSq = 0;
			}
		}
		if (isRef) {
			this.refCarrySamples = carrySamples;
			this.refCarrySumSq = carrySumSq;
		} else {
			this.inCarrySamples = carrySamples;
			this.inCarrySumSq = carrySumSq;
		}
		return out;
	}
}
