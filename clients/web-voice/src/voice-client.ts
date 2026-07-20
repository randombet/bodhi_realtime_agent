/**
 * WebSocket voice client for bodhi sessions — the shared browser half of the
 * client wire contract (@bodhi/client-protocol).
 *
 * Seeded from a distilled client (plan step B2) with the web
 * client's hardening ported in (B3): connection generations defuse stale
 * settle timers across reconnects; `primeAudioContext()` (call it from the
 * user gesture, before `connect()`) keeps early greeting audio audible; a
 * pluggable {@link PlaybackRenderer} decides the playback-state protocol
 * (B4); pacing frames drive `PcmAudio.playbackRate` key-aware (B5).
 *
 * One socket carries binary PCM both ways plus JSON events. Core frames are
 * handled here; everything else goes to `onServerMessage` — the extension
 * escape hatch (`'handled' | 'unhandled'`); unknown frames are ignored per
 * the protocol's forward-compatibility rule.
 *
 * `turn.end` semantics (open question resolved here): `turn.end` is
 * bookkeeping only — it clears any pending settle timer as a fallback for
 * turns whose `audio.done` acknowledgment can no longer apply (e.g. the
 * server completed the turn without the handshake). It never triggers
 * `playback.ended` by itself; acknowledgment requires `audio.done` + drain +
 * settle, exactly as the hosted API doc specifies.
 */

import type {
	AnyServerToClientMessage,
	ClientExtensionMessage,
	CoreClientToServerMessage,
} from '@bodhi/client-protocol';
import { type PacingRates, rateForBehaviorChange, rateFromCatalog } from './pacing.js';
import { PcmAudio } from './pcm-audio.js';
import { PlaybackEndedGate } from './playback-ended-gate.js';
import { PcmPlaybackRenderer, type PlaybackRenderer } from './renderer.js';

export type VoiceStatus = 'idle' | 'connecting' | 'live' | 'ended' | 'error';

export interface TranscriptEvent {
	role: 'user' | 'assistant';
	text: string;
	partial: boolean;
	/** Provider correction — replace earlier partial text, don't append. */
	corrected: boolean;
}

export interface VoiceClientCallbacks {
	onStatus(status: VoiceStatus, detail?: string): void;
	onTranscript(event: TranscriptEvent): void;
	/**
	 * Extension escape hatch: every JSON frame the core dispatch does not own
	 * is offered here (app/peer frames like `peer.session_ended`,
	 * `sessions_list`, …). Return `'handled'` to consume; `'unhandled'`
	 * frames are ignored (forward compatibility — never an error).
	 */
	onServerMessage?(
		msg: AnyServerToClientMessage | Record<string, unknown>,
	): 'handled' | 'unhandled';
}

export interface VoiceClientOptions {
	/** Playback renderer; defaults to the WebSocket-PCM path. */
	renderer?: (audio: PcmAudio) => PlaybackRenderer;
	/** Preset→rate table for pacing frames; `false` disables pacing handling. */
	pacingRates?: PacingRates | false;
	/** Bring your own PcmAudio (tests, custom capture chains). */
	audio?: PcmAudio;
}

export class VoiceClient {
	readonly audio: PcmAudio;
	private readonly renderer: PlaybackRenderer;
	private readonly callbacks: VoiceClientCallbacks;
	/** undefined ⇒ protocol default table; false ⇒ pacing handling disabled. */
	private readonly pacingRates: PacingRates | false | undefined;
	private ws: WebSocket | null = null;
	private readonly gate: PlaybackEndedGate;
	private closedByUs = false;
	/** Connection generation — bumped per connect(); async callbacks compare
	 *  against it so a frame from a previous connection can never act on the
	 *  current one (the gate keeps its own for settle timers). */
	private generation = 0;

	constructor(callbacks: VoiceClientCallbacks, options?: VoiceClientOptions) {
		this.callbacks = callbacks;
		this.audio = options?.audio ?? new PcmAudio();
		this.renderer = options?.renderer
			? options.renderer(this.audio)
			: new PcmPlaybackRenderer(this.audio);
		this.pacingRates = options?.pacingRates;
		// The gate owns the audio.done → drain → settle → playback.ended
		// ordering (shared with socket-owning apps; see playback-ended-gate.ts).
		this.gate = new PlaybackEndedGate(this.renderer, (playbackId) =>
			this.sendClientMessage({ type: 'playback.ended', playbackId }),
		);
	}

