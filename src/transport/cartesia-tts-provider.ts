// SPDX-License-Identifier: MIT

import { WebSocket } from 'ws';
import { SentenceBuffer } from '../audio/sentence-buffer.js';
import type { TTSAudioConfig, TTSProvider } from '../types/tts.js';

/** Configuration for the Cartesia TTS provider. */
export interface CartesiaTTSConfig {
	/** Cartesia API key. Required. */
	apiKey: string;
	/** Cartesia voice ID. Required. */
	voiceId: string;
	/** Model identifier. Default: `'sonic-2'`. */
	modelId?: string;
	/** ISO 639-1 language code (e.g. `'en'`). Default: `'en'`. */
	language?: string;
	/** Speech speed control. Default: `'normal'`. */
	speed?: 'slowest' | 'slow' | 'normal' | 'fast' | 'fastest' | number;
	/** Emotion tags (e.g. `['cheerful', 'friendly']`). Default: `[]`. */
	emotion?: string[];
}

/** Cartesia API version header value. */
const CARTESIA_VERSION = '2024-06-10';

/** WebSocket endpoint for Cartesia streaming TTS. */
const WS_BASE_URL = 'wss://api.cartesia.ai/tts/websocket';

/** Connection timeout in milliseconds. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Supported PCM sample rates for Cartesia `pcm_s16le` output.
 * Cartesia supports 8000, 16000, 22050, 24000, 44100 Hz.
 */
const SUPPORTED_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100];

type ProviderState = 'idle' | 'connecting' | 'connected' | 'stopped';

/**
 * Streaming TTS provider backed by the Cartesia WebSocket API.
 *
 * Each `requestId` from `synthesize()` maps to a unique Cartesia "context".
 * Text is buffered at sentence boundaries via {@link SentenceBuffer} before
 * being sent to the API. Audio chunks arrive as base64-encoded PCM and are
 * delivered through the `onAudio` callback.
 */
export class CartesiaTTSProvider implements TTSProvider {
	// --- Config ---
	private readonly _apiKey: string;
	private readonly _voiceId: string;
	private readonly _modelId: string;
	private readonly _language: string;
	private readonly _speed: 'slowest' | 'slow' | 'normal' | 'fast' | 'fastest' | number;
	private readonly _emotion: string[];

	// --- Audio format (set by configure()) ---
	private _sampleRate = 0;

	// --- Connection state ---
	private _state: ProviderState = 'idle';
	private _ws: WebSocket | null = null;

	// --- Sentence buffering ---
	private _sentenceBuffer = new SentenceBuffer();

	// --- Context tracking ---
	/** Current requestId being synthesized. */
	private _currentRequestId: number | null = null;
	/** Map from Cartesia context_id → requestId for audio/done correlation. */
	private readonly _contextToRequest = new Map<string, number>();
	/** Set of requestIds that have been cancelled (to suppress late callbacks). */
	private readonly _cancelledRequests = new Set<number>();
	/** Counter for generating unique context IDs within this session. */
	private _contextCounter = 0;
	/** Current context ID (for the active requestId). */
	private _currentContextId: string | null = null;
	/** Whether the current context has been finalized (continue: false sent). */
	private _contextFinalized = false;

	// --- Start promise resolution ---
	private _connectResolve: (() => void) | null = null;
	private _connectReject: ((err: Error) => void) | null = null;
	private _connectTimer?: ReturnType<typeof setTimeout>;

	// --- Callbacks (wired by VoiceSession) ---
	onAudio?: (base64Pcm: string, durationMs: number, requestId: number) => void;
	onDone?: (requestId: number) => void;
	onWordBoundary?: (word: string, offsetMs: number, requestId: number) => void;
	onError?: (error: Error, fatal: boolean) => void;

	constructor(config: CartesiaTTSConfig) {
		if (!config.apiKey?.trim()) {
			throw new Error('CartesiaTTSProvider requires a non-empty apiKey');
		}
		if (!config.voiceId?.trim()) {
			throw new Error('CartesiaTTSProvider requires a non-empty voiceId');
		}
		this._apiKey = config.apiKey;
		this._voiceId = config.voiceId;
		this._modelId = config.modelId ?? 'sonic-2';
		this._language = config.language ?? 'en';
		this._speed = config.speed ?? 'normal';
		this._emotion = config.emotion ?? [];
	}

	// ─── TTSProvider interface ───────────────────────────────────────────

	configure(preferred: TTSAudioConfig): TTSAudioConfig {
		// Find the closest supported sample rate to the preferred rate
		let bestRate = SUPPORTED_SAMPLE_RATES[0];
		let bestDiff = Math.abs(preferred.sampleRate - bestRate);

		for (const rate of SUPPORTED_SAMPLE_RATES) {
			const diff = Math.abs(preferred.sampleRate - rate);
			if (diff < bestDiff) {
				bestRate = rate;
				bestDiff = diff;
			}
		}

		this._sampleRate = bestRate;

		return {
			sampleRate: bestRate,
			bitDepth: 16,
			channels: 1,
			encoding: 'pcm',
		};
	}

