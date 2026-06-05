// SPDX-License-Identifier: MIT

import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	STTProvider,
	TransportCapabilities,
} from '../../src/types/transport.js';
import type { TTSAudioConfig, TTSProvider } from '../../src/types/tts.js';

/**
 * Characterization oracle for `VoiceSession.finalizeTurn` (Step 0 of the
 * VoiceSession modularization plan, see
 * dev_docs/framework/investigation-voice-session-modularity.md).
 *
 * It records the ORDER of the observable side effects finalizeTurn drives —
 * STT (commit / complete / interrupt), external-TTS cancel, transcript flush,
 * the notification sink (legacy queue vs actor runtime), and the EventBus
 * turn.end / turn.interrupted publishes — across the fixture matrix
 * {clean, interrupted} × {neither, native, tts} × {actor, legacy}, minus the
 * one impossible cell: `tts` is actor-only (ttsProvider requires
 * orchestrationMode: 'actor'), so legacy+tts does not exist. Native gating IS
 * reachable in legacy mode, so legacy+native is covered.
 *
 * The recorded sequences are pinned with explicit assertions so that the Step 6
 * extraction of `TurnManager` + `PlaybackCompletionArbiter` can prove it did NOT
 * reorder these load-bearing effects (the "Hazard-2 order" / "ORDERING" comments
 * in voice-session.ts). It is a behavior snapshot, not a spec — if the current
 * order is "wrong", that is a separate change, not a silent edit here.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return { name: 'main', instructions: 'You are a concise assistant.', tools: [] };
}

function createMockTransport(): LLMTransport {
	return {
		capabilities: {
			messageTruncation: true,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: true,
			sessionResumption: false,
			contextCompression: false,
			groundingMetadata: false,
			textResponseModality: true,
		} satisfies TransportCapabilities,
		audioFormat: {
			inputSampleRate: 16000,
			outputSampleRate: 24000,
			channels: 1,
			bitDepth: 16,
			encoding: 'pcm',
		} satisfies AudioFormatSpec,
		isConnected: true,
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		reconnect: vi.fn().mockResolvedValue(undefined),
		sendAudio: vi.fn(),
		commitAudio: vi.fn(),
		clearAudio: vi.fn(),
		updateSession: vi.fn(async () => {}),
		transferSession: vi.fn().mockResolvedValue(undefined),
		sendContent: vi.fn(),
		sendFile: vi.fn(),
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
	};
}

/** Mock STT provider whose lifecycle calls append to the shared order log. */
function createMockStt(order: string[]): STTProvider {
	return {
		supportedEncodings: ['pcm'],
		configure: vi.fn(),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		feedAudio: vi.fn(),
		commit: vi.fn(() => order.push('stt.commit')),
		handleInterrupted: vi.fn(() => order.push('stt.interrupt')),
		handleTurnComplete: vi.fn(() => order.push('stt.complete')),
	} as unknown as STTProvider;
}

/** Mock external-TTS provider; only `cancel` is logged (the finalize effect). */
function createMockTts(order: string[]): TTSProvider {
	const fmt: TTSAudioConfig = {
		sampleRate: 24000,
		bitDepth: 16,
		channels: 1,
		encoding: 'pcm',
	};
	return {
		configure: vi.fn(() => fmt),
		synthesize: vi.fn(),
		cancel: vi.fn(() => order.push('tts.cancel')),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
	} as unknown as TTSProvider;
}

type Mode = 'actor' | 'legacy';
type Gating = 'neither' | 'native' | 'tts';

