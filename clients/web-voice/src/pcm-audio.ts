/**
 * Browser PCM capture + playback for bodhi voice sessions.
 *
 * Seeded from a distilled copy (itself distilled from the Bodhi web
 * client's audio module) with the web client's hardening ported in
 * (plan step B3): eager AudioContext creation via {@link primeAudioContext}
 * so server audio arriving before mic permission still plays, `playbackRate`
 * scaling for speech pacing, and delayed context close on teardown so a fast
 * reconnect can reuse the context instead of leaking or losing it.
 *
 * Keeps the audio physics: linear-interpolation downsample, float32↔int16
 * conversion, gapless scheduled AudioBuffer playback through one GainNode,
 * hard-mute barge-in flush, playback.ended settle timing.
 */

import { MIN_PLAYBACK_RATE } from '@bodhi/client-protocol';

const CAPTURE_BUF = 2048;

/** Settle delay used when AudioContext latency fields are unavailable. */
const FALLBACK_SETTLE_MS = 250;

/** Delay before actually closing the AudioContext on teardown — a reconnect
 *  within this window reuses it (mirrors the web client's 2s delayed close). */
const CONTEXT_CLOSE_DELAY_MS = 2000;

function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
	if (fromRate === toRate) return input;
	const ratio = fromRate / toRate;
	const len = Math.floor(input.length / ratio);
	const out = new Float32Array(len);
	for (let i = 0; i < len; i++) {
		const pos = i * ratio;
		const idx = Math.floor(pos);
		const frac = pos - idx;
		out[i] = (input[idx] ?? 0) * (1 - frac) + (input[idx + 1] ?? 0) * frac;
	}
	return out;
}

