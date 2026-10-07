import type { STTAudioConfig, STTProvider } from '../types/transport.js';
import { compareTranscripts, isSubstantiveDivergence } from './shadow-stt.js';

/** Most turns whose live transcript is kept waiting for a shadow result. */
const MAX_LIVE_SNAPSHOTS = 8;

/** Collaborators the {@link ShadowSttController} needs, injected so it holds no
 *  `VoiceSession` reference. */
export interface ShadowSttControllerDeps {
	/** The shadow transcriber. Configured and given its `onTranscript` callback
	 *  by the controller's constructor. */
	provider: STTProvider;
	/** Format of the audio the session feeds: raw client PCM. */
	audio: STTAudioConfig;
	/** The session's current numeric turn id. */
	getCurrentTurnId: () => number;
	/** Called once per divergence with the built-in and the shadow transcript. */
	onDivergence?: (live: string, shadow: string, turnId?: number) => void;
	/** Whether a meaningful divergence on the current turn is corrected. */
	correctionEnabled: boolean;
	/** Deliver a correction for `turnId`. Resolves whether it was sent. */
	sendCorrection: (correctionText: string, turnId: number) => Promise<boolean>;
	log: (msg: string) => void;
}

/**
 * Observation-only second transcription. The shadow provider hears the same
 * audio as the model; its per-turn transcript is compared with the model's
 * built-in transcription of that turn, and a disagreement is logged and
 * reported through `onDivergence`. The shadow never feeds the transcript
 * manager, so conversation history and the model's input are unchanged.
 *
 * Built-in transcription accumulates through {@link noteLiveTranscript}.
 * {@link commit} runs when the model starts responding: it snapshots that text
 * under the turn id and asks the provider to transcribe the turn, so the
 * provider's result, which arrives later, is compared against its own turn's
 * text rather than whatever has accumulated since.
 *
 * With `correctionEnabled`, a meaningful divergence on the still-current turn
 * asks the session to correct the answer through `sendCorrection`.
 */
export class ShadowSttController {
	private liveText = '';
	/** Built-in transcript of each committed turn, until its shadow result
	 *  arrives. Bounded to {@link MAX_LIVE_SNAPSHOTS}, oldest evicted first. */
	private readonly snapshots = new Map<number, string>();
	private lastCommittedTurn = -1;

	constructor(private readonly deps: ShadowSttControllerDeps) {
		deps.provider.configure(deps.audio);
		deps.provider.onTranscript = (text, turnId) => this.handleShadowTranscript(text, turnId);
	}

	start(): Promise<void> {
		return this.deps.provider.start();
	}

	stop(): Promise<void> {
		return this.deps.provider.stop();
	}

	feedAudio(base64Pcm: string): void {
		this.deps.provider.feedAudio(base64Pcm);
	}

	/** Accumulate a built-in (model-side) transcription chunk for the current turn. */
	noteLiveTranscript(text: string): void {
		this.liveText += text;
	}

	/** Snapshot the current turn's built-in transcript and commit the provider.
	 *  Runs once per turn id; repeated calls for the same turn are ignored. */
	commit(turnId: number): void {
		if (this.lastCommittedTurn === turnId) return;
		this.lastCommittedTurn = turnId;
		this.snapshots.set(turnId, this.liveText);
		this.liveText = '';
		if (this.snapshots.size > MAX_LIVE_SNAPSHOTS) {
			const oldest = this.snapshots.keys().next().value;
			if (oldest !== undefined) this.snapshots.delete(oldest);
		}
		this.deps.provider.commit(turnId);
	}

	/** The correction sent to the model: what the shadow heard, what the model
	 *  answered, and how to recover. */
	static buildCorrectionText(shadowText: string, liveText: string): string {
		return `[TRANSCRIPTION CORRECTION — not the user speaking] A second transcription shows the user actually said: "${shadowText}". You answered a mishearing ("${liveText}"). In ONE short sentence acknowledge the correction (e.g. "sorry — you asked about …"), then answer the user's ACTUAL question. Do not repeat the wrong answer.`;
	}

	private handleShadowTranscript(text: string, turnId?: number): void {
		// A result for a committed turn compares against that turn's snapshot;
		// one without a turn id takes the text accumulated so far.
		const live = turnId !== undefined ? (this.snapshots.get(turnId) ?? '') : this.liveText;
		if (turnId !== undefined) this.snapshots.delete(turnId);
		else this.liveText = '';
		const result = compareTranscripts(live, text);
		// Logged on every compare, so a quiet session is distinguishable from a
		// shadow provider that stopped reporting.
		this.deps.log(`[ShadowSTT] turn ${turnId ?? '?'} compared: ${result.reason}`);
		if (!result.diverged) return;
		this.deps.log(
			`[ShadowSTT] DIVERGENCE turn=${turnId ?? '?'} live="${result.normalizedLive}" shadow="${result.normalizedShadow}"`,
		);
		try {
			this.deps.onDivergence?.(live, text, turnId);
		} catch {
			/* an observer must never break the session */
		}
		// Every divergence is reported above; only a meaningful one on the
		// still-current turn is corrected. A result for an older turn would
		// derail the exchange the user has already moved on to.
		if (
			!this.deps.correctionEnabled ||
			turnId === undefined ||
			turnId !== this.deps.getCurrentTurnId() ||
			!isSubstantiveDivergence(live, text)
		) {
			return;
		}
		this.deps.log(`[ShadowSTT] speaking self-correction for turn ${turnId}`);
		this.deps
			.sendCorrection(ShadowSttController.buildCorrectionText(text, live), turnId)
			.catch(() => {
				/* the divergence is already reported; a failed send must not break the session */
			});
	}
}
