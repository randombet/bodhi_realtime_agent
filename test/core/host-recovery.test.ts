import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';
import { SessionError, ValidationError } from '../../src/core/errors.js';
import {
	DialGenerationFence,
	type RecoverUpstreamArgs,
	type RecoverUpstreamResult,
	SyntheticOutputHold,
	type SyntheticOutputHoldDeps,
} from '../../src/core/host-recovery.js';
import { VoiceSession, type VoiceSessionConfig } from '../../src/core/voice-session.js';
import { GeminiBatchSTTProvider } from '../../src/transport/gemini-batch-stt-provider.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { ConversationItem } from '../../src/types/conversation.js';
import type { ConversationHistoryStore } from '../../src/types/history.js';
import type { FrameworkHooks } from '../../src/types/hooks.js';
import type { SessionClientSender } from '../../src/types/session-client.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	STTProvider,
	TransportCapabilities,
	TransportToolResult,
} from '../../src/types/transport.js';

/**
 * Host upstream recovery: the synthetic-output hold and the dial-generation
 * fence, on their own and wired into a legacy-mode session, then the recovery
 * controller behind `recoverUpstream()` and `parkUpstream()`. The fence cases
 * mark the boundary directly and then advance the stub transport's dial
 * generation the way a recovery's incumbent abort and redial would.
 */

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

// ─── SyntheticOutputHold ───────────────────────────────────────────────────

function makeHold() {
	const deps = {
		setNotificationsHeld: vi.fn<SyntheticOutputHoldDeps['setNotificationsHeld']>(),
		drainNotifications: vi.fn<SyntheticOutputHoldDeps['drainNotifications']>(),
		log: vi.fn<SyntheticOutputHoldDeps['log']>(),
	};
	return { hold: new SyntheticOutputHold(deps), deps };
}