function float32ToInt16(f32: Float32Array): Int16Array {
	const i16 = new Int16Array(f32.length);
	for (let i = 0; i < f32.length; i++) {
		const s = Math.max(-1, Math.min(1, f32[i] ?? 0));
		i16[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0;
	}
	return i16;
}

function int16ToFloat32(buf: ArrayBuffer): Float32Array {
	const view = new DataView(buf);
	const len = buf.byteLength / 2;
	const out = new Float32Array(len);
	for (let i = 0; i < len; i++) {
		out[i] = view.getInt16(i * 2, true) / 32768;
	}
	return out;
}

export { downsample, float32ToInt16, int16ToFloat32 };

export class PcmAudio {
	/** Server-instructed rates; set from session.config before the mic gate opens. */
	inputRate = 16000;
	outputRate = 24000;
	/** Mic gate — frames are dropped until session.config arrives. */
	gateOpen = false;
	/** Fired whenever the last scheduled assistant source drains. */
	onAllSourcesEnded: (() => void) | null = null;

	private audioCtx: AudioContext | null = null;
	private outputGain: GainNode | null = null;
	private activeSources: AudioBufferSourceNode[] = [];
	private nextPlayTime = 0;
	private micStream: MediaStream | null = null;
	private processor: ScriptProcessorNode | null = null;
	/** Invalidates an in-flight getUserMedia request when capture is stopped or
	 *  replaced. Browsers do not expose a way to abort the permission prompt,
	 *  so a late stream must be recognized and stopped after it resolves. */
	private micGeneration = 0;
	private pendingCloseTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingCloseContext: AudioContext | null = null;
	private _playbackRate = 1.0;

	get playing(): boolean {
		return this.activeSources.length > 0;
	}

	/** Context introspection for status UIs. */
	get contextState(): AudioContextState | 'none' {
		return this.audioCtx?.state ?? 'none';
	}
	get contextSampleRate(): number | null {
		return this.audioCtx?.sampleRate ?? null;
	}

	/** Web Audio playback rate for assistant audio (speech pacing). Clamped to
	 *  the protocol floor — the server's playback-duration fallback assumes
	 *  audio never plays slower than MIN_PLAYBACK_RATE. Applies to newly
	 *  scheduled chunks. */
	get playbackRate(): number {
		return this._playbackRate;
	}
	set playbackRate(rate: number) {
		this._playbackRate = Math.max(MIN_PLAYBACK_RATE, rate);
	}

	/**
	 * Create (or revive) the AudioContext synchronously. MUST be called from a
	 * user gesture (click/tap) per browser autoplay rules — before `connect()`
	 * — so server audio arriving while the mic-permission prompt is still open
	 * is audible instead of silently dropped. Reuses a context pending delayed
	 * close (fast reconnect); closes a truly orphaned one.
	 */
	primeAudioContext(opts?: { fresh?: boolean }): void {
		if (this.pendingCloseTimer !== null) {
			clearTimeout(this.pendingCloseTimer);
			this.pendingCloseTimer = null;
		}
		const pending = this.pendingCloseContext;
		this.pendingCloseContext = null;
		if (pending && pending.state !== 'closed') {
			if (!opts?.fresh && (!this.audioCtx || this.audioCtx.state === 'closed')) {
				// teardown() detached this context from the instance while its close
				// timer was pending. A reconnect inside the grace window owns it now.
				this.audioCtx = pending;
				this.outputGain = null;
				this.nextPlayTime = 0;
			} else if (pending !== this.audioCtx) {
				void pending.close().catch(() => {});
			}
		}
		if (opts?.fresh && this.audioCtx && this.audioCtx.state !== 'closed') {
			// Fresh-per-call semantics (a new user gesture wants a cold AEC/
			// clean graph): discard the old context instead of reviving it.
			void this.audioCtx.close().catch(() => {});
			this.audioCtx = null;
		}
		if (!this.audioCtx || this.audioCtx.state === 'closed') {
			this.audioCtx = new AudioContext();
			this.outputGain = null;
			this.nextPlayTime = 0;
		}
		if (this.audioCtx.state === 'suspended') {
			void this.audioCtx.resume();
		}
	}

	/** Stop capture only (mic stream + processor); playback and the context
	 *  are untouched. `teardown()` calls this. */
	stopMic(): void {
		this.micGeneration += 1;
		if (this.processor) {
			this.processor.disconnect();
			this.processor = null;
		}
		if (this.micStream) {
			for (const t of this.micStream.getTracks()) t.stop();
			this.micStream = null;
		}
	}

	/** Delay between the Web Audio graph draining and emitting playback.ended —
	 *  covers the OS/hardware output buffer plus one mic capture quantum. */
	settleDelayMs(): number {
		const ctx = this.audioCtx;
		const outputLatency = ctx?.outputLatency;
		const baseLatency = ctx?.baseLatency;
		if (
			ctx &&
			typeof outputLatency === 'number' &&
			Number.isFinite(outputLatency) &&
			typeof baseLatency === 'number' &&
			Number.isFinite(baseLatency)
		) {
			const latencyMs = (outputLatency + baseLatency) * 1000;
			const captureQuantumMs = (CAPTURE_BUF / ctx.sampleRate) * 1000;
			return Math.max(latencyMs + captureQuantumMs + 50, FALLBACK_SETTLE_MS);
		}
		return FALLBACK_SETTLE_MS;
	}

	async startMic(onPcm: (pcm: ArrayBuffer) => void): Promise<void> {
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error(
				'Microphone access is not available — use HTTPS or localhost in a modern browser.',
			);
		}
		// Replace existing capture and invalidate any older permission request.
		this.stopMic();
		const generation = this.micGeneration;
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
		} catch (error) {
			// A rejected permission prompt from a call that has already ended must
			// not surface as an error on a newer connection.
			if (generation !== this.micGeneration) return;
			throw error;
		}
		if (generation !== this.micGeneration) {
			for (const track of stream.getTracks()) track.stop();
			return;
		}
		this.micStream = stream;
		// primeAudioContext() from the gesture is the normal path; this is the
		// fallback for callers that skipped it (audio arriving before this
		// point was dropped for them).
		this.primeAudioContext();
		const ctx = this.audioCtx;
		if (!ctx) throw new Error('AudioContext unavailable');
		const source = ctx.createMediaStreamSource(this.micStream);
		this.processor = ctx.createScriptProcessor(CAPTURE_BUF, 1, 1);
		this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
			if (!this.gateOpen || !this.audioCtx) return;
			const raw = e.inputBuffer.getChannelData(0);
			const down = downsample(raw, this.audioCtx.sampleRate, this.inputRate);
			onPcm(float32ToInt16(down).buffer as ArrayBuffer);
		};
		source.connect(this.processor);
		// ScriptProcessor only fires while connected to the destination; route it
		// through a zero-gain node so mic audio is never audible locally.
		const silence = ctx.createGain();
		silence.gain.value = 0;
		this.processor.connect(silence);
		silence.connect(ctx.destination);
	}

	playChunk(arrayBuf: ArrayBuffer): void {
		if (!this.audioCtx || this.audioCtx.state === 'closed') return;
		if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();
		const f32 = int16ToFloat32(arrayBuf);
		if (f32.length === 0) return;
		if (!this.outputGain) {
			this.outputGain = this.audioCtx.createGain();
			this.outputGain.gain.value = 1;
			this.outputGain.connect(this.audioCtx.destination);
		}
		const audioBuf = this.audioCtx.createBuffer(1, f32.length, this.outputRate);
		audioBuf.getChannelData(0).set(f32);
		const src = this.audioCtx.createBufferSource();
		src.buffer = audioBuf;
		src.playbackRate.value = this._playbackRate;
		src.connect(this.outputGain);
		const now = this.audioCtx.currentTime;
		if (this.nextPlayTime < now) this.nextPlayTime = now + 0.05;
		src.start(this.nextPlayTime);
		this.nextPlayTime += audioBuf.duration / this._playbackRate;
		this.activeSources.push(src);
		src.onended = () => {
			const idx = this.activeSources.indexOf(src);
			if (idx >= 0) this.activeSources.splice(idx, 1);
			if (this.activeSources.length === 0) this.onAllSourcesEnded?.();
		};
	}

	/** Barge-in: hard-mute the shared gate FIRST (stopping sources does not
	 *  flush the 50–200 ms OS/Bluetooth output buffer; a gain drop propagates
	 *  in one render quantum), then discard everything scheduled. */
	muteAndFlush(): void {
		if (this.outputGain && this.audioCtx) {
			const t = this.audioCtx.currentTime;
			this.outputGain.gain.cancelScheduledValues(t);
			this.outputGain.gain.setValueAtTime(0, t);
		}
		for (const s of this.activeSources) {
			try {
				s.stop();
			} catch {
				// already ended or context closed
			}
		}
		this.activeSources = [];
		this.nextPlayTime = 0;
	}

	/** Re-open the gate for the next assistant turn (short ramp avoids a click). */
	unmute(): void {
		if (this.outputGain && this.audioCtx) {
			const t = this.audioCtx.currentTime;
			this.outputGain.gain.linearRampToValueAtTime(1, t + 0.02);
		}
	}

	/**
	 * Stop capture and playback. The AudioContext closes after a short delay so
	 * a fast reconnect (`primeAudioContext()` within the window) reuses it —
	 * losing the context between the WS open and `getUserMedia` resolving is
	 * how early greeting audio gets dropped.
	 */
	teardown(): void {
		this.gateOpen = false;
		this.stopMic();
		this.muteAndFlush();
		// NOTE: onAllSourcesEnded intentionally survives teardown — the
		// playback-ended gate binds it once for the lifetime of the renderer,
		// and a reconnect (prime + startMic) must keep drain events flowing.
		const ctx = this.audioCtx;
		this.audioCtx = null;
		this.outputGain = null;
		if (ctx && ctx.state !== 'closed') {
			this.pendingCloseContext = ctx;
			this.pendingCloseTimer = setTimeout(() => {
				this.pendingCloseTimer = null;
				const pending = this.pendingCloseContext;
				this.pendingCloseContext = null;
				if (pending && pending.state !== 'closed') void pending.close().catch(() => {});
			}, CONTEXT_CLOSE_DELAY_MS);
		}
	}
}
