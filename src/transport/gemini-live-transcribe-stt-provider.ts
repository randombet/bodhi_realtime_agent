/**
 * Streaming STT provider for Gemini Transcribe Live (`gemini-3.5-transcribe-live`),
 * usable as a `whisperProvider`, including for dictation (transcription) mode.
 *
 * Protocol: https://ai.google.dev/gemini-api/docs/live-api/live-transcribe
 *   setup → { model, generationConfig.responseModalities:["TEXT"], inputAudioTranscription }
 *   audio → realtimeInput.audio { data, mimeType:"audio/pcm;rate=16000" }
 *   out   → serverContent.interimInputTranscription.text (partial)
 *           serverContent.inputTranscription.text        (final)
 *
 * A Transcribe Live session lasts at most 10 minutes, so the provider rotates:
 * shortly before the limit it opens a new socket, keeps feeding the old one
 * until the new one is ready and the speaker pauses, then switches over and sends
 * `audioStreamEnd` to the old one so its last utterance is finalized before it
 * closes. Every audio chunk goes to exactly one socket — nothing is fed twice,
 * and nothing is dropped while the new socket connects.
 */

import { WebSocket } from 'ws';
import { resamplePcm } from '../audio/resample.js';
import type { STTAudioConfig, STTProvider } from '../types/transport.js';

export interface GeminiLiveTranscribeSTTConfig {
	apiKey: string;
	model?: string;
	/** BCP-47 hints; empty = auto-detect (handles mixed Chinese/English). */
	languageCodes?: string[];
	/** Up to 1000 names/terms the model should spell correctly. */
	customVocabulary?: string[];
	mode?: 'VERBATIM' | 'SMART';
	/** Rotate before the server's 10-minute cap. */
	rotateAfterMs?: number;
	/** Longest wait for a pause before handing over anyway. */
	pauseWaitMs?: number;
	/** How long the old socket stays open after `audioStreamEnd`. */
	drainMs?: number;
	/** Longest wait for `setupComplete` before a connection counts as failed. */
	connectTimeoutMs?: number;
	/** Retries for a connection that fails before it is ready; the delay grows per attempt. */
	maxRetries?: number;
	retryDelayMs?: number;
	/** Test seam. */
	createSocket?: (url: string) => WebSocketLike;
	log?: (msg: string) => void;
}

export interface WebSocketLike {
	readyState: number;
	send(data: string): void;
	close(): void;
	on(event: 'open' | 'message' | 'close' | 'error', fn: (...args: never[]) => void): void;
}

const WS_URL =
	'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const TARGET_RATE = 16000;
const OPEN = 1;
const STOP_DRAIN_MS = 500;
const QUIET_RMS = 300;
const PAUSE_MS = 250;

export function rmsPcm16(pcm: Buffer): number {
	const n = Math.floor(pcm.length / 2);
	if (n === 0) return 0;
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const v = pcm.readInt16LE(i * 2);
		sum += v * v;
	}
	return Math.sqrt(sum / n);
}

/** ~30 s of 16 kHz PCM16 held while no socket is ready yet. */
const MAX_PENDING_BYTES = 960_000;

interface ServerMessage {
	setupComplete?: unknown;
	serverContent?: {
		interimInputTranscription?: { text?: unknown };
		inputTranscription?: { text?: unknown };
	};
}

interface Conn {
	ws: WebSocketLike;
	ready: boolean;
	id: number;
	/** The provider run this connection belongs to; callbacks from an older run are dropped. */
	run: number;
	/** Settles on `setupComplete` (resolve) or on failure before it (reject). */
	readyPromise: Promise<void>;
	settle: (err?: Error) => void;
	/** Set once the connection is retired and draining toward close. */
	drain?: Promise<void>;
}

export class GeminiLiveTranscribeSTTProvider implements STTProvider {
	onTranscript?: (text: string, turnId: number | undefined) => void;
	onPartialTranscript?: (text: string) => void;

