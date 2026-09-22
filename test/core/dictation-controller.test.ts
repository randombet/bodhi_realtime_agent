import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DictationController,
	type DictationControllerConfig,
	type DictationControllerDeps,
} from '../../src/core/dictation-controller.js';
import { EventBus } from '../../src/core/event-bus.js';
import type {
	LLMTransport,
	STTAudioConfig,
	STTProvider,
	TransportCapabilities,
	TransportToolResult,
} from '../../src/types/transport.js';

// ───────────────────────────────────────────────────────────────────────
// Minimal LLMTransport mock — only the fields DictationController reads.
// ───────────────────────────────────────────────────────────────────────

interface MockTransport extends LLMTransport {
	__toolResults: TransportToolResult[];
	__content: Array<{ turns: unknown; turnComplete?: boolean }>;
	__quiesceCount: number;
	__unquiesceCount: number;
	__clearAudioCount: number;
}

function createMockTransport(opts: { quiescible?: boolean } = {}): MockTransport {
	const toolResults: TransportToolResult[] = [];
	const content: Array<{ turns: unknown; turnComplete?: boolean }> = [];
	let quiesceCount = 0;
	let unquiesceCount = 0;
	let clearAudioCount = 0;

	const capabilities = {
		quiescible: opts.quiescible ?? true,
	} as unknown as TransportCapabilities;

	const transport: Partial<MockTransport> = {
		capabilities,
		sendToolResult: (result: TransportToolResult) => {
			toolResults.push(result);
		},
		sendContent: (turns, turnComplete) => {
			content.push({ turns, turnComplete });
		},
		clearAudio: () => {
			clearAudioCount += 1;
		},
		triggerGeneration: vi.fn(),
	};

	if (opts.quiescible !== false) {
		transport.quiesce = async () => {
			quiesceCount += 1;
		};
		transport.unquiesce = async () => {
			unquiesceCount += 1;
		};
	}

	const result = transport as MockTransport;
	Object.defineProperty(result, '__toolResults', { get: () => toolResults });
	Object.defineProperty(result, '__content', { get: () => content });
	Object.defineProperty(result, '__quiesceCount', { get: () => quiesceCount });
	Object.defineProperty(result, '__unquiesceCount', { get: () => unquiesceCount });
	Object.defineProperty(result, '__clearAudioCount', { get: () => clearAudioCount });
	return result;
}

// ───────────────────────────────────────────────────────────────────────
// Minimal STTProvider mock for the whisperProvider slot.
// ───────────────────────────────────────────────────────────────────────

interface MockSttProvider extends STTProvider {
	__startCount: number;
	__stopCount: number;
	__config?: STTAudioConfig;
	__triggerTranscript(text: string): void;
	__failNextStart(): void;
}

function createMockSttProvider(): MockSttProvider {
	let startCount = 0;
	let stopCount = 0;
	let config: STTAudioConfig | undefined;
	let failNext = false;
	let onTranscript: ((text: string, turnId: number | undefined) => void) | undefined;

	const provider: Partial<MockSttProvider> = {
		supportedEncodings: ['pcm'],
		configure(audio: STTAudioConfig) {
			config = audio;
		},
		async start() {
			if (failNext) {
				failNext = false;
				throw new Error('whisper start failed');
			}
			startCount += 1;
		},
		async stop() {
			stopCount += 1;
		},
		feedAudio: vi.fn(),
		commit: vi.fn(),
		handleInterrupted: vi.fn(),
		handleTurnComplete: vi.fn(),
		get onTranscript() {
			return onTranscript;
		},
		set onTranscript(fn) {
			onTranscript = fn;
		},
	};

	const result = provider as MockSttProvider;
	Object.defineProperty(result, '__startCount', { get: () => startCount });
	Object.defineProperty(result, '__stopCount', { get: () => stopCount });
	Object.defineProperty(result, '__config', { get: () => config });
	result.__triggerTranscript = (text: string) => onTranscript?.(text, undefined);
	result.__failNextStart = () => {
		failNext = true;
	};
	return result;
}

// ───────────────────────────────────────────────────────────────────────

function build(
	overrides: Partial<DictationControllerConfig> = {},
	depOverrides: Partial<DictationControllerDeps> = {},
): {
	controller: DictationController;
	transport: MockTransport;
	whisper: MockSttProvider;
	eventBus: EventBus;
	drainCount: () => number;
	reportError: ReturnType<typeof vi.fn>;
} {
	const transport = createMockTransport();
	const whisper = createMockSttProvider();
	const eventBus = new EventBus();
	let drainCount = 0;
	const reportError = vi.fn();

	const deps: DictationControllerDeps = {
		transport,
		getAudioRouter: () => ({
			drainTransitionBufferToWhisper: () => {
				drainCount += 1;
			},
		}),
		eventBus,
		getSessionId: () => 'sess-1',
		reportError,
		log: () => undefined,
		...depOverrides,
	};

	const config: DictationControllerConfig = {
		whisperProvider: whisper,
		sttProvider: undefined,
		transcriptionMode: 'agent',
		...overrides,
	};

	const controller = new DictationController(deps, config);
	return { controller, transport, whisper, eventBus, drainCount: () => drainCount, reportError };
}

