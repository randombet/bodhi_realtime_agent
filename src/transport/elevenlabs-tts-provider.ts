// SPDX-License-Identifier: MIT

import { WebSocket } from 'ws';
import { SentenceBuffer } from '../audio/sentence-buffer.js';
import type { TTSAudioConfig, TTSProvider } from '../types/tts.js';

/** Configuration for the ElevenLabs TTS streaming provider. */
export interface ElevenLabsTTSConfig {
	/** ElevenLabs API key (xi-api-key). Required. */
	apiKey: string;
	/** ElevenLabs voice ID (preset or cloned). Required. */
	voiceId: string;
	/** Model identifier. Default: `'eleven_flash_v2_5'` (lowest latency). */
	modelId?: string;
	/** Voice stability (0.0-1.0). Default: `0.5`. */
	stability?: number;
	/** Voice similarity boost (0.0-1.0). Default: `0.75`. */
	similarityBoost?: number;
	/** Voice expressiveness / style (0.0-1.0). Default: `0.0`. */
	style?: number;
	/** Enhance voice clarity. Default: `true`. */
	useSpeakerBoost?: boolean;
	/** BCP-47 language code for multilingual models. */
	languageCode?: string;
}

/** Supported PCM sample rates to ElevenLabs `output_format` values. */
const SUPPORTED_OUTPUT_FORMATS: Record<number, string> = {
	8000: 'pcm_8000',
	16000: 'pcm_16000',
	22050: 'pcm_22050',
	24000: 'pcm_24000',
	44100: 'pcm_44100',
};

const WS_BASE_URL = 'wss://api.elevenlabs.io/v1/text-to-speech';
const CONNECT_TIMEOUT_MS = 10_000;

/** Maximum characters pending synthesis before applying backpressure. */
const MAX_PENDING_CHARS = 10_000;

type ProviderState = 'idle' | 'connecting' | 'connected' | 'stopping' | 'stopped';

/**
 * Streaming TTS provider backed by ElevenLabs WebSocket streaming API.
 *
 * Uses the `/v1/text-to-speech/{voice_id}/stream-input` endpoint to stream
 * text in and receive base64-encoded PCM audio out. Text is buffered via
 * {@link SentenceBuffer} and sent at sentence boundaries for natural prosody.
 */
export class ElevenLabsTTSProvider implements TTSProvider {
	// --- Config ---
	private readonly _apiKey: string;
	private readonly _voiceId: string;
	private readonly _modelId: string;
	private readonly _stability: number;
	private readonly _similarityBoost: number;
	private readonly _style: number;
	private readonly _useSpeakerBoost: boolean;
	private readonly _languageCode: string | undefined;

	// --- Audio format (set by configure()) ---
	private _outputFormat = '';
	private _sampleRate = 0;

	// --- Connection state ---
	private _state: ProviderState = 'idle';
	private _ws: WebSocket | null = null;

	// --- Text buffering ---
	private _sentenceBuffer = new SentenceBuffer();
	/** Total characters sent to TTS but not yet acknowledged (pending synthesis). */
	private _pendingChars = 0;

	// --- Request tracking ---
	private _currentRequestId = -1;
	/** Set of requestIds for which we've sent text but not yet received final audio. */
	private _pendingRequestIds = new Set<number>();

	// --- Start promise resolution ---
	private _connectResolve: (() => void) | null = null;
	private _connectReject: ((err: Error) => void) | null = null;
	private _connectTimer?: ReturnType<typeof setTimeout>;

	// --- Callbacks (wired by VoiceSession before start()) ---
	onAudio?: (base64Pcm: string, durationMs: number, requestId: number) => void;
	onDone?: (requestId: number) => void;
	onWordBoundary?: (word: string, offsetMs: number, requestId: number) => void;
	onError?: (error: Error, fatal: boolean) => void;

	constructor(config: ElevenLabsTTSConfig) {
		if (!config.apiKey?.trim()) {
			throw new Error('ElevenLabsTTSProvider requires a non-empty apiKey');
		}
		if (!config.voiceId?.trim()) {
			throw new Error('ElevenLabsTTSProvider requires a non-empty voiceId');
		}
		this._apiKey = config.apiKey;
		this._voiceId = config.voiceId;
		this._modelId = config.modelId ?? 'eleven_flash_v2_5';
		this._stability = config.stability ?? 0.5;
		this._similarityBoost = config.similarityBoost ?? 0.75;
		this._style = config.style ?? 0.0;
		this._useSpeakerBoost = config.useSpeakerBoost ?? true;
		this._languageCode = config.languageCode;
	}

	// ─── TTSProvider interface ───────────────────────────────────────