	private readonly cfg: Required<
		Omit<GeminiLiveTranscribeSTTConfig, 'createSocket' | 'log' | 'customVocabulary'>
	> &
		Pick<GeminiLiveTranscribeSTTConfig, 'customVocabulary'>;
	private readonly createSocket: (url: string) => WebSocketLike;
	private readonly log: (msg: string) => void;
	private inputRate = 24000;
	private running = false;
	private runSeq = 0;
	/** Current run; 0 while stopped. */
	private run = 0;
	/** A run that is shutting down, whose draining sockets may still deliver finals until a new run starts. */
	private closingRun = 0;
	/** Shared by concurrent start() calls (prewarm and entry). */
	private starting: Promise<void> | null = null;
	/** The socket audio is currently fed to. */
	private active: Conn | null = null;
	/** A socket that is connecting to replace `active`. */
	private next: Conn | null = null;
	/** Every connection of the current run that is not closed yet, retired ones included. */
	private readonly conns = new Set<Conn>();
	private pending: Buffer[] = [];
	private pendingBytes = 0;
	private rotateTimer: NodeJS.Timeout | null = null;
	private retryTimer: NodeJS.Timeout | null = null;
	private connSeq = 0;
	private switchDeadline = 0;
	private quietMs = 0;
	private activeRetries = 0;
	private replaceRetries = 0;

	constructor(config: GeminiLiveTranscribeSTTConfig) {
		this.cfg = {
			apiKey: config.apiKey,
			model: config.model ?? 'gemini-3.5-transcribe-live',
			languageCodes: config.languageCodes ?? [],
			customVocabulary: config.customVocabulary,
			mode: config.mode ?? 'VERBATIM',
			rotateAfterMs: config.rotateAfterMs ?? 9 * 60_000,
			drainMs: config.drainMs ?? 5_000,
			pauseWaitMs: config.pauseWaitMs ?? 30_000,
			connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
			maxRetries: config.maxRetries ?? 3,
			retryDelayMs: config.retryDelayMs ?? 1_000,
		};
		this.createSocket =
			config.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
		this.log = config.log ?? (() => {});
	}

	configure(audio: STTAudioConfig): void {
		if (audio.bitDepth !== 16 || audio.channels !== 1) {
			throw new Error(
				`GeminiLiveTranscribeSTTProvider needs PCM16 mono, got ${audio.bitDepth}-bit ${audio.channels}ch`,
			);
		}
		this.inputRate = audio.sampleRate;
	}

	/** Resolves once the first session is set up; rejects (and resets) if setup fails or times out. */
	start(): Promise<void> {
		if (this.starting) return this.starting;
		if (this.running) return Promise.resolve();
		this.running = true;
		this.run = ++this.runSeq;
		this.closingRun = 0;
		this.activeRetries = 0;
		this.replaceRetries = 0;
		const conn = this.open();
		this.active = conn;
		this.starting = conn.readyPromise.then(
			() => {
				this.starting = null;
			},
			async (err: Error) => {
				this.starting = null;
				await this.shutdown(0);
				throw err;
			},
		);
		return this.starting;
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		await this.shutdown(Math.min(this.cfg.drainMs, STOP_DRAIN_MS));
	}

