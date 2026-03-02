// SPDX-License-Identifier: MIT

import { WebSocket } from 'ws';
import type { STTAudioConfig, STTProvider } from '../types/transport.js';

/** Configuration for the ElevenLabs Scribe v2 Realtime STT provider. */
export interface ElevenLabsSTTConfig {
	/** ElevenLabs API key (xi-api-key). Required. */
	apiKey: string;
	/** Model identifier. Default: `'scribe_v2'`. */
	model?: string;
	/** BCP-47 language code. Default: `'en'`. */
	languageCode?: string;
}

/** Supported PCM sample rates → ElevenLabs `audio_format` query-param values. */
const SUPPORTED_RATES: Record<number, string> = {
	8000: 'pcm_8000',
	16000: 'pcm_16000',
	22050: 'pcm_22050',
	24000: 'pcm_24000',
	44100: 'pcm_44100',
	48000: 'pcm_48000',
};

const WS_BASE_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

/** ~2 seconds of audio at 16 kHz 16-bit mono (32 000 B/s × 2). */
const MAX_RECONNECT_BUFFER_BYTES = 64_000;

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 10_000;
const BACKOFF_MULTIPLIER = 2;
const CONNECT_TIMEOUT_MS = 10_000;

type ProviderState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

/**
 * Streaming STT provider backed by ElevenLabs Scribe v2 Realtime API.
 *
 * Unlike the batch {@link GeminiBatchSTTProvider}, this provider forwards
 * every audio chunk to ElevenLabs in real time over a persistent WebSocket
 * and fires `onPartialTranscript` during speech.
 */
export class ElevenLabsSTTProvider implements STTProvider {
	// --- Config ---
	private readonly _apiKey: string;
	private readonly _model: string;
	private readonly _languageCode: string;

	// --- Audio format (set by configure()) ---
	private _sampleRate = 0;
	private _audioFormat = '';

	// --- Connection state ---
	private _state: ProviderState = 'idle';
	private _ws: WebSocket | null = null;

	// --- Turn attribution ---
	private _pendingTurnIds: number[] = [];

	// --- Reconnection ---
	private _reconnectBuffer: string[] = [];
	private _reconnectBufferBytes = 0;
	private _reconnectBackoff = INITIAL_BACKOFF_MS;
	private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	// --- Start promise resolution ---
	private _sessionStartedResolve: (() => void) | null = null;

	// --- Callbacks (wired by VoiceSession) ---
	onTranscript?: (text: string, turnId: number | undefined) => void;
	onPartialTranscript?: (text: string) => void;

	constructor(config: ElevenLabsSTTConfig) {
		if (!config.apiKey?.trim()) {
			throw new Error('ElevenLabsSTTProvider requires a non-empty apiKey');
		}
		this._apiKey = config.apiKey;
		this._model = config.model ?? 'scribe_v2';
		this._languageCode = config.languageCode ?? 'en';
	}

	// ─── STTProvider interface ────────────────────────────────────────

	configure(audio: STTAudioConfig): void {
		if (audio.bitDepth !== 16) {
			throw new Error(`ElevenLabsSTTProvider requires bitDepth=16, got ${audio.bitDepth}`);
		}
		if (audio.channels !== 1) {
			throw new Error(`ElevenLabsSTTProvider requires channels=1 (mono), got ${audio.channels}`);
		}
		const format = SUPPORTED_RATES[audio.sampleRate];
		if (!format) {
			throw new Error(
				`ElevenLabsSTTProvider: unsupported sample rate ${audio.sampleRate}Hz. ` +
					`Supported: ${Object.keys(SUPPORTED_RATES).join(', ')} Hz.`,
			);
		}
		this._sampleRate = audio.sampleRate;
		this._audioFormat = format;
	}

	async start(): Promise<void> {
		if (this._state !== 'idle') return;
		this._state = 'connecting';
		return this._connect();
	}

	async stop(): Promise<void> {
		if (this._state === 'stopped') return;
		this._state = 'stopped';

		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}

		this._pendingTurnIds = [];
		this._reconnectBuffer = [];
		this._reconnectBufferBytes = 0;

