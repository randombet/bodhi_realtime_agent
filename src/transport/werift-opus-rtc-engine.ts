/**
 * Server-side WebRTC audio (Opus RTP) using werift + @evan/opus — no SFU / LiveKit.
 * Bridges PCM at LLM transport rates ↔ Opus at 48 kHz for the browser peer.
 *
 * The browser’s **offer** must negotiate duplex audio (`a=sendrecv`), not `sendonly`, or werift’s
 * answer will be `recvonly` and assistant RTP will not be sent to the client.
 */

import { Decoder, Encoder } from '@evan/opus';
import {
	ExtensionProfiles,
	MediaStreamTrack,
	RTCPeerConnection,
	RtpHeader,
	RtpPacket,
	useOPUS,
} from 'werift';
import { resamplePcm } from '../audio/resample.js';
import type { IceServerEntry } from '../types/client-media.js';
import type { RtcAudioEngine, RtcAudioEngineOptions } from '../types/rtc-engine.js';
import type { RtcClientSignalingMessage } from '../types/rtc-signaling.js';

const OPUS_PCM_HZ = 48_000;
const OPUS_FRAME_SAMPLES = 960; // 20 ms @ 48 kHz mono
const OPUS_FRAME_BYTES = OPUS_FRAME_SAMPLES * 2;

/** The engine-neutral options; the werift engine adds nothing of its own. */
export type WeriftOpusRtcEngineOptions = RtcAudioEngineOptions;

function mapIceServers(
	entries: readonly IceServerEntry[] | undefined,
): { urls: string; username?: string; credential?: string }[] {
	if (!entries?.length) {
		return [{ urls: 'stun:stun.l.google.com:19302' }];
	}
	return entries.map((e) => ({
		urls: typeof e.urls === 'string' ? e.urls : [...e.urls].join(','),
		...(e.username !== undefined ? { username: e.username } : {}),
		...(e.credential !== undefined ? { credential: e.credential } : {}),
	}));
}

function randomU16(): number {
	return Math.floor(Math.random() * 65_535);
}

function randomU32(): number {
	return Math.floor(Math.random() * 0xffff_ffff);
}

export class WeriftOpusRtcEngine implements RtcAudioEngine {
	private readonly opts: WeriftOpusRtcEngineOptions;
	private readonly decoder = new Decoder({ channels: 1, sample_rate: 48_000 });
	private readonly encoder = new Encoder({ channels: 1, sample_rate: 48_000, application: 'voip' });
	private pc: RTCPeerConnection | null = null;
	private iceUnsub?: { unSubscribe: () => void };
	private trackUnsub?: { unSubscribe: () => void };
	private connUnsub?: { unSubscribe: () => void };
	private inboundRtpUnsub?: { unSubscribe: () => void };
	private pendingRemoteIce: Parameters<RTCPeerConnection['addIceCandidate']>[0][] = [];
	private outboundTrack: MediaStreamTrack | null = null;
	private outboundSeq = randomU16();
	private outboundTs = randomU32();
	private outboundPcmBuf = Buffer.alloc(0);
	private _mediaReady = false;

	constructor(opts: WeriftOpusRtcEngineOptions) {
		this.opts = opts;
	}

	get mediaReady(): boolean {
		return this._mediaReady;
	}

	private log(msg: string): void {
		this.opts.onLog?.(msg);
	}

	private emitError(text: string): void {
		this.opts.emitServerJson({ type: 'rtc.error', message: text });
	}

	async dispose(): Promise<void> {
		await this.closePeer();
	}

	sendAssistantPcm(pcm: Buffer): void {
		if (!this._mediaReady || !this.outboundTrack) return;
		if (pcm.length === 0) return;
		const at48k = resamplePcm(pcm, this.opts.outputPcmSampleRate, OPUS_PCM_HZ, 16);
		this.outboundPcmBuf = Buffer.concat(
			this.outboundPcmBuf.length === 0 ? [at48k] : [this.outboundPcmBuf, at48k],
		);
		const pt = this.outboundTrack.codec?.payloadType ?? 111;
		while (this.outboundPcmBuf.length >= OPUS_FRAME_BYTES) {
			const frame = this.outboundPcmBuf.subarray(0, OPUS_FRAME_BYTES);
			this.outboundPcmBuf = this.outboundPcmBuf.subarray(OPUS_FRAME_BYTES);
			let opus: Uint8Array;
			try {
				opus = this.encoder.encode(frame);
			} catch {
				continue;
			}
			this.outboundSeq = (this.outboundSeq + 1) & 0xffff;
			const ts = this.outboundTs >>> 0;
			this.outboundTs = (this.outboundTs + OPUS_FRAME_SAMPLES) >>> 0;
			const header = new RtpHeader({
				version: 2,
				padding: false,
				extension: false,
				marker: false,
				payloadType: pt,
				sequenceNumber: this.outboundSeq,
				timestamp: ts,
				ssrc: 0,
				csrcLength: 0,
				csrc: [],
				extensionProfile: ExtensionProfiles.OneByte,
				extensions: [],
			});
			const pkt = new RtpPacket(header, Buffer.from(opus));
			try {
				this.outboundTrack.writeRtp(pkt);
			} catch {
				// DTLS may not be ready yet; drop frame
			}
		}
	}