	configure(preferred: TTSAudioConfig): TTSAudioConfig {
		const format = SUPPORTED_OUTPUT_FORMATS[preferred.sampleRate];
		if (format) {
			this._outputFormat = format;
			this._sampleRate = preferred.sampleRate;
		} else {
			// Default to 24kHz if preferred rate not natively supported
			this._outputFormat = 'pcm_24000';
			this._sampleRate = 24000;
		}
		return {
			sampleRate: this._sampleRate,
			bitDepth: 16,
			channels: 1,
			encoding: 'pcm',
		};
	}

	async start(): Promise<void> {
		if (this._state !== 'idle') return;
		if (!this._outputFormat) {
			throw new Error('ElevenLabsTTSProvider: configure() must be called before start()');
		}
		this._state = 'connecting';
		return this._connect();
	}

	async stop(): Promise<void> {
		if (this._state === 'stopped' || this._state === 'stopping') return;
		this._state = 'stopping';

		// Send EOS (end of stream) if connected
		if (this._ws?.readyState === WebSocket.OPEN) {
			this._send({ text: '' });
		}

		this._cleanup();
		this._state = 'stopped';
	}

	synthesize(text: string, requestId: number, options?: { flush?: boolean }): void {
		if (this._state !== 'connected') return;

		// Track request
		if (this._currentRequestId !== requestId) {
			// New requestId — flush any remaining text from previous request
			this._flushBuffer(this._currentRequestId);
			this._currentRequestId = requestId;
			this._pendingRequestIds.add(requestId);
		}

		// Backpressure: reject input when too much text is pending synthesis
		if (this._pendingChars > MAX_PENDING_CHARS) {
			this._log(
				`Backpressure: dropping ${text.length} chars (${this._pendingChars} pending, limit ${MAX_PENDING_CHARS})`,
			);
			return;
		}

		// Buffer text and send at sentence boundaries
		const sentences = this._sentenceBuffer.add(text);
		for (const sentence of sentences) {
			this._sendText(sentence);
			this._pendingChars += sentence.length;
		}

		if (options?.flush) {
			this._flushBuffer(requestId);
		}
	}

	cancel(): void {
		// Clear text buffer
		this._sentenceBuffer.clear();
		this._pendingChars = 0;

		// Send flush signal and close/reopen the WebSocket
		if (this._ws?.readyState === WebSocket.OPEN) {
			// Send an empty text to signal flush
			this._send({ text: '', flush: true });
		}

		// Fire onDone for any pending requestIds (synthesis cancelled)
		for (const rid of this._pendingRequestIds) {
			this.onDone?.(rid);
		}
		this._pendingRequestIds.clear();

		// Close and reconnect
		this._closeAndReconnect();
	}

	// ─── Private helpers ─────────────────────────────────────────────

	private _connect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const url = `${WS_BASE_URL}/${encodeURIComponent(this._voiceId)}/stream-input?model_id=${encodeURIComponent(this._modelId)}&output_format=${encodeURIComponent(this._outputFormat)}`;

			this._ws = new WebSocket(url, {
				headers: { 'xi-api-key': this._apiKey },
			});

			this._connectResolve = resolve;
			this._connectReject = reject;