		if (this._ws) {
			if (this._ws.readyState === WebSocket.OPEN) {
				this._ws.close(1000, 'Provider stopped');
			}
			this._ws = null;
		}
	}

	feedAudio(base64Pcm: string): void {
		if (this._state === 'stopped' || this._state === 'idle') return;

		if (this._state === 'connected' && this._ws?.readyState === WebSocket.OPEN) {
			this._send({
				message_type: 'input_audio_chunk',
				audio_base_64: base64Pcm,
				sample_rate: this._sampleRate,
			});
		} else if (this._state === 'reconnecting' || this._state === 'connecting') {
			this._bufferForReconnect(base64Pcm);
		}
	}

	commit(turnId: number): void {
		this._pendingTurnIds.push(turnId);
		// Send manual commit signal so ElevenLabs commits even if VAD hasn't fired yet
		if (this._state === 'connected' && this._ws?.readyState === WebSocket.OPEN) {
			this._send({
				message_type: 'input_audio_chunk',
				audio_base_64: '',
				commit: true,
			});
		}
	}

	handleInterrupted(): void {
		// No-op: streaming provider has no local buffer to preserve.
	}

	handleTurnComplete(): void {
		// No-op: streaming provider has no local buffer to clear.
	}

	// ─── Private helpers ──────────────────────────────────────────────

	private _connect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const url = new URL(WS_BASE_URL);
			url.searchParams.set('model_id', this._model);
			url.searchParams.set('audio_format', this._audioFormat);
			url.searchParams.set('sample_rate', String(this._sampleRate));
			url.searchParams.set('language_code', this._languageCode);
			url.searchParams.set('commit_strategy', 'vad');

			this._ws = new WebSocket(url.toString(), {
				headers: { 'xi-api-key': this._apiKey },
			});

			this._sessionStartedResolve = resolve;

			this._ws.on('open', () => {
				this._log('WebSocket opened');
			});

			this._ws.on('message', (data: Buffer | string) => {
				this._handleMessage(typeof data === 'string' ? data : data.toString('utf-8'));
			});

			this._ws.on('close', (code: number, reason: Buffer) => {
				this._handleClose(code, reason.toString('utf-8'));
			});

			this._ws.on('error', (err: Error) => {
				this._log(`WebSocket error: ${err.message}`);
				if (this._sessionStartedResolve) {
					this._sessionStartedResolve = null;
					reject(err);
				}
			});

			// Connection timeout
			setTimeout(() => {
				if (this._sessionStartedResolve) {
					this._sessionStartedResolve = null;
					reject(new Error('ElevenLabsSTTProvider: connection timeout'));
				}
			}, CONNECT_TIMEOUT_MS);
		});
	}

	private _handleMessage(raw: string): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw);
		} catch {
			this._log(`Failed to parse message: ${raw.slice(0, 100)}`);
			return;
		}

		switch (msg.message_type) {
			case 'session_started':
				this._log(`Session started: ${msg.session_id}`);
				if (this._state === 'connecting' || this._state === 'reconnecting') {
					this._state = 'connected';
					this._reconnectBackoff = INITIAL_BACKOFF_MS;
					this._flushReconnectBuffer();
				}
				if (this._sessionStartedResolve) {
					this._sessionStartedResolve();
					this._sessionStartedResolve = null;
				}
				break;

			case 'partial_transcript': {
				const text = typeof msg.text === 'string' ? msg.text.trim() : '';
				if (text) this.onPartialTranscript?.(text);
				break;
			}

			case 'committed_transcript': {
				const text = typeof msg.text === 'string' ? msg.text.trim() : '';
				if (!text) break;
				const turnId = this._pendingTurnIds.shift();
				this.onTranscript?.(text, turnId);
				break;
			}

			case 'begin_utterance':
			case 'end_of_utterance':
				this._log(`${msg.message_type as string}`);
				break;

			default:
				// Error types: auth_error, quota_exceeded, rate_limited, etc.
				if (typeof msg.error === 'string') {
					this._log(`Server error (${msg.message_type}): ${msg.error}`);
				}
				break;
		}
	}

	private _handleClose(code: number, reason: string): void {
		this._log(`WebSocket closed: code=${code} reason="${reason}"`);
		this._ws = null;

		if (this._state === 'stopped') return;

		this._state = 'reconnecting';
		this._scheduleReconnect();
	}

	private _scheduleReconnect(): void {
		if (this._state !== 'reconnecting') return;

		const delay = this._reconnectBackoff;
		this._log(`Reconnecting in ${delay}ms...`);

		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = null;
			if (this._state !== 'reconnecting') return;

			this._connect().catch((err: Error) => {
				this._log(`Reconnect failed: ${err.message}`);
				this._reconnectBackoff = Math.min(
					this._reconnectBackoff * BACKOFF_MULTIPLIER,
					MAX_BACKOFF_MS,
				);
				if (this._state === 'reconnecting') {
					this._scheduleReconnect();
				}
			});
		}, delay);
	}

	private _flushReconnectBuffer(): void {
		if (this._reconnectBuffer.length === 0) return;
		this._log(`Flushing ${this._reconnectBuffer.length} buffered chunks`);

		for (const chunk of this._reconnectBuffer) {
			if (this._ws?.readyState === WebSocket.OPEN) {
				this._send({
					message_type: 'input_audio_chunk',
					audio_base_64: chunk,
					sample_rate: this._sampleRate,
				});
			}
		}
		this._reconnectBuffer = [];
		this._reconnectBufferBytes = 0;
	}

	private _bufferForReconnect(base64Pcm: string): void {
		const chunkBytes = Math.ceil((base64Pcm.length * 3) / 4);
		while (
			this._reconnectBufferBytes + chunkBytes > MAX_RECONNECT_BUFFER_BYTES &&
			this._reconnectBuffer.length > 0
		) {
			const dropped = this._reconnectBuffer.shift();
			if (dropped) this._reconnectBufferBytes -= Math.ceil((dropped.length * 3) / 4);
		}
		this._reconnectBuffer.push(base64Pcm);
		this._reconnectBufferBytes += chunkBytes;
	}

	private _send(msg: Record<string, unknown>): void {
		this._ws?.send(JSON.stringify(msg));
	}

	private _log(msg: string): void {
		const t = new Date().toISOString().slice(11, 23);
		console.log(`${t} [ElevenLabsSTT] ${msg}`);
	}
}
