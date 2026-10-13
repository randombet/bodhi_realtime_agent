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
 *
 * It authenticates with a static `apiKey`, or with a `credentialProvider`: the
 * {@link GeminiCredentialProvider} `GeminiLiveTransport` takes, called for every
 * connection (start, rotation, reconnect, retry) inside that connection's
 * `connectTimeoutMs`, with the setup the connection then sends. An ephemeral
 * token (`auth_tokens/…`) dials the Constrained endpoint with `access_token=`, as
 * the SDK's `live.connect` does; a key dials the key endpoint, as `apiKey` does.
 * A credential's `expiresAtMs` bounds when its connection rotates, and closes the
 * connection if it is still in use then.
 */

import { type AudioTranscriptionConfig, Modality } from '@google/genai';
import { WebSocket } from 'ws';
import { resamplePcm } from '../audio/resample.js';
import { ValidationError } from '../core/errors.js';
import type {
	ConnectFailure,
	ConnectFailureError,
	STTAudioConfig,
	STTProvider,
} from '../types/transport.js';
import {
	DEFAULT_MIN_CREDENTIAL_LIFETIME_MS,
	type GeminiCredential,
	type GeminiCredentialProvider,
	type GeminiLiveSetup,
	deepFreeze,
	refuseCredential,
	untilAborted,
	upgradeStatus,
	wireCopy,
} from './gemini-live-transport.js';

/** {@link GeminiLiveTranscribeSTTProvider}'s options apart from its credential. */
export interface GeminiLiveTranscribeSTTOptions {
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
	/** Longest wait for `setupComplete` before a connection counts as failed. With a
	 *  `credentialProvider` it is one deadline over the credential fetch, the dial
	 *  and setupComplete; the fetch may use at most half of it. */
	connectTimeoutMs?: number;
	/** Retries for a connection that fails before it is ready; the delay grows per attempt. */
	maxRetries?: number;
	retryDelayMs?: number;
	/** Test seam. */
	createSocket?: (url: string) => WebSocketLike;
	log?: (msg: string) => void;
	/** Each connection's dial, setup and close, for a caller that tracks the
	 *  credentials it issued. Also settable as a property. */
	onConnectionLifecycle?: (event: GeminiLiveTranscribeLifecycleEvent) => void;
	/** The run ended on its own, after `start()` resolved: a lost connection could
	 *  not be replaced within `maxRetries`, or the credential provider failed
	 *  permanently (`retryable: false`). The provider has stopped (a later `start()`
	 *  begins a new run) and no more transcripts come. Before `start()` resolves, a
	 *  failure rejects `start()` instead. The error carries the last attempt's
	 *  `connectFailure`. Also settable as a property. */
	onFatal?: (error: Error) => void;
}

/** Transcribe Live with one static API key. */
export interface GeminiLiveTranscribeSTTConfig extends GeminiLiveTranscribeSTTOptions {
	apiKey: string;
	credentialProvider?: never;
}

/** Transcribe Live with a credential fetched for each connection. */
export interface GeminiLiveTranscribeSTTProviderConfig extends GeminiLiveTranscribeSTTOptions {
	/** Called for every connection (start, rotation, reconnect, retry) with the
	 *  setup it sends, `{ model, config: { responseModalities: ['TEXT'],
	 *  inputAudioTranscription } }` deep-frozen, so a token can be locked to it.
	 *  `signal` aborts when its half of `connectTimeoutMs` runs out or the
	 *  connection is closed meanwhile (`stop()`, a timeout); a credential that
	 *  arrives after that is dropped unused. Rejecting with `retryable: false` ends
	 *  the run without a retry (`onFatal`). The rest of the contract is
	 *  {@link GeminiCredentialProvider}'s. */
	credentialProvider: GeminiCredentialProvider;
	apiKey?: never;
	/** The least use, in ms, a credential must leave after the connect deadline:
	 *  one that expires sooner is refused, failing that connection. Default 60000;
	 *  as `GeminiProviderTransportConfig.minCredentialLifetimeMs`. */
	minCredentialLifetimeMs?: number;
}