			this._ws.on('open', () => {
				this._log('WebSocket opened');
				this._sendBOS();
				this._state = 'connected';
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
					const err = new Error('ElevenLabsTTSProvider: connection timeout');
					this._connectResolve = null;
					if (this._connectReject) {
						this._connectReject(err);
						this._connectReject = null;
					}
				}
			}, CONNECT_TIMEOUT_MS);
		});
	}

	/** Send Beginning of Stream (BOS) message with voice settings. */
	private _sendBOS(): void {
		const bos: Record<string, unknown> = {
			text: ' ',
			voice_settings: {
				stability: this._stability,
				similarity_boost: this._similarityBoost,
				style: this._style,
				use_speaker_boost: this._useSpeakerBoost,
			},
			generation_config: {
				flush: true,
			},
			xi_api_key: this._apiKey,
		};
		if (this._languageCode) {
			bos.language_code = this._languageCode;
		}
		this._send(bos);
	}

	private _sendText(text: string): void {
		if (this._ws?.readyState !== WebSocket.OPEN) return;
		this._send({
			text,
			try_trigger_generation: true,
		});
	}

	private _flushBuffer(requestId: number): void {
		if (requestId < 0) return;
		const remaining = this._sentenceBuffer.flush();
		if (remaining) {
			this._sendText(remaining);
			this._pendingChars += remaining.length;
		}
		// Send generation flush to trigger any remaining synthesis
		if (this._ws?.readyState === WebSocket.OPEN) {
			this._send({ text: '', flush: true });
		}
	}

	private _handleMessage(raw: string): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw);
		} catch {
			this._log(`Failed to parse message: ${raw.slice(0, 100)}`);
			return;
		}

		// Audio data
		if (typeof msg.audio === 'string' && msg.audio.length > 0) {
			const requestId = this._currentRequestId;
			if (requestId >= 0 && this._pendingRequestIds.has(requestId)) {
				// Calculate duration from PCM data: base64 → bytes → samples → duration
				const byteLength = Math.ceil((msg.audio.length * 3) / 4);
				// 16-bit mono = 2 bytes per sample
				const samples = byteLength / 2;
				const durationMs = (samples / this._sampleRate) * 1000;
				this.onAudio?.(msg.audio, durationMs, requestId);
			}
		}

		// Word alignment / boundary data — prefer normalizedAlignment, fall back to alignment
		const alignmentData = (msg.normalizedAlignment ?? msg.alignment) as
			| { chars?: string[]; charStartTimesMs?: number[]; charDurationsMs?: number[] }
			| undefined;
		if (alignmentData != null && typeof alignmentData === 'object') {
			this._processAlignment(alignmentData);
		}

		// Final message indicator — isFinal is true on the last chunk
		if (msg.isFinal === true) {
			const requestId = this._currentRequestId;
			if (requestId >= 0 && this._pendingRequestIds.has(requestId)) {
				this._pendingRequestIds.delete(requestId);
				this._pendingChars = 0;
				this.onDone?.(requestId);
			}
		}

		// Error messages
		if (typeof msg.error === 'string') {
			this._log(`Server error: ${msg.error}`);
			this.onError?.(new Error(`ElevenLabs TTS error: ${msg.error}`), false);
		}

		if (typeof msg.message === 'string' && msg.error !== undefined) {
			this._log(`Server message: ${msg.message}`);
		}
	}

	private _processAlignment(alignment: {
		chars?: string[];
		charStartTimesMs?: number[];
		charDurationsMs?: number[];
	}): void {
		const requestId = this._currentRequestId;
		if (requestId < 0 || !this._pendingRequestIds.has(requestId)) return;

		const chars = alignment.chars;
		const startTimes = alignment.charStartTimesMs;
		if (!chars || !startTimes || chars.length === 0) return;

		// Reconstruct words from character data
		let wordStart = -1;
		let currentWord = '';

		for (let i = 0; i < chars.length; i++) {
			const ch = chars[i];
			if (ch === ' ' || ch === '\n' || ch === '\t') {
				if (currentWord && wordStart >= 0) {
					this.onWordBoundary?.(currentWord, startTimes[wordStart], requestId);
				}
				currentWord = '';
				wordStart = -1;
			} else {
				if (wordStart < 0) wordStart = i;
				currentWord += ch;
			}
		}
		// Emit trailing word
		if (currentWord && wordStart >= 0) {
			this.onWordBoundary?.(currentWord, startTimes[wordStart], requestId);
		}
	}

	private _handleClose(code: number, reason: string): void {
		this._log(`WebSocket closed: code=${code} reason="${reason}"`);
		this._ws = null;

		if (this._state === 'stopped' || this._state === 'stopping') return;

		// Unexpected close — report as fatal error
		this._state = 'stopped';
		this.onError?.(
			new Error(`ElevenLabs TTS WebSocket closed unexpectedly: code=${code} reason="${reason}"`),
			true,
		);
	}

	private _closeAndReconnect(): void {
		if (this._ws) {
			// Remove close handler temporarily to avoid triggering error path
			this._ws.removeAllListeners('close');
			this._ws.removeAllListeners('error');
			if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
				this._ws.close(1000, 'Cancel and reconnect');
			}
			this._ws = null;
		}

		if (this._state === 'stopped' || this._state === 'stopping') return;

		this._state = 'connecting';
		this._connect().catch((err: Error) => {
			this._log(`Reconnect failed: ${err.message}`);
			this._state = 'stopped';
			this.onError?.(err, true);
		});
	}

	private _cleanup(): void {
		this._sentenceBuffer.clear();
		this._pendingChars = 0;
		this._pendingRequestIds.clear();
		if (this._connectTimer) {
			clearTimeout(this._connectTimer);
			this._connectTimer = undefined;
		}

		if (this._ws) {
			if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
				this._ws.close(1000, 'Provider stopped');
			}
			this._ws = null;
		}
	}

	private _send(msg: Record<string, unknown>): void {
		this._ws?.send(JSON.stringify(msg));
	}

	private _log(msg: string): void {
		const t = new Date().toISOString().slice(11, 23);
		console.log(`${t} [ElevenLabsTTS] ${msg}`);
	}
}
