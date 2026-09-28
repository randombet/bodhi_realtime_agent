import type { LanguageModelV1 } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
	DialGenerationFence,
	SyntheticOutputHold,
	type SyntheticOutputHoldDeps,
} from '../../src/core/host-recovery.js';
import { VoiceSession, type VoiceSessionConfig } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	STTProvider,
	TransportCapabilities,
	TransportToolResult,
} from '../../src/types/transport.js';

/**
 * Host upstream recovery building blocks: the synthetic-output hold and the
 * dial-generation fence, on their own and wired into a legacy-mode session.
 * No recovery exists to mark a boundary yet, so the fence cases mark it
 * directly and then advance the stub transport's dial generation the way a
 * recovery's incumbent abort and redial would.
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
