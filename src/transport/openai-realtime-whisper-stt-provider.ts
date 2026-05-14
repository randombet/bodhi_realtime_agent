// SPDX-License-Identifier: MIT

import { WebSocket } from 'ws';
import { TransportError } from '../core/errors.js';
import type { STTAudioConfig, STTProvider } from '../types/transport.js';

/**
 * Streaming STT provider backed by OpenAI's `gpt-realtime-whisper` model.
 *
 * Opens a WebSocket to `/v1/realtime?intent=transcription` and runs a
 * transcription-only session (`session.type = 'transcription'`) — distinct
 * from the voice-agent session used by `OpenAIRealtimeTransport`.
 * Useful as:
 *
 *  1. A drop-in `sttProvider` in agent mode (alongside any LLM transport).
 *  2. The transcription-mode target for `VoiceSession.setTranscriptionMode`
 *     when paired with any `LLMTransport` (cross-provider supported).
 *
 * The provider itself does **not** resample. `configure()` accepts only
 * PCM16 @ 24 kHz mono and throws otherwise — `VoiceSession` is the single
 * resample point in the framework (see design-openai-realtime-transport-v2.md
 * §1.3 "Resampling ownership").
 *
 * Turn attribution uses the server-issued `item_id` (via
 * `input_audio_buffer.committed`) rather than naive FIFO of `commit()` calls,
 * because OpenAI Realtime does not guarantee ordering across overlapping
 * turns or interleaved partial/final events.
 */
export interface OpenAIRealtimeWhisperConfig {
	/** OpenAI API key. Required. */
	apiKey: string;
	/** Model identifier. Default: `'gpt-realtime-whisper'`. */
	model?: string;
	/** BCP-47 language hint. Optional. */
	language?: string;
	/** Server VAD config passed through to `session.audio.input.turn_detection`.
	 *  Default `{ type: 'server_vad' }`. */
	turnDetection?: Record<string, unknown> | null;
}

const WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

/** ~2 seconds of audio at 24 kHz 16-bit mono (48 000 B/s × 2). */
const MAX_RECONNECT_BUFFER_BYTES = 96_000;

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 10_000;
const BACKOFF_MULTIPLIER = 2;
const CONNECT_TIMEOUT_MS = 10_000;

type ProviderState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

export class OpenAIRealtimeWhisperSTTProvider implements STTProvider {
	readonly supportedEncodings = ['pcm'] as const;

	// --- Config ---
	private readonly _apiKey: string;
	private readonly _model: string;
	private readonly _language?: string;
	private readonly _turnDetection: Record<string, unknown> | null;

	// --- Connection state ---
	private _state: ProviderState = 'idle';
	private _ws: WebSocket | null = null;

	// --- Turn attribution ---
	// FIFO of framework turnIds awaiting a server-issued committed item_id.
	private _pendingTurnIds: number[] = [];
	// Map of server-issued item_id → framework turnId. Resolves attribution
	// correctness under back-to-back utterances / out-of-order completions.
	private _itemTurnIds: Map<string, number> = new Map();

	// --- Reconnection ---
	private _reconnectBuffer: string[] = [];
	private _reconnectBufferBytes = 0;
	private _reconnectBackoff = INITIAL_BACKOFF_MS;
	private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	// --- Start promise resolution ---
	private _sessionStartedResolve: (() => void) | null = null;
	private _sessionStartedReject: ((err: Error) => void) | null = null;

	// --- Callbacks (wired by VoiceSession) ---
	onTranscript?: (text: string, turnId: number | undefined) => void;
	onPartialTranscript?: (text: string) => void;

	constructor(config: OpenAIRealtimeWhisperConfig) {
		if (!config.apiKey?.trim()) {
			throw new Error('OpenAIRealtimeWhisperSTTProvider requires a non-empty apiKey');
		}
		this._apiKey = config.apiKey;
		this._model = config.model ?? 'gpt-realtime-whisper';
		this._language = config.language;
		this._turnDetection = config.turnDetection ?? { type: 'server_vad' };
	}

	// ─── STTProvider interface ────────────────────────────────────────

