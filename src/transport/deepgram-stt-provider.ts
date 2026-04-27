// SPDX-License-Identifier: MIT

import { WebSocket } from 'ws';
import type { STTAudioConfig, STTProvider } from '../types/transport.js';

/** Configuration for Deepgram Nova-3 live streaming STT. */
export interface DeepgramSTTConfig {
	/** Deepgram API key. Required. */
	apiKey: string;
	/** Deepgram live transcription model. Default: `'nova-3'`. */
	model?: string;
	/** BCP-47 language code. Default: `'en-US'`. */
	language?: string;
	/** Endpointing silence threshold in milliseconds, or false to disable. Default: `300`. */
	endpointingMs?: number | false;
	/** Utterance-end gap threshold in milliseconds. Default: `1000`. */
	utteranceEndMs?: number;
	/** Enable punctuation. Default: `true`. */
	punctuate?: boolean;
	/** Enable smart formatting. Default: `true`. */
	smartFormat?: boolean;
	/** Nova-3 keyterm prompting values. */
	keyterms?: string[];
}

const WS_BASE_URL = 'wss://api.deepgram.com/v1/listen';

/** ~2 seconds of audio at 16 kHz 16-bit mono. */
const MAX_RECONNECT_BUFFER_BYTES = 64_000;

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 10_000;
const BACKOFF_MULTIPLIER = 2;
const CONNECT_TIMEOUT_MS = 10_000;
const KEEPALIVE_INTERVAL_MS = 3_000;

type ProviderState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

/**
 * Streaming STT provider backed by Deepgram Nova-3 live transcription.
 *
 * The provider accepts the framework's base64 PCM chunks, sends raw binary
 * `linear16` audio to Deepgram, and maps Deepgram `Results` messages onto the
 * framework's partial/final transcript callbacks.
 */
export class DeepgramSTTProvider implements STTProvider {
	private readonly _apiKey: string;
	private readonly _model: string;
	private readonly _language: string;
	private readonly _endpointingMs: number | false;
	private readonly _utteranceEndMs: number | undefined;
	private readonly _punctuate: boolean;
	private readonly _smartFormat: boolean;
	private readonly _keyterms: string[];

	private _sampleRate = 0;
	private _state: ProviderState = 'idle';
	private _ws: WebSocket | null = null;

	private _pendingTurnId: number | undefined;
	private _reconnectBuffer: string[] = [];
	private _reconnectBufferBytes = 0;
	private _reconnectBackoff = INITIAL_BACKOFF_MS;
	private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private _keepAliveTimer: ReturnType<typeof setInterval> | null = null;

	onTranscript?: (text: string, turnId: number | undefined) => void;
	onPartialTranscript?: (text: string) => void;

	constructor(config: DeepgramSTTConfig) {
		if (!config.apiKey?.trim()) {
			throw new Error('DeepgramSTTProvider requires a non-empty apiKey');
		}

		this._apiKey = config.apiKey;
		this._model = config.model ?? 'nova-3';
		this._language = config.language ?? 'en-US';
		this._endpointingMs = config.endpointingMs ?? 300;
		this._utteranceEndMs = config.utteranceEndMs ?? 1000;
		this._punctuate = config.punctuate ?? true;
		this._smartFormat = config.smartFormat ?? true;
		this._keyterms = config.keyterms ?? [];
	}

	configure(audio: STTAudioConfig): void {
		if (audio.bitDepth !== 16) {
			throw new Error(`DeepgramSTTProvider requires bitDepth=16, got ${audio.bitDepth}`);
		}
		if (audio.channels !== 1) {
			throw new Error(`DeepgramSTTProvider requires channels=1 (mono), got ${audio.channels}`);
		}
		if (!Number.isInteger(audio.sampleRate) || audio.sampleRate <= 0) {
			throw new Error(
				`DeepgramSTTProvider requires a positive sampleRate, got ${audio.sampleRate}`,
			);
		}
		this._sampleRate = audio.sampleRate;
	}

	async start(): Promise<void> {
		if (this._state !== 'idle') return;
		if (this._sampleRate === 0) {
			throw new Error('DeepgramSTTProvider must be configured before start()');
		}

		this._state = 'connecting';
		return this._connect();
	}

	async stop(): Promise<void> {
		if (this._state === 'stopped') return;
		this._state = 'stopped';

		this._clearReconnectTimer();
		this._clearKeepAliveTimer();

		this._pendingTurnId = undefined;
		this._reconnectBuffer = [];
		this._reconnectBufferBytes = 0;

		if (this._ws) {
			if (this._ws.readyState === WebSocket.OPEN) {
				this._sendJson({ type: 'CloseStream' });
				this._ws.close(1000, 'Provider stopped');
			}
			this._ws = null;
		}
	}

	feedAudio(base64Pcm: string): void {
		if (this._state === 'stopped' || this._state === 'idle') return;

		if (this._state === 'connected' && this._ws?.readyState === WebSocket.OPEN) {
			this._ws.send(Buffer.from(base64Pcm, 'base64'));
		} else if (this._state === 'connecting' || this._state === 'reconnecting') {
			this._bufferForReconnect(base64Pcm);
		}
	}