describe('DictationController', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('construction wiring', () => {
		it('configures whisper at 24k/16/mono/pcm', () => {
			const { whisper } = build();
			expect(whisper.__config).toEqual({
				sampleRate: 24000,
				bitDepth: 16,
				channels: 1,
				encoding: 'pcm',
			});
		});

		it('wires whisper.onTranscript into the dictation buffer', () => {
			const { controller, whisper } = build();
			whisper.__triggerTranscript('hello');
			whisper.__triggerTranscript('world');
			expect(controller.getDictationBuffer()).toBe('hello world');
		});

		it('throws when whisperProvider === sttProvider', () => {
			const shared = createMockSttProvider();
			expect(() => build({ whisperProvider: shared, sttProvider: shared })).toThrow(
				/distinct instance/,
			);
		});

		it('seeds internalMode from transcriptionMode="transcription"', () => {
			const { controller } = build({ transcriptionMode: 'transcription' });
			expect(controller.mode).toBe('transcription');
			expect(controller.isAgentMode()).toBe(false);
		});

		it('defaults internalMode to agent', () => {
			const { controller } = build();
			expect(controller.mode).toBe('agent');
			expect(controller.isAgentMode()).toBe(true);
		});
	});

	describe('send-guard interception', () => {
		it('passes tool results through in agent mode', () => {
			const { transport } = build();
			transport.sendToolResult({ id: '1', name: 't', result: {} } as never);
			expect(transport.__toolResults).toHaveLength(1);
		});

		it('queues non-silent tool results while not in agent mode, drains on exit', async () => {
			const { controller, transport } = build({ transcriptionMode: 'transcription' });
			transport.sendToolResult({ id: '1', name: 't', result: {} } as never);
			// Queued, not sent.
			expect(transport.__toolResults).toHaveLength(0);
			await controller.exitTranscriptionMode();
			// Drained in order on re-entry to agent mode.
			expect(transport.__toolResults).toHaveLength(1);
		});

		it('passes silent-scheduled tool results through even while not in agent mode', () => {
			const { transport } = build({ transcriptionMode: 'transcription' });
			transport.sendToolResult({ id: '1', name: 't', result: {}, scheduling: 'silent' } as never);
			expect(transport.__toolResults).toHaveLength(1);
		});

		it('queues turnComplete=true content while not in agent mode; turnComplete=false passes through', async () => {
			const { controller, transport } = build({ transcriptionMode: 'transcription' });
			transport.sendContent([{ role: 'user', text: 'gated' }], true);
			transport.sendContent([{ role: 'user', text: 'passive' }], false);
			// Only the passive append went through.
			expect(transport.__content).toHaveLength(1);
			expect(transport.__content[0]?.turnComplete).toBe(false);
			await controller.exitTranscriptionMode();
			// The gated turnComplete=true content drained on re-entry to agent mode.
			expect(transport.__content).toHaveLength(2);
			expect(transport.__content[1]?.turnComplete).toBe(true);
		});
	});

	describe('enter / exit transitions', () => {
		it('enter quiesces, clears audio, starts whisper, drains, flips to transcription, publishes', async () => {
			const events: Array<{ mode: string; sessionId: string }> = [];
			const { controller, transport, whisper, eventBus, drainCount } = build();
			eventBus.subscribe('session.transcription_mode_changed', (p) => events.push(p));

			await controller.enterTranscriptionMode();

			expect(transport.__quiesceCount).toBe(1);
			expect(transport.__clearAudioCount).toBe(1);
			expect(whisper.__startCount).toBe(1);
			expect(drainCount()).toBe(1);
			expect(controller.mode).toBe('transcription');
			expect(events).toEqual([{ mode: 'transcription', sessionId: 'sess-1' }]);
		});

		it('exit stops whisper, flips to agent, unquiesces, publishes', async () => {
			const events: Array<{ mode: string }> = [];
			const { controller, transport, whisper, eventBus } = build({
				transcriptionMode: 'transcription',
			});
			eventBus.subscribe('session.transcription_mode_changed', (p) => events.push(p));

			await controller.exitTranscriptionMode();

			expect(whisper.__stopCount).toBe(1);
			expect(transport.__unquiesceCount).toBe(1);
			expect(controller.mode).toBe('agent');
			expect(events).toEqual([{ mode: 'agent', sessionId: 'sess-1' }]);
		});

		it('rolls back to agent + unquiesces when whisper.start() fails', async () => {
			const { controller, transport, whisper } = build();
			whisper.__failNextStart();
			await expect(controller.enterTranscriptionMode()).rejects.toThrow(/whisper start failed/);
			expect(controller.mode).toBe('agent');
			// Rollback unquiesces the transport that enter() quiesced.
			expect(transport.__unquiesceCount).toBe(1);
		});
	});

	describe('prepareForStart', () => {
		it('starts whisper + quiesces when initial mode is transcription', async () => {
			const { controller, transport, whisper } = build({ transcriptionMode: 'transcription' });
			await controller.prepareForStart();
			expect(whisper.__startCount).toBe(1);
			expect(transport.__quiesceCount).toBe(1);
		});

		it('is a no-op in agent mode', async () => {
			const { controller, transport, whisper } = build();
			await controller.prepareForStart();
			expect(whisper.__startCount).toBe(0);
			expect(transport.__quiesceCount).toBe(0);
		});
	});

	describe('dictation buffer', () => {
		it('takeDictationBufferForInjection clears in agent mode', () => {
			const { controller, whisper } = build();
			whisper.__triggerTranscript('one');
			whisper.__triggerTranscript('two');
			expect(controller.takeDictationBufferForInjection()).toBe('one two');
			expect(controller.getDictationBuffer()).toBe('');
		});

		it('takeDictationBufferForInjection is a no-op (keeps buffer) when not in agent mode', () => {
			const { controller, whisper } = build({ transcriptionMode: 'transcription' });
			whisper.__triggerTranscript('dictating');
			expect(controller.takeDictationBufferForInjection()).toBe('');
			expect(controller.getDictationBuffer()).toBe('dictating');
		});

		it('clearDictationBuffer discards without injecting', () => {
			const { controller, whisper } = build();
			whisper.__triggerTranscript('x');
			controller.clearDictationBuffer();
			expect(controller.getDictationBuffer()).toBe('');
		});
	});
});