	configure(audio: STTAudioConfig): void {
		const encoding = audio.encoding ?? 'pcm';
		if (encoding !== 'pcm') {
			throw new TransportError(
				`OpenAIRealtimeWhisperSTTProvider: encoding '${encoding}' not supported; only 'pcm'. VoiceSession is the single resample/encode point — feed PCM16 here.`,
			);
		}
		if (audio.bitDepth !== 16) {
			throw new Error(
				`OpenAIRealtimeWhisperSTTProvider requires bitDepth=16, got ${audio.bitDepth}`,
			);
		}
		if (audio.channels !== 1) {
			throw new Error(
				`OpenAIRealtimeWhisperSTTProvider requires channels=1 (mono), got ${audio.channels}`,
			);
		}
		if (audio.sampleRate !== 24000) {
			throw new TransportError(
				`UNSUPPORTED_SAMPLE_RATE: OpenAIRealtimeWhisperSTTProvider only accepts 24000 Hz, got ${audio.sampleRate}. VoiceSession must resample before feedAudio().`,
			);
		}
		// No persisted state — the provider only accepts 24kHz PCM16 mono and we
		// hardcode `format: { type: 'audio/pcm', rate: 24000 }` in the session
		// update. VoiceSession is the single resample point (design §1.3).
	}

	async start(): Promise<void> {
		if (this._state === 'connected' || this._state === 'connecting') return;
		if (this._state === 'stopped' || this._state === 'idle') {
			this._state = 'connecting';
			try {
				await this._connect();
			} catch (err) {
				// Reset to idle so a subsequent start() can retry instead of
				// silently returning because state is stuck at 'connecting'.
				this._state = 'idle';
				if (this._ws) {
					try {
						this._ws.close();
					} catch {
						/* best-effort */
					}
					this._ws = null;
				}
				throw err;
			}
		}
	}

	async stop(): Promise<void> {
		if (this._state === 'stopped' || this._state === 'idle') return;
		this._state = 'stopped';

		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}

