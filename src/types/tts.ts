// SPDX-License-Identifier: MIT

/**
 * Audio format descriptor for TTS output.
 * Returned by TTSProvider.configure() to indicate the actual output format.
 */
export interface TTSAudioConfig {
	/** Sample rate in Hz (e.g. 24000 for ElevenLabs, 44100 for Cartesia). */
	sampleRate: number;
	/** Bits per sample (16). */
	bitDepth: number;
	/** Number of channels (1 = mono). */
	channels: number;
	/** Encoding format. */
	encoding: 'pcm';
}

/**
 * Provider-agnostic interface for pluggable text-to-speech providers.
 *
 * VoiceSession creates the provider, calls configure() with the preferred
 * output format, then start(). Text flows in via synthesize() with a
 * requestId for turn correlation; audio chunks flow out via onAudio callback
 * tagged with the same requestId. The provider handles streaming, buffering,
 * and chunked delivery internally.
 *
 * Actor-mode only — not used in legacy orchestration path.
 */
export interface TTSProvider {
	// --- Configuration & Lifecycle ---

	/** Called once before start(). Provider receives the preferred output format
	 *  (derived from the transport's outputSampleRate) and returns the actual
	 *  format it will produce. If the provider can emit at the preferred rate
	 *  natively, it SHOULD do so to avoid resampling overhead.
	 *
	 *  @param preferred The ideal output format (sampleRate, bitDepth, channels)
	 *  @returns The actual output format the provider will produce */
	configure(preferred: TTSAudioConfig): TTSAudioConfig;

	/** Open connection (WebSocket for streaming providers). */
	start(): Promise<void>;

	/** Close connection and release resources. */
	stop(): Promise<void>;

	// --- Text Input ---

	/** Synthesize text into speech. Called with text chunks as they arrive
	 *  from the LLM. The provider decides internally whether to buffer for
	 *  sentence boundaries or stream immediately.
	 *
	 *  @param text Partial or complete text from LLM response
	 *  @param requestId Monotonic ID correlating this text to a specific turn/response.
	 *                   All onAudio/onDone callbacks for this text MUST carry the same requestId.
	 *  @param options.flush If true, flush any buffered text to TTS now (does NOT mean end-of-request). */
	synthesize(text: string, requestId: number, options?: { flush?: boolean }): void;

	// --- Interruption ---

	/** Cancel any in-progress synthesis (best-effort). Called when the user
	 *  interrupts (barge-in). Provider SHOULD stop generating audio as quickly
	 *  as possible and clear internal buffers. Late-arriving audio chunks after
	 *  cancel() are safe — VoiceSession filters them via requestId. */
	cancel(): void;

	// --- Output Callbacks (set by VoiceSession before start()) ---

	/** Audio chunk ready for delivery to client.
	 *  @param base64Pcm Base64-encoded PCM audio chunk
	 *  @param durationMs Duration of this chunk in milliseconds
	 *  @param requestId The requestId from the synthesize() call that produced this audio */
	onAudio?: (base64Pcm: string, durationMs: number, requestId: number) => void;

	/** Synthesis completed for a request.
	 *  Fired after the final audio chunk for the given requestId.
	 *  VoiceSession uses this to gate turn completion.
	 *  @param requestId The requestId that has completed synthesis */
	onDone?: (requestId: number) => void;

	/** Word-level timing for caption synchronization (optional).
	 *  Providers that support word timestamps (Cartesia, ElevenLabs) fire this
	 *  for real-time caption alignment on the client.
	 *  NOTE: This is for timing metadata only, NOT for output transcription.
	 *  @param word The spoken word
	 *  @param offsetMs Offset from the start of synthesis for this requestId, in milliseconds
	 *  @param requestId The requestId this word belongs to */
	onWordBoundary?: (word: string, offsetMs: number, requestId: number) => void;

	/** Error during synthesis. Non-fatal errors are logged;
	 *  fatal errors trigger session close (fail-fast in V1). */
	onError?: (error: Error, fatal: boolean) => void;
}
