/**
 * Receives each chunk of native assistant audio (the model's own speech) as
 * PCM, right before the session sends it to the client. Chunks dropped before
 * delivery (by `outputInterceptor.audio`, in transcription mode, or for an
 * already-finalized turn) are not observed, and neither is audio synthesized
 * by an external TTS provider. Register with `VoiceSession.observeAudioOutput`.
 *
 * `pcm` is the buffer the client receives; treat it as read-only. A throw is
 * reported through `hooks.onError` and does not stop delivery.
 */
export type AudioOutputObserver = (
	pcm: Buffer,
	meta: {
		/** Id of the turn the chunk belongs to. */
		turnId: string | null;
		/** Sample rate of `pcm`: the transport's output rate. */
		sampleRate: number;
		/** Always `'pcm'` (16-bit little-endian mono): G.711 output is decoded first. */
		encoding: 'pcm';
	},
) => void;

/**
 * Receives each inbound client audio frame (PCM16) as it enters the session,
 * before any routing or gating, from the local client WebSocket, the direct
 * RTC audio plane, and `VoiceSession.feedAudioFromClient`. Register with
 * `VoiceSession.observeAudioInput`.
 *
 * `pcm` is the frame the session routes; treat it as read-only. A throw is
 * reported through `hooks.onError` and does not stop the frame.
 */
export type AudioInputObserver = (
	pcm: Buffer,
	meta: {
		/** `'rtc'` for the direct RTC audio plane, `'websocket'` otherwise. */
		source: 'websocket' | 'rtc';
		/** Sample rate the session reads the frame at (`clientAudioInputRate`). */
		sampleRate: number;
	},
) => void;

/**
 * Host hooks that sit between the provider's native assistant output and the
 * session, set once through `VoiceSessionConfig.outputInterceptor`, for
 * example to screen what the assistant says. Every hook is optional. Hooks
 * run inline on the output path. A throwing hook is reported through
 * `hooks.onError` and the output path fails open, continuing as it would
 * without that hook.
 */
export interface AssistantOutputInterceptor {
	/**
	 * Receives each assistant transcript chunk before it reaches the session's
	 * transcript. Call `forward` with the text to keep, now or later (for
	 * example from `beforeTranscriptFlush`); a chunk never forwarded is dropped.
	 * Without this hook every chunk is forwarded unchanged. If the hook throws,
	 * the original chunk is forwarded unchanged, after any text the hook
	 * forwarded before throwing.
	 */
	transcript?(chunk: string, forward: (text: string) => void): void;
	/**
	 * Receives each native assistant audio chunk (base64, in the transport's
	 * output encoding). Return `false` to drop the chunk before the session
	 * handles it: it is neither observed nor sent to the client. If the hook
	 * throws, the chunk is delivered.
	 */
	audio?(chunkBase64: string): boolean;
	/**
	 * Runs at the start of every transcript flush (for example when a turn
	 * ends or is interrupted, on `resetConversationContext()` and at close),
	 * before the buffered assistant text is committed, so text forwarded from
	 * here joins the message being committed. If the hook throws, the flush
	 * still commits the buffers, so turn finalization and `close()` complete.
	 */
	beforeTranscriptFlush?(): void;
}