		this._pendingTurnIds = [];
		this._itemTurnIds.clear();
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
			this._send({ type: 'input_audio_buffer.append', audio: base64Pcm });
		} else {
			this._bufferForReconnect(base64Pcm);
		}
	}

	commit(turnId: number): void {
		this._pendingTurnIds.push(turnId);
		if (this._state === 'connected' && this._ws?.readyState === WebSocket.OPEN) {
			this._send({ type: 'input_audio_buffer.commit' });
		}
	}

	handleInterrupted(): void {
		// No-op: server VAD on the OpenAI side handles its own buffer state.
		// We do not throw away locally-buffered audio because partial transcripts
		// may still arrive for the just-interrupted segment.
	}

	handleTurnComplete(): void {
		// No-op for the streaming/VAD-driven model.
	}

	// ─── Private helpers ──────────────────────────────────────────────

	private _connect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this._sessionStartedResolve = resolve;
			this._sessionStartedReject = reject;

			this._ws = new WebSocket(WS_URL, {
				headers: {
					Authorization: `Bearer ${this._apiKey}`,
				},
			});

			this._ws.on('open', () => {
				// Send the transcription-session config immediately. Realtime
				// transcription sessions use `session.update` with
				// `session.type='transcription'` and audio settings nested under
				// `audio.input`.
				if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
				this._send({
					type: 'session.update',
					session: {
						type: 'transcription',
						audio: {
							input: {
								format: {
									type: 'audio/pcm',
									rate: 24000,
								},
								turn_detection: this._turnDetection,
								transcription: {
									model: this._model,
									...(this._language ? { language: this._language } : {}),
								},
							},
						},
					},
				});
			});

			this._ws.on('message', (data: Buffer | string) => {
				this._handleMessage(typeof data === 'string' ? data : data.toString('utf-8'));
			});

			this._ws.on('close', (code: number, reason: Buffer) => {
				this._handleClose(code, reason.toString('utf-8'));
			});

			this._ws.on('error', (err: Error) => {
				if (this._sessionStartedReject) this._rejectSessionStarted(err);
				else this._log(`WebSocket error: ${err.message}`);
			});

			setTimeout(() => {
				if (this._sessionStartedReject) {
					this._rejectSessionStarted(
						new Error('OpenAIRealtimeWhisperSTTProvider: connection timeout'),
					);
				}
			}, CONNECT_TIMEOUT_MS);
		});
	}

	private _handleMessage(raw: string): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}

		const type = msg.type as string | undefined;
		switch (type) {
			case 'transcription_session.created':
			case 'session.created':
				// Creation only proves the socket is alive. Wait for the update
				// acknowledgement before marking the provider connected; otherwise
				// buffered mic frames can be flushed before transcription is enabled.
				break;

			case 'transcription_session.updated':
			case 'session.updated':
				this._resolveSessionStarted();
				break;

			case 'input_audio_buffer.committed': {
				// Map the server-issued item_id to the next pending framework turnId.
				const itemId = typeof msg.item_id === 'string' ? msg.item_id : null;
				if (itemId) {
					const turnId = this._pendingTurnIds.shift();
					if (turnId !== undefined) {
						this._itemTurnIds.set(itemId, turnId);
					}
				}
				break;
			}

			case 'conversation.item.input_audio_transcription.delta': {
				const delta = typeof msg.delta === 'string' ? msg.delta : '';
				if (delta) this.onPartialTranscript?.(delta);
				break;
			}

			case 'conversation.item.input_audio_transcription.completed': {
				const text = typeof msg.transcript === 'string' ? msg.transcript.trim() : '';
				const itemId = typeof msg.item_id === 'string' ? msg.item_id : null;
				const turnId = itemId ? this._itemTurnIds.get(itemId) : undefined;
				if (itemId) this._itemTurnIds.delete(itemId);
				if (text) this.onTranscript?.(text, turnId);
				break;
			}

			case 'conversation.item.input_audio_transcription.failed': {
				const itemId = typeof msg.item_id === 'string' ? msg.item_id : null;
				const turnId = itemId ? this._itemTurnIds.get(itemId) : undefined;
				if (itemId) this._itemTurnIds.delete(itemId);
				this.onTranscript?.('', turnId);
				break;
			}

			case 'error':
				this._handleServerError(msg);
				break;

			default:
				// Including: input_audio_buffer.speech_started / .stopped.
				// We don't need to surface these today.
				break;
		}
	}

	private _handleClose(code: number, reason: string): void {
		this._ws = null;
		if (this._state === 'stopped') return;
		if (this._sessionStartedReject) {
			this._rejectSessionStarted(
				new Error(
					`OpenAIRealtimeWhisperSTTProvider: WebSocket closed before session update (code=${code}, reason="${reason}")`,
				),
			);
			return;
		}

		this._state = 'reconnecting';
		this._scheduleReconnect();
	}

	private _scheduleReconnect(): void {
		if (this._state !== 'reconnecting') return;

		const delay = this._reconnectBackoff;
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = null;
			if (this._state !== 'reconnecting') return;

			this._connect().catch(() => {
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
		for (const chunk of this._reconnectBuffer) {
			if (this._ws?.readyState === WebSocket.OPEN) {
				this._send({ type: 'input_audio_buffer.append', audio: chunk });
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

	private _send(message: Record<string, unknown>): void {
		this._ws?.send(JSON.stringify(message));
	}

	private _resolveSessionStarted(): void {
		if (this._state === 'connecting' || this._state === 'reconnecting') {
			this._state = 'connected';
			this._reconnectBackoff = INITIAL_BACKOFF_MS;
			this._flushReconnectBuffer();
		}
		if (this._sessionStartedResolve) {
			this._sessionStartedResolve();
			this._sessionStartedResolve = null;
			this._sessionStartedReject = null;
		}
	}

	private _rejectSessionStarted(error: Error): void {
		const reject = this._sessionStartedReject;
		this._sessionStartedResolve = null;
		this._sessionStartedReject = null;
		if (reject) reject(error);
	}

	private _handleServerError(msg: Record<string, unknown>): void {
		const error = msg.error;
		let detail = 'unknown error';
		if (error && typeof error === 'object') {
			const err = error as Record<string, unknown>;
			const message = typeof err.message === 'string' ? err.message : undefined;
			const code = typeof err.code === 'string' ? err.code : undefined;
			detail = [code, message].filter(Boolean).join(': ') || JSON.stringify(err);
		} else if (typeof error === 'string') {
			detail = error;
		}
		const serverError = new Error(`OpenAIRealtimeWhisperSTTProvider server error: ${detail}`);
		this._log(serverError.message);
		if (this._sessionStartedReject) this._rejectSessionStarted(serverError);
	}

	private _log(message: string): void {
		const t = new Date().toISOString().slice(11, 23);
		console.warn(`${t} [OpenAIRealtimeWhisperSTT] ${message}`);
	}
}