	feedAudio(base64Pcm: string): void {
		if (!this.running) return;
		const pcm = resamplePcm(Buffer.from(base64Pcm, 'base64'), this.inputRate, TARGET_RATE, 16);
		this.maybeSwitchAtPause(pcm);
		const conn = this.active;
		if (conn?.ready && conn.ws.readyState === OPEN) {
			this.flushPendingTo(conn);
			this.sendAudio(conn, pcm);
			return;
		}
		this.pending.push(pcm);
		this.pendingBytes += pcm.length;
		while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 1) {
			this.pendingBytes -= this.pending.shift()?.length ?? 0;
		}
	}

	// Streaming provider with server-side VAD: turn signals are not needed.
	commit(_turnId: number): void {}
	handleInterrupted(): void {}
	handleTurnComplete(): void {}

	/** Ends the run: the active socket drains for `waitMs`, retired ones get the same bound, then all close. */
	private async shutdown(waitMs: number): Promise<void> {
		this.running = false;
		const ending = this.run;
		this.closingRun = ending;
		this.run = 0;
		this.clearTimers();
		const conns = [...this.conns];
		this.conns.clear();
		const active = this.active;
		this.flushPendingTo(active);
		this.pending = [];
		this.pendingBytes = 0;
		if (this.next) this.closeConn(this.next);
		this.next = null;
		this.active = null;
		const waits: Promise<void>[] = [];
		for (const conn of conns) {
			if (conn === active && conn.ready) waits.push(this.drainAndClose(conn, waitMs));
			else if (conn.drain) waits.push(Promise.race([conn.drain, sleep(waitMs)]));
			else {
				conn.settle(new Error('Gemini Transcribe Live stopped before setup'));
				this.closeConn(conn);
			}
		}
		await Promise.all(waits);
		for (const conn of conns) this.closeConn(conn);
		// Anything still in flight from the ended run is ignored from here on.
		if (this.closingRun === ending) this.closingRun = 0;
	}

	private open(): Conn {
		let settle: (err?: Error) => void = () => {};
		const readyPromise = new Promise<void>((resolve, reject) => {
			settle = (err) => (err ? reject(err) : resolve());
		});
		readyPromise.catch(() => {}); // a failure is acted on in onFailed, not left unhandled
		let settled = false;
		const conn: Conn = {
			ws: this.createSocket(`${WS_URL}?key=${this.cfg.apiKey}`),
			ready: false,
			id: ++this.connSeq,
			run: this.run,
			readyPromise,
			settle: (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				settle(err);
			},
		};
		this.conns.add(conn);
		const timeout = setTimeout(() => {
			if (conn.ready) return;
			this.log(`[Transcribe#${conn.id}] setup timed out`);
			this.onFailed(conn, new Error('Gemini Transcribe Live setup timed out'));
		}, this.cfg.connectTimeoutMs);
		timeout.unref?.();
		const inputAudioTranscription: Record<string, unknown> = {
			languageCodes: this.cfg.languageCodes,
			mode: this.cfg.mode,
		};
		if (this.cfg.customVocabulary?.length)
			inputAudioTranscription.customVocabulary = this.cfg.customVocabulary.slice(0, 1000);
		conn.ws.on('open', () => {
			conn.ws.send(
				JSON.stringify({
					setup: {
						model: `models/${this.cfg.model}`,
						generationConfig: { responseModalities: ['TEXT'] },
						inputAudioTranscription,
					},
				}),
			);
		});
		conn.ws.on('message', (raw: unknown) => this.onMessage(conn, raw));
		conn.ws.on('error', (err: Error) => {
			this.log(`[Transcribe#${conn.id}] error: ${err?.message ?? err}`);
			if (!conn.ready) this.onFailed(conn, err instanceof Error ? err : new Error(String(err)));
		});
		conn.ws.on('close', (code: number, reason: unknown) => {
			this.log(`[Transcribe#${conn.id}] closed ${code ?? ''} ${String(reason ?? '')}`.trim());
			this.conns.delete(conn);
			if (!conn.ready) {
				this.onFailed(conn, new Error(`Gemini Transcribe Live closed before setup (${code})`));
				return;
			}
			if (conn.run !== this.run || !this.running) return;
			if (conn === this.next) {
				this.next = null;
				this.retryReplacement();
				return;
			}
			if (this.active !== conn) return;
			// Loss of the socket being fed: promote an open replacement or reconnect, buffering meanwhile.
			const next = this.next;
			this.next = null;
			this.activate(next && next.ws.readyState === OPEN ? next : this.open());
		});
		return conn;
	}

	/** A connection failed before setup: reject startup, or retry it within the retry budget. */
	private onFailed(conn: Conn, err: Error): void {
		if (conn.ready) return;
		conn.settle(err);
		this.closeConn(conn);
		if (conn.run !== this.run || !this.running || this.starting) return;
		if (conn === this.next) {
			this.next = null;
			this.retryReplacement();
		} else if (conn === this.active) {
			if (this.activeRetries >= this.cfg.maxRetries) {
				this.log('[Transcribe] session kept failing; giving up');
				return;
			}
			this.activeRetries++;
			this.retryLater(this.activeRetries, () => this.activate(this.open()));
		}
	}

	/** Opens a new replacement after the last one failed or closed, within the replacement budget. */
	private retryReplacement(): void {
		if (this.replaceRetries >= this.cfg.maxRetries) {
			this.log('[Transcribe] replacement session kept failing; staying on the current one');
			return;
		}
		this.replaceRetries++;
		this.retryLater(this.replaceRetries, () => {
			if (this.next) return;
			this.next = this.open();
			this.switchDeadline = Date.now() + this.cfg.pauseWaitMs;
			this.quietMs = 0;
		});
	}

	private retryLater(attempt: number, fn: () => void): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			if (this.running) fn();
		}, this.cfg.retryDelayMs * attempt);
		this.retryTimer.unref?.();
	}

	private onMessage(conn: Conn, raw: unknown): void {
		if (conn.run !== this.run && conn.run !== this.closingRun) return;
		let msg: ServerMessage;
		try {
			msg = JSON.parse(
				typeof raw === 'string' ? raw : Buffer.from(raw as Buffer).toString('utf-8'),
			);
		} catch {
			return;
		}
		if (msg.setupComplete !== undefined) {
			if (conn.ready) return;
			conn.ready = true;
			conn.settle();
			this.log(`[Transcribe#${conn.id}] ready`);
			if (conn === this.next && !this.active?.ready) this.switchTo(conn);
			else if (conn === this.active) this.onActiveReady(conn);
			return;
		}
		const sc = msg.serverContent;
		if (!sc) return;
		const partial = sc.interimInputTranscription?.text;
		if (typeof partial === 'string' && partial) this.onPartialTranscript?.(partial);
		const final = sc.inputTranscription?.text;
		if (typeof final === 'string' && final.trim()) this.onTranscript?.(final.trim(), undefined);
	}

	/** Makes `conn` the fed socket; its rotation clock starts once it is ready. */
	private activate(conn: Conn): void {
		this.active = conn;
		if (this.next === conn) this.next = null;
		if (conn.ready) this.onActiveReady(conn);
	}

	private onActiveReady(conn: Conn): void {
		this.activeRetries = 0;
		this.flushPendingTo(conn);
		this.scheduleRotation();
	}

	private scheduleRotation(): void {
		if (this.rotateTimer) clearTimeout(this.rotateTimer);
		this.rotateTimer = setTimeout(() => {
			if (!this.running) return;
			this.log('[Transcribe] rotating session before the 10-minute limit');
			this.replaceRetries = 0;
			this.next = this.open();
			this.switchDeadline = Date.now() + this.cfg.pauseWaitMs;
			this.quietMs = 0;
		}, this.cfg.rotateAfterMs);
		this.rotateTimer.unref?.();
	}

	/** Hand over to the ready next session during a pause, so no word is split across sessions. */
	private maybeSwitchAtPause(pcm: Buffer): void {
		const next = this.next;
		if (!next?.ready || next.ws.readyState !== OPEN) return;
		this.quietMs =
			rmsPcm16(pcm) < QUIET_RMS ? this.quietMs + (pcm.length / 2 / TARGET_RATE) * 1000 : 0;
		if (this.quietMs >= PAUSE_MS || Date.now() >= this.switchDeadline) {
			this.log(
				`[Transcribe#${next.id}] taking over (${this.quietMs >= PAUSE_MS ? 'pause' : 'deadline'})`,
			);
			this.switchTo(next);
		}
	}

	private switchTo(conn: Conn): void {
		const old = this.active;
		this.activate(conn);
		if (old && old !== conn) void this.drainAndClose(old);
	}

	private drainAndClose(conn: Conn, waitMs = this.cfg.drainMs): Promise<void> {
		if (conn.drain) return conn.drain;
		try {
			if (conn.ws.readyState === OPEN)
				conn.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
		} catch {}
		conn.drain = sleep(waitMs).then(() => this.closeConn(conn));
		return conn.drain;
	}

	private closeConn(conn: Conn): void {
		try {
			conn.ws.close();
		} catch {}
	}

	private clearTimers(): void {
		if (this.rotateTimer) clearTimeout(this.rotateTimer);
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.rotateTimer = null;
		this.retryTimer = null;
	}

	private flushPendingTo(conn: Conn | null): void {
		if (!conn?.ready || conn.ws.readyState !== OPEN || this.pending.length === 0) return;
		const chunks = this.pending;
		this.pending = [];
		this.pendingBytes = 0;
		for (const c of chunks) this.sendAudio(conn, c);
	}

	private sendAudio(conn: Conn, pcm: Buffer): void {
		conn.ws.send(
			JSON.stringify({
				realtimeInput: {
					audio: { data: pcm.toString('base64'), mimeType: `audio/pcm;rate=${TARGET_RATE}` },
				},
			}),
		);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