	async handleClientSignaling(msg: RtcClientSignalingMessage): Promise<void> {
		if (msg.type === 'rtc.offer') {
			await this.handleOffer(msg.sdp);
			return;
		}
		if (msg.type === 'rtc.ice_candidate') {
			await this.handleRemoteIce(msg.candidate);
		}
	}

	private async handleRemoteIce(candidate: Record<string, unknown>): Promise<void> {
		const init = candidate as Parameters<RTCPeerConnection['addIceCandidate']>[0];
		if (!this.pc || !this.pc.remoteDescription) {
			this.pendingRemoteIce.push(init);
			return;
		}
		try {
			await this.pc.addIceCandidate(init);
		} catch (err) {
			const m = err instanceof Error ? err.message : String(err);
			this.log(`addIceCandidate failed: ${m}`);
		}
	}

	private async flushPendingIce(): Promise<void> {
		if (!this.pc) return;
		for (const c of this.pendingRemoteIce) {
			try {
				await this.pc.addIceCandidate(c);
			} catch {
				// ignore stale
			}
		}
		this.pendingRemoteIce.length = 0;
	}

	private async closePeer(): Promise<void> {
		const hadPc = !!this.pc;
		this.connUnsub?.unSubscribe();
		this.connUnsub = undefined;
		this.iceUnsub?.unSubscribe();
		this.iceUnsub = undefined;
		this.trackUnsub?.unSubscribe();
		this.trackUnsub = undefined;
		this.inboundRtpUnsub?.unSubscribe();
		this.inboundRtpUnsub = undefined;
		this.outboundTrack = null;
		this._mediaReady = false;
		this.outboundPcmBuf = Buffer.alloc(0);
		if (this.pc) {
			const p = this.pc;
			this.pc = null;
			await p.close();
		}
		if (hadPc) {
			this.pendingRemoteIce.length = 0;
		}
	}

	private wireInboundAudio(track: MediaStreamTrack): void {
		this.inboundRtpUnsub?.unSubscribe();
		this.inboundRtpUnsub = track.onReceiveRtp.subscribe((rtp) => {
			const pkt = Buffer.isBuffer(rtp) ? RtpPacket.deSerialize(rtp) : rtp;
			const opusPayload = pkt.payload;
			if (!opusPayload.length) return;
			let pcm48: Uint8Array;
			try {
				pcm48 = this.decoder.decode(opusPayload);
			} catch {
				return;
			}
			const pcm16 = resamplePcm(Buffer.from(pcm48), OPUS_PCM_HZ, this.opts.inputPcmSampleRate, 16);
			this.opts.onInboundPcm(pcm16);
		});
	}

	private async tryAttachOutboundSender(): Promise<boolean> {
		const pc = this.pc;
		if (!pc || this._mediaReady) return true;
		const audioTx = pc.getTransceivers().find((t) => t.kind === 'audio');
		if (!audioTx?.sender?.codec) return false;
		const local = new MediaStreamTrack({ kind: 'audio', remote: false });
		try {
			await audioTx.sender.replaceTrack(local);
			local.codec = audioTx.sender.codec;
			this.outboundTrack = local;
			this.outboundSeq = randomU16();
			this.outboundTs = randomU32();
			this._mediaReady = true;
			this.log('werift_opus: outbound RTP path ready');
			this.opts.onMediaReady?.();
			return true;
		} catch (err) {
			const m = err instanceof Error ? err.message : String(err);
			this.log(`replaceTrack failed: ${m}`);
			return false;
		}
	}

	private async handleOffer(sdp: string): Promise<void> {
		await this.closePeer();
		const iceServers = mapIceServers(this.opts.iceServers);
		this.pc = new RTCPeerConnection({
			iceServers,
			codecs: { audio: [useOPUS()] },
		});

		this.iceUnsub = this.pc.onIceCandidate.subscribe((c) => {
			if (!c) return;
			const candidate =
				typeof (c as { toJSON?: () => Record<string, unknown> }).toJSON === 'function'
					? (c as { toJSON: () => Record<string, unknown> }).toJSON()
					: {
							candidate: c.candidate,
							sdpMid: c.sdpMid,
							sdpMLineIndex: c.sdpMLineIndex,
						};
			this.opts.emitServerJson({ type: 'rtc.ice_candidate', candidate });
		});

		this.trackUnsub = this.pc.onTrack.subscribe((track: MediaStreamTrack) => {
			if (track.kind !== 'audio' || !track.remote) return;
			this.wireInboundAudio(track);
		});

		try {
			await this.pc.setRemoteDescription({ type: 'offer', sdp });
			for (const tx of this.pc.getTransceivers()) {
				if (tx.kind === 'audio') tx.setDirection('sendrecv');
			}
			await this.flushPendingIce();
			const answer = await this.pc.createAnswer();
			await this.pc.setLocalDescription({ type: 'answer', sdp: answer.sdp });
			const outSdp = this.pc.localDescription?.sdp ?? answer.sdp;
			this.opts.emitServerJson({ type: 'rtc.answer', sdp: outSdp });
		} catch (err) {
			const m = err instanceof Error ? err.message : String(err);
			this.emitError(`RTC negotiation failed: ${m}`);
			await this.closePeer();
			return;
		}

		void this.tryAttachOutboundSender();
		this.connUnsub = this.pc.connectionStateChange.subscribe((state) => {
			if (state === 'connected' || state === 'connecting') {
				void this.tryAttachOutboundSender();
			}
		});
	}
}