	async start(): Promise<void> {
		if (this._state !== 'idle') return;
		if (this._sampleRate === 0) {
			throw new Error('CartesiaTTSProvider: configure() must be called before start()');
		}
		this._state = 'connecting';
		return this._connect();
	}

	async stop(): Promise<void> {
		if (this._state === 'stopped') return;
		this._state = 'stopped';

		this._sentenceBuffer.clear();
		this._contextToRequest.clear();
		this._cancelledRequests.clear();
		this._currentRequestId = null;
		this._currentContextId = null;
		this._contextFinalized = false;

		if (this._connectTimer) {
			clearTimeout(this._connectTimer);
			this._connectTimer = undefined;
		}
		if (this._connectResolve) {
			this._connectResolve = null;
			this._connectReject = null;
		}

		if (this._ws) {
			if (this._ws.readyState === WebSocket.OPEN) {
				this._ws.close(1000, 'Provider stopped');
			}
			this._ws = null;
		}
	}

	synthesize(text: string, requestId: number, options?: { flush?: boolean }): void {
		if (this._state !== 'connected') return;

		// If requestId changed, finalize previous context and start new one
		if (this._currentRequestId !== null && this._currentRequestId !== requestId) {
			this._finalizeCurrentContext();
		}

		// Ensure a context exists for this requestId
		if (this._currentRequestId !== requestId) {
			this._currentRequestId = requestId;
			this._currentContextId = this._generateContextId();
			this._contextToRequest.set(this._currentContextId, requestId);
			this._contextFinalized = false;
			this._sentenceBuffer.clear();
		}

		// At this point _currentContextId is guaranteed non-null (set above or previously)
		if (!this._currentContextId) return;
		const contextId = this._currentContextId;

		// Buffer text and send complete sentences
		const sentences = this._sentenceBuffer.add(text);
		for (const sentence of sentences) {
			this._sendTextChunk(sentence, contextId, true);
		}

		// Flush remaining buffered text if requested
		if (options?.flush) {
			const remaining = this._sentenceBuffer.flush();
			if (remaining) {
				this._sendTextChunk(remaining, contextId, false);
				this._contextFinalized = true;
			} else if (!this._contextFinalized) {
				// No remaining text, but we still need to finalize the context
				// Send an empty final chunk to signal end-of-input
				this._sendTextChunk('', contextId, false);
				this._contextFinalized = true;
			}
		}
	}

	cancel(): void {
		if (this._state !== 'connected') return;

		this._sentenceBuffer.clear();

		if (this._currentContextId && this._currentRequestId !== null) {
			// Send cancel message to Cartesia
			this._send({
				context_id: this._currentContextId,
				cancel: true,
			});

			// Clean up context mapping eagerly — don't rely on 'done' arriving
			this._contextToRequest.delete(this._currentContextId);

			this._currentContextId = null;
			this._currentRequestId = null;
			this._contextFinalized = false;
		}
	}

	// ─── Private helpers ─────────────────────────────────────────────────

	private _connect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const url = new URL(WS_BASE_URL);
			url.searchParams.set('api_key', this._apiKey);
			url.searchParams.set('cartesia_version', CARTESIA_VERSION);

			this._ws = new WebSocket(url.toString());

			this._connectResolve = resolve;
			this._connectReject = reject;

			this._ws.on('open', () => {
				this._log('WebSocket opened');
				if (this._state === 'connecting') {
					this._state = 'connected';
				}
				if (this._connectResolve) {
					this._connectResolve();
					this._connectResolve = null;
					this._connectReject = null;
				}
			});

			this._ws.on('message', (data: Buffer | string) => {
				this._handleMessage(typeof data === 'string' ? data : data.toString('utf-8'));
			});

			this._ws.on('close', (code: number, reason: Buffer) => {
				this._handleClose(code, reason.toString('utf-8'));
			});

			this._ws.on('error', (err: Error) => {
				this._log(`WebSocket error: ${err.message}`);
				if (this._connectReject) {
					this._connectReject(err);
					this._connectResolve = null;
					this._connectReject = null;
				} else {
					this.onError?.(err, true);
				}
			});