	/** Create/revive the AudioContext. Call synchronously from the user
	 *  gesture that starts the call, BEFORE `connect()`. */
	primeAudioContext(): void {
		this.audio.primeAudioContext();
	}

	async connect(wsUrl: string): Promise<void> {
		this.generation += 1;
		const gen = this.generation;
		this.closedByUs = false;
		this.gate.newGeneration();
		this.callbacks.onStatus('connecting');
		const ws = new WebSocket(wsUrl);
		ws.binaryType = 'arraybuffer';
		this.ws = ws;

		ws.onopen = async () => {
			try {
				await this.audio.startMic((pcm) => {
					if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
				});
			} catch (err) {
				this.callbacks.onStatus(
					'error',
					err instanceof Error ? err.message : 'Microphone access failed',
				);
				ws.close();
			}
		};

		ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
			if (gen !== this.generation) return;
			if (event.data instanceof ArrayBuffer) {
				if (this.renderer.rendersAssistantPcm) this.renderer.playChunk?.(event.data);
				return;
			}
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(event.data) as Record<string, unknown>;
			} catch {
				return;
			}
			this.handleJson(msg, gen);
		};

		ws.onclose = (e) => {
			if (gen !== this.generation) return;
			this.gate.clear();
			this.audio.teardown();
			if (this.closedByUs) {
				this.callbacks.onStatus('ended');
			} else if (e.code >= 4400) {
				this.callbacks.onStatus('error', e.reason || `connection rejected (${e.code})`);
			} else {
				this.callbacks.onStatus('ended', e.reason || undefined);
			}
		};

		ws.onerror = () => {
			if (gen !== this.generation) return;
			this.callbacks.onStatus('error', 'connection failed — is the voice server running?');
		};
	}

	/** Send a typed client→server frame (core or registered extension). */
	sendClientMessage(msg: CoreClientToServerMessage | ClientExtensionMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	/** Type a message instead of speaking (also useful for testing). */
	sendText(text: string): void {
		this.sendClientMessage({ type: 'text_input', text });
	}

	disconnect(): void {
		this.closedByUs = true;
		this.gate.clear();
		this.ws?.close();
		this.ws = null;
	}

	/** Exposed for tests: feed a parsed JSON frame through core dispatch. */
	handleJson(msg: Record<string, unknown>, gen = this.generation): void {
		switch (msg.type) {
			case 'session.config': {
				const fmt = msg.audioFormat as
					| { inputSampleRate?: number; outputSampleRate?: number }
					| undefined;
				if (fmt?.inputSampleRate) this.audio.inputRate = fmt.inputSampleRate;
				if (fmt?.outputSampleRate) this.audio.outputRate = fmt.outputSampleRate;
				this.gate.clear();
				this.audio.gateOpen = true;
				this.callbacks.onStatus('live');
				break;
			}
			case 'transcript': {
				this.callbacks.onTranscript({
					role: msg.role === 'assistant' ? 'assistant' : 'user',
					text: typeof msg.text === 'string' ? msg.text : '',
					partial: msg.partial === true,
					corrected: msg.corrected === true,
				});
				break;
			}
			case 'turn.interrupted': {
				this.renderer.interrupt();
				this.gate.clear();
				break;
			}
			case 'turn.end': {
				// Fallback bookkeeping only — see the header note on semantics.
				this.renderer.onTurnEnd?.();
				this.gate.clear();
				break;
			}
			case 'audio.done': {
				if (typeof msg.playbackId !== 'number') break;
				this.gate.audioDone(msg.playbackId);
				break;
			}
			case 'behavior.catalog': {
				if (this.pacingRates === false) break;
				const rate = rateFromCatalog(
					(msg.categories as Parameters<typeof rateFromCatalog>[0]) ?? [],
					this.pacingRates,
				);
				if (rate !== null) this.audio.playbackRate = rate;
				break;
			}
			case 'behavior.changed': {
				if (this.pacingRates === false) break;
				const rate = rateForBehaviorChange(
					String(msg.key ?? ''),
					String(msg.preset ?? ''),
					this.pacingRates,
				);
				if (rate !== null) this.audio.playbackRate = rate;
				break;
			}
			default: {
				this.callbacks.onServerMessage?.(msg);
				// Unknown/unhandled frames are ignored — forward compatibility.
				break;
			}
		}
	}
}