	commit(turnId: number): void {
		this._pendingTurnId = turnId;
		if (this._state === 'connected' && this._ws?.readyState === WebSocket.OPEN) {
			this._sendJson({ type: 'Finalize' });
		}
	}

	handleInterrupted(): void {
		// No local audio buffer to preserve. Deepgram receives chunks continuously.
	}

	handleTurnComplete(): void {
		// Keep pending turn ids so late final Results can still be attributed.
	}

	private _connect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const url = this._buildUrl();
			const ws = new WebSocket(url.toString(), {
				headers: { Authorization: `Token ${this._apiKey}` },
			});
			this._ws = ws;

			let settled = false;
			const timeout = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new Error('DeepgramSTTProvider: connection timeout'));
			}, CONNECT_TIMEOUT_MS);

			ws.on('open', () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				this._state = 'connected';
				this._reconnectBackoff = INITIAL_BACKOFF_MS;
				this._startKeepAlive();
				this._flushReconnectBuffer();
				this._log('WebSocket opened');
				resolve();
			});

			ws.on('message', (data: Buffer | string) => {
				this._handleMessage(typeof data === 'string' ? data : data.toString('utf-8'));
			});

			ws.on('close', (code: number, reason: Buffer) => {
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					reject(new Error(`DeepgramSTTProvider: connection closed before open (${code})`));
				}
				this._handleClose(code, reason.toString('utf-8'));
			});

			ws.on('error', (err: Error) => {
				this._log(`WebSocket error: ${err.message}`);
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					reject(err);
				}
			});
		});
	}

	private _buildUrl(): URL {
		const url = new URL(WS_BASE_URL);
		url.searchParams.set('model', this._model);
		url.searchParams.set('language', this._language);
		url.searchParams.set('encoding', 'linear16');
		url.searchParams.set('sample_rate', String(this._sampleRate));
		url.searchParams.set('channels', '1');
		url.searchParams.set('interim_results', 'true');
		url.searchParams.set('punctuate', String(this._punctuate));
		url.searchParams.set('smart_format', String(this._smartFormat));
		url.searchParams.set(
			'endpointing',
			this._endpointingMs === false ? 'false' : String(this._endpointingMs),
		);
		if (this._utteranceEndMs !== undefined) {
			url.searchParams.set('utterance_end_ms', String(this._utteranceEndMs));
		}
		url.searchParams.set('vad_events', 'true');
		for (const keyterm of this._keyterms) {
			if (keyterm.trim()) url.searchParams.append('keyterm', keyterm);
		}
		return url;
	}

	private _handleMessage(raw: string): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw);
		} catch {
			this._log(`Failed to parse message: ${raw.slice(0, 100)}`);
			return;
		}

		switch (msg.type) {
			case 'Results':
				this._handleResults(msg);
				break;
			case 'Metadata':
				this._log(`Metadata received: ${String(msg.request_id ?? 'unknown')}`);
				break;
			case 'UtteranceEnd':
			case 'SpeechStarted':
				this._log(String(msg.type));
				break;
			case 'Error':
			case 'Warning':
				this._log(
					`Server ${String(msg.type).toLowerCase()}: ${String(msg.description ?? msg.code ?? 'unknown')}`,
				);
				break;
			default:
				break;
		}
	}

	private _handleResults(msg: Record<string, unknown>): void {
		const text = this._extractTranscript(msg).trim();
		if (!text) return;

		if (msg.is_final === true) {
			const turnId = this._pendingTurnId;
			this._pendingTurnId = undefined;
			this.onTranscript?.(text, turnId);
			return;
		}

		this.onPartialTranscript?.(text);
	}

	private _extractTranscript(msg: Record<string, unknown>): string {
		const channel = msg.channel;
		if (!channel || typeof channel !== 'object') return '';

		const alternatives = (channel as { alternatives?: unknown }).alternatives;
		if (!Array.isArray(alternatives) || alternatives.length === 0) return '';

		const first = alternatives[0];
		if (!first || typeof first !== 'object') return '';

		const transcript = (first as { transcript?: unknown }).transcript;
		return typeof transcript === 'string' ? transcript : '';
	}

	private _handleClose(code: number, reason: string): void {
		this._log(`WebSocket closed: code=${code} reason="${reason}"`);
		this._ws = null;
		this._clearKeepAliveTimer();

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
				this._ws.send(Buffer.from(chunk, 'base64'));
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

	private _startKeepAlive(): void {
		this._clearKeepAliveTimer();
		this._keepAliveTimer = setInterval(() => {
			if (this._state === 'connected' && this._ws?.readyState === WebSocket.OPEN) {
				this._sendJson({ type: 'KeepAlive' });
			}
		}, KEEPALIVE_INTERVAL_MS);
	}

	private _clearKeepAliveTimer(): void {
		if (this._keepAliveTimer) {
			clearInterval(this._keepAliveTimer);
			this._keepAliveTimer = null;
		}
	}

	private _clearReconnectTimer(): void {
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
	}

	private _sendJson(msg: Record<string, unknown>): void {
		this._ws?.send(JSON.stringify(msg));
	}

	private _log(msg: string): void {
		const t = new Date().toISOString().slice(11, 23);
		console.log(`${t} [DeepgramSTT] ${msg}`);
	}
}