/**
 * One connection of a {@link GeminiLiveTranscribeSTTProvider}: `dial` when its
 * socket is created, `setup-ok` at setupComplete, and `closed` once it is gone,
 * whether it failed before setup, was retired after a handover, expired, or was
 * stopped. Every connection ends with one `closed` (once its socket reports the
 * close), including one whose credential never came. `meta` is the credential's
 * `meta` (`credentialProvider` only), once the provider returned it.
 */
export type GeminiLiveTranscribeLifecycleEvent =
	| { phase: 'dial'; connectionId: number; meta?: unknown }
	| { phase: 'setup-ok'; connectionId: number; meta?: unknown }
	| {
			phase: 'closed';
			connectionId: number;
			meta?: unknown;
			/** Whether it reached setupComplete. */
			setupDone: boolean;
			/** WebSocket close code and reason, when its socket closed. */
			code?: number;
			reason?: string;
			/** Why it failed before setupComplete; absent once it was set up. */
			failure?: ConnectFailure;
	  };

export interface WebSocketLike {
	readyState: number;
	send(data: string): void;
	close(): void;
	on(event: 'open' | 'message' | 'close' | 'error', fn: (...args: never[]) => void): void;
}

const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage';
/** API version of the key endpoint. */
const KEY_API_VERSION = 'v1beta';
/** API version of the Constrained endpoint for an ephemeral token whose credential
 *  names none. The SDK supports tokens on v1alpha only. */
const TOKEN_API_VERSION = 'v1alpha';
const WS_URL = `${WS_BASE}.${KEY_API_VERSION}.GenerativeService.BidiGenerateContent`;
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
	/** `null` until its credential arrives (`credentialProvider` only). */
	ws: WebSocketLike | null;
	ready: boolean;
	id: number;
	/** The provider run this connection belongs to; callbacks from an older run are dropped. */
	run: number;
	/** Settles on `setupComplete` (resolve) or on failure before it (reject). */
	readyPromise: Promise<void>;
	settle: (err?: Error) => void;
	/** Set once the connection is retired and draining toward close. */
	drain?: Promise<void>;
	/** Where it is before setup: fetching its credential, dialing, or open and awaiting setupComplete. */
	stage: ConnectFailure['source'];
	/** Its credential fetch, while one is in flight. */
	fetch?: AbortController;
	/** Its credential's `meta` and expiry (`credentialProvider` only). */
	meta?: unknown;
	expiresAtMs?: number;
	expiryTimer?: NodeJS.Timeout;
	/** Why it failed before setup, once it did. */
	failure?: ConnectFailure;
	/** closeConn() ran: nothing more is dialed or armed for it. */
	ended: boolean;
	/** Its `closed` lifecycle event went out. */
	closedReported: boolean;
}

export class GeminiLiveTranscribeSTTProvider implements STTProvider {
	onTranscript?: (text: string, turnId: number | undefined) => void;
	onPartialTranscript?: (text: string) => void;
	/** See {@link GeminiLiveTranscribeSTTOptions.onConnectionLifecycle}. */
	onConnectionLifecycle?: (event: GeminiLiveTranscribeLifecycleEvent) => void;
	/** See {@link GeminiLiveTranscribeSTTOptions.onFatal}. */
	onFatal?: (error: Error) => void;

	private readonly cfg: Required<
		Omit<
			GeminiLiveTranscribeSTTOptions,
			'createSocket' | 'log' | 'customVocabulary' | 'onConnectionLifecycle' | 'onFatal'
		>
	> &
		Pick<GeminiLiveTranscribeSTTOptions, 'customVocabulary'>;
	private readonly apiKey: string | undefined;
	private readonly credentialProvider: GeminiCredentialProvider | undefined;
	private readonly minCredentialLifetimeMs: number;
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

