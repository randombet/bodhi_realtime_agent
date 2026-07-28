import { resamplePcm } from '../audio/resample.js';
import { encodePcmToMulaw } from '../telephony/audio-codec.js';
import type { LLMTransport, STTProvider } from '../types/transport.js';
import { VAD_FRAME } from './client-vad-detector.js';
import type { ClientVadDetector } from './client-vad-detector.js';
import type { UserTurnEvidenceLedger } from './user-turn-evidence.js';

/**
 * Internal audio-routing mode — the public `TranscriptionMode` ('agent' |
 * 'transcription') plus the two transient transition states the router buffers
 * across.
 */
export type InternalTranscriptionMode =
	| 'agent'
	| 'starting_transcription'
	| 'transcription'
	| 'stopping_transcription';

/** Bounded cap for mic audio buffered during a mode transition — roughly 2 s of
 *  24 kHz PCM16 mono (48 000 B/s × 2). */
const MAX_TRANSITION_BUFFER_BYTES = 96_000;

/** Collaborators the router needs, injected so it holds no `VoiceSession`
 *  reference. Providers and gate state are read through getters/predicates so
 *  the router observes the same call-time values the inline code did. */
export interface AudioRouterDeps {
	transport: LLMTransport;
	vad: ClientVadDetector;
	/** Inbound client PCM sample rate (what `handleFromClient` receives). */
	clientAudioInputRate: number;
	getSttProvider: () => STTProvider | undefined;
	getWhisperProvider: () => STTProvider | undefined;
	isSessionActive: () => boolean;
	/** True when a direct-RTC audio plane is live — websocket frames are ignored. */
	isRtcAudioReady: () => boolean;
	getMode: () => InternalTranscriptionMode;
	/** Drop outbound transport + STT audio during the greeting-grace window. */
	shouldDropOutbound: () => boolean;
	/** If the active agent uses external audio, route the frame there and return
	 *  `true` so the router does not forward it to the transport. */
	routeExternalAudio: (data: Buffer) => boolean;
	/** Optional last-utterance retention tee (watchdog-stall recovery replay).
	 *  Fed the transport-normalized PCM only on the agent path, after the
	 *  greeting-grace gate — retention must mirror what the model received. */
	retainer?: { feed(data: Buffer): void };
	/** Phase-1 evidence ledger (shadow mode). The router is the ROUTED-bit
	 *  source: it updates the live record atomically with each routing
	 *  decision and finalizes frame-driven terminals AFTER routing the
	 *  terminal frame (dual-track — see
	 *  design-speech-evidence-architecture.md §1). Optional so unit harnesses
	 *  without evidence keep working. */
	ledger?: UserTurnEvidenceLedger;
	/** Model-turn-start count at segment start (advisory epoch fact). */
	getResponseEpoch?: () => number;
	/** Clock for ledger timestamps (the session's metric clock). */
	nowMs?: () => number;
}

/**
 * Inbound client-audio fast path, extracted from `VoiceSession` (Step 3 of the
 * modularization plan). Owns the transcription-mode dispatch, the transition
 * buffer, and the μ-law encode. The VAD, greeting-grace gate, external-audio
 * routing, and current mode are injected, so the router holds no session
 * reference. Hot path: no per-frame allocation beyond the existing resample /
 * encode the inline code already performed.
 */
export class AudioRouter {
	private transitionBuffer: Buffer[] = [];
	private transitionBufferBytes = 0;
	constructor(private readonly d: AudioRouterDeps) {}

	/** Entry point for an inbound client mic frame (PCM16). Per-frame order is
	 *  fixed (§1): (1) `process()` → segment start/reset, (2) routing with ONE
	 *  gate read → routed-bit update on the ledger's live record, (3) explicit
	 *  terminal finalization AFTER routing the terminal frame. */
	handleFromClient(data: Buffer, source: 'websocket' | 'rtc' = 'websocket'): void {
		if (source === 'websocket' && this.d.isRtcAudioReady()) return;
		if (!this.d.isSessionActive()) return;

		const flags = this.d.vad.process(data);
		if (flags & VAD_FRAME.SEGMENT_STARTED) {
			const segId = this.d.vad.activeSegmentId;
			if (this.d.ledger && segId !== null) {
				this.d.ledger.beginSegment(segId, this.d.nowMs?.() ?? 0, {
					gateActive: false, // set by routeToAgent's single gate read below
					responseEpoch: this.d.getResponseEpoch?.() ?? 0,
				});
			}
		}
		const voiced = (flags & VAD_FRAME.VOICED) !== 0;
		if (voiced) this.d.ledger?.noteVoicedFrame(this.d.nowMs?.() ?? 0);

		// External-audio agents (e.g. TwilioBridge) consume mic frames directly
		// — pre-gate by design (exemption confirmed in the investigation).
		if (this.d.routeExternalAudio(data)) {
			if (voiced) this.d.ledger?.noteRouted('external');
			this.finalizeLedgerTerminal(flags);
			return;
		}

		switch (this.d.getMode()) {
			case 'agent':
				this.routeToAgent(data, voiced, (flags & VAD_FRAME.SEGMENT_STARTED) !== 0);
				break;
			case 'starting_transcription':
				// Whisper not ready yet — buffer (bounded, oldest evicted on overflow).
				// Admission counts even if later evicted (admission ≠ receipt).
				if (voiced) this.d.ledger?.noteRouted('stt');
				this.bufferTransitionFrame(data);
				break;
			case 'transcription':
				// Entering the route counts even with no whisper provider.
				if (voiced) this.d.ledger?.noteRouted('stt');
				this.routeToWhisper(data);
				break;
			case 'stopping_transcription':
				// Transport already authoritative; restore the audio path immediately
				// so the user is never silent while whisper stop is in flight.
				this.routeToAgent(data, voiced, (flags & VAD_FRAME.SEGMENT_STARTED) !== 0);
				break;
		}
		this.finalizeLedgerTerminal(flags);
	}