function buildSession(mode: Mode, gating: Gating, order: string[]) {
	const transport = createMockTransport();
	const sendAudio = vi.fn();
	const sendJson = vi.fn();
	const stt = createMockStt(order);
	const tts = gating === 'tts' ? createMockTts(order) : undefined;

	const session = new VoiceSession({
		sessionId: 'sess_finalize_order',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [createAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport,
		orchestrationMode: mode === 'actor' ? 'actor' : 'legacy',
		clientSender: { sendAudio, sendJson, supportsPlaybackStateProtocol: true },
		playbackStateProtocol: 'audio_done',
		nativePlaybackGating: gating === 'native',
		sttProvider: stt,
		...(tts ? { ttsProvider: tts } : {}),
	});

	// EventBus publishes (turn boundary).
	session.eventBus.subscribe('turn.interrupted', () => order.push('publish.turn_interrupted'));
	session.eventBus.subscribe('turn.end', () => order.push('publish.turn_end'));

	// Internal effect points the oracle pins (private at the type level only).
	const internals = session as unknown as {
		transcriptManager: { flush: () => void };
		notificationQueue?: {
			resetAudio: () => void;
			markInterrupted: () => void;
			onTurnComplete: () => void;
			markAudioReceived: () => void;
		};
		runtimeOrchestrator?: { runtime: { tell: (type: string, p: unknown, to: string) => void } };
	};

	const flush = internals.transcriptManager.flush.bind(internals.transcriptManager);
	internals.transcriptManager.flush = () => {
		order.push('transcript.flush');
		flush();
	};

	return { transport, sendJson, session, internals };
}

/** Wrap the notification path AFTER start() (the runtime exists only then). */
function instrumentNotifications(
	mode: Mode,
	internals: ReturnType<typeof buildSession>['internals'],
	order: string[],
) {
	if (mode === 'legacy') {
		const q = internals.notificationQueue;
		if (!q) return;
		const reset = q.resetAudio.bind(q);
		const intr = q.markInterrupted.bind(q);
		const done = q.onTurnComplete.bind(q);
		q.resetAudio = () => {
			order.push('notif.reset_audio');
			reset();
		};
		q.markInterrupted = () => {
			order.push('notif.interrupted');
			intr();
		};
		q.onTurnComplete = () => {
			order.push('notif.turn_complete');
			done();
		};
		return;
	}
	const rt = internals.runtimeOrchestrator?.runtime;
	if (!rt) return;
	const tell = rt.tell.bind(rt);
	rt.tell = (type: string, p: unknown, to: string) => {
		if (type === 'notification.reset_audio') order.push('notif.reset_audio');
		else if (type === 'notification.interrupted') order.push('notif.interrupted');
		else if (type === 'notification.turn_complete') order.push('notif.turn_complete');
		tell(type, p, to);
	};
}

/** 1 s of 24 kHz PCM16 mono as base64 (48 bytes/ms). */
function pcm1s(): string {
	return Buffer.alloc(1000 * 48).toString('base64');
}

/** Drive one full turn to finalization and return the recorded effect order. */
async function runTurn(
	mode: Mode,
	gating: Gating,
	kind: 'clean' | 'interrupted',
): Promise<string[]> {
	const order: string[] = [];
	const built = buildSession(mode, gating, order);
	const { transport, session, internals } = built;
	try {
		await session.start();
		instrumentNotifications(mode, internals, order);
		order.length = 0; // drop start-up noise; record only the turn

		transport.onModelTurnStart?.();
		if (gating === 'tts') {
			transport.onTextOutput?.('Hello there.');
			transport.onTextDone?.();
		} else {
			transport.onAudioOutput?.(pcm1s());
		}

		if (kind === 'clean') {
			transport.onTurnComplete?.(1);
			if (gating === 'tts') {
				// Drive the external-TTS gate to completion: audio then done.
				const ttsProvider = (session as unknown as { ttsPipeline?: { provider: TTSProvider } })
					.ttsPipeline?.provider;
				ttsProvider?.onAudio?.(pcm1s(), 1000, 1);
				ttsProvider?.onDone?.(1);
				vi.advanceTimersByTime(5000);
			} else if (gating === 'native') {
				// Native gate defers; the fallback timer finalizes.
				vi.advanceTimersByTime(5000);
			}
		} else {
			transport.onInterrupted?.(1);
		}
		// Copy is evaluated before `finally` runs close(), so close-time effects
		// (a trailing transcript flush, provider stops) are excluded.
		return [...order];
	} finally {
		await session.close();
	}
}

/**
 * The pinned sequences (captured from the unchanged `VoiceSession`). Step 6 must
 * reproduce these byte-for-byte. Observations they lock in:
 *  - clean completion: stt.commit (at turn start) → stt.complete → transcript.flush
 *    → publish.turn_end → notif.turn_complete — identical across every gating
 *    path and across actor/legacy (the notification *order* is mode-independent;
 *    only the underlying mechanism differs).
 *  - interrupted: the interrupt block (stt.interrupt → [tts.cancel] →
 *    notif.reset_audio → notif.interrupted → transcript.flush →
 *    publish.turn_interrupted) runs in full BEFORE the shared completion block,
 *    so the transcript is flushed TWICE.
 *  - the external-TTS path adds `tts.cancel` immediately after `stt.interrupt`
 *    (the "Hazard-2 order": invalidate + cancel before the notification sink).
 */
const CLEAN = [
	'stt.commit',
	'stt.complete',
	'transcript.flush',
	'publish.turn_end',
	'notif.turn_complete',
];

const INTERRUPTED = [
	'stt.commit',
	'stt.interrupt',
	'notif.reset_audio',
	'notif.interrupted',
	'transcript.flush',
	'publish.turn_interrupted',
	'stt.complete',
	'transcript.flush',
	'publish.turn_end',
	'notif.turn_complete',
];

const INTERRUPTED_TTS = [
	'stt.commit',
	'stt.interrupt',
	'tts.cancel',
	'notif.reset_audio',
	'notif.interrupted',
	'transcript.flush',
	'publish.turn_interrupted',
	'stt.complete',
	'transcript.flush',
	'publish.turn_end',
	'notif.turn_complete',
];

describe('finalizeTurn effect ordering — characterization oracle', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const fixtures: Array<[Mode, Gating, 'clean' | 'interrupted', string[]]> = [
		['actor', 'neither', 'clean', CLEAN],
		['actor', 'neither', 'interrupted', INTERRUPTED],
		['legacy', 'neither', 'clean', CLEAN],
		['legacy', 'neither', 'interrupted', INTERRUPTED],
		['actor', 'native', 'clean', CLEAN],
		['actor', 'native', 'interrupted', INTERRUPTED],
		// Native gating is NOT actor-only — `nativePlaybackGatingActive` has no
		// `_isActorMode` guard — so legacy+native is reachable and must be pinned
		// too (a Step 4 native-gate extraction could otherwise reorder legacy
		// notification-queue effects undetected).
		['legacy', 'native', 'clean', CLEAN],
		['legacy', 'native', 'interrupted', INTERRUPTED],
		// `tts` is actor-only (ttsProvider requires orchestrationMode: 'actor'),
		// so legacy+tts is intentionally absent — not a gap.
		['actor', 'tts', 'clean', CLEAN],
		['actor', 'tts', 'interrupted', INTERRUPTED_TTS],
	];

	for (const [mode, gating, kind, expected] of fixtures) {
		it(`${mode}/${gating}/${kind} effect order is unchanged`, async () => {
			expect(await runTurn(mode, gating, kind)).toEqual(expected);
		});
	}
});
