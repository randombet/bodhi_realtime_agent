import { WebSocket } from 'ws';
import { SentenceBuffer } from '../audio/sentence-buffer.js';
import type { TTSAudioConfig, TTSProvider } from '../types/tts.js';

export interface HumeTTSConfig {
	/** Hume API key. Required. */
	apiKey: string;
	/** Hume voice name. If omitted, Hume can synthesize with a generated voice on Octave 1. */
	voiceName?: string;
	/** Hume voice id. Takes precedence over voiceName when set. */
	voiceId?: string;
	/** Hume voice provider. Default: HUME_AI. */
	voiceProvider?: 'HUME_AI' | 'CUSTOM_VOICE';
	/** Acting instructions / delivery style. */
	description?: string;
	/** Octave model version. */
	version?: '1' | '2';
	/** Optional speech speed. Hume accepts numeric speed controls. */
	speed?: number;
}

const WS_BASE_URL = 'wss://api.hume.ai/v0/tts/stream/input';
const CONNECT_TIMEOUT_MS = 10_000;
const OUTPUT_SAMPLE_RATE = 48_000;

type ProviderState = 'idle' | 'connecting' | 'connected' | 'stopped';

type HumeAudioMessage = {
	type?: string;
	audio?: string;
	is_last_chunk?: boolean;
	request_id?: string;
	text?: string;
};

export class HumeTTSProvider implements TTSProvider {
	private readonly _apiKey: string;
	private readonly _voiceName?: string;
	private readonly _voiceId?: string;
	private readonly _voiceProvider: 'HUME_AI' | 'CUSTOM_VOICE';
	private readonly _description?: string;
	private readonly _version?: '1' | '2';
	private readonly _speed?: number;

	private _state: ProviderState = 'idle';
	private _ws: WebSocket | null = null;
	private _sentenceBuffer = new SentenceBuffer();
	private _currentRequestId: number | null = null;
	private _pendingDone = new Set<number>();
	private _closeRequested = false;

	private _connectResolve: (() => void) | null = null;
	private _connectReject: ((err: Error) => void) | null = null;
	private _connectTimer?: ReturnType<typeof setTimeout>;

	onAudio?: (base64Pcm: string, durationMs: number, requestId: number) => void;
	onDone?: (requestId: number) => void;
	onWordBoundary?: (word: string, offsetMs: number, requestId: number) => void;
	onError?: (error: Error, fatal: boolean) => void;

	constructor(config: HumeTTSConfig) {
		if (!config.apiKey?.trim()) {
			throw new Error('HumeTTSProvider requires a non-empty apiKey');
		}
		this._apiKey = config.apiKey;
		this._voiceName = config.voiceName?.trim() || undefined;
		this._voiceId = config.voiceId?.trim() || undefined;
		this._voiceProvider = config.voiceProvider ?? 'HUME_AI';
		this._description = config.description?.trim() || undefined;
		this._version = config.version;
		this._speed = config.speed;
	}

	configure(_preferred: TTSAudioConfig): TTSAudioConfig {
		return {
			sampleRate: OUTPUT_SAMPLE_RATE,
			bitDepth: 16,
			channels: 1,
			encoding: 'pcm',
		};
	}

	async start(): Promise<void> {
		if (this._state !== 'idle') return;
		this._state = 'connecting';
		return this._connect();
	}

	async stop(): Promise<void> {
		if (this._state === 'stopped') return;
		this._state = 'stopped';
		this._closeRequested = true;
		this._sentenceBuffer.clear();
		if (this._connectTimer) {
			clearTimeout(this._connectTimer);
			this._connectTimer = undefined;
		}
		if (this._ws?.readyState === WebSocket.OPEN) {
			this._send({ close: true });
			this._ws.close(1000, 'Provider stopped');
		}
		this._ws = null;
		this._pendingDone.clear();
		this._currentRequestId = null;
	}

	synthesize(text: string, requestId: number, options?: { flush?: boolean }): void {
		if (this._state !== 'connected') return;
		if (this._currentRequestId !== null && this._currentRequestId !== requestId) {
			this._flush(this._currentRequestId);
		}
		if (this._currentRequestId !== requestId) {
			this._sentenceBuffer.clear();
			this._currentRequestId = requestId;
			this._pendingDone.add(requestId);
		}

		const sentences = this._sentenceBuffer.add(text);
		for (const sentence of sentences) {
			this._sendInput(sentence, requestId);
		}
		if (options?.flush) {
			this._flush(requestId);
		}
	}