	/** Dual-track: the frame-driven terminal reaches the ledger only AFTER the
	 *  terminal frame's routing completed (legacy `VadEvents` already fired
	 *  synchronously inside `process()`). */
	private finalizeLedgerTerminal(flags: number): void {
		if (!(flags & VAD_FRAME.TERMINAL) || !this.d.ledger) return;
		const desc = this.d.vad.takeTerminal();
		if (!desc) return;
		this.d.ledger.finalizeSegment({
			segmentId: desc.segmentId,
			outcome: desc.outcome,
			terminalCause: desc.terminalCause,
			resolvedAtMs: desc.resolvedAtMs,
		});
	}

	/** H2 gate-aware drain helper: transform + send a frame whose ADMISSION
	 *  was already decided at capture time — re-reading the live gate here
	 *  would recreate the drain-time race, and the retention tee is
	 *  deliberately skipped (drained audio is excluded from retention; a
	 *  no-segment feed would pollute the pre-roll ring). Fixes the latent
	 *  raw-drain format bug: frames now resample/µ-law-encode like every
	 *  other agent-path frame (an approved Phase-4 behavior change). */
	sendPreAdmitted(data: Buffer): void {
		const clientRate = this.d.clientAudioInputRate;
		const transportRate = this.d.transport.audioFormat.inputSampleRate;
		const transportPcm =
			clientRate === transportRate ? data : resamplePcm(data, clientRate, transportRate, 16);
		const transportAudio =
			this.d.transport.audioFormat.encoding === 'pcmu'
				? encodePcmToMulaw(transportPcm).toString('base64')
				: transportPcm.toString('base64');
		this.d.transport.sendAudio(transportAudio);
	}

	/** Flush buffered transition frames to whisper in FIFO order — called by
	 *  `setTranscriptionMode` once whisper is ready. */
	drainTransitionBufferToWhisper(): void {
		const buffered = this.transitionBuffer;
		this.transitionBuffer = [];
		this.transitionBufferBytes = 0;
		for (const chunk of buffered) this.routeToWhisper(chunk);
	}

	private bufferTransitionFrame(data: Buffer): void {
		this.transitionBuffer.push(data);
		this.transitionBufferBytes += data.length;
		while (
			this.transitionBufferBytes > MAX_TRANSITION_BUFFER_BYTES &&
			this.transitionBuffer.length > 1
		) {
			const dropped = this.transitionBuffer.shift();
			if (dropped) this.transitionBufferBytes -= dropped.length;
		}
	}

	/** Forward a PCM frame to the agent transport + optional STT provider.
	 *  `voiced` is the frame's VAD classification; the gate is read exactly
	 *  ONCE and that single result decides the drop, the route-flag update,
	 *  AND the diagnostics gate-at-start fact (two reads could disagree at a
	 *  grace-expiry boundary). */
	private routeToAgent(data: Buffer, voiced = false, segmentStarted = false): void {
		// Greeting-grace / greeting-in-flight gate: drop outbound transport + STT
		// audio. The client-VAD in handleFromClient still processed the frame —
		// only the downstream consumers are gated.
		const drop = this.d.shouldDropOutbound();
		if (segmentStarted && drop) this.d.ledger?.noteGateActiveAtSegmentStart();
		if (drop) return;
		if (voiced) this.d.ledger?.noteRouted('llm');
		// PCM is the source of truth here. The transport fork: G.711 μ-law
		// (telephony) resamples to 8 kHz then encodes; PCM transports rate-match
		// to transport.audioFormat.inputSampleRate.
		const clientRate = this.d.clientAudioInputRate;
		const transportRate = this.d.transport.audioFormat.inputSampleRate;
		const transportPcm =
			clientRate === transportRate ? data : resamplePcm(data, clientRate, transportRate, 16);
		// Retention tee: the transport-normalized PCM the model is about to
		// receive (pre µ-law encode — the retained copy is PCM16 either way).
		this.d.retainer?.feed(transportPcm);
		const transportAudio =
			this.d.transport.audioFormat.encoding === 'pcmu'
				? encodePcmToMulaw(transportPcm).toString('base64') // already at 8 kHz
				: transportPcm.toString('base64');
		this.d.transport.sendAudio(transportAudio);

		const stt = this.d.getSttProvider();
		if (stt) {
			const sttSupportsPcmu = stt.supportedEncodings?.includes('pcmu');
			const sttSupportsPcm = (stt.supportedEncodings ?? ['pcm']).includes('pcm');
			if (sttSupportsPcm) {
				// Raw client PCM at its native rate — what STT was configured with.
				stt.feedAudio(data.toString('base64'));
			} else if (sttSupportsPcmu) {
				const stt8k = clientRate === 8000 ? data : resamplePcm(data, clientRate, 8000, 16);
				stt.feedAudio(encodePcmToMulaw(stt8k).toString('base64'));
			}
		}
	}

	/** Forward a PCM frame to the whisper provider (resampled to its 24 kHz). */
	private routeToWhisper(data: Buffer): void {
		const whisper = this.d.getWhisperProvider();
		if (!whisper) return;
		const clientRate = this.d.clientAudioInputRate;
		const pcm = clientRate === 24000 ? data : resamplePcm(data, clientRate, 24000, 16);
		whisper.feedAudio(pcm.toString('base64'));
	}
}
