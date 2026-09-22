import type { CoreClientToServerMessage } from '@bodhi/client-protocol';
import type { RtcClientSignalingMessage } from '../types/rtc-signaling.js';
import { tryParseRtcClientSignaling } from '../types/rtc-signaling.js';
import type { ConversationContext } from './conversation-context.js';
import type { EventBus } from './event-bus.js';
import type { PlaybackGate } from './playback-gate.js';

/** Minimal RTC signaling surface the router reaches for `direct_rtc` sessions. */
export interface RtcSignalingSink {
	feedSignaling(message: RtcClientSignalingMessage): void;
}

/** Minimal behavior surface the router reaches for `behavior.set`. */
export interface BehaviorSetSink {
	handleClientSet(key: string, preset: string): void;
}

/** Per-session artifact store the router writes uploaded images into. */
export interface ArtifactStore {
	store(
		base64: string,
		mimeType: string,
		description: string,
		source?: string,
		fileName?: string,
	): string;
}

/** Built-in `type` values dispatched here. A *malformed* payload for one of these
 *  is dropped (not forwarded to `onClientJson`); only an unrecognized `type` is. */
type RoutedCoreClientType = Exclude<
	CoreClientToServerMessage['type'],
	RtcClientSignalingMessage['type']
>;

const RECOGNIZED_TYPE_MAP = {
	'behavior.set': true,
	'ui.response': true,
	file_upload: true,
	text_input: true,
	'playback.ended': true,
} as const satisfies Record<RoutedCoreClientType, true>;

const RECOGNIZED_TYPES: ReadonlySet<RoutedCoreClientType> = new Set(
	Object.keys(RECOGNIZED_TYPE_MAP) as RoutedCoreClientType[],
);

function isRecognizedType(type: unknown): type is RoutedCoreClientType {
	return typeof type === 'string' && RECOGNIZED_TYPES.has(type as RoutedCoreClientType);
}

/** Playback-defer state the router consults before completing a `playback.ended`. */
export interface PlaybackDeferArbiter {
	readonly hasDeferred: boolean;
	finishOrDeferForVad(reason: 'signal' | 'fallback'): void;
}

/**
 * Collaborators the {@link ClientMessageRouter} reaches back into on the session.
 * Thunks are used wherever a value is constructed after the router or mutable at
 * runtime (the RTC channel, behavior manager, and live playback gate are all
 * resolved lazily); direct callbacks carry actions (`sendFile`, `handleTextInput`,
 * `reportError`, `log`).
 */
export interface ClientMessageRouterDeps {
	/** The RTC signaling channel when the session is `direct_rtc`, else `null`. */
	getDirectRtcChannel(): RtcSignalingSink | null;
	/** The behavior manager when present, else `undefined`. */
	getBehaviorManager(): BehaviorSetSink | undefined;
	eventBus: EventBus;
	/** True while the session is active (gates `file_upload`). */
	getSessionActive(): boolean;
	conversationContext: ConversationContext;
	/** Forward an uploaded file to the LLM transport as inline data. */
	sendFile(base64: string, mimeType: string): void;
	/** Defer arbiter consulted by `playback.ended`. */
	getArbiter(): PlaybackDeferArbiter;
	/** The live playback-completion gate (external-TTS or native), else `null`. */
	getLiveGate(): PlaybackGate | null;
	/** True when the client participates in the ordered playback-state protocol. */
	getPlaybackStateProtocolActive(): boolean;
	sessionId: string;
	/** Per-session artifact registry for cross-tool image sharing, if configured. */
	getArtifactRegistry(): ArtifactStore | undefined;
	/** Async direct-text-input path (serialized via the session FIFO). */
	handleTextInput(text: string): Promise<void>;
	/** Additive opt-in: fired ONLY for an unrecognized `type`. */
	onClientJson?: (message: Record<string, unknown>) => void;
	reportError(context: string, error: Error): void;
	log(message: string): void;
}

/**
 * Owns the inbound client→server JSON dispatch as one cohesive unit: RTC
 * signaling, `behavior.set`, `ui.response`, `file_upload`, `text_input`, and
 * `playback.ended`, plus the `file_upload` ingest and the `playback.ended`
 * completion routing.
 *
 * `VoiceSession.handleJsonFromClient` stays as the thin entry/intercept method
 * (an example monkey-patches it) and delegates to {@link dispatch}. A recognized
 * built-in `type` is consumed here; a *malformed* recognized type is dropped
 * exactly as before and is NOT forwarded to `onClientJson`. `onClientJson` fires
 * only for an unrecognized `type` — the former silent-drop fall-through — so the
 * change is byte-identical unless a consumer wires the hook.
 */