describe('SyntheticOutputHold', () => {
	it('gates nothing until engaged; engaged, it gates with a log and holds notifications', () => {
		const { hold, deps } = makeHold();
		expect(hold.isActive()).toBe(false);
		expect(hold.gate('greeting')).toBe(true);
		expect(deps.log).not.toHaveBeenCalled();

		hold.engage();
		expect(hold.isActive()).toBe(true);
		expect(deps.setNotificationsHeld).toHaveBeenLastCalledWith(true);
		expect(hold.gate('directive-reinforcement')).toBe(false);
		expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('directive-reinforcement'));
	});

	it('release() frees the gate and the notifications once, notifying listeners', () => {
		const { hold, deps } = makeHold();
		const listener = vi.fn();
		hold.onRelease(listener);
		expect(hold.release('typed-input')).toBe(false); // nothing engaged: no-op
		expect(listener).not.toHaveBeenCalled();

		hold.engage();
		expect(hold.release('input-transcription')).toBe(true);
		expect(hold.isActive()).toBe(false);
		expect(hold.gate('greeting')).toBe(true);
		expect(deps.setNotificationsHeld).toHaveBeenLastCalledWith(false);
		expect(listener).toHaveBeenCalledTimes(1);

		expect(hold.release('input-transcription')).toBe(false);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('onRelease returns an unsubscribe', () => {
		const { hold } = makeHold();
		const listener = vi.fn();
		const off = hold.onRelease(listener);
		off();
		hold.engage();
		hold.release('provider-interrupted');
		expect(listener).not.toHaveBeenCalled();
	});

	it('the dial window gates and holds notifications; its release drains once', () => {
		const { hold, deps } = makeHold();
		hold.engageDialWindow();
		// Not the host-observable fresh-speech hold, but it still gates.
		expect(hold.isActive()).toBe(false);
		expect(hold.gate('greeting')).toBe(false);
		expect(deps.setNotificationsHeld).toHaveBeenLastCalledWith(true);

		hold.releaseDialWindow();
		expect(hold.gate('greeting')).toBe(true);
		expect(deps.setNotificationsHeld).toHaveBeenLastCalledWith(false);
		expect(deps.drainNotifications).toHaveBeenCalledTimes(1);

		hold.releaseDialWindow(); // not open: no-op
		expect(deps.drainNotifications).toHaveBeenCalledTimes(1);
	});

	it('with a fresh-speech hold, closing the dial window keeps notifications held and drains nothing', () => {
		const { hold, deps } = makeHold();
		hold.engage();
		hold.engageDialWindow();

		hold.releaseDialWindow();
		expect(hold.gate('greeting')).toBe(false);
		expect(deps.setNotificationsHeld).not.toHaveBeenCalledWith(false);
		expect(deps.drainNotifications).not.toHaveBeenCalled();

		hold.release('external-stt-final');
		expect(deps.setNotificationsHeld).toHaveBeenLastCalledWith(false);
		expect(deps.drainNotifications).not.toHaveBeenCalled();
	});

	it('fresh evidence during the dial window does not release the notifications early', () => {
		const { hold, deps } = makeHold();
		hold.engage();
		hold.engageDialWindow();

		expect(hold.release('typed-input')).toBe(true);
		expect(hold.isActive()).toBe(false);
		expect(hold.gate('greeting')).toBe(false); // the window still gates
		expect(deps.setNotificationsHeld).not.toHaveBeenCalledWith(false);

		hold.releaseDialWindow();
		expect(deps.setNotificationsHeld).toHaveBeenLastCalledWith(false);
		expect(deps.drainNotifications).toHaveBeenCalledTimes(1);
	});
});

// ─── Session harness (legacy orchestration, hosted client sender) ─────────

interface StubTransport {
	transport: LLMTransport;
	/** The raw spies: the session wraps `sendToolResult` and `sendContent`,
	 *  so assertions read these, not the transport's current members. */
	sendToolResult: ReturnType<typeof vi.fn>;
	sendContent: ReturnType<typeof vi.fn>;
	triggerGeneration: ReturnType<typeof vi.fn>;
	/** Advance the dial generation, as an incumbent abort plus a redial would. */
	setDialGen(gen: number): void;
}

/** A transport with a dial generation; `reconnect()` dials the next one. */
function createStubTransport(): StubTransport {
	let dialGen = 1;
	const sendToolResult = vi.fn();
	const sendContent = vi.fn();
	const triggerGeneration = vi.fn();
	const transport: LLMTransport = {
		capabilities: {
			messageTruncation: false,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: false,
			sessionResumption: true,
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
		get currentDialGen() {
			return dialGen;
		},
		connect: vi.fn(async () => {}),
		disconnect: vi.fn(async () => {}),
		reconnect: vi.fn(async () => {
			dialGen += 1;
		}),
		sendAudio: vi.fn(),
		commitAudio: vi.fn(),
		clearAudio: vi.fn(),
		updateSession: vi.fn(async () => {}),
		transferSession: vi.fn(async () => {}),
		sendContent,
		sendFile: vi.fn(),
		sendToolResult,
		triggerGeneration,
	};
	return {
		transport,
		sendToolResult,
		sendContent,
		triggerGeneration,
		setDialGen: (gen) => {
			dialGen = gen;
		},
	};
}

function stubStt(): STTProvider {
	return {
		configure: vi.fn(),
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		feedAudio: vi.fn(),
		commit: vi.fn(),
		handleInterrupted: vi.fn(),
		handleTurnComplete: vi.fn(),
	};
}

/** An inline tool whose calls complete only when the test finishes them. */
function deferredTool() {
	const pending = new Map<string, (value: unknown) => void>();
	const tool: ToolDefinition = {
		name: 'slow_lookup',
		description: 'A lookup that completes when the test says so.',
		parameters: z.object({}),
		execution: 'inline',
		execute: (_args, ctx) => new Promise((resolve) => pending.set(ctx.toolCallId, resolve)),
	};
	return {
		tool,
		async finish(id: string): Promise<void> {
			await vi.waitFor(() => expect(pending.has(id)).toBe(true));
			pending.get(id)?.({ ok: id });
			pending.delete(id);
			// Let the router's result continuation run.
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
	};
}

function createAgent(opts: { tools?: ToolDefinition[]; greeting?: string } = {}): MainAgent {
	return {
		name: 'main',
		instructions: 'You are a concise assistant.',
		tools: opts.tools ?? [],
		...(opts.greeting ? { greeting: opts.greeting } : {}),
	};
}

interface SessionInternals {
	hold: SyntheticOutputHold;
	fence: { markBoundary(): void };
	directiveManager: { set(key: string, value: string, scope?: 'session' | 'agent'): void };
	reconnector: {
		onSyntheticHoldReleased(): void;
		armResponseWatchdog(): void;
		isRecoveryHeld(): boolean;
	};
	transcriptManager: { flushInput(): void };
	handleTextInput(text: string): Promise<void>;
}

function internals(session: VoiceSession): SessionInternals {
	return session as unknown as SessionInternals;
}

function createSession(
	stub: StubTransport,
	opts: {
		agent?: MainAgent;
		sttProvider?: STTProvider;
		whisperProvider?: STTProvider;
		responseWatchdogMs?: number;
		log?: (line: string) => void;
	} = {},
): VoiceSession {
	const config: VoiceSessionConfig = {
		sessionId: 'sess_host_recovery',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [opts.agent ?? createAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport: stub.transport,
		clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		sttProvider: opts.sttProvider,
		whisperProvider: opts.whisperProvider,
		responseWatchdogMs: opts.responseWatchdogMs,
		log: opts.log ?? (() => {}),
	};
	return new VoiceSession(config);
}

async function activate(session: VoiceSession, stub: StubTransport): Promise<void> {
	await session.start();
	stub.transport.onSessionReady?.('stub_session'); // CONNECTING → ACTIVE
}

function sentToolResultIds(stub: StubTransport): string[] {
	return stub.sendToolResult.mock.calls.map((c) => (c[0] as TransportToolResult).id);
}

function sentTexts(stub: StubTransport): string[] {
	return stub.sendContent.mock.calls.flatMap((c) =>
		(c[0] as Array<{ text: string }>).map((t) => t.text),
	);
}

/** A 30 ms client mic frame (16 kHz PCM16) at the given amplitude. */
function micFrame(amplitude: number): Buffer {
	const f = Buffer.alloc(480 * 2);
	for (let i = 0; i < f.length; i += 2) f.writeInt16LE(amplitude, i);
	return f;
}

// ─── DialGenerationFence ────────────────────────────────────────────────────

describe('DialGenerationFence (legacy mode)', () => {
	let session: VoiceSession | undefined;

	afterEach(async () => {
		await session?.close().catch(() => {});
		session = undefined;
	});

	it('drops a tool result issued before the boundary and sends one issued after it', async () => {
		const stub = createStubTransport();
		const slow = deferredTool();
		const lines: string[] = [];
		session = createSession(stub, {
			agent: createAgent({ tools: [slow.tool] }),
			log: (l) => lines.push(l),
		});
		await activate(session, stub);

		stub.transport.onToolCall?.([{ id: 'call_before', name: 'slow_lookup', args: {} }]);
		internals(session).fence.markBoundary(); // the incumbent, dial 1
		stub.setDialGen(3); // incumbent aborted (2), replacement dialed (3)
		stub.transport.onToolCall?.([{ id: 'call_after', name: 'slow_lookup', args: {} }]);

		await slow.finish('call_before');
		await slow.finish('call_after');

		expect(sentToolResultIds(stub)).toEqual(['call_after']);
		expect(lines.some((l) => l.includes('Dropped tool result call_before'))).toBe(true);
	});

	it('drops a result the dictation controller queued before the boundary and drained after the redial', async () => {
		const stub = createStubTransport();
		const slow = deferredTool();
		session = createSession(stub, {
			agent: createAgent({ tools: [slow.tool] }),
			whisperProvider: stubStt(),
		});
		await activate(session, stub);

		stub.transport.onToolCall?.([{ id: 'call_before', name: 'slow_lookup', args: {} }]);
		await session.setTranscriptionMode('transcription');
		await slow.finish('call_before'); // queued: not in agent mode
		expect(stub.sendToolResult).not.toHaveBeenCalled();

		internals(session).fence.markBoundary();
		stub.setDialGen(3);
		stub.transport.onToolCall?.([{ id: 'call_after', name: 'slow_lookup', args: {} }]);
		await slow.finish('call_after'); // queued too
		expect(stub.sendToolResult).not.toHaveBeenCalled();

		// Leaving transcription mode drains the queue through the fence.
		await session.setTranscriptionMode('agent');
		expect(sentToolResultIds(stub)).toEqual(['call_after']);
	});

	it('a pre-recovery STT capture completing after the boundary does not release the hold', async () => {
		const stub = createStubTransport();
		const stt = stubStt();
		const lines: string[] = [];
		session = createSession(stub, { sttProvider: stt, log: (l) => lines.push(l) });
		await activate(session, stub);
		const hold = internals(session).hold;

		stub.transport.onModelTurnStart?.(); // commits turn 0 on dial 1
		expect(stt.commit).toHaveBeenCalledWith(0);
		hold.engage();
		internals(session).fence.markBoundary();
		stub.setDialGen(3);

		stt.onTranscript?.('said before the recovery', 0);
		expect(hold.isActive()).toBe(true);
		expect(lines.some((l) => l.includes('Dropped transcript for turn 0'))).toBe(true);

		// A capture committed on the replacement connection is fresh evidence.
		stub.transport.onTurnComplete?.();
		stub.transport.onModelTurnStart?.(); // commits turn 1 on dial 3
		expect(stt.commit).toHaveBeenLastCalledWith(1);
		stt.onTranscript?.('said after the recovery', 1);
		expect(hold.isActive()).toBe(false);
	});

	it('a capture committed when a turn completes without a model start is fenced too', async () => {
		const stub = createStubTransport();
		const stt = stubStt();
		session = createSession(stub, { sttProvider: stt });
		await activate(session, stub);
		const hold = internals(session).hold;

		// No model-turn start, so turn 0's capture is committed at its completion.
		stub.transport.onTurnComplete?.(); // commits turn 0 on dial 1
		expect(stt.commit).toHaveBeenCalledWith(0);
		hold.engage();
		internals(session).fence.markBoundary();
		stub.setDialGen(3);

		stt.onTranscript?.('said before the recovery', 0);
		expect(hold.isActive()).toBe(true);

		// The same commit point on the replacement connection yields fresh evidence.
		stub.transport.onTurnComplete?.(); // commits turn 1 on dial 3
		expect(stt.commit).toHaveBeenLastCalledWith(1);
		stt.onTranscript?.('said after the recovery', 1);
		expect(hold.isActive()).toBe(false);
	});

	it('a pre-recovery capture still seals its reserved user message but does not release the hold', async () => {
		const stub = createStubTransport();
		const stt = stubStt();
		session = createSession(stub, { sttProvider: stt });
		await activate(session, stub);
		const hold = internals(session).hold;
		const context = session.conversationContext;

		// Turn 0 finalizes on dial 1 before its external STT transcript arrives,
		// so its user message is reserved with the provider's own transcription.
		stub.transport.onInputTranscription?.('provisional');
		stub.transport.onModelTurnStart?.(); // commits turn 0 on dial 1
		stub.transport.onTurnComplete?.();
		expect(context.hasPendingUserMessages).toBe(true);
		hold.engage();
		internals(session).fence.markBoundary();
		stub.setDialGen(3);

		stt.onTranscript?.('said before the recovery', 0);
		// The late transcript still resolves the reservation...
		expect(context.hasPendingUserMessages).toBe(false);
		expect(context.items.filter((i) => i.role === 'user').map((i) => i.content)).toEqual([
			'said before the recovery',
		]);
		// ...but a capture from the abandoned connection is not fresh evidence.
		expect(hold.isActive()).toBe(true);
	});

	it('a transcript whose capture stamp was pruned is placed by its turn', () => {
		const stub = createStubTransport();
		const fence = new DialGenerationFence(stub.transport, () => {});
		fence.stampSttCommit(0); // committed on dial 1
		fence.markBoundary();
		stub.setDialGen(3);
		// Four turns on the replacement connection prune the stamps of turns 0 and 1.
		for (const turn of [1, 2, 3, 4]) fence.stampSttCommit(turn);

		// A reservation outlives the turn window, so turn 0 can still be sealed.
		expect(fence.isSttCaptureStale(0)).toBe(true);
		expect(fence.isSttCaptureStale(1)).toBe(false);
		expect(fence.isSttCaptureStale(4)).toBe(false);
	});

	it("an automatic resumption reconnect with no boundary keeps today's delivery", async () => {
		const stub = createStubTransport();
		const stt = stubStt();
		const slow = deferredTool();
		session = createSession(stub, {
			agent: createAgent({ tools: [slow.tool] }),
			sttProvider: stt,
		});
		await activate(session, stub);
		stub.transport.onResumptionUpdate?.('handle-1', true);
		const hold = internals(session).hold;
		hold.engage();

		stub.transport.onModelTurnStart?.(); // STT capture committed on dial 1
		stub.transport.onToolCall?.([{ id: 'call_before', name: 'slow_lookup', args: {} }]);

		// GoAway: an immediate resumption reconnect onto dial 2, no host boundary.
		stub.transport.onGoAway?.('10s');
		await vi.waitFor(() => expect(session?.sessionManager.state).toBe('ACTIVE'));
		expect(stub.transport.reconnect).toHaveBeenCalledTimes(1);
		expect(stub.transport.currentDialGen).toBe(2);

		// The pre-reconnect tool result is still sent...
		await slow.finish('call_before');
		expect(sentToolResultIds(stub)).toEqual(['call_before']);
		// ...and the pre-reconnect STT capture still counts as fresh evidence.
		stt.onTranscript?.('said before the reconnect', 0);
		expect(hold.isActive()).toBe(false);
	});
});

// ─── Hold wiring ───────────────────────────────────────────────────────────

describe('synthetic-output hold wiring (legacy mode)', () => {
	let session: VoiceSession | undefined;

	afterEach(async () => {
		await session?.close().catch(() => {});
		session = undefined;
	});

	it('while held, no greeting, directive reinforcement or guarded generation trigger is sent', async () => {
		const stub = createStubTransport();
		session = createSession(stub, { agent: createAgent({ greeting: 'Say hello.' }) });
		const origins: string[] = [];
		session.eventBus.subscribe('response.started', (p) => origins.push(p.origin));
		internals(session).hold.engage();
		await activate(session, stub);

		session.notifyClientConnected();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(sentTexts(stub).some((t) => t.includes('Say hello.'))).toBe(false);

		// No greeting was sent, so the next response is not marked as one.
		stub.transport.onModelTurnStart?.();
		expect(origins).toEqual(['user_audio']);

		internals(session).directiveManager.set('pacing', 'Speak slowly.', 'session');
		stub.transport.onTurnComplete?.();
		expect(sentTexts(stub).some((t) => t.includes('Speak slowly.'))).toBe(false);

		session.guardedTriggerGeneration();
		expect(stub.triggerGeneration).not.toHaveBeenCalled();

		// Released: the same owners send again.
		internals(session).hold.release('typed-input');
		session.guardedTriggerGeneration();
		expect(stub.triggerGeneration).toHaveBeenCalledTimes(1);
		stub.transport.onModelTurnStart?.();
		stub.transport.onTurnComplete?.();
		expect(sentTexts(stub).some((t) => t.includes('Speak slowly.'))).toBe(true);
	});

	it('a greeting is sent once the hold is released before the client attaches', async () => {
		const stub = createStubTransport();
		session = createSession(stub, { agent: createAgent({ greeting: 'Say hello.' }) });
		const origins: string[] = [];
		session.eventBus.subscribe('response.started', (p) => origins.push(p.origin));
		internals(session).hold.engage();
		await activate(session, stub);
		internals(session).hold.release('input-transcription');

		session.notifyClientConnected();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(sentTexts(stub).some((t) => t.includes('Say hello.'))).toBe(true);
		stub.transport.onModelTurnStart?.();
		expect(origins).toEqual(['assistant_initiated']);
	});

	it('holds notifications; a dial-window release delivers one at once while the model is idle', async () => {
		const stub = createStubTransport();
		session = createSession(stub);
		await activate(session, stub);
		const hold = internals(session).hold;

		hold.engageDialWindow();
		session.publishSystemNotification('background job finished');
		expect(sentTexts(stub).some((t) => t.includes('background job finished'))).toBe(false);

		hold.releaseDialWindow();
		expect(sentTexts(stub).filter((t) => t.includes('background job finished'))).toHaveLength(1);
	});

	it('under a fresh-speech hold, notifications wait for the turn after the release', async () => {
		const stub = createStubTransport();
		session = createSession(stub);
		await activate(session, stub);
		const hold = internals(session).hold;

		hold.engage();
		hold.engageDialWindow();
		session.publishSystemNotification('background job finished');
		hold.releaseDialWindow();
		stub.transport.onModelTurnStart?.();
		stub.transport.onTurnComplete?.();
		expect(sentTexts(stub).some((t) => t.includes('background job finished'))).toBe(false);

		stub.transport.onInputTranscription?.('hello');
		expect(hold.isActive()).toBe(false);
		expect(sentTexts(stub).some((t) => t.includes('background job finished'))).toBe(false);

		stub.transport.onModelTurnStart?.();
		stub.transport.onTurnComplete?.();
		expect(sentTexts(stub).filter((t) => t.includes('background job finished'))).toHaveLength(1);
	});

	it('hold-respecting injections are refused while held; host injections are not', async () => {
		const stub = createStubTransport();
		session = createSession(stub);
		await activate(session, stub);
		internals(session).hold.engage();
		const inject = (
			session as unknown as {
				injectTextInternal(
					input: string,
					opts: { mode: 'quiet'; respectSyntheticHold: boolean },
				): Promise<boolean>;
			}
		).injectTextInternal.bind(session);

		await expect(
			inject('framework correction', { mode: 'quiet', respectSyntheticHold: true }),
		).resolves.toBe(false);
		await expect(session.injectText('host context', { mode: 'quiet' })).resolves.toBe(true);
		expect(sentTexts(stub)).toEqual(['host context']);
	});

	it.each([
		{
			source: 'built-in input transcription',
			fire: (_s: VoiceSession, stub: StubTransport) => stub.transport.onInputTranscription?.('hi'),
		},
		{
			source: 'provider interruption',
			fire: (_s: VoiceSession, stub: StubTransport) => {
				stub.transport.onModelTurnStart?.();
				stub.transport.onInterrupted?.();
			},
		},
		{
			source: 'typed text',
			fire: (s: VoiceSession) => void internals(s).handleTextInput('typed hello'),
		},
		{
			source: 'an injected transcript',
			fire: (s: VoiceSession) => void s.injectTranscript('dictated hello'),
		},
	])('fresh evidence releases the hold: $source', async ({ fire }) => {
		const stub = createStubTransport();
		session = createSession(stub);
		await activate(session, stub);
		const released = vi.spyOn(internals(session).reconnector, 'onSyntheticHoldReleased');
		internals(session).hold.engage();

		fire(session, stub);
		expect(internals(session).hold.isActive()).toBe(false);
		// A watchdog fire the hold held is re-evaluated.
		expect(released).toHaveBeenCalledTimes(1);
	});

	it('an external STT final and its provider-correction transcription both release the hold', async () => {
		const stub = createStubTransport();
		const stt = stubStt();
		session = createSession(stub, { sttProvider: stt });
		await activate(session, stub);
		const hold = internals(session).hold;

		hold.engage();
		stt.onTranscript?.('hello', undefined);
		expect(hold.isActive()).toBe(false);

		hold.engage();
		stub.transport.onInputTranscription?.('hello');
		expect(hold.isActive()).toBe(false);
	});

	it('an external STT final for a turn whose input already finalized still releases the hold', async () => {
		const stub = createStubTransport();
		const stt = stubStt();
		session = createSession(stub, { sttProvider: stt });
		await activate(session, stub);
		const hold = internals(session).hold;

		stt.onTranscript?.('hello', 0);
		internals(session).transcriptManager.flushInput(); // turn 0's input finalizes
		hold.engage();
		stt.onTranscript?.('hello again', 0);
		expect(hold.isActive()).toBe(false);
	});

	it('client-VAD microphone PCM is not evidence and does not release the hold', async () => {
		const stub = createStubTransport();
		session = createSession(stub);
		await activate(session, stub);
		internals(session).hold.engage();

		for (let i = 0; i < 20; i++) session.feedAudioFromClient(micFrame(4000));
		expect(stub.transport.sendAudio).toHaveBeenCalled();
		expect(internals(session).hold.isActive()).toBe(true);
	});
});

// ─── Held watchdog recovery ────────────────────────────────────────────────

describe('a watchdog fire held by the synthetic-output hold (legacy mode)', () => {
	let session: VoiceSession | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		await session?.close().catch(() => {});
		session = undefined;
		vi.useRealTimers();
	});

	/** An active session whose watchdog fired under the hold. A resumption
	 *  handle is present, so a released fire would force a reconnect. */
	async function sessionWithHeldFire(stub: StubTransport, lines: string[]): Promise<VoiceSession> {
		const s = createSession(stub, { responseWatchdogMs: 1000, log: (l) => lines.push(l) });
		session = s;
		await activate(s, stub);
		stub.transport.onResumptionUpdate?.('handle-1', true);
		internals(s).hold.engage();
		internals(s).reconnector.armResponseWatchdog();
		vi.advanceTimersByTime(1100);
		expect(internals(s).reconnector.isRecoveryHeld()).toBe(true);
		return s;
	}

	it.each([
		{
			source: 'typed text',
			send: (s: VoiceSession) => internals(s).handleTextInput('typed hello'),
		},
		{
			source: 'an injected transcript',
			send: (s: VoiceSession) => s.injectTranscript('typed hello'),
		},
	])('direct input supersedes it: $source', async ({ send }) => {
		const stub = createStubTransport();
		const lines: string[] = [];
		const s = await sessionWithHeldFire(stub, lines);

		const done = send(s);
		expect(s.sessionManager.state).toBe('ACTIVE');
		await vi.advanceTimersByTimeAsync(3000);
		await done;

		expect(internals(s).hold.isActive()).toBe(false);
		expect(sentTexts(stub)).toContain('typed hello');
		expect(stub.transport.reconnect).not.toHaveBeenCalled();
		expect(stub.triggerGeneration).not.toHaveBeenCalled();
		expect(s.sessionManager.state).toBe('ACTIVE');
		expect(lines.some((l) => l.includes('forcing reconnect'))).toBe(false);
	});

	it.each([
		{
			source: 'input transcription',
			fire: (stub: StubTransport) => stub.transport.onInputTranscription?.('hello'),
		},
		{
			source: 'a provider interruption',
			fire: (stub: StubTransport) => stub.transport.onInterrupted?.(),
		},
	])('the model answering resolves it: $source afterwards re-fires nothing', async ({ fire }) => {
		const stub = createStubTransport();
		const lines: string[] = [];
		const s = await sessionWithHeldFire(stub, lines);

		stub.transport.onModelTurnStart?.();
		stub.transport.onAudioOutput?.(Buffer.alloc(960).toString('base64'));
		expect(internals(s).reconnector.isRecoveryHeld()).toBe(false);

		fire(stub);
		expect(internals(s).hold.isActive()).toBe(false);
		await vi.advanceTimersByTimeAsync(3000);

		expect(stub.transport.reconnect).not.toHaveBeenCalled();
		expect(stub.triggerGeneration).not.toHaveBeenCalled();
		expect(s.sessionManager.state).toBe('ACTIVE');
		expect(lines.some((l) => l.includes('forcing reconnect'))).toBe(false);
	});
});

// ─── Recovery controller: recoverUpstream / parkUpstream ───────────────────

interface RecoveryStub {
	transport: LLMTransport;
	connect: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
	abortIncumbent: ReturnType<typeof vi.fn>;
	clearResumption: ReturnType<typeof vi.fn>;
	sendContent: ReturnType<typeof vi.fn>;
	sendAudio: ReturnType<typeof vi.fn>;
	/** The next dial stays pending until the returned controls settle it. */
	holdNextDial(): { resolve(): void; reject(error: Error): void };
	/** The next dial fails with `error`. */
	failNextDial(error: Error): void;
	/** Open a model generation that the next incumbent abort ends. */
	openGeneration(id: string): void;
	/** Dial generations whose dial completed after it was superseded: the
	 *  fence closed their sessions instead of installing them. */
	lateSessionsClosed: number[];
}

/**
 * A transport with the recovery primitives, shaped like the Gemini
 * transport: a dial counter that advances per dial (and once more when a
 * dial fails), a post-setup generation counter, `abortIncumbent()` that
 * advances the dial counter and synchronously ends an open generation, and
 * `connect()` that reports setup complete before it resolves. A dial that
 * completes after it was superseded (the counter moved on while it was
 * pending) is fenced: its session is closed, never installed, and nothing is
 * reported.
 */
function createRecoveryTransport(): RecoveryStub {
	let dialGen = 0;
	let transportGeneration = 0;
	let connected = false;
	let openGenerationId: string | null = null;
	const plans: Array<() => Promise<void>> = [];
	const lateSessionsClosed: number[] = [];
	const sendContent = vi.fn();
	const sendAudio = vi.fn();
	const connect = vi.fn(async () => {
		const gen = ++dialGen;
		try {
			await plans.shift()?.();
		} catch (err) {
			if (gen === dialGen) dialGen += 1;
			throw err;
		}
		if (gen !== dialGen) {
			lateSessionsClosed.push(gen);
			return;
		}
		transportGeneration += 1;
		connected = true;
		transport.onSessionReady?.(`stub_${gen}`);
	});
	const disconnect = vi.fn(async () => {
		connected = false;
	});
	const abortIncumbent = vi.fn((): Promise<'closed' | 'forced'> => {
		dialGen += 1;
		connected = false;
		if (openGenerationId !== null) {
			const id = openGenerationId;
			openGenerationId = null;
			transport.onGenerationEnd?.(id, 'disconnected');
		}
		return Promise.resolve('closed');
	});
	const clearResumption = vi.fn();
	const transport: LLMTransport = {
		capabilities: {
			messageTruncation: false,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: false,
			sessionResumption: true,
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
		get isConnected() {
			return connected;
		},
		get currentDialGen() {
			return dialGen;
		},
		get currentTransportGeneration() {
			return transportGeneration;
		},
		connect,
		disconnect,
		reconnect: vi.fn(async () => {}),
		abortIncumbent,
		clearResumption,
		sendAudio,
		commitAudio: vi.fn(),
		clearAudio: vi.fn(),
		updateSession: vi.fn(async () => {}),
		transferSession: vi.fn(async () => {}),
		sendContent,
		sendFile: vi.fn(),
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
	};
	return {
		transport,
		connect,
		disconnect,
		abortIncumbent,
		clearResumption,
		sendContent,
		sendAudio,
		holdNextDial() {
			let resolve!: () => void;
			let reject!: (error: Error) => void;
			const settled = new Promise<void>((res, rej) => {
				resolve = res;
				reject = rej;
			});
			plans.push(() => settled);
			return { resolve, reject };
		},
		failNextDial(error) {
			plans.push(() => Promise.reject(error));
		},
		openGeneration(id) {
			openGenerationId = id;
			transport.onGenerationStart?.(id);
		},
		lateSessionsClosed,
	};
}

interface RecoveryInternals {
	greeting: { isUninterruptibleGreetingActive(): boolean };
	reconnector: { armResponseWatchdog(): void; isRecoveryHeld(): boolean };
	directiveManager: { set(key: string, value: string, scope?: 'session' | 'agent'): void };
	clientTransport: unknown;
	fence: { markBoundary(): void };
	utteranceRetainer?: {
		feed(data: Buffer): void;
		markSpeechStart(): void;
		seal(): boolean;
		peek(maxAgeMs: number): unknown;
	};
	historyWriter?: { drain(): Promise<void> };
	handleTextInput(text: string): Promise<void>;
	injectRecentContext(origin: 'client-reconnect-context'): void;
}

function recoveryInternals(session: VoiceSession): RecoveryInternals {
	return session as unknown as RecoveryInternals;
}

function createRecoverySession(
	stub: RecoveryStub,
	opts: {
		agent?: MainAgent;
		sttProvider?: STTProvider;
		upstreamLossPolicy?: 'close' | 'hold';
		orchestrationMode?: 'legacy' | 'actor';
		clientSender?: SessionClientSender;
		port?: number;
		greetingInterruptible?: boolean;
		responseWatchdogMs?: number;
		watchdogReplayRecovery?: boolean;
		hooks?: FrameworkHooks;
		log?: (line: string) => void;
		responseModality?: 'audio' | 'text';
		initialHistory?: ConversationItem[];
		conversationHistoryStore?: ConversationHistoryStore;
	} = {},
): VoiceSession {
	return new VoiceSession({
		sessionId: 'sess_recover',
		userId: 'user_1',
		apiKey: 'test-key',
		agents: [opts.agent ?? createAgent()],
		initialAgent: 'main',
		model: mockModel,
		transport: stub.transport,
		upstreamLossPolicy: opts.upstreamLossPolicy ?? 'hold',
		orchestrationMode: opts.orchestrationMode,
		...(opts.port !== undefined
			? { port: opts.port }
			: { clientSender: opts.clientSender ?? { sendAudio: vi.fn(), sendJson: vi.fn() } }),
		sttProvider: opts.sttProvider,
		greetingInterruptible: opts.greetingInterruptible,
		responseWatchdogMs: opts.responseWatchdogMs,
		watchdogReplayRecovery: opts.watchdogReplayRecovery,
		hooks: opts.hooks,
		log: opts.log ?? (() => {}),
		responseModality: opts.responseModality,
		initialHistory: opts.initialHistory,
		conversationHistoryStore: opts.conversationHistoryStore,
	});
}

/** A history store that accepts every write and holds nothing. */
function nullHistoryStore(): ConversationHistoryStore {
	return {
		createSession: vi.fn(async () => {}),
		updateSession: vi.fn(async () => {}),
		addItems: vi.fn(async () => {}),
		saveSessionReport: vi.fn(async () => {}),
		getSession: vi.fn(async () => null),
		getSessionItems: vi.fn(async () => []),
		listUserSessions: vi.fn(async () => []),
	};
}

function recoverArgs(overrides: Partial<RecoverUpstreamArgs> = {}): RecoverUpstreamArgs {
	return {
		reason: 'active-silence',
		skipContextInjection: true,
		holdSyntheticUntilFreshSpeech: false,
		...overrides,
	};
}

function stubTexts(stub: RecoveryStub): string[] {
	return stub.sendContent.mock.calls.flatMap((c) =>
		(c[0] as Array<{ text: string }>).map((t) => t.text),
	);
}

describe('host recovery (legacy mode)', () => {
	let session: VoiceSession | undefined;

	afterEach(async () => {
		await session?.close().catch(() => {});
		session = undefined;
	});

	it('recoverUpstream returns a numeric attemptEpoch synchronously, enters RECONNECTING, clears the handle and publishes one boundary', async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub);
		await session.start();
		stub.transport.onResumptionUpdate?.('handle-1', true);
		expect(session.sessionManager.resumptionHandle).toBe('handle-1');
		const published: string[] = [];
		const boundaries: unknown[] = [];
		session.eventBus.subscribe('session.reset', (p) => published.push(`reset:${p.reason}`));
		session.eventBus.subscribe('session.reconnectBoundary', (p) => {
			published.push('boundary');
			boundaries.push(p);
		});

		const r = session.recoverUpstream(recoverArgs());

		// Dial 1 is the incumbent: its abort takes 2, the replacement dials on 3.
		expect(r.attemptEpoch).toBe(3);
		expect(r.activated).toBeInstanceOf(Promise);
		expect(r.incumbentClosed).toBeInstanceOf(Promise);
		expect(session.sessionManager.state).toBe('RECONNECTING');
		expect(session.sessionManager.resumptionHandle).toBeNull();
		expect(stub.clearResumption).toHaveBeenCalled();
		expect(stub.abortIncumbent).toHaveBeenCalledTimes(1);
		expect(published).toEqual(['reset:reconnect', 'boundary']);
		expect(boundaries).toEqual([
			{
				sessionId: 'sess_recover',
				reason: 'active-silence',
				transportGeneration: 3,
				attemptEpoch: 3,
			},
		]);

		await r.activated;
		expect(stub.transport.currentDialGen).toBe(r.attemptEpoch);
		expect(boundaries).toHaveLength(1);
	});

	it('activation reaches ACTIVE with no greeting and no injected context', async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub, { agent: createAgent({ greeting: 'Say hello.' }) });
		await session.start();
		session.notifyClientConnected(); // the first client is greeted once
		session.conversationContext.addUserMessage('what is the weather');
		session.conversationContext.addAssistantMessage('sunny');

		const r = session.recoverUpstream(recoverArgs({ skipContextInjection: true }));
		await r.activated;

		expect(session.sessionManager.state).toBe('ACTIVE');
		await expect(r.incumbentClosed).resolves.toBe('closed');
		expect(stubTexts(stub).filter((t) => t.includes('Say hello.'))).toHaveLength(1);
		expect(stubTexts(stub).some((t) => t.includes('reconnected'))).toBe(false);
	});

	it('skipContextInjection: false injects quiet recent context after activation; the fresh-speech hold suppresses it', async () => {
		const stub = createRecoveryTransport();
		const lines: string[] = [];
		session = createRecoverySession(stub, { log: (l) => lines.push(l) });
		await session.start();
		session.conversationContext.addUserMessage('what is the weather');
		session.conversationContext.addAssistantMessage('sunny');

		const pending = session.recoverUpstream(recoverArgs({ skipContextInjection: false }));
		expect(stubTexts(stub).some((t) => t.includes('reconnected'))).toBe(false); // not before activation
		await pending.activated;
		const injected = stub.sendContent.mock.calls.filter((c) =>
			(c[0] as Array<{ text: string }>).some((t) => t.text.includes('You just reconnected.')),
		);
		expect(injected).toHaveLength(1);
		const [turns, turnComplete] = injected[0] as [Array<{ text: string }>, boolean];
		expect(turnComplete).toBe(false); // quiet: no response requested
		expect(turns[0].text).toContain('user: what is the weather\nassistant: sunny');

		// Under the fresh-speech hold the same injection is suppressed.
		stub.sendContent.mockClear();
		const held = session.recoverUpstream(
			recoverArgs({ skipContextInjection: false, holdSyntheticUntilFreshSpeech: true }),
		);
		await held.activated;
		expect(session.isSyntheticHoldActive()).toBe(true);
		expect(stubTexts(stub).some((t) => t.includes('reconnected'))).toBe(false);
		expect(lines.some((l) => l.includes('suppressed gemini-reconnect-context'))).toBe(true);
	});

	it('is single-flight for a boundary subscriber and a generation.end subscriber that re-enter, with one dial', async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub);
		await session.start();
		stub.openGeneration('gen_1');
		const s = session;
		const reentries: Array<{
			at: string;
			result: RecoverUpstreamResult;
			epochType: string;
			incumbentClosedIsPromise: boolean;
		}> = [];
		const reenter = (at: string) => {
			const result = s.recoverUpstream(recoverArgs());
			reentries.push({
				at,
				result,
				epochType: typeof result.attemptEpoch,
				incumbentClosedIsPromise: result.incumbentClosed instanceof Promise,
			});
		};
		// generation.end is published while abortIncumbent() runs, before the boundary event.
		session.eventBus.subscribe('generation.end', () => reenter('generation.end'));
		session.eventBus.subscribe('session.reconnectBoundary', () => reenter('boundary'));

		const outer = session.recoverUpstream(recoverArgs());

		expect(reentries.map((e) => e.at)).toEqual(['generation.end', 'boundary']);
		for (const e of reentries) {
			expect(e.result).toBe(outer);
			expect(e.epochType).toBe('number');
			expect(e.incumbentClosedIsPromise).toBe(true);
		}
		await outer.activated;
		const outerClosed = await outer.incumbentClosed;
		for (const e of reentries) {
			await expect(e.result.activated).resolves.toBeUndefined();
			await expect(e.result.incumbentClosed).resolves.toBe(outerClosed);
			expect(e.result.attemptEpoch).toBe(outer.attemptEpoch);
		}
		expect(stub.abortIncumbent).toHaveBeenCalledTimes(1);
		expect(stub.connect).toHaveBeenCalledTimes(2); // start() plus exactly one recovery dial
	});

	it('redials a session parked in UPSTREAM_LOST', async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub);
		await session.start();
		// No resumption handle: the transport close parks the session.
		stub.transport.onClose?.(1006, 'socket lost');
		expect(session.sessionManager.state).toBe('UPSTREAM_LOST');

		const r = session.recoverUpstream(recoverArgs({ reason: 'human-retry' }));
		expect(session.sessionManager.state).toBe('RECONNECTING');
		await r.activated;
		expect(session.sessionManager.state).toBe('ACTIVE');
		expect(stub.connect).toHaveBeenCalledTimes(2);
	});

	const history: ConversationItem[] = [
		{ role: 'user', content: 'my name is Ada', timestamp: 1 },
		{ role: 'assistant', content: 'hello Ada', timestamp: 2 },
	];

	describe('while the first dial of start() is still pending', () => {
		/** Call start() with its first dial held open; returns once the
		 *  session is CONNECTING on that dial. */
		async function startWithPendingDial(
			stub: RecoveryStub,
			s: VoiceSession,
		): Promise<{ started: Promise<void>; firstDial: ReturnType<RecoveryStub['holdNextDial']> }> {
			const firstDial = stub.holdNextDial();
			const started = s.start();
			await vi.waitFor(() => expect(stub.connect).toHaveBeenCalledTimes(1));
			expect(s.sessionManager.state).toBe('CONNECTING');
			return { started, firstDial };
		}

		/** Record every close and park the session publishes. */
		function recordEndings(s: VoiceSession): string[] {
			const endings: string[] = [];
			s.eventBus.subscribe('session.close', (p) => endings.push(`close:${p.reason}`));
			s.eventBus.subscribe('session.upstreamLost', (p) => endings.push(`lost:${p.reason}`));
			return endings;
		}

		const timings = [
			{ when: 'after the replacement activates', settleFirstDialEarly: false },
			{ when: 'while the replacement is still dialing', settleFirstDialEarly: true },
		];

		it.each(timings)(
			"recoverUpstream during CONNECTING under 'hold' replaces the pending first dial and reaches ACTIVE; the original dial's late rejection $when neither closes nor parks the session and start() rejects with that dial's error",
			async ({ settleFirstDialEarly }) => {
				const stub = createRecoveryTransport();
				const lines: string[] = [];
				session = createRecoverySession(stub, { log: (l) => lines.push(l) });
				const endings = recordEndings(session);
				const { started, firstDial } = await startWithPendingDial(stub, session);
				const replacement = stub.holdNextDial();

				const r = session.recoverUpstream(recoverArgs());
				expect(session.sessionManager.state).toBe('RECONNECTING');
				expect(stub.abortIncumbent).toHaveBeenCalledTimes(1);

				const refused = new Error('first dial refused');
				if (settleFirstDialEarly) {
					firstDial.reject(refused);
					await expect(started).rejects.toBe(refused);
					expect(session.sessionManager.state).toBe('RECONNECTING');
					replacement.resolve();
					await r.activated;
				} else {
					replacement.resolve();
					await r.activated;
					firstDial.reject(refused);
					await expect(started).rejects.toBe(refused);
				}

				expect(session.sessionManager.state).toBe('ACTIVE');
				expect(stub.transport.isConnected).toBe(true);
				expect(stub.transport.currentDialGen).toBe(r.attemptEpoch);
				expect(stub.disconnect).not.toHaveBeenCalled();
				expect(stub.connect).toHaveBeenCalledTimes(2);
				expect(endings).toEqual([]);
				expect(lines.filter((l) => l.includes('a host recovery replaced'))).toHaveLength(1);
			},
		);

		it.each(timings)(
			"recoverUpstream during CONNECTING under 'hold' replaces the pending first dial; the original dial's late resolution $when leaves the replacement installed and ACTIVE, the transport fence closes the late session, and start() resolves",
			async ({ settleFirstDialEarly }) => {
				const stub = createRecoveryTransport();
				const stt = stubStt();
				const lines: string[] = [];
				session = createRecoverySession(stub, { sttProvider: stt, log: (l) => lines.push(l) });
				const endings = recordEndings(session);
				const { started, firstDial } = await startWithPendingDial(stub, session);
				const replacement = stub.holdNextDial();

				const r = session.recoverUpstream(recoverArgs());
				if (settleFirstDialEarly) {
					firstDial.resolve();
					await started;
					expect(session.sessionManager.state).toBe('RECONNECTING');
					replacement.resolve();
					await r.activated;
				} else {
					replacement.resolve();
					await r.activated;
					const sttStarts = vi.mocked(stt.start).mock.calls.length;
					firstDial.resolve();
					await started;
					// Nothing the activation ran runs again.
					expect(vi.mocked(stt.start).mock.calls.length).toBe(sttStarts);
				}

				expect(stub.lateSessionsClosed).toEqual([1]);
				expect(session.sessionManager.state).toBe('ACTIVE');
				expect(stub.transport.isConnected).toBe(true);
				expect(stub.transport.currentDialGen).toBe(r.attemptEpoch);
				expect(stub.transport.currentTransportGeneration).toBe(1); // only the replacement set up
				expect(stub.disconnect).not.toHaveBeenCalled();
				expect(endings).toEqual([]);
				expect(lines.filter((l) => l.includes('a host recovery replaced'))).toHaveLength(1);
				expect(lines.some((l) => l.includes('LLM transport connected and setup complete'))).toBe(
					false,
				);
			},
		);

		it("recoverUpstream during CONNECTING under upstreamLossPolicy 'close' still throws SessionError and the state stays CONNECTING", async () => {
			const stub = createRecoveryTransport();
			session = createRecoverySession(stub, { upstreamLossPolicy: 'close' });
			const { started, firstDial } = await startWithPendingDial(stub, session);

			expect(() => session?.recoverUpstream(recoverArgs())).toThrow(SessionError);
			expect(() => session?.recoverUpstream(recoverArgs())).toThrow("upstreamLossPolicy 'hold'");
			expect(session.sessionManager.state).toBe('CONNECTING');
			expect(stub.abortIncumbent).not.toHaveBeenCalled();

			firstDial.resolve();
			await started;
			expect(session.sessionManager.state).toBe('ACTIVE');
			expect(stub.connect).toHaveBeenCalledTimes(1);
		});

		it('a CONNECTING recovery publishes exactly one session.reconnectBoundary, dials on attemptEpoch, and parkUpstream() still refuses CONNECTING', async () => {
			const stub = createRecoveryTransport();
			session = createRecoverySession(stub);
			const { started, firstDial } = await startWithPendingDial(stub, session);
			const boundaries: unknown[] = [];
			session.eventBus.subscribe('session.reconnectBoundary', (p) => boundaries.push(p));

			await expect(session.parkUpstream('idle')).rejects.toThrow('it is CONNECTING');
			expect(session.sessionManager.state).toBe('CONNECTING');

			const r = session.recoverUpstream(recoverArgs());

			// The pending first dial is dial 1: its abort takes 2, the replacement dials on 3.
			expect(r.attemptEpoch).toBe(3);
			expect(boundaries).toEqual([
				{
					sessionId: 'sess_recover',
					reason: 'active-silence',
					transportGeneration: 3,
					attemptEpoch: 3,
				},
			]);
			await r.activated;
			expect(stub.transport.currentDialGen).toBe(r.attemptEpoch);

			firstDial.reject(new Error('stranded dial timed out'));
			await expect(started).rejects.toThrow('stranded dial timed out');
			expect(boundaries).toHaveLength(1);
			expect(stub.transport.currentDialGen).toBe(r.attemptEpoch);
			expect(stub.abortIncumbent).toHaveBeenCalledTimes(1);
		});

		it('a recovery from a subscriber of the CONNECTING state change leaves exactly one dial: start() dials nothing, resolves, and attemptEpoch is exact', async () => {
			const stub = createRecoveryTransport();
			const lines: string[] = [];
			session = createRecoverySession(stub, { log: (l) => lines.push(l) });
			const endings = recordEndings(session);
			const s = session;
			let r: RecoverUpstreamResult | undefined;
			session.eventBus.subscribe('session.stateChange', (p) => {
				if (p.toState === 'CONNECTING' && !r) r = s.recoverUpstream(recoverArgs());
			});

			await session.start();
			if (!r) throw new Error('the subscriber did not recover');
			await r.activated;

			expect(stub.connect).toHaveBeenCalledTimes(1);
			expect(session.sessionManager.state).toBe('ACTIVE');
			// Nothing had dialed: the abort takes 1, the replacement dials on 2.
			expect(r.attemptEpoch).toBe(2);
			expect(stub.transport.currentDialGen).toBe(r.attemptEpoch);
			expect(stub.transport.isConnected).toBe(true);
			expect(endings).toEqual([]);
			expect(lines.some((l) => l.includes('LLM transport connected and setup complete'))).toBe(
				false,
			);
		});

		it('a recovery during the text-mode session update a pre-constructed transport gets before it connects leaves exactly one dial', async () => {
			const stub = createRecoveryTransport();
			session = createRecoverySession(stub, { responseModality: 'text' });
			const endings = recordEndings(session);
			// The constructor's own update is not the dial's: hold the next one.
			const updateSession = vi.mocked(stub.transport.updateSession);
			updateSession.mockClear();
			let releaseUpdate: (() => void) | undefined;
			updateSession.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						releaseUpdate = resolve;
					}),
			);
			const started = session.start();
			await vi.waitFor(() => expect(updateSession).toHaveBeenCalledTimes(1));
			expect(updateSession).toHaveBeenCalledWith({ responseModality: 'text' });
			expect(session.sessionManager.state).toBe('CONNECTING');
			expect(stub.connect).not.toHaveBeenCalled();

			const r = session.recoverUpstream(recoverArgs());
			releaseUpdate?.();
			await started;
			await r.activated;

			expect(stub.connect).toHaveBeenCalledTimes(1);
			expect(session.sessionManager.state).toBe('ACTIVE');
			expect(r.attemptEpoch).toBe(2);
			expect(stub.transport.currentDialGen).toBe(r.attemptEpoch);
			expect(endings).toEqual([]);
		});

		it("an ACTIVE recovery that runs after the first dial set up, before start() resumes, leaves start()'s completion intact: the history writer drains and the connect is logged", async () => {
			const stub = createRecoveryTransport();
			const lines: string[] = [];
			session = createRecoverySession(stub, {
				conversationHistoryStore: nullHistoryStore(),
				log: (l) => lines.push(l),
			});
			const writer = recoveryInternals(session).historyWriter;
			if (!writer) throw new Error('no history writer');
			const drain = vi.spyOn(writer, 'drain');
			const s = session;
			let r: RecoverUpstreamResult | undefined;
			// Published from the first dial's setup, before its connect() resolves.
			session.eventBus.subscribe('session.stateChange', (p) => {
				if (p.fromState === 'CONNECTING' && p.toState === 'ACTIVE' && !r) {
					r = s.recoverUpstream(recoverArgs());
				}
			});

			await session.start();

			expect(drain).toHaveBeenCalledTimes(1);
			expect(lines.some((l) => l.includes('LLM transport connected and setup complete'))).toBe(
				true,
			);
			expect(lines.some((l) => /a host recovery replaced/i.test(l))).toBe(false);
			if (!r) throw new Error('the subscriber did not recover');
			await r.activated;
			expect(session.sessionManager.state).toBe('ACTIVE');
			expect(stub.transport.currentDialGen).toBe(r.attemptEpoch);
			expect(stub.connect).toHaveBeenCalledTimes(2);
		});

		it('initialHistory is replayed once, by the replacement, after a CONNECTING recovery', async () => {
			const stub = createRecoveryTransport();
			const replayedOnDial: Array<number | undefined> = [];
			const replayHistory = vi.fn(() => {
				replayedOnDial.push(stub.transport.currentDialGen);
			});
			stub.transport.replayHistory = replayHistory;
			session = createRecoverySession(stub, { initialHistory: history });
			const { started, firstDial } = await startWithPendingDial(stub, session);

			const r = session.recoverUpstream(recoverArgs());
			await r.activated;
			firstDial.resolve();
			await started;

			expect(replayedOnDial).toEqual([r.attemptEpoch]);
			expect(replayHistory).toHaveBeenCalledWith([
				{ type: 'text', role: 'user', text: 'my name is Ada' },
				{ type: 'text', role: 'assistant', text: 'hello Ada' },
			]);
		});

		it('initialHistory is replayed once by a first dial that sets up, and not again by a later recovery', async () => {
			const stub = createRecoveryTransport();
			const replayHistory = vi.fn();
			stub.transport.replayHistory = replayHistory;
			session = createRecoverySession(stub, { initialHistory: history });
			await session.start();
			expect(replayHistory).toHaveBeenCalledTimes(1);

			await session.recoverUpstream(recoverArgs()).activated;
			expect(replayHistory).toHaveBeenCalledTimes(1);
		});
	});

	it("after a failed initial start() under 'hold', recoverUpstream reaches ACTIVE", async () => {
		const stub = createRecoveryTransport();
		stub.failNextDial(new Error('getaddrinfo ENOTFOUND'));
		session = createRecoverySession(stub);
		await expect(session.start()).rejects.toThrow('ENOTFOUND');
		expect(session.sessionManager.state).toBe('UPSTREAM_LOST');

		const r = session.recoverUpstream(recoverArgs({ reason: 'human-retry' }));
		await r.activated;
		expect(session.sessionManager.state).toBe('ACTIVE');
		expect(stub.transport.currentDialGen).toBe(r.attemptEpoch);
	});

	it("with initialHistory under 'hold', a failed first dial parks without the session ever being ACTIVE; the first successful recovery replays the history once, on its setup, and a second recovery does not replay it again", async () => {
		const stub = createRecoveryTransport();
		const replayedOnDial: Array<number | undefined> = [];
		const replayHistory = vi.fn(() => {
			replayedOnDial.push(stub.transport.currentDialGen);
		});
		stub.transport.replayHistory = replayHistory;
		stub.failNextDial(new Error('getaddrinfo ENOTFOUND'));
		session = createRecoverySession(stub, { initialHistory: history });
		const states: string[] = [];
		session.eventBus.subscribe('session.stateChange', (p) => states.push(p.toState));

		await expect(session.start()).rejects.toThrow('ENOTFOUND');
		expect(session.sessionManager.state).toBe('UPSTREAM_LOST');
		expect(states).toEqual(['CONNECTING', 'UPSTREAM_LOST']);
		expect(session.sessionManager.startedAtMs).toBeNull();
		expect(replayHistory).not.toHaveBeenCalled();

		const first = session.recoverUpstream(recoverArgs({ reason: 'human-retry' }));
		await first.activated;
		expect(session.sessionManager.state).toBe('ACTIVE');
		expect(replayedOnDial).toEqual([first.attemptEpoch]);
		expect(replayHistory).toHaveBeenCalledWith([
			{ type: 'text', role: 'user', text: 'my name is Ada' },
			{ type: 'text', role: 'assistant', text: 'hello Ada' },
		]);

		const second = session.recoverUpstream(recoverArgs({ reason: 'human-retry' }));
		await second.activated;
		expect(session.sessionManager.state).toBe('ACTIVE');
		expect(stub.transport.currentDialGen).toBe(second.attemptEpoch);
		expect(replayedOnDial).toEqual([first.attemptEpoch]);
		expect(replayHistory).toHaveBeenCalledTimes(1);
	});

	it("throws SessionError under upstreamLossPolicy 'close' and reports the degraded capabilities", async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub, { upstreamLossPolicy: 'close' });
		await session.start();

		expect(session.getRecoveryCapabilities()).toEqual({
			version: 1,
			recoverUpstream: false,
			reconnectBoundary: false,
			turnStartPublication: true,
			transportGenerations: true,
			syntheticHold: false,
		});
		expect(() => session?.recoverUpstream(recoverArgs())).toThrow(SessionError);
		expect(() => session?.recoverUpstream(recoverArgs())).toThrow("upstreamLossPolicy 'hold'");
		await expect(session.parkUpstream('idle')).rejects.toThrow(SessionError);
		expect(session.sessionManager.state).toBe('ACTIVE');
		expect(stub.abortIncumbent).not.toHaveBeenCalled();
	});

	it('a failed dial reports recover-upstream, parks in UPSTREAM_LOST and rejects activated', async () => {
		const stub = createRecoveryTransport();
		const onError = vi.fn();
		session = createRecoverySession(stub, { hooks: { onError } });
		await session.start();
		const lost: unknown[] = [];
		session.eventBus.subscribe('session.upstreamLost', (p) => lost.push(p));
		stub.failNextDial(new Error('dial refused'));

		const r = session.recoverUpstream(recoverArgs());
		await expect(r.activated).rejects.toThrow('dial refused');

		expect(session.sessionManager.state).toBe('UPSTREAM_LOST');
		expect(lost).toEqual([
			{ sessionId: 'sess_recover', reason: 'recover-upstream-failed', detail: 'dial refused' },
		]);
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ component: 'recover-upstream', error: expect.any(Error) }),
		);
	});

	it('close() during a pending recovery rejects activated, disconnects the late dial and ends CLOSED', async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub);
		await session.start();
		const dial = stub.holdNextDial();
		const r = session.recoverUpstream(recoverArgs());

		await session.close();
		expect(session.sessionManager.state).toBe('CLOSED');

		dial.resolve(); // the dial completes after the close
		await expect(r.activated).rejects.toThrow(SessionError);
		expect(stub.transport.isConnected).toBe(false);
		expect(stub.disconnect).toHaveBeenCalledTimes(2); // close()'s teardown, then the late dial
		expect(session.sessionManager.state).toBe('CLOSED');
		expect(() => session?.recoverUpstream(recoverArgs())).toThrow(SessionError);
	});

	it("in actor mode 'hold' is rejected at construction and recovery is unavailable", async () => {
		const stub = createRecoveryTransport();
		expect(() =>
			createRecoverySession(stub, { orchestrationMode: 'actor', upstreamLossPolicy: 'hold' }),
		).toThrow(ValidationError);

		session = createRecoverySession(stub, {
			orchestrationMode: 'actor',
			upstreamLossPolicy: 'close',
		});
		expect(session.getRecoveryCapabilities().recoverUpstream).toBe(false);
		expect(session.getRecoveryCapabilities().syntheticHold).toBe(false);
		expect(() => session?.recoverUpstream(recoverArgs())).toThrow(SessionError);
		expect(() => session?.recoverUpstream(recoverArgs())).toThrow("orchestrationMode 'actor'");
		await expect(session.parkUpstream('idle')).rejects.toThrow(SessionError);
	});

	it.each([
		{ binding: 'bound to its model turn', modelStarted: true },
		{ binding: 'not yet bound', modelStarted: false },
	])(
		'recovery during an uninterruptible greeting $binding releases the gate, sends no second greeting, and the microphone reaches the replacement',
		async ({ modelStarted }) => {
			const stub = createRecoveryTransport();
			session = createRecoverySession(stub, {
				agent: createAgent({ greeting: 'Say hello.' }),
				greetingInterruptible: false,
			});
			await session.start();
			session.notifyClientConnected(); // greeting sent, suppression armed
			if (modelStarted) stub.transport.onModelTurnStart?.();
			expect(recoveryInternals(session).greeting.isUninterruptibleGreetingActive()).toBe(true);
			session.feedAudioFromClient(micFrame(3000));
			expect(stub.sendAudio).not.toHaveBeenCalled(); // dropped under suppression

			const dial = stub.holdNextDial();
			const r = session.recoverUpstream(recoverArgs());
			expect(recoveryInternals(session).greeting.isUninterruptibleGreetingActive()).toBe(false);
			session.publishSystemNotification('job finished');
			dial.resolve();
			await r.activated;

			expect(stubTexts(stub).filter((t) => t.includes('Say hello.'))).toHaveLength(1);
			// The abandoned greeting's pending response does not hold back the
			// activation's notification delivery.
			expect(stubTexts(stub).filter((t) => t.includes('job finished'))).toHaveLength(1);
			session.feedAudioFromClient(micFrame(3000));
			expect(stub.sendAudio).toHaveBeenCalledTimes(1);
		},
	);

	it('a watchdog fire held behind the greeting starts no automatic reconnect beside the recovery', async () => {
		vi.useFakeTimers();
		try {
			const stub = createRecoveryTransport();
			const sender = { sendAudio: vi.fn(), sendJson: vi.fn() };
			session = createRecoverySession(stub, {
				agent: createAgent({ greeting: 'Say hello.' }),
				greetingInterruptible: false,
				responseWatchdogMs: 1000,
				clientSender: sender,
			});
			await session.start();
			stub.transport.onResumptionUpdate?.('handle-1', true);
			session.notifyClientConnected(); // greeting sent, suppression armed
			stub.transport.onModelTurnStart?.(); // the greeting's turn
			recoveryInternals(session).reconnector.armResponseWatchdog();
			vi.advanceTimersByTime(1100);
			expect(recoveryInternals(session).reconnector.isRecoveryHeld()).toBe(true);

			// The boundary finalizes the greeting's turn, releasing the greeting gate.
			const dial = stub.holdNextDial();
			const r = session.recoverUpstream(recoverArgs());
			await vi.advanceTimersByTimeAsync(10_000); // past every reconnect backoff
			expect(stub.transport.reconnect).not.toHaveBeenCalled();
			dial.resolve();
			await r.activated;

			// Nothing is left buffering: assistant audio reaches the client.
			stub.transport.onAudioOutput?.(Buffer.alloc(960, 3).toString('base64'));
			expect(sender.sendAudio).toHaveBeenCalledTimes(1);
			expect(session.sessionManager.state).toBe('ACTIVE');
		} finally {
			vi.useRealTimers();
		}
	});

	it('after a mid-turn recovery with the STT commit latch set, the replacement turn commits fresh input exactly once', async () => {
		const stub = createRecoveryTransport();
		const stt = stubStt();
		session = createRecoverySession(stub, { sttProvider: stt });
		await session.start();
		stub.transport.onModelTurnStart?.(); // commits turn 0 and sets the latch
		expect(stt.commit).toHaveBeenCalledTimes(1);

		const r = session.recoverUpstream(recoverArgs());
		expect(stt.commit).toHaveBeenCalledTimes(1); // the latch already fired for turn 0
		await r.activated;

		stub.transport.onModelTurnStart?.(); // the replacement connection's first turn
		stub.transport.onTurnComplete?.();
		expect(vi.mocked(stt.commit).mock.calls).toEqual([[0], [1]]);
	});

	describe('with the batch STT provider', () => {
		function batchStt(transcript: string) {
			const stt = new GeminiBatchSTTProvider({ apiKey: 'test-key', model: 'stt-model' });
			const generateContent = vi.fn(async () => ({
				candidates: [{ content: { parts: [{ text: transcript }] } }],
			}));
			(
				stt as unknown as { ai: { models: { generateContent: unknown } } }
			).ai.models.generateContent = generateContent;
			return { stt, generateContent };
		}

		it('audio buffered after a fired commit is neither transcribed into the replacement turn nor releases the hold', async () => {
			const stub = createRecoveryTransport();
			const { stt, generateContent } = batchStt('said before the recovery');
			session = createRecoverySession(stub, { sttProvider: stt });
			await session.start();
			stub.transport.onModelTurnStart?.(); // commit fired for turn 0 (nothing buffered yet)
			for (let i = 0; i < 20; i++) session.feedAudioFromClient(micFrame(4000));

			const r = session.recoverUpstream(recoverArgs({ holdSyntheticUntilFreshSpeech: true }));
			await r.activated;
			stub.transport.onModelTurnStart?.(); // the replacement turn commits
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(generateContent).not.toHaveBeenCalled();
			expect(session.isSyntheticHoldActive()).toBe(true);
		});

		it('the boundary discards that audio itself, for a provider whose stop() keeps its buffer', async () => {
			const stub = createRecoveryTransport();
			const { stt, generateContent } = batchStt('said before the recovery');
			// The RECONNECTING transition stops the provider; this one keeps its audio.
			vi.spyOn(stt, 'stop').mockResolvedValue(undefined);
			session = createRecoverySession(stub, { sttProvider: stt });
			await session.start();
			stub.transport.onModelTurnStart?.(); // commit fired for turn 0 (nothing buffered yet)
			for (let i = 0; i < 20; i++) session.feedAudioFromClient(micFrame(4000));

			const r = session.recoverUpstream(recoverArgs({ holdSyntheticUntilFreshSpeech: true }));
			await r.activated;
			stub.transport.onModelTurnStart?.(); // the replacement turn commits
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(stt.stop).toHaveBeenCalled();
			expect(generateContent).not.toHaveBeenCalled();
			expect(session.isSyntheticHoldActive()).toBe(true);
		});

		it('a capture committed by the boundary finalization resolves as stale', async () => {
			const stub = createRecoveryTransport();
			const { stt, generateContent } = batchStt('said before the recovery');
			const lines: string[] = [];
			session = createRecoverySession(stub, { sttProvider: stt, log: (l) => lines.push(l) });
			await session.start();
			for (let i = 0; i < 20; i++) session.feedAudioFromClient(micFrame(4000));
			// Model output opens the turn without a model start: the commit latch is clear.
			stub.transport.onAudioOutput?.(Buffer.alloc(960).toString('base64'));

			const r = session.recoverUpstream(recoverArgs({ holdSyntheticUntilFreshSpeech: true }));
			expect(generateContent).toHaveBeenCalledTimes(1); // the finalization committed turn 0
			await r.activated;
			await vi.waitFor(() =>
				expect(lines.some((l) => l.includes('Dropped transcript for turn 0'))).toBe(true),
			);
			expect(session.isSyntheticHoldActive()).toBe(true);
		});
	});

	it('delivers notifications from a recovery without a fresh-speech hold once at activation; with one, after the next turn; early evidence releases nothing', async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub);
		await session.start();
		const delivered = (text: string) => stubTexts(stub).filter((t) => t.includes(text)).length;

		// No fresh-speech hold: held during the dial, delivered at activation.
		let dial = stub.holdNextDial();
		let r = session.recoverUpstream(recoverArgs());
		session.publishSystemNotification('job one finished');
		expect(delivered('job one finished')).toBe(0);
		dial.resolve();
		await r.activated;
		expect(delivered('job one finished')).toBe(1); // no turnComplete needed
		stub.transport.onModelTurnStart?.();
		stub.transport.onTurnComplete?.();
		expect(delivered('job one finished')).toBe(1);

		// Fresh evidence during the dial releases the fresh-speech hold but not
		// the notifications: they wait for the activation.
		dial = stub.holdNextDial();
		r = session.recoverUpstream(recoverArgs({ holdSyntheticUntilFreshSpeech: true }));
		session.publishSystemNotification('job two finished');
		stub.transport.onInputTranscription?.('hello');
		expect(session.isSyntheticHoldActive()).toBe(false);
		expect(delivered('job two finished')).toBe(0);
		dial.resolve();
		await r.activated;
		expect(delivered('job two finished')).toBe(1);

		// A fresh-speech hold that outlives the dial: the notification waits for
		// the turn completing after the release.
		dial = stub.holdNextDial();
		r = session.recoverUpstream(recoverArgs({ holdSyntheticUntilFreshSpeech: true }));
		session.publishSystemNotification('job three finished');
		dial.resolve();
		await r.activated;
		stub.transport.onModelTurnStart?.();
		stub.transport.onTurnComplete?.();
		expect(delivered('job three finished')).toBe(0);
		stub.transport.onInputTranscription?.('hello');
		expect(delivered('job three finished')).toBe(0);
		stub.transport.onModelTurnStart?.();
		stub.transport.onTurnComplete?.();
		expect(delivered('job three finished')).toBe(1);
	});

	it("parkUpstream('idle') while detached disconnects, dials nothing until recoverUpstream, and publishes host-parked", async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub);
		await session.start();
		stub.transport.onResumptionUpdate?.('handle-1', true);
		const lost: unknown[] = [];
		session.eventBus.subscribe('session.upstreamLost', (p) => lost.push(p));

		await session.parkUpstream('idle');

		expect(session.sessionManager.state).toBe('UPSTREAM_LOST');
		expect(stub.disconnect).toHaveBeenCalledTimes(1);
		expect(lost).toEqual([{ sessionId: 'sess_recover', reason: 'host-parked', detail: 'idle' }]);
		// The socket's own close and a GoAway find a parked session: no dial.
		stub.transport.onClose?.(1000, 'closed by host');
		stub.transport.onGoAway?.('10s');
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(stub.connect).toHaveBeenCalledTimes(1);
		expect(stub.transport.reconnect).not.toHaveBeenCalled();
		expect(session.sessionManager.state).toBe('UPSTREAM_LOST');
		// A notification while parked is held, not sent into the dead connection.
		session.publishSystemNotification('job finished');
		expect(stubTexts(stub).some((t) => t.includes('job finished'))).toBe(false);

		const r = session.recoverUpstream(recoverArgs({ reason: 'human-retry' }));
		await r.activated;
		expect(stub.connect).toHaveBeenCalledTimes(2);
		expect(session.sessionManager.state).toBe('ACTIVE');
		expect(stubTexts(stub).filter((t) => t.includes('job finished'))).toHaveLength(1);
	});

	it('taking over an automatic reconnect on the owned socket discards the buffered microphone frames', async () => {
		const stub = createRecoveryTransport();
		const port = 9953;
		session = createRecoverySession(stub, { port });
		await session.start();
		const ws = new WebSocket(`ws://localhost:${port}`);
		await new Promise<void>((resolve, reject) => {
			ws.once('message', () => resolve()); // session.config: input is admitted
			ws.once('error', reject);
		});
		const b64 = (f: Buffer) => f.toString('base64');
		const sentAudio = () => stub.sendAudio.mock.calls.map((c) => c[0] as string);
		try {
			stub.transport.onResumptionUpdate?.('handle-1', true);
			stub.transport.onClose?.(1006, 'socket lost'); // automatic reconnect: buffering, backoff
			expect(session.sessionManager.state).toBe('RECONNECTING');
			const before = micFrame(1111);
			ws.send(before);
			const buffered = (
				recoveryInternals(session).clientTransport as { audioBuffer: { size: number } }
			).audioBuffer;
			await vi.waitFor(() => expect(buffered.size).toBeGreaterThan(0));

			const r = session.recoverUpstream(recoverArgs());
			await r.activated;
			const after = micFrame(2222);
			ws.send(after);
			await vi.waitFor(() => expect(sentAudio()).toContain(b64(after)));

			expect(sentAudio()).not.toContain(b64(before));
			expect(stub.transport.reconnect).not.toHaveBeenCalled();
		} finally {
			ws.close();
		}
	});

	it('taking over an automatic reconnect on a hosted channel never delivers the buffered assistant audio', async () => {
		const stub = createRecoveryTransport();
		const sender = { sendAudio: vi.fn(), sendJson: vi.fn() };
		session = createRecoverySession(stub, { clientSender: sender });
		await session.start();
		session.notifyClientConnected();
		stub.transport.onResumptionUpdate?.('handle-1', true);
		stub.transport.onClose?.(1006, 'socket lost'); // automatic reconnect: buffering, backoff
		const before = Buffer.alloc(960, 1);
		stub.transport.onAudioOutput?.(before.toString('base64'));
		expect(sender.sendAudio).not.toHaveBeenCalled(); // buffered for the reconnect

		const r = session.recoverUpstream(recoverArgs());
		await r.activated;
		const after = Buffer.alloc(960, 2);
		stub.transport.onAudioOutput?.(after.toString('base64'));

		expect(sender.sendAudio.mock.calls.map((c) => c[0] as Buffer)).toEqual([after]);
		expect(stub.transport.reconnect).not.toHaveBeenCalled();
	});

	it('an active turn at the boundary emits turn.interrupted then turn.end once, with no directive send', async () => {
		const stub = createRecoveryTransport();
		const sender = { sendAudio: vi.fn(), sendJson: vi.fn() };
		session = createRecoverySession(stub, { clientSender: sender });
		await session.start();
		recoveryInternals(session).directiveManager.set('pacing', 'Speak slowly.', 'session');
		const events: string[] = [];
		session.eventBus.subscribe('turn.interrupted', (p) => events.push(`interrupted:${p.turnId}`));
		session.eventBus.subscribe('turn.end', (p) => events.push(`end:${p.turnId}`));
		stub.transport.onModelTurnStart?.(); // turn_1 is active

		const r = session.recoverUpstream(recoverArgs());
		expect(events).toEqual(['interrupted:turn_1', 'end:turn_1']);
		await r.activated;

		expect(events).toEqual(['interrupted:turn_1', 'end:turn_1']);
		expect(stubTexts(stub).some((t) => t.includes('Speak slowly.'))).toBe(false);
		const frames = sender.sendJson.mock.calls.map((c) => (c[0] as { type: string }).type);
		expect(frames.filter((t) => t === 'turn.interrupted')).toHaveLength(1);
		expect(frames.filter((t) => t === 'turn.end')).toHaveLength(1);
	});

	it('the fresh-speech hold gates the greeting, directives, notifications and reattach context', async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub, { agent: createAgent({ greeting: 'Say hello.' }) });
		await session.start();
		session.conversationContext.addUserMessage('what is the weather');
		const r = session.recoverUpstream(recoverArgs({ holdSyntheticUntilFreshSpeech: true }));
		await r.activated;
		expect(session.isSyntheticHoldActive()).toBe(true);

		session.notifyClientConnected(); // would greet
		recoveryInternals(session).directiveManager.set('pacing', 'Speak slowly.', 'session');
		stub.transport.onModelTurnStart?.();
		stub.transport.onTurnComplete?.(); // would reinforce directives and flush notifications
		session.publishSystemNotification('job finished');
		stub.transport.onModelTurnStart?.();
		stub.transport.onTurnComplete?.();
		recoveryInternals(session).injectRecentContext('client-reconnect-context');

		const texts = stubTexts(stub);
		expect(texts.some((t) => t.includes('Say hello.'))).toBe(false);
		expect(texts.some((t) => t.includes('Speak slowly.'))).toBe(false);
		expect(texts.some((t) => t.includes('job finished'))).toBe(false);
		expect(texts.some((t) => t.includes('reconnected'))).toBe(false);
		expect(session.isSyntheticHoldActive()).toBe(true);
	});

	it.each([
		{
			source: 'input transcription',
			fire: (_s: VoiceSession, stub: RecoveryStub) => stub.transport.onInputTranscription?.('hi'),
		},
		{
			source: 'an external STT final',
			fire: (_s: VoiceSession, _stub: RecoveryStub, stt: STTProvider) =>
				stt.onTranscript?.('hi', undefined),
		},
		{
			source: 'a provider interruption',
			fire: (_s: VoiceSession, stub: RecoveryStub) => {
				stub.transport.onModelTurnStart?.();
				stub.transport.onInterrupted?.();
			},
		},
		{
			source: 'typed text',
			fire: (s: VoiceSession) => void recoveryInternals(s).handleTextInput('typed hello'),
		},
	])('after a recovery, the fresh-speech hold is released by $source', async ({ fire }) => {
		const stub = createRecoveryTransport();
		const stt = stubStt();
		session = createRecoverySession(stub, { sttProvider: stt });
		await session.start();
		const r = session.recoverUpstream(recoverArgs({ holdSyntheticUntilFreshSpeech: true }));
		await r.activated;
		expect(session.isSyntheticHoldActive()).toBe(true);

		fire(session, stub, stt);
		expect(session.isSyntheticHoldActive()).toBe(false);
	});

	it('after a recovery, client-VAD microphone PCM does not release the fresh-speech hold', async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub);
		await session.start();
		const r = session.recoverUpstream(recoverArgs({ holdSyntheticUntilFreshSpeech: true }));
		await r.activated;

		for (let i = 0; i < 20; i++) session.feedAudioFromClient(micFrame(4000));
		expect(stub.sendAudio).toHaveBeenCalled();
		expect(session.isSyntheticHoldActive()).toBe(true);
	});

	it('runs the boundary against the still-open incumbent: the turn ends and the fence is marked before the abort', async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub);
		await session.start();
		stub.openGeneration('gen_1');
		stub.transport.onModelTurnStart?.();
		const order: string[] = [];
		for (const event of [
			'turn.interrupted',
			'turn.end',
			'generation.end',
			'session.reset',
			'session.reconnectBoundary',
		] as const) {
			session.eventBus.subscribe(event, () => order.push(event));
		}
		session.eventBus.subscribe('session.stateChange', (p) => order.push(`state:${p.toState}`));
		const fence = recoveryInternals(session).fence;
		const markBoundary = fence.markBoundary.bind(fence);
		fence.markBoundary = () => {
			order.push('fence.markBoundary');
			markBoundary();
		};
		const abort = stub.abortIncumbent.getMockImplementation();
		stub.abortIncumbent.mockImplementation(() => {
			order.push('abortIncumbent');
			return abort?.();
		});

		const r = session.recoverUpstream(recoverArgs());

		expect(order).toEqual([
			'turn.interrupted',
			'turn.end',
			'fence.markBoundary',
			'abortIncumbent',
			'generation.end',
			'state:RECONNECTING',
			'session.reset',
			'session.reconnectBoundary',
		]);
		await r.activated;
	});

	it('refuses before start(): recoverUpstream throws and parkUpstream rejects with SessionError', async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub);
		expect(session.sessionManager.state).toBe('CREATED');

		expect(() => session?.recoverUpstream(recoverArgs())).toThrow(SessionError);
		expect(() => session?.recoverUpstream(recoverArgs())).toThrow('it is CREATED');
		await expect(session.parkUpstream('idle')).rejects.toThrow(SessionError);
		expect(stub.abortIncumbent).not.toHaveBeenCalled();
		expect(stub.connect).not.toHaveBeenCalled();
		expect(session.sessionManager.state).toBe('CREATED');
	});

	it('flushes a buffered input transcript at the boundary, before the abort', async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub);
		await session.start();
		stub.transport.onInputTranscription?.('what time is it'); // buffered, no turn open
		const userTexts = () =>
			(session?.conversationContext.items ?? [])
				.filter((item) => item.role === 'user')
				.map((item) => item.content);
		expect(userTexts()).not.toContain('what time is it');

		const r = session.recoverUpstream(recoverArgs());
		expect(userTexts()).toContain('what time is it');
		await r.activated;
	});

	it('drops the retained user utterance, so no watchdog replay reaches the replacement', async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub, { watchdogReplayRecovery: true });
		await session.start();
		const retainer = recoveryInternals(session).utteranceRetainer;
		if (!retainer) throw new Error('watchdogReplayRecovery builds the retainer');
		retainer.markSpeechStart();
		retainer.feed(micFrame(3000));
		expect(retainer.seal()).toBe(true);
		expect(retainer.peek(60_000)).not.toBeNull();

		const r = session.recoverUpstream(recoverArgs());
		expect(retainer.peek(60_000)).toBeNull();
		await r.activated;
	});

	it('taking over an automatic reconnect resets its spent budget once the replacement activates', async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub);
		await session.start();
		const reconnector = recoveryInternals(session).reconnector as unknown as {
			reconnectAttempts: number;
		};
		const budget = () => reconnector.reconnectAttempts;
		stub.transport.onResumptionUpdate?.('handle-1', true);
		stub.transport.onClose?.(1006, 'socket lost'); // automatic attempt 1 of the budget
		expect(budget()).toBe(1);

		const dial = stub.holdNextDial();
		const r = session.recoverUpstream(recoverArgs());
		expect(budget()).toBe(1); // handed over, reset only on activation
		dial.resolve();
		await r.activated;
		expect(budget()).toBe(0);
	});

	it('close() with a slow pre-close finalizer: a dial completing mid-close never activates the session', async () => {
		const stub = createRecoveryTransport();
		session = createRecoverySession(stub);
		await session.start();
		let releaseFinalizer!: () => void;
		const finalizerGate = new Promise<void>((resolve) => {
			releaseFinalizer = resolve;
		});
		session.sessionManager.registerPreCloseFinalizer(() => finalizerGate);
		const dial = stub.holdNextDial();
		const r = session.recoverUpstream(recoverArgs());
		const states: string[] = [];
		session.eventBus.subscribe('session.stateChange', (p) => states.push(p.toState));

		const closing = session.close();
		dial.resolve(); // setup completes while close() awaits the finalizer
		await expect(r.activated).rejects.toThrow(SessionError);
		expect(states).not.toContain('ACTIVE');
		expect(session.sessionManager.state).not.toBe('ACTIVE');

		releaseFinalizer();
		await closing;
		expect(session.sessionManager.state).toBe('CLOSED');
	});

	it.each([
		{
			step: 'the external STT discard at the boundary, before the abort',
			arrange: (_stub: RecoveryStub, stt: STTProvider) =>
				vi.mocked(stt.handleTurnComplete).mockImplementationOnce(() => {
					throw new Error('stt boom');
				}),
			message: 'stt boom',
		},
		{
			step: 'the transport handle clear, after the abort',
			arrange: (stub: RecoveryStub) =>
				stub.clearResumption.mockImplementationOnce(() => {
					throw new Error('clear boom');
				}),
			message: 'clear boom',
		},
	])(
		'a throw in $step fails the recovery like a failed dial: parked, activated rejects, the next recovery dials',
		async ({ arrange, message }) => {
			const stub = createRecoveryTransport();
			const stt = stubStt();
			const onError = vi.fn();
			session = createRecoverySession(stub, { sttProvider: stt, hooks: { onError } });
			await session.start();
			const lost: unknown[] = [];
			session.eventBus.subscribe('session.upstreamLost', (p) => lost.push(p));
			arrange(stub, stt);

			const r = session.recoverUpstream(recoverArgs());

			await expect(r.activated).rejects.toThrow(message);
			await expect(r.incumbentClosed).resolves.toBe('closed');
			expect(stub.abortIncumbent).toHaveBeenCalledTimes(1);
			expect(session.sessionManager.state).toBe('UPSTREAM_LOST');
			expect(lost).toEqual([
				{ sessionId: 'sess_recover', reason: 'recover-upstream-failed', detail: message },
			]);
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ component: 'recover-upstream' }),
			);
			expect(stub.connect).toHaveBeenCalledTimes(1); // start() only

			const again = session.recoverUpstream(recoverArgs({ reason: 'human-retry' }));
			expect(again).not.toBe(r);
			await again.activated;
			expect(stub.connect).toHaveBeenCalledTimes(2);
			expect(session.sessionManager.state).toBe('ACTIVE');
		},
	);

	it('a throwing send during activation is reported; activated still resolves and the next recovery dials', async () => {
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		try {
			const stub = createRecoveryTransport();
			const onError = vi.fn();
			session = createRecoverySession(stub, { hooks: { onError } });
			await session.start();
			session.conversationContext.addUserMessage('what is the weather');
			const dial = stub.holdNextDial();
			const r = session.recoverUpstream(recoverArgs({ skipContextInjection: false }));
			session.publishSystemNotification('job finished'); // held for the activation drain
			stub.sendContent.mockImplementation(() => {
				throw new Error('send boom');
			});
			dial.resolve();

			await expect(r.activated).resolves.toBeUndefined();
			expect(session.sessionManager.state).toBe('ACTIVE');
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ component: 'recover-upstream' }),
			);
			// Both the drain and the injection were attempted.
			const attempted = stub.sendContent.mock.calls.flatMap((c) =>
				(c[0] as Array<{ text: string }>).map((t) => t.text),
			);
			expect(attempted.some((t) => t.includes('job finished'))).toBe(true);
			expect(attempted.some((t) => t.includes('You just reconnected.'))).toBe(true);

			stub.sendContent.mockReset();
			const again = session.recoverUpstream(recoverArgs());
			expect(again).not.toBe(r);
			await again.activated;
			expect(stub.connect).toHaveBeenCalledTimes(3);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});

	it.each([
		{ at: 'turn.end', during: 'the boundary' },
		{ at: 'generation.end', during: 'the incumbent abort' },
	] as const)(
		'a park from a $at subscriber during $during supersedes the recovery: no RECONNECTING, no dial',
		async ({ at }) => {
			const stub = createRecoveryTransport();
			session = createRecoverySession(stub);
			await session.start();
			stub.openGeneration('gen_1');
			stub.transport.onModelTurnStart?.();
			const s = session;
			const states: string[] = [];
			const boundaries: unknown[] = [];
			session.eventBus.subscribe('session.stateChange', (p) => states.push(p.toState));
			session.eventBus.subscribe('session.reconnectBoundary', (p) => boundaries.push(p));
			let parking: Promise<void> | undefined;
			const unsubscribe = session.eventBus.subscribe(at, () => {
				unsubscribe();
				parking = s.parkUpstream('idle');
			});

			const r = session.recoverUpstream(recoverArgs());

			await expect(r.activated).rejects.toThrow('superseded by a park');
			await expect(r.incumbentClosed).resolves.toBe('closed');
			await parking;
			expect(states).toEqual(['UPSTREAM_LOST']);
			expect(boundaries).toEqual([]);
			expect(stub.connect).toHaveBeenCalledTimes(1); // start() only
			expect(session.sessionManager.state).toBe('UPSTREAM_LOST');

			const again = session.recoverUpstream(recoverArgs({ reason: 'human-retry' }));
			await again.activated;
			expect(session.sessionManager.state).toBe('ACTIVE');
			expect(stub.connect).toHaveBeenCalledTimes(2);
		},
	);

	it.each(['session.reset', 'session.reconnectBoundary'] as const)(
		'a close() from a %s subscriber stops the recovery before it dials',
		async (event) => {
			const stub = createRecoveryTransport();
			session = createRecoverySession(stub);
			await session.start();
			const s = session;
			let closing: Promise<void> | undefined;
			const unsubscribe = session.eventBus.subscribe(event, () => {
				unsubscribe();
				closing = s.close();
			});

			const r = session.recoverUpstream(recoverArgs());

			expect(stub.connect).toHaveBeenCalledTimes(1); // start() only
			await expect(r.activated).rejects.toThrow('the session closed');
			await expect(r.incumbentClosed).resolves.toBe('closed');
			await closing;
			expect(stub.connect).toHaveBeenCalledTimes(1);
			expect(session.sessionManager.state).toBe('CLOSED');
			expect(() => session?.recoverUpstream(recoverArgs())).toThrow(SessionError);
		},
	);

	it.each([
		{
			during: 'from a subscriber of the ACTIVE transition',
			// The held notification is never drained into the parked transport.
			heldSends: 0,
			arrange: (s: VoiceSession, _stub: RecoveryStub, park: () => void) => {
				const unsubscribe = s.eventBus.subscribe('session.stateChange', (p) => {
					if (p.toState !== 'ACTIVE') return;
					unsubscribe();
					park();
				});
			},
		},
		{
			during: 'from the send of the activation notification drain',
			// The drained notification's own send is what parks.
			heldSends: 1,
			arrange: (_s: VoiceSession, stub: RecoveryStub, park: () => void) => {
				stub.sendContent.mockImplementation((turns: Array<{ text: string }>) => {
					if (turns.some((t) => t.text.includes('job finished'))) park();
				});
			},
		},
	])(
		'a park during activation $during stops it: activated rejects, nothing is injected, the session stays parked',
		async ({ heldSends, arrange }) => {
			const stub = createRecoveryTransport();
			session = createRecoverySession(stub);
			await session.start();
			session.conversationContext.addUserMessage('what is the weather');
			const s = session;
			const sends = (text: string) => stubTexts(stub).filter((t) => t.includes(text)).length;
			const dial = stub.holdNextDial();
			const r = session.recoverUpstream(recoverArgs({ skipContextInjection: false }));
			session.publishSystemNotification('job finished'); // held for the activation drain
			let parking: Promise<void> | undefined;
			arrange(s, stub, () => {
				parking ??= s.parkUpstream('idle');
			});
			dial.resolve();

			await expect(r.activated).rejects.toThrow('superseded by a park');
			await parking;
			expect(session.sessionManager.state).toBe('UPSTREAM_LOST');
			expect(sends('You just reconnected.')).toBe(0);
			expect(sends('job finished')).toBe(heldSends);
			// Still parked: the dial window holds notifications and nothing redials.
			session.publishSystemNotification('job two finished');
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(sends('job two finished')).toBe(0);
			expect(stub.connect).toHaveBeenCalledTimes(2); // start() and the stopped recovery
			expect(session.sessionManager.state).toBe('UPSTREAM_LOST');

			const again = session.recoverUpstream(recoverArgs({ reason: 'human-retry' }));
			await again.activated;
			expect(session.sessionManager.state).toBe('ACTIVE');
			// The next activation delivers one held notification.
			expect(sends('finished')).toBe(heldSends + 1);
		},
	);

	it.each([
		{
			step: 'the client buffer discard',
			arrange: (s: VoiceSession) => {
				const channel = recoveryInternals(s).clientTransport as { discardBuffered(): void };
				vi.spyOn(channel, 'discardBuffered').mockImplementationOnce(() => {
					throw new Error('discard boom');
				});
			},
			message: 'discard boom',
		},
		{
			step: 'the ACTIVE transition',
			arrange: (s: VoiceSession) => {
				const manager = s.sessionManager;
				const transitionTo = manager.transitionTo.bind(manager);
				let thrown = false;
				vi.spyOn(manager, 'transitionTo').mockImplementation((state) => {
					if (state === 'ACTIVE' && !thrown) {
						thrown = true;
						throw new Error('transition boom');
					}
					transitionTo(state);
				});
			},
			message: 'transition boom',
		},
	])(
		'a throw in $step after a successful dial disconnects the replacement connection and parks',
		async ({ arrange, message }) => {
			const stub = createRecoveryTransport();
			const onError = vi.fn();
			session = createRecoverySession(stub, { hooks: { onError } });
			await session.start();
			const lost: unknown[] = [];
			session.eventBus.subscribe('session.upstreamLost', (p) => lost.push(p));
			// Take over an automatic reconnect, so the recovery owns its client buffering.
			stub.transport.onResumptionUpdate?.('handle-1', true);
			stub.transport.onClose?.(1006, 'socket lost');
			arrange(session);

			const r = session.recoverUpstream(recoverArgs());

			await expect(r.activated).rejects.toThrow(message);
			expect(stub.connect).toHaveBeenCalledTimes(2); // the replacement did dial
			expect(stub.disconnect).toHaveBeenCalledTimes(1);
			expect(stub.transport.isConnected).toBe(false);
			expect(session.sessionManager.state).toBe('UPSTREAM_LOST');
			expect(lost).toEqual([
				{ sessionId: 'sess_recover', reason: 'recover-upstream-failed', detail: message },
			]);
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ component: 'recover-upstream' }),
			);

			const again = session.recoverUpstream(recoverArgs({ reason: 'human-retry' }));
			await again.activated;
			expect(session.sessionManager.state).toBe('ACTIVE');
			expect(stub.transport.isConnected).toBe(true);
		},
	);

	it('disarms a response watchdog the incumbent armed, so it cannot fire after activation', async () => {
		vi.useFakeTimers();
		try {
			const stub = createRecoveryTransport();
			const lines: string[] = [];
			session = createRecoverySession(stub, {
				responseWatchdogMs: 1000,
				log: (l) => lines.push(l),
			});
			await session.start();
			const lost: unknown[] = [];
			session.eventBus.subscribe('session.upstreamLost', (p) => lost.push(p));
			// The user's turn ended on the incumbent: its response window is open.
			recoveryInternals(session).reconnector.armResponseWatchdog();

			const r = session.recoverUpstream(recoverArgs());
			await r.activated;
			await vi.advanceTimersByTimeAsync(5000);

			expect(lines.filter((l) => l.includes('[Watchdog]'))).toEqual([]);
			expect(lost).toEqual([]);
			expect(session.sessionManager.state).toBe('ACTIVE');
		} finally {
			vi.useRealTimers();
		}
	});

	it('a caller that never observes activated leaks no unhandled rejection when the dial fails', async () => {
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		try {
			const stub = createRecoveryTransport();
			session = createRecoverySession(stub);
			await session.start();
			stub.failNextDial(new Error('dial refused'));

			session.recoverUpstream(recoverArgs()); // `activated` is dropped unobserved

			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(session.sessionManager.state).toBe('UPSTREAM_LOST');
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});
});
