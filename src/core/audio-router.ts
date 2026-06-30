import { resamplePcm } from '../audio/resample.js';
import { encodePcmToMulaw } from '../telephony/audio-codec.js';
import type { LLMTransport, STTProvider } from '../types/transport.js';
import type { ClientVadDetector } from './client-vad-detector.js';

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

	/** Entry point for an inbound client mic frame (PCM16). */
	handleFromClient(data: Buffer, source: 'websocket' | 'rtc' = 'websocket'): void {
		if (source === 'websocket' && this.d.isRtcAudioReady()) return;
		if (!this.d.isSessionActive()) return;

		this.d.vad.process(data);

		// External-audio agents (e.g. TwilioBridge) consume mic frames directly.
		if (this.d.routeExternalAudio(data)) return;

		switch (this.d.getMode()) {
			case 'agent':
				this.routeToAgent(data);
				break;
			case 'starting_transcription':
				// Whisper not ready yet — buffer (bounded, oldest evicted on overflow).
				this.bufferTransitionFrame(data);
				break;
			case 'transcription':
				this.routeToWhisper(data);
				break;
			case 'stopping_transcription':
				// Transport already authoritative; restore the audio path immediately
				// so the user is never silent while whisper stop is in flight.
				this.routeToAgent(data);
				break;
		}
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

	/** Forward a PCM frame to the agent transport + optional STT provider. */
	private routeToAgent(data: Buffer): void {
		// Greeting-grace / greeting-in-flight gate: drop outbound transport + STT
		// audio. The client-VAD in handleFromClient still processed the frame —
		// only the downstream consumers are gated.
		if (this.d.shouldDropOutbound()) return;
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