	constructor(config: GeminiLiveTranscribeSTTConfig | GeminiLiveTranscribeSTTProviderConfig) {
		if (config.credentialProvider !== undefined) {
			if (typeof config.credentialProvider !== 'function') {
				throw new ValidationError(
					'GeminiLiveTranscribeSTTProvider: credentialProvider must be a function.',
				);
			}
			if (config.apiKey !== undefined) {
				throw new ValidationError(
					'GeminiLiveTranscribeSTTProvider: apiKey and credentialProvider are mutually exclusive; set only one.',
				);
			}
		} else if (config.apiKey === undefined) {
			throw new ValidationError(
				'GeminiLiveTranscribeSTTProvider: set apiKey or credentialProvider.',
			);
		}
		const minLifetimeMs = config.credentialProvider
			? (config.minCredentialLifetimeMs ?? DEFAULT_MIN_CREDENTIAL_LIFETIME_MS)
			: 0;
		if (!Number.isFinite(minLifetimeMs) || minLifetimeMs < 0) {
			throw new ValidationError(
				'GeminiLiveTranscribeSTTProvider: minCredentialLifetimeMs must be a finite number of ms, 0 or more.',
			);
		}
		this.apiKey = config.apiKey;
		this.credentialProvider = config.credentialProvider;
		this.minCredentialLifetimeMs = minLifetimeMs;
		this.cfg = {
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
		this.onConnectionLifecycle = config.onConnectionLifecycle;
		this.onFatal = config.onFatal;
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
		if (conn?.ready && conn.ws?.readyState === OPEN) {
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
		// Connections still before setup fail (a start() awaiting one rejects) and close,
		// a credential fetch in flight included.
		for (const conn of conns) {
			if (!conn.ready)
				this.onFailed(conn, new Error('Gemini Transcribe Live stopped before setup'));
		}
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
			else this.closeConn(conn);
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
			ws: null,
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
			stage: this.credentialProvider ? 'provider' : 'dial',
			ended: false,
			closedReported: false,
		};
		this.conns.add(conn);
		const timeout = setTimeout(() => {
			if (conn.ready) return;
			this.log(`[Transcribe#${conn.id}] setup timed out`);
			this.onFailed(conn, new Error('Gemini Transcribe Live setup timed out'));
		}, this.cfg.connectTimeoutMs);
		timeout.unref?.();
		const setup = this.setup();
		if (this.credentialProvider) void this.dialWithCredential(conn, this.credentialProvider, setup);
		else this.dial(conn, `${WS_URL}?key=${this.apiKey}`, setup);
		return conn;
	}

	/** The setup every connection sends, in the SDK's `live.connect` form: what a
	 *  `credentialProvider` gets, so what a token is locked to. */
	private setup(): GeminiLiveSetup {
		const inputAudioTranscription: AudioTranscriptionConfig & {
			mode: string;
			customVocabulary?: string[];
		} = { languageCodes: this.cfg.languageCodes, mode: this.cfg.mode };
		if (this.cfg.customVocabulary?.length)
			inputAudioTranscription.customVocabulary = this.cfg.customVocabulary.slice(0, 1000);
		return {
			model: this.cfg.model,
			config: { responseModalities: [Modality.TEXT], inputAudioTranscription },
		};
	}

	/**
	 * A `credentialProvider` connection: fetch its credential with a frozen copy of
	 * its setup (aborted at half the connect deadline, or when the connection is
	 * closed meanwhile), then dial with it. A credential that arrives after the
	 * connection ended is dropped unused; a failed or refused one fails the
	 * connection like a failed dial.
	 */
	private async dialWithCredential(
		conn: Conn,
		provider: GeminiCredentialProvider,
		setup: GeminiLiveSetup,
	): Promise<void> {
		// A copy as sent on the wire, so the provider sees what the server will.
		const locked: GeminiLiveSetup = deepFreeze(wireCopy(setup));
		const fetch = new AbortController();
		conn.fetch = fetch;
		const budgetMs = Math.floor(this.cfg.connectTimeoutMs / 2);
		const budget = setTimeout(
			() => fetch.abort(new Error(`Gemini credential fetch timed out after ${budgetMs}ms`)),
			budgetMs,
		);
		budget.unref?.();
		let credential: GeminiCredential;
		try {
			// A provider that throws synchronously fails the connection like one that rejects.
			credential = await untilAborted(
				Promise.resolve(provider(locked, fetch.signal)),
				fetch.signal,
			);
		} catch (err) {
			// Closed while fetching (stop(), the setup deadline), which reported it already.
			if (!conn.ended) this.onFailed(conn, credentialError(err));
			return;
		} finally {
			clearTimeout(budget);
			conn.fetch = undefined;
		}
		if (conn.ended) return;
		// Recorded before the checks: a refused credential was still minted, and its
		// meta is how the owner matches this connection's failure to it.
		if (typeof credential === 'object' && credential !== null) conn.meta = credential.meta;
		const refusal = refuseCredential(
			credential,
			this.cfg.connectTimeoutMs,
			this.minCredentialLifetimeMs,
		);
		if (refusal) {
			this.onFailed(conn, credentialError(new ValidationError(refusal)));
			return;
		}
		conn.expiresAtMs = credential.expiresAtMs;
		try {
			this.dial(conn, credentialUrl(credential), locked);
		} catch {
			// The URL holds the credential, and a socket error may quote it: report neither.
			this.onFailed(conn, new Error('Gemini Transcribe Live could not open its socket'));
		}
	}

	/** Opens `conn`'s socket and sends `setup` once it is open. */
	private dial(conn: Conn, url: string, setup: GeminiLiveSetup): void {
		conn.stage = 'dial';
		const ws = this.createSocket(url);
		conn.ws = ws;
		ws.on('open', () => {
			conn.stage = 'session';
			ws.send(setupMessage(setup));
		});
		ws.on('message', (raw: unknown) => this.onMessage(conn, raw));
		ws.on('error', (err: Error) => {
			this.log(`[Transcribe#${conn.id}] error: ${err?.message ?? err}`);
			if (!conn.ready) this.onFailed(conn, err instanceof Error ? err : new Error(String(err)));
		});
		ws.on('close', (code: number, reason: unknown) => {
			this.log(`[Transcribe#${conn.id}] closed ${code ?? ''} ${String(reason ?? '')}`.trim());
			this.conns.delete(conn);
			const why = String(reason ?? '');
			if (!conn.ready) {
				this.onFailed(conn, new Error(`Gemini Transcribe Live closed before setup (${code})`), {
					code,
					reason: why,
				});
			}
			this.reportClosed(conn, code, why);
			if (conn.ready) this.lost(conn);
		});
		this.lifecycle({ phase: 'dial', connectionId: conn.id, meta: conn.meta });
	}

	/** A set-up connection is gone (closed, or its credential expired): replace it where it mattered. */
	private lost(conn: Conn): void {
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
		this.activate(next && next.ws?.readyState === OPEN ? next : this.open());
	}

	/** A connection failed before setup: reject startup, or retry it within the retry budget. */
	private onFailed(conn: Conn, err: Error, close?: { code?: number; reason?: string }): void {
		// Once per connection: a socket that errors then closes is one failure.
		if (conn.ready || conn.failure) return;
		const failure = failureOf(conn, err, close);
		conn.failure = failure;
		if (!('connectFailure' in err) && Object.isExtensible(err)) {
			(err as ConnectFailureError).connectFailure = failure;
		}
		conn.settle(err);
		this.closeConn(conn);
		if (conn.run !== this.run || !this.running || this.starting) return;
		if (failure.retryable === false) {
			this.log(`[Transcribe#${conn.id}] credential refused permanently; giving up`);
			this.fatal(err);
			return;
		}
		if (conn === this.next) {
			this.next = null;
			this.retryReplacement();
		} else if (conn === this.active) {
			if (this.activeRetries >= this.cfg.maxRetries) {
				this.log('[Transcribe] session kept failing; giving up');
				this.fatal(err);
				return;
			}
			this.activeRetries++;
			this.retryLater(this.activeRetries, () => this.activate(this.open()));
		}
	}

	/** The run cannot go on: end it, letting a set-up active socket finalize, and tell the owner. */
	private fatal(err: Error): void {
		void this.shutdown(Math.min(this.cfg.drainMs, STOP_DRAIN_MS));
		try {
			this.onFatal?.(err);
		} catch {
			this.log('[Transcribe] onFatal threw');
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
			// A connection that already failed (timed out, stopped) stays failed.
			if (conn.ready || conn.failure) return;
			conn.ready = true;
			conn.settle();
			this.log(`[Transcribe#${conn.id}] ready`);
			this.armExpiry(conn);
			this.lifecycle({ phase: 'setup-ok', connectionId: conn.id, meta: conn.meta });
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
		this.scheduleRotation(conn);
	}

	/** Rotates `conn` before the 10-minute cap, or earlier when its credential expires
	 *  first: early enough for a replacement to connect, the handover to wait for a
	 *  pause, and `conn` to drain before the expiry. */
	private scheduleRotation(conn: Conn): void {
		if (this.rotateTimer) clearTimeout(this.rotateTimer);
		const untilExpiry =
			conn.expiresAtMs === undefined
				? Number.POSITIVE_INFINITY
				: conn.expiresAtMs -
					Date.now() -
					(this.cfg.connectTimeoutMs + this.cfg.pauseWaitMs + this.cfg.drainMs);
		const byExpiry = untilExpiry < this.cfg.rotateAfterMs;
		this.rotateTimer = setTimeout(
			() => {
				if (!this.running) return;
				this.log(
					byExpiry
						? '[Transcribe] rotating session before its credential expires'
						: '[Transcribe] rotating session before the 10-minute limit',
				);
				this.replaceRetries = 0;
				this.next = this.open();
				this.switchDeadline = Date.now() + this.cfg.pauseWaitMs;
				this.quietMs = 0;
			},
			byExpiry ? Math.max(0, untilExpiry) : this.cfg.rotateAfterMs,
		);
		this.rotateTimer.unref?.();
	}

	/** Closes `conn` at its credential's expiry, replacing it if it is still in use. */
	private armExpiry(conn: Conn): void {
		if (conn.expiresAtMs === undefined || conn.ended) return;
		conn.expiryTimer = setTimeout(
			() => {
				conn.expiryTimer = undefined;
				if (conn.ended) return;
				this.log(`[Transcribe#${conn.id}] credential expired; closing`);
				this.closeConn(conn);
				this.lost(conn);
			},
			Math.max(0, conn.expiresAtMs - Date.now()),
		);
		conn.expiryTimer.unref?.();
	}

	/** Hand over to the ready next session during a pause, so no word is split across sessions. */
	private maybeSwitchAtPause(pcm: Buffer): void {
		const next = this.next;
		if (!next?.ready || next.ws?.readyState !== OPEN) return;
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
			if (conn.ws?.readyState === OPEN)
				conn.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
		} catch {}
		conn.drain = sleep(waitMs).then(() => this.closeConn(conn));
		return conn.drain;
	}

	/** Closes `conn` once. One that never dialed has its credential fetch aborted and
	 *  its close reported here, since no socket will report it. */
	private closeConn(conn: Conn): void {
		if (conn.expiryTimer) clearTimeout(conn.expiryTimer);
		conn.expiryTimer = undefined;
		if (conn.ended) return;
		conn.ended = true;
		if (!conn.ws) {
			conn.fetch?.abort(new Error('Gemini Transcribe Live connection closed before its dial'));
			this.conns.delete(conn);
			this.reportClosed(conn);
			return;
		}
		try {
			conn.ws.close();
		} catch {}
	}

	private reportClosed(conn: Conn, code?: number, reason?: string): void {
		if (conn.closedReported) return;
		conn.closedReported = true;
		this.lifecycle({
			phase: 'closed',
			connectionId: conn.id,
			meta: conn.meta,
			setupDone: conn.ready,
			...(code !== undefined ? { code } : {}),
			...(reason ? { reason } : {}),
			...(!conn.ready && conn.failure ? { failure: conn.failure } : {}),
		});
	}

	private lifecycle(event: GeminiLiveTranscribeLifecycleEvent): void {
		try {
			this.onConnectionLifecycle?.(event);
		} catch {
			this.log('[Transcribe] onConnectionLifecycle threw');
		}
	}

	private clearTimers(): void {
		if (this.rotateTimer) clearTimeout(this.rotateTimer);
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.rotateTimer = null;
		this.retryTimer = null;
	}

	private flushPendingTo(conn: Conn | null): void {
		if (!conn?.ready || conn.ws?.readyState !== OPEN || this.pending.length === 0) return;
		const chunks = this.pending;
		this.pending = [];
		this.pendingBytes = 0;
		for (const c of chunks) this.sendAudio(conn, c);
	}

	private sendAudio(conn: Conn, pcm: Buffer): void {
		conn.ws?.send(
			JSON.stringify({
				realtimeInput: {
					audio: { data: pcm.toString('base64'), mimeType: `audio/pcm;rate=${TARGET_RATE}` },
				},
			}),
		);
	}
}

/** The `setup` message for `setup`, as the SDK's `live.connect` puts it on the
 *  wire, so it is exactly the setup a token locked to `setup` admits. */
function setupMessage(setup: GeminiLiveSetup): string {
	return JSON.stringify({
		setup: {
			model: `models/${setup.model}`,
			generationConfig: { responseModalities: setup.config.responseModalities },
			inputAudioTranscription: setup.config.inputAudioTranscription,
		},
	});
}

/** Where a credential connects: an ephemeral token (`auth_tokens/…`) to the
 *  Constrained endpoint as `access_token`, a key to the key endpoint, each on the
 *  credential's `apiVersion` when it names one. */
function credentialUrl({ apiKey, apiVersion }: GeminiCredential): string {
	if (apiKey.startsWith('auth_tokens/')) {
		return `${WS_BASE}.${apiVersion ?? TOKEN_API_VERSION}.GenerativeService.BidiGenerateContentConstrained?access_token=${apiKey}`;
	}
	return `${WS_BASE}.${apiVersion ?? KEY_API_VERSION}.GenerativeService.BidiGenerateContent?key=${apiKey}`;
}

/** A credential provider's failure, as the error its connection fails with. A
 *  provider marks a permanent one with `retryable: false` on what it throws. */
function credentialError(err: unknown): ConnectFailureError {
	const error = err instanceof Error ? err : new Error(String(err));
	const permanent =
		typeof err === 'object' && err !== null && (err as { retryable?: unknown }).retryable === false;
	const connectFailure: ConnectFailure = {
		source: 'provider',
		message: `Gemini credential provider failed: ${error.message}`,
		error: err,
		...(permanent ? { retryable: false as const } : {}),
	};
	return Object.assign(new Error(connectFailure.message, { cause: err }), { connectFailure });
}

/** Why `conn` failed before setup: a credential failure's own, or where it was and what happened. */
function failureOf(
	conn: Conn,
	err: Error,
	close?: { code?: number; reason?: string },
): ConnectFailure {
	const own = (err as Partial<ConnectFailureError>).connectFailure;
	if (own) return own;
	const status = conn.stage === 'dial' ? upgradeStatus(err.message) : undefined;
	return {
		source: conn.stage,
		message: err.message,
		...(close?.code !== undefined ? { code: close.code } : {}),
		...(close?.reason ? { reason: close.reason } : {}),
		...(status !== undefined ? { status } : {}),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