			// Connection timeout
			this._connectTimer = setTimeout(() => {
				this._connectTimer = undefined;
				if (this._connectResolve) {
					const err = new Error('CartesiaTTSProvider: connection timeout');
					this._connectResolve = null;
					if (this._connectReject) {
						this._connectReject(err);
						this._connectReject = null;
					}
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

		const contextId = typeof msg.context_id === 'string' ? msg.context_id : null;
		const requestId = contextId ? this._contextToRequest.get(contextId) : undefined;

		// Suppress callbacks for cancelled requests (legacy guard).
		// In normal cancel() flow we eagerly delete context mapping, so requestId is
		// usually undefined here and callbacks are naturally skipped.
		if (requestId !== undefined && this._cancelledRequests.has(requestId)) {
			// Still handle 'done' to clean up context mapping
			if (msg.type === 'done' && contextId) {
				this._contextToRequest.delete(contextId);
				this._cancelledRequests.delete(requestId);
			}
			return;
		}

		switch (msg.type) {
			case 'chunk': {
				if (requestId === undefined || !contextId) break;
				const audioData = typeof msg.data === 'string' ? msg.data : null;
				if (!audioData) break;

				// Calculate duration: base64 → bytes → samples → ms
				const byteLength = Math.ceil((audioData.length * 3) / 4);
				const samples = byteLength / 2; // 16-bit PCM = 2 bytes per sample
				const durationMs = (samples / this._sampleRate) * 1000;

				this.onAudio?.(audioData, durationMs, requestId);

				// Parse word-level timestamps if present
				this._parseWordTimestamps(msg, requestId);
				break;
			}

			case 'done': {
				if (requestId !== undefined && contextId) {
					this._contextToRequest.delete(contextId);
					this.onDone?.(requestId);
				}
				break;
			}

			case 'timestamps': {
				if (requestId !== undefined) {
					this._parseWordTimestamps(msg, requestId);
				}
				break;
			}

			case 'error': {
				const errorMsg =
					typeof msg.message === 'string'
						? msg.message
						: typeof msg.error === 'string'
							? msg.error
							: 'Unknown Cartesia error';
				this._log(`Server error: ${errorMsg}`);
				this.onError?.(new Error(errorMsg), false);
				break;
			}

			default:
				// Unknown message type — ignore gracefully
				break;
		}
	}

	private _parseWordTimestamps(msg: Record<string, unknown>, requestId: number): void {
		// Cartesia word_timestamps format:
		// { word_timestamps: { words: ["hello", "world"], start: [0.0, 0.5], end: [0.5, 1.0] } }
		const timestamps = msg.word_timestamps as
			| { words?: string[]; start?: number[]; end?: number[] }
			| undefined;
		if (!timestamps?.words || !timestamps?.start) return;

		const words = timestamps.words;
		const starts = timestamps.start;

		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			const startSec = starts[i];
			if (word && startSec !== undefined) {
				this.onWordBoundary?.(word, startSec * 1000, requestId);
			}
		}
	}

	private _handleClose(code: number, reason: string): void {
		this._log(`WebSocket closed: code=${code} reason="${reason}"`);
		this._ws = null;

		if (this._state === 'stopped') return;

		// Cartesia TTS does not auto-reconnect in V1 — report as fatal error
		this._state = 'stopped';
		this.onError?.(
			new Error(`CartesiaTTSProvider: WebSocket closed unexpectedly (code=${code})`),
			true,
		);
	}

	private _sendTextChunk(text: string, contextId: string, isContinuation: boolean): void {
		if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

		const voice: Record<string, unknown> = {
			mode: 'id',
			id: this._voiceId,
		};

		// Add optional voice controls
		if (this._speed !== 'normal' || this._emotion.length > 0) {
			const controls: Record<string, unknown> = {};
			if (this._speed !== 'normal') controls.speed = this._speed;
			if (this._emotion.length > 0) controls.emotion = this._emotion;
			voice.__experimental_controls = controls;
		}

		this._send({
			model_id: this._modelId,
			transcript: text,
			voice,
			output_format: {
				container: 'raw',
				encoding: 'pcm_s16le',
				sample_rate: this._sampleRate,
			},
			context_id: contextId,
			language: this._language,
			continue: isContinuation,
			add_timestamps: true,
		});
	}

	private _finalizeCurrentContext(): void {
		if (!this._currentContextId || this._contextFinalized || this._currentRequestId === null) {
			return;
		}

		// Flush any remaining buffered text
		const remaining = this._sentenceBuffer.flush();
		if (remaining) {
			this._sendTextChunk(remaining, this._currentContextId, false);
		} else {
			// Send empty final chunk to close the context
			this._sendTextChunk('', this._currentContextId, false);
		}
		this._contextFinalized = true;
	}

	private _generateContextId(): string {
		this._contextCounter++;
		return `ctx-${this._contextCounter}`;
	}

	private _send(msg: Record<string, unknown>): void {
		this._ws?.send(JSON.stringify(msg));
	}

	private _log(msg: string): void {
		const t = new Date().toISOString().slice(11, 23);
		console.log(`${t} [CartesiaTTS] ${msg}`);
	}
}