export class ClientMessageRouter {
	constructor(private readonly deps: ClientMessageRouterDeps) {}

	dispatch(message: Record<string, unknown>): void {
		const rtc = this.deps.getDirectRtcChannel();
		if (rtc) {
			const parsed = tryParseRtcClientSignaling(message);
			if (parsed) {
				rtc.feedSignaling(parsed);
				return;
			}
		}

		if (
			message.type === 'behavior.set' &&
			typeof message.key === 'string' &&
			typeof message.preset === 'string'
		) {
			this.deps.getBehaviorManager()?.handleClientSet(message.key, message.preset);
		} else if (message.type === 'ui.response' && message.payload) {
			this.deps.eventBus.publish('subagent.ui.response', {
				sessionId: this.deps.sessionId,
				response: message.payload as {
					requestId: string;
					selectedOptionId?: string;
					formData?: Record<string, unknown>;
				},
			});
		} else if (message.type === 'file_upload' && message.data) {
			const data = message.data as { base64: string; mimeType: string; fileName?: string };
			this.handleFileUpload(data.base64, data.mimeType, data.fileName);
		} else if (message.type === 'text_input' && typeof message.text === 'string') {
			// Fire-and-forget — handleTextInput is async (serializes via the
			// direct-input FIFO). dispatch is a dispatcher and must not block
			// other branches on one text input.
			this.deps
				.handleTextInput(message.text)
				.catch((err) =>
					this.deps.reportError('text_input', err instanceof Error ? err : new Error(String(err))),
				);
		} else if (message.type === 'playback.ended' && typeof message.playbackId === 'number') {
			this.handlePlaybackEnded(message.playbackId);
		} else if (!isRecognizedType(message.type)) {
			// A recognized type with a malformed payload was dropped above and is
			// NOT forwarded; only an unrecognized `type` reaches `onClientJson` (the
			// former silent-drop fall-through).
			this.deps.onClientJson?.(message);
		}
	}

	/**
	 * Client→server playback-state signal: the client's audio buffer for
	 * `playbackId` has drained. Completes the turn (or defers it for an
	 * in-progress potential barge-in via `finishOrDeferForVad`). The guards
	 * reject every signal that does not concern the live, post-synthesis turn —
	 * source-agnostic via `getLiveGate()` (external TTS or native audio).
	 */
	private handlePlaybackEnded(playbackId: number): void {
		if (!this.deps.getPlaybackStateProtocolActive()) return;
		// A signal was already accepted and deferred this turn — ignore further
		// ones so a client cannot keep re-arming the defer timeout.
		if (this.deps.getArbiter().hasDeferred) return;
		const gate = this.deps.getLiveGate();
		if (!gate) return;
		// Timer armed ⇒ the audio-done point has passed — rejects a premature
		// signal that would otherwise complete the turn mid-synthesis.
		if (!gate.timerArmed) return;
		// Not pending ⇒ the turn already finished or was interrupted.
		if (!gate.pending) return;
		// Stale: a signal for a turn superseded by an interrupt (bumps the id).
		if (playbackId !== gate.id) return;
		this.deps.getArbiter().finishOrDeferForVad('signal');
	}

	private handleFileUpload(base64: string, mimeType: string, fileName?: string): void {
		if (!this.deps.getSessionActive()) return;

		// Send image/document to the LLM as inline data
		this.deps.sendFile(base64, mimeType);

		// Record in conversation context
		this.deps.conversationContext.addUserMessage(`[Uploaded file: ${fileName ?? 'file'}]`);

		// Store in artifact registry for cross-tool access (supported binary image types only).
		const registry = this.deps.getArtifactRegistry();
		if (registry && mimeType.startsWith('image/')) {
			try {
				registry.store(base64, mimeType, fileName ?? `upload_${Date.now()}`, 'uploaded', fileName);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.deps.log(`Failed to store artifact: ${msg}`);
				this.deps.eventBus.publish('gui.notification', {
					sessionId: this.deps.sessionId,
					message: `File uploaded to voice session but cannot be forwarded to agents: ${msg}`,
				});
			}
		}
	}
}