	cancel(): void {
		this._sentenceBuffer.clear();
		for (const requestId of this._pendingDone) {
			this.onDone?.(requestId);
		}
		this._pendingDone.clear();
		this._currentRequestId = null;
	}

	private _connect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const url = new URL(WS_BASE_URL);
			url.searchParams.set('api_key', this._apiKey);
			url.searchParams.set('no_binary', 'true');
			url.searchParams.set('instant_mode', 'true');
			url.searchParams.set('strip_headers', 'true');
			url.searchParams.set('format_type', 'pcm');
			if (this._version) url.searchParams.set('version', this._version);

			this._ws = new WebSocket(url.toString());
			this._connectResolve = resolve;
			this._connectReject = reject;

			this._ws.on('open', () => {
				if (this._connectTimer) {
					clearTimeout(this._connectTimer);
					this._connectTimer = undefined;
				}
				if (this._state === 'connecting') this._state = 'connected';
				this._connectResolve?.();
				this._connectResolve = null;
				this._connectReject = null;
			});

			this._ws.on('message', (data: Buffer | string) => {
				this._handleMessage(typeof data === 'string' ? data : data.toString('utf-8'));
			});

			this._ws.on('close', (code: number, reason: Buffer) => {
				const wasExpected = this._closeRequested || this._state === 'stopped' || code === 1000;
				this._ws = null;
				if (!wasExpected) {
					this.onError?.(
						new Error(
							`HumeTTSProvider: WebSocket closed unexpectedly (code=${code}, reason="${reason.toString('utf-8')}")`,
						),
						true,
					);
				}
			});

			this._ws.on('error', (err: Error) => {
				if (this._connectReject) {
					this._connectReject(err);
					this._connectResolve = null;
					this._connectReject = null;
				} else {
					this.onError?.(err, true);
				}
			});

			this._connectTimer = setTimeout(() => {
				this._connectTimer = undefined;
				if (this._connectReject) {
					const err = new Error('HumeTTSProvider: connection timeout');
					this._connectReject(err);
					this._connectResolve = null;
					this._connectReject = null;
				}
			}, CONNECT_TIMEOUT_MS);
		});
	}

	private _voice(): Record<string, string> | undefined {
		if (this._voiceId) return { id: this._voiceId, provider: this._voiceProvider };
		if (this._voiceName) return { name: this._voiceName, provider: this._voiceProvider };
		return undefined;
	}

	private _sendInput(text: string, requestId: number): void {
		const message: Record<string, unknown> = {
			text,
			request_id: String(requestId),
		};
		const voice = this._voice();
		if (voice) message.voice = voice;
		if (this._description) message.description = this._description;
		if (this._speed !== undefined && Number.isFinite(this._speed)) message.speed = this._speed;
		this._send(message);
	}

	private _flush(requestId: number): void {
		const remaining = this._sentenceBuffer.flush();
		if (remaining) this._sendInput(remaining, requestId);
		this._send({ flush: true, request_id: String(requestId) });
	}

	private _send(message: Record<string, unknown>): void {
		if (this._ws?.readyState !== WebSocket.OPEN) return;
		this._ws.send(JSON.stringify(message));
	}

	private _handleMessage(raw: string): void {
		let msg: HumeAudioMessage;
		try {
			msg = JSON.parse(raw) as HumeAudioMessage;
		} catch {
			return;
		}
		if (msg.type !== 'audio' || !msg.audio) return;
		const requestId =
			msg.request_id && /^\d+$/.test(msg.request_id)
				? Number(msg.request_id)
				: (this._currentRequestId ?? 0);
		const durationMs = this._estimateDurationMs(msg.audio);
		this.onAudio?.(msg.audio, durationMs, requestId);
		if (msg.is_last_chunk) {
			this._pendingDone.delete(requestId);
			this.onDone?.(requestId);
		}
	}

	private _estimateDurationMs(base64Pcm: string): number {
		const bytes = Buffer.byteLength(base64Pcm, 'base64');
		return Math.round((bytes / 2 / OUTPUT_SAMPLE_RATE) * 1000);
	}
}
