import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RECONNECT_DEADLINE_MS } from '../../src/core/constants.js';
import type {
	ReconnectSessionManager,
	TransportReconnectorDeps,
} from '../../src/core/transport-reconnector.js';
import { TransportReconnector } from '../../src/core/transport-reconnector.js';
import { GeminiLiveTransport } from '../../src/transport/gemini-live-transport.js';
import type { IClientChannel } from '../../src/types/session-client.js';
import type { LLMTransport, ReplayItem } from '../../src/types/transport.js';

type SessionState = ReconnectSessionManager['state'];

/** A mutable in-memory session-manager stub (the real one enforces transition
 *  validity, which is out of scope for the reconnector's own contract). */
function fakeSessionManager(initial: SessionState = 'ACTIVE', handle: string | null = 'handle-1') {
	let state: SessionState = initial;
	let resumptionHandle = handle;
	return {
		get state() {
			return state;
		},
		get resumptionHandle() {
			return resumptionHandle;
		},
		transitionTo: vi.fn((s: SessionState) => {
			state = s;
		}),
		closeWithReason: vi.fn(async (_reason: string) => {
			state = 'CLOSED';
		}),
		updateResumptionHandle: vi.fn((h: string) => {
			resumptionHandle = h;
		}),
		clearResumptionHandle: vi.fn(() => {
			resumptionHandle = null;
		}),
		/** Test helper: force state without transition validation. */
		_setState(s: SessionState) {
			state = s;
		},
	};
}

function fakeClientTransport(
	buffered: Buffer[] = [],
	opts: { discardBuffered?: boolean } = {},
): IClientChannel & {
	startBuffering: ReturnType<typeof vi.fn>;
	stopBuffering: ReturnType<typeof vi.fn>;
	discardBuffered?: ReturnType<typeof vi.fn>;
} {
	return {
		sendAudioToClient: vi.fn(),
		sendJsonToClient: vi.fn(),
		startBuffering: vi.fn(),
		stopBuffering: vi.fn(() => buffered),
		...(opts.discardBuffered ? { discardBuffered: vi.fn() } : {}),
	} as unknown as IClientChannel & {
		startBuffering: ReturnType<typeof vi.fn>;
		stopBuffering: ReturnType<typeof vi.fn>;
		discardBuffered?: ReturnType<typeof vi.fn>;
	};
}

function fakeTransport(overrides: Partial<LLMTransport> = {}): LLMTransport {
	return {
		reconnect: vi.fn().mockResolvedValue(undefined),
		sendAudio: vi.fn(),
		elicitResponse: vi.fn(),
		triggerGeneration: vi.fn(),
		...overrides,
	} as unknown as LLMTransport;
}

interface Harness {
	reconnector: TransportReconnector;
	sm: ReturnType<typeof fakeSessionManager>;
	clientTransport: ReturnType<typeof fakeClientTransport>;
	transport: LLMTransport;
	eventBus: { publish: ReturnType<typeof vi.fn> };
	log: ReturnType<typeof vi.fn>;
	reportError: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: {
	watchdogMs?: number;
	agentMode?: boolean;
	initial?: SessionState;
	handle?: string | null;
	transport?: LLMTransport;
	clientTransport?: ReturnType<typeof fakeClientTransport>;
	replay?: ReplayItem[];
	peekRetainedUtterance?: TransportReconnectorDeps['peekRetainedUtterance'];
	detectSpeech?: TransportReconnectorDeps['detectSpeech'];
	isSpeechActive?: TransportReconnectorDeps['isSpeechActive'];
	hostedReconnectSpeech?: TransportReconnectorDeps['hostedReconnectSpeech'];
	onReplayDispatched?: TransportReconnectorDeps['onReplayDispatched'];
	isGreetingSuppressionArmed?: TransportReconnectorDeps['isGreetingSuppressionArmed'];
	isSyntheticHeld?: TransportReconnectorDeps['isSyntheticHeld'];
	upstreamLossPolicy?: TransportReconnectorDeps['upstreamLossPolicy'];
	hostOwnsRecovery?: TransportReconnectorDeps['hostOwnsRecovery'];
	reconnectDeadlineMs?: number;
}): Harness {
	const sm = fakeSessionManager(
		opts.initial ?? 'ACTIVE',
		opts.handle === undefined ? 'handle-1' : opts.handle,
	);
	const clientTransport = opts.clientTransport ?? fakeClientTransport();
	const transport = opts.transport ?? fakeTransport();
	const eventBus = { publish: vi.fn() };
	const log = vi.fn();
	const reportError = vi.fn();
	const deps: TransportReconnectorDeps = {
		sessionManager: sm,
		clientTransport,
		transport,
		toReplayContent: () => opts.replay ?? [],
		eventBus: eventBus as unknown as TransportReconnectorDeps['eventBus'],
		getSessionId: () => 'sess_1',
		isAgentMode: () => opts.agentMode ?? true,
		reportError,
		log,
		peekRetainedUtterance: opts.peekRetainedUtterance,
		detectSpeech: opts.detectSpeech,
		isSpeechActive: opts.isSpeechActive,
		hostedReconnectSpeech: opts.hostedReconnectSpeech,
		onReplayDispatched: opts.onReplayDispatched,
		isGreetingSuppressionArmed: opts.isGreetingSuppressionArmed,
		isSyntheticHeld: opts.isSyntheticHeld,
		upstreamLossPolicy: opts.upstreamLossPolicy ?? 'close',
		hostOwnsRecovery: opts.hostOwnsRecovery,
	};
	const reconnector = new TransportReconnector(
		deps,
		opts.watchdogMs ?? 8000,
		opts.reconnectDeadlineMs === undefined
			? undefined
			: { reconnectDeadlineMs: opts.reconnectDeadlineMs },
	);
	return { reconnector, sm, clientTransport, transport, eventBus, log, reportError };
}

describe('TransportReconnector', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	describe('triggerReconnect (budgeted, backed-off)', () => {
		it('reconnects with the resumption handle, replays buffered audio, and goes ACTIVE', async () => {
			const buffered = [Buffer.from('one'), Buffer.from('two')];
			const ct = fakeClientTransport(buffered);
			const replay: ReplayItem[] = [{ role: 'user', parts: [] } as unknown as ReplayItem];
			const h = makeHarness({ clientTransport: ct, replay });

			h.reconnector.triggerReconnect('transport-close');
			expect(h.sm.transitionTo).toHaveBeenCalledWith('RECONNECTING');
			expect(ct.startBuffering).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(1000); // RECONNECT_BACKOFF_MS[0]
			await vi.runAllTimersAsync();

			expect(h.transport.reconnect).toHaveBeenCalledWith({
				resumptionHandle: 'handle-1',
				conversationHistory: replay,
			});
			expect((h.transport.sendAudio as ReturnType<typeof vi.fn>).mock.calls).toEqual([
				[Buffer.from('one').toString('base64')],
				[Buffer.from('two').toString('base64')],
			]);
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('ACTIVE');
		});

		it('hosted (ClientSenderAdapter) reconnect drains assistant audio to the client, never the LLM', async () => {
			// Real adapter, not a fake: the hosted drain contract (R1 of
			// design-retained-user-content-recovery.md) at the reconnector level.
			const { ClientSenderAdapter } = await import('../../src/transport/client-sender-adapter.js');
			const senderAudio = vi.fn();
			const adapter = new ClientSenderAdapter({ sendAudio: senderAudio, sendJson: vi.fn() });
			const h = makeHarness({
				clientTransport: adapter as unknown as ReturnType<typeof fakeClientTransport>,
			});

			h.reconnector.triggerReconnect('transport-close');
			// Assistant audio produced during the reconnect window is buffered.
			adapter.sendAudioToClient(Buffer.from('assistant-speech'));
			expect(senderAudio).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();

			// Drained to the CLIENT on stopBuffering — never into the LLM as input.
			expect(senderAudio).toHaveBeenCalledWith(Buffer.from('assistant-speech'));
			expect(h.transport.sendAudio).not.toHaveBeenCalled();
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('ACTIVE');
		});

		it('hosted (DirectRtcClientChannel) reconnect drains assistant audio to the client, never the LLM', async () => {
			// H1 of design-hosted-replay-recovery-rollout.md: same contract as the
			// ClientSenderAdapter case, for the direct-RTC channel — both drain
			// paths (this one: budgeted triggerReconnect).
			const { DirectRtcClientChannel } = await import(
				'../../src/transport/direct-rtc-client-channel.js'
			);
			const senderAudio = vi.fn();
			const channel = new DirectRtcClientChannel({
				sender: { sendAudio: senderAudio, sendJson: vi.fn() },
			});
			const h = makeHarness({
				clientTransport: channel as unknown as ReturnType<typeof fakeClientTransport>,
			});

			h.reconnector.triggerReconnect('transport-close');
			channel.sendAudioToClient(Buffer.from('assistant-speech'));
			expect(senderAudio).not.toHaveBeenCalled();

			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();

			expect(senderAudio).toHaveBeenCalledWith(Buffer.from('assistant-speech'));
			expect(h.transport.sendAudio).not.toHaveBeenCalled();
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('ACTIVE');
		});

		it('GoAway drain (DirectRtcClientChannel) also delivers assistant audio to the client, never the LLM', async () => {
			const { DirectRtcClientChannel } = await import(
				'../../src/transport/direct-rtc-client-channel.js'
			);
			const senderAudio = vi.fn();
			const channel = new DirectRtcClientChannel({
				sender: { sendAudio: senderAudio, sendJson: vi.fn() },
			});
			const h = makeHarness({
				clientTransport: channel as unknown as ReturnType<typeof fakeClientTransport>,
			});

			h.reconnector.handleGoAway('10s');
			channel.sendAudioToClient(Buffer.from('assistant-tail'));
			await vi.runAllTimersAsync();

			expect(senderAudio).toHaveBeenCalledWith(Buffer.from('assistant-tail'));
			expect(h.transport.sendAudio).not.toHaveBeenCalled();
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('ACTIVE');
		});

		it('follows the backoff schedule 1000/2000/4000 across attempts', async () => {
			const h = makeHarness({});
			const reconnect = h.transport.reconnect as ReturnType<typeof vi.fn>;

			// Attempt 1: 1000ms backoff.
			h.reconnector.triggerReconnect('transport-close');
			vi.advanceTimersByTime(999);
			expect(reconnect).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			await vi.runAllTimersAsync();
			expect(reconnect).toHaveBeenCalledTimes(1);

			// Attempt 2: 2000ms backoff (state is back to ACTIVE after success).
			h.reconnector.triggerReconnect('transport-close');
			vi.advanceTimersByTime(1999);
			expect(reconnect).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1);
			await vi.runAllTimersAsync();
			expect(reconnect).toHaveBeenCalledTimes(2);

			// Attempt 3: 4000ms backoff.
			h.reconnector.triggerReconnect('transport-close');
			vi.advanceTimersByTime(3999);
			expect(reconnect).toHaveBeenCalledTimes(2);
			vi.advanceTimersByTime(1);
			await vi.runAllTimersAsync();
			expect(reconnect).toHaveBeenCalledTimes(3);
		});

		it('CLOSEs when the reconnect budget is exhausted (4th attempt gives up)', async () => {
			const h = makeHarness({});
			for (let i = 0; i < 3; i++) {
				h.reconnector.triggerReconnect('transport-close');
				vi.advanceTimersByTime(4000);
				await vi.runAllTimersAsync();
			}
			expect(h.transport.reconnect).toHaveBeenCalledTimes(3);

			// 4th: budget spent → immediate CLOSED, no further reconnect.
			h.reconnector.triggerReconnect('transport-close');
			expect(h.sm.closeWithReason).toHaveBeenCalledWith('reconnect_failed');
			vi.advanceTimersByTime(4000);
			await vi.runAllTimersAsync();
			expect(h.transport.reconnect).toHaveBeenCalledTimes(3);
		});

		it('CLOSEs immediately when there is no resumption handle', () => {
			const h = makeHarness({ handle: null });
			h.reconnector.triggerReconnect('transport-close');
			expect(h.transport.reconnect).not.toHaveBeenCalled();
			expect(h.sm.closeWithReason).toHaveBeenCalledWith('reconnect_failed');
		});

		it('CLOSEs on a failed reconnect attempt', async () => {
			const transport = fakeTransport({
				reconnect: vi.fn().mockRejectedValue(new Error('boom')),
			});
			const h = makeHarness({ transport });
			h.reconnector.triggerReconnect('transport-close');
			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();
			expect(h.reportError).toHaveBeenCalledWith('reconnect', expect.any(Error));
			expect(h.sm.closeWithReason).toHaveBeenCalledWith('reconnect_failed');
		});

		it('no-ops when the session is not ACTIVE', () => {
			const h = makeHarness({ initial: 'RECONNECTING' });
			h.reconnector.triggerReconnect('transport-close');
			expect(h.sm.transitionTo).not.toHaveBeenCalled();
			expect(h.transport.reconnect).not.toHaveBeenCalled();
		});

		it('resetAttempts restores the budget after a healthy turn completion', async () => {
			const h = makeHarness({});
			// Spend the whole budget.
			for (let i = 0; i < 3; i++) {
				h.reconnector.triggerReconnect('transport-close');
				vi.advanceTimersByTime(4000);
				await vi.runAllTimersAsync();
			}
			// Budget exhausted → next trigger gives up.
			h.reconnector.triggerReconnect('transport-close');
			expect(h.sm.closeWithReason).toHaveBeenCalledWith('reconnect_failed');

			// Healthy turn → reset → reconnect works again with the 1000ms backoff.
			// (A healthy completion implies the session is ACTIVE again.)
			h.sm._setState('ACTIVE');
			h.reconnector.resetAttempts();
			h.reconnector.triggerReconnect('transport-close');
			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();
			expect(h.transport.reconnect).toHaveBeenCalledTimes(4);
		});
	});

	describe('response watchdog', () => {
		it('arms on user-turn-complete, fires, and forces a triggerReconnect', async () => {
			const h = makeHarness({ watchdogMs: 8000 });
			h.reconnector.armResponseWatchdog();
			expect(h.transport.reconnect).not.toHaveBeenCalled();

			vi.advanceTimersByTime(8000); // watchdog fires → triggerReconnect('response-watchdog', true)
			vi.advanceTimersByTime(1000); // backoff
			await vi.runAllTimersAsync();
			expect(h.transport.reconnect).toHaveBeenCalledTimes(1);
		});

		it('re-elicits a response after a watchdog-driven reconnect (agent mode)', async () => {
			const h = makeHarness({ watchdogMs: 8000, agentMode: true });
			h.reconnector.armResponseWatchdog();
			vi.advanceTimersByTime(8000);
			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();
			expect(h.transport.elicitResponse).toHaveBeenCalledTimes(1);
		});

		it('does not arm when not in agent mode', () => {
			const h = makeHarness({ watchdogMs: 8000, agentMode: false });
			h.reconnector.armResponseWatchdog();
			vi.advanceTimersByTime(20000);
			expect(h.transport.reconnect).not.toHaveBeenCalled();
		});

		it('does not arm when watchdog is disabled (<= 0)', () => {
			const h = makeHarness({ watchdogMs: 0 });
			h.reconnector.armResponseWatchdog();
			vi.advanceTimersByTime(20000);
			expect(h.transport.reconnect).not.toHaveBeenCalled();
		});

		it('disarm cancels a pending watchdog (model showed activity)', () => {
			const h = makeHarness({ watchdogMs: 8000 });
			h.reconnector.armResponseWatchdog();
			h.reconnector.disarmResponseWatchdog();
			vi.advanceTimersByTime(20000);
			expect(h.transport.reconnect).not.toHaveBeenCalled();
		});

		describe('provider-activity liveness extension', () => {
			it('an input-transcription liveness signal extends the deadline by a fresh budget', async () => {
				const h = makeHarness({ watchdogMs: 5000 });
				h.reconnector.armResponseWatchdog();

				// Liveness at t=4s (Gemini's transcription deltas on a slow turn).
				vi.advanceTimersByTime(4000);
				h.reconnector.notifyProviderActivity();

				// Old deadline (t=5s) passes without firing…
				vi.advanceTimersByTime(2000);
				expect(h.transport.reconnect).not.toHaveBeenCalled();

				// …the extended deadline (t=9s) fires normally.
				vi.advanceTimersByTime(3000);
				vi.advanceTimersByTime(1000); // reconnect backoff
				await vi.runAllTimersAsync();
				expect(h.transport.reconnect).toHaveBeenCalledTimes(1);
			});

			it('repeated liveness cannot defer past the absolute cap (15s from arm)', async () => {
				const h = makeHarness({ watchdogMs: 5000 });
				h.reconnector.armResponseWatchdog();

				// A stuck stream signalling liveness every second, forever.
				for (let i = 0; i < 14; i++) {
					vi.advanceTimersByTime(1000);
					h.reconnector.notifyProviderActivity();
				}
				// t=14s: not yet fired (still inside the cap).
				expect(h.transport.reconnect).not.toHaveBeenCalled();

				// The cap bounds the last extension to t=15s — signals after the cap
				// is exhausted are no-ops and the watchdog still fires.
				vi.advanceTimersByTime(1000);
				h.reconnector.notifyProviderActivity();
				vi.advanceTimersByTime(1000); // reconnect backoff
				await vi.runAllTimersAsync();
				expect(h.transport.reconnect).toHaveBeenCalledTimes(1);
			});

			it('liveness while disarmed is a no-op (does not resurrect the watchdog)', () => {
				const h = makeHarness({ watchdogMs: 5000 });
				h.reconnector.armResponseWatchdog();
				h.reconnector.disarmResponseWatchdog();
				h.reconnector.notifyProviderActivity();
				vi.advanceTimersByTime(30000);
				expect(h.transport.reconnect).not.toHaveBeenCalled();
			});

			it('a fresh arm resets the extension cap anchor', () => {
				const h = makeHarness({ watchdogMs: 5000 });
				h.reconnector.armResponseWatchdog();
				vi.advanceTimersByTime(3000);
				h.reconnector.disarmResponseWatchdog(); // model responded
				vi.advanceTimersByTime(11000); // idle chat gap; t=14s from first arm

				// New turn: the new window gets its own full cap, so liveness at +4s
				// extends normally even though the FIRST arm's cap would be exhausted.
				h.reconnector.armResponseWatchdog();
				vi.advanceTimersByTime(4000);
				h.reconnector.notifyProviderActivity();
				vi.advanceTimersByTime(2000); // old deadline passes without firing
				expect(h.transport.reconnect).not.toHaveBeenCalled();
			});
		});

		it('falls back to triggerGeneration when the transport cannot elicit', async () => {
			const transport = fakeTransport({ elicitResponse: undefined });
			const h = makeHarness({ watchdogMs: 8000, transport });
			h.reconnector.armResponseWatchdog();
			vi.advanceTimersByTime(8000);
			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();
			expect(transport.triggerGeneration).toHaveBeenCalledTimes(1);
		});

		it('survives a throwing re-elicit nudge (best-effort) and stays reconnected', async () => {
			const transport = fakeTransport({
				elicitResponse: vi.fn(() => {
					throw new Error('half-open');
				}),
			});
			const h = makeHarness({ watchdogMs: 8000, transport });
			h.reconnector.armResponseWatchdog();
			vi.advanceTimersByTime(8000);
			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();
			expect(transport.reconnect).toHaveBeenCalledTimes(1);
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('ACTIVE');
		});
	});

	describe('handleGoAway (immediate, unbudgeted)', () => {
		it('disarms the watchdog, publishes session.goaway, and reconnects immediately', async () => {
			const buffered = [Buffer.from('x')];
			const ct = fakeClientTransport(buffered);
			const h = makeHarness({ watchdogMs: 8000, clientTransport: ct });
			h.reconnector.armResponseWatchdog();

			h.reconnector.handleGoAway('5s');
			expect(h.eventBus.publish).toHaveBeenCalledWith('session.goaway', {
				sessionId: 'sess_1',
				timeLeft: '5s',
			});
			// Immediate — no backoff timer needed before reconnect().
			expect(h.sm.transitionTo).toHaveBeenCalledWith('RECONNECTING');
			expect(ct.startBuffering).toHaveBeenCalledTimes(1);
			await vi.runAllTimersAsync();
			expect(h.transport.reconnect).toHaveBeenCalledTimes(1);
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('ACTIVE');

			// The armed watchdog was disarmed by GoAway — it must not also fire.
			vi.advanceTimersByTime(20000);
			expect(h.transport.reconnect).toHaveBeenCalledTimes(1);
		});

		it('GoAway is unbudgeted: it reconnects after triggerReconnect spent all three attempts, while still ACTIVE', async () => {
			const h = makeHarness({});
			for (let i = 0; i < 3; i++) {
				h.reconnector.triggerReconnect('transport-close');
				vi.advanceTimersByTime(4000);
				await vi.runAllTimersAsync();
			}
			expect(h.transport.reconnect).toHaveBeenCalledTimes(3);

			// The budget is spent (a 4th triggerReconnect would give up and CLOSE),
			// but the session is still ACTIVE — the only state GoAway acts in…
			expect(h.sm.state).toBe('ACTIVE');

			// …so GoAway still reconnects immediately (its own path, no budget).
			h.reconnector.handleGoAway('3s');
			await vi.runAllTimersAsync();
			expect(h.transport.reconnect).toHaveBeenCalledTimes(4);
			expect(h.sm.closeWithReason).not.toHaveBeenCalled();
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('ACTIVE');
		});

		it('handleGoAway is ignored without throwing when CLOSED', () => {
			const h = makeHarness({ initial: 'CLOSED' });
			// Mirror the real SessionManager: CLOSED has no valid transitions.
			h.sm.transitionTo.mockImplementation((s: SessionState) => {
				throw new Error(`Invalid transition: CLOSED → ${s}`);
			});

			expect(() => h.reconnector.handleGoAway('5s')).not.toThrow();

			expect(h.eventBus.publish).toHaveBeenCalledWith('session.goaway', {
				sessionId: 'sess_1',
				timeLeft: '5s',
			});
			expect(h.sm.transitionTo).not.toHaveBeenCalled();
			expect(h.clientTransport.startBuffering).not.toHaveBeenCalled();
			expect(h.transport.reconnect).not.toHaveBeenCalled();
			expect(h.sm.state).toBe('CLOSED');
		});

		it('does not reconnect when there is no resumption handle', () => {
			const h = makeHarness({ handle: null });
			h.reconnector.handleGoAway('5s');
			expect(h.eventBus.publish).toHaveBeenCalledWith(
				'session.goaway',
				expect.objectContaining({ sessionId: 'sess_1' }),
			);
			expect(h.transport.reconnect).not.toHaveBeenCalled();
		});
	});

	describe('handleResumptionUpdate', () => {
		it('caches the handle on a resumable update', () => {
			const h = makeHarness({});
			h.reconnector.handleResumptionUpdate('handle-2', true);
			expect(h.sm.updateResumptionHandle).toHaveBeenCalledWith('handle-2');
			expect(h.sm.clearResumptionHandle).not.toHaveBeenCalled();
		});

		it('clears the cache on a non-resumable update', () => {
			const h = makeHarness({});
			h.reconnector.handleResumptionUpdate('handle-2', false);
			expect(h.sm.clearResumptionHandle).toHaveBeenCalledTimes(1);
			expect(h.sm.updateResumptionHandle).not.toHaveBeenCalled();
		});
	});

	describe('handleTransportClose', () => {
		it('routes through triggerReconnect (budgeted path)', async () => {
			const h = makeHarness({});
			h.reconnector.handleTransportClose(1006, 'gone');
			vi.advanceTimersByTime(1000);
			await vi.runAllTimersAsync();
			expect(h.transport.reconnect).toHaveBeenCalledTimes(1);
		});
	});

	describe('reconnect deadline and guards', () => {
		/** A transport whose reconnect() never settles, with an abortIncumbent spy. */
		function stalledTransport() {
			return fakeTransport({
				reconnect: vi.fn(() => new Promise<void>(() => {})),
				abortIncumbent: vi.fn(async () => 'closed' as const),
			});
		}

		it('GoAway reconnect that never settles closes with reconnect_failed after the deadline', async () => {
			const transport = stalledTransport();
			const h = makeHarness({ transport });

			h.reconnector.handleGoAway('5s');
			expect(h.sm.state).toBe('RECONNECTING');
			expect(transport.reconnect).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_DEADLINE_MS - 1);
			expect(h.sm.closeWithReason).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			const abort = transport.abortIncumbent as ReturnType<typeof vi.fn>;
			expect(abort).toHaveBeenCalledTimes(1);
			// The incumbent is aborted BEFORE the close, so the stranded reconnect
			// continuation cannot dial after CLOSED.
			expect(abort.mock.invocationCallOrder[0]).toBeLessThan(
				h.sm.closeWithReason.mock.invocationCallOrder[0],
			);
			expect(h.sm.closeWithReason).toHaveBeenCalledWith('reconnect_failed');
			expect(h.reportError).toHaveBeenCalledWith(
				'reconnect',
				expect.objectContaining({
					message: `Reconnect timed out after ${DEFAULT_RECONNECT_DEADLINE_MS}ms`,
				}),
			);
			expect(h.clientTransport.stopBuffering).toHaveBeenCalled();
			expect(h.sm.state).toBe('CLOSED');
			expect(vi.getTimerCount()).toBe(0);
		});

		it('budgeted reconnect obeys the same deadline', async () => {
			const transport = stalledTransport();
			const h = makeHarness({ transport });

			h.reconnector.triggerReconnect('transport-close');
			await vi.advanceTimersByTimeAsync(1000); // backoff → dial
			expect(transport.reconnect).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_DEADLINE_MS - 1);
			expect(h.sm.closeWithReason).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			expect(transport.abortIncumbent).toHaveBeenCalledTimes(1);
			expect(h.sm.closeWithReason).toHaveBeenCalledWith('reconnect_failed');
			expect(h.reportError).toHaveBeenCalledWith(
				'reconnect',
				expect.objectContaining({
					message: `Reconnect timed out after ${DEFAULT_RECONNECT_DEADLINE_MS}ms`,
				}),
			);
			expect(h.sm.state).toBe('CLOSED');
		});

		it('reconnect resolving after CLOSED neither activates nor reports', async () => {
			let resolveReconnect: () => void = () => {};
			const transport = fakeTransport({
				reconnect: vi.fn(
					() =>
						new Promise<void>((resolve) => {
							resolveReconnect = resolve;
						}),
				),
			});
			const h = makeHarness({ transport });

			h.reconnector.handleGoAway('5s');
			expect(transport.reconnect).toHaveBeenCalledTimes(1);
			await h.sm.closeWithReason('normal'); // the session closed mid-reconnect

			resolveReconnect();
			await vi.runAllTimersAsync();

			expect(h.sm.transitionTo).not.toHaveBeenCalledWith('ACTIVE');
			expect(h.sm.state).toBe('CLOSED');
			expect(h.reportError).not.toHaveBeenCalled();
			expect(h.sm.closeWithReason).toHaveBeenCalledTimes(1);
			expect(h.log).toHaveBeenCalledWith(expect.stringContaining('result ignored'));
			expect(vi.getTimerCount()).toBe(0); // the attempt deadline was cleared
		});

		it('a delayed incumbent close completing after the deadline neither dials nor leaves a provider connection', async () => {
			// Real transport with a fake SDK: the incumbent's close() hangs past the
			// session deadline, then completes.
			let releaseClose: () => void = () => {};
			const incumbent = {
				close: vi.fn(
					() =>
						new Promise<void>((resolve) => {
							releaseClose = resolve;
						}),
				),
				sendRealtimeInput: vi.fn(),
				sendClientContent: vi.fn(),
				sendToolResponse: vi.fn(),
			};
			const connect = vi.fn(
				async (params: { callbacks: { onmessage: (msg: unknown) => void } }) => {
					void Promise.resolve().then(() =>
						params.callbacks.onmessage({ setupComplete: { sessionId: 'sid_1' } }),
					);
					return incumbent;
				},
			);
			const gemini = new GeminiLiveTransport({ apiKey: 'test-key' }, {});
			(gemini as unknown as { ai: unknown }).ai = { live: { connect } };
			await gemini.connect();
			expect(gemini.isConnected).toBe(true);

			const h = makeHarness({ transport: gemini, reconnectDeadlineMs: 100 });
			h.reconnector.handleGoAway('5s');
			// reconnect() → disconnect() detached the incumbent and awaits its close.
			expect(incumbent.close).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(100); // session deadline
			expect(h.sm.closeWithReason).toHaveBeenCalledWith('reconnect_failed');
			expect(h.sm.state).toBe('CLOSED');

			// The incumbent close finally completes: the stranded reconnect()
			// continuation must not dial after CLOSED.
			releaseClose();
			await vi.runAllTimersAsync();

			expect(connect).toHaveBeenCalledTimes(1);
			expect(gemini.isConnected).toBe(false);
			expect(h.sm.transitionTo).not.toHaveBeenCalledWith('ACTIVE');
			expect(vi.getTimerCount()).toBe(0);
		});

		it('session close during backoff cancels the pending dial', async () => {
			const h = makeHarness({});
			h.reconnector.triggerReconnect('transport-close');
			expect(h.sm.state).toBe('RECONNECTING');

			await h.sm.closeWithReason('normal'); // closed before the 1000ms backoff elapses
			await vi.advanceTimersByTimeAsync(1000);

			expect(h.transport.reconnect).not.toHaveBeenCalled();
			expect(h.sm.transitionTo).not.toHaveBeenCalledWith('ACTIVE');
		});

		it('dispose() is terminal: a later transport close or GoAway starts no dial', async () => {
			const h = makeHarness({});
			h.reconnector.dispose();
			h.reconnector.triggerReconnect('transport-close');
			h.reconnector.handleGoAway('10s');
			await vi.advanceTimersByTimeAsync(5000);
			expect(h.transport.reconnect).not.toHaveBeenCalled();
			expect(h.sm.transitionTo).not.toHaveBeenCalledWith('RECONNECTING');
		});

		it('dispose() clears pending timers', async () => {
			// Pending backoff dial, armed watchdog and a held recovery.
			const h = makeHarness({ watchdogMs: 100, isGreetingSuppressionArmed: () => true });
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(100); // fires → held behind the greeting gate
			expect(h.reconnector.isRecoveryHeld()).toBe(true);
			h.reconnector.armResponseWatchdog();
			h.reconnector.triggerReconnect('transport-close');
			expect(vi.getTimerCount()).toBe(2); // watchdog + backoff

			h.reconnector.dispose();
			expect(vi.getTimerCount()).toBe(0);
			expect(h.reconnector.isRecoveryHeld()).toBe(false);
			await vi.advanceTimersByTimeAsync(5000);
			expect(h.transport.reconnect).not.toHaveBeenCalled();

			// In-flight attempt: its deadline is cleared and the incumbent aborted, once.
			const transport = stalledTransport();
			const g = makeHarness({ transport });
			g.reconnector.handleGoAway('5s');
			expect(vi.getTimerCount()).toBe(1); // the attempt deadline
			g.reconnector.dispose();
			g.reconnector.dispose(); // idempotent
			expect(vi.getTimerCount()).toBe(0);
			expect(transport.abortIncumbent).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_DEADLINE_MS);
			expect(g.sm.closeWithReason).not.toHaveBeenCalled();
		});

		// CONNECTING → RECONNECTING is a legal edge reserved for a host recovery
		// that replaces the pending first dial; the stub session manager accepts
		// any transition, so only the reconnector's own guards keep these out.
		it('a GoAway during the first dial (CONNECTING) publishes session.goaway but never enters RECONNECTING', async () => {
			const h = makeHarness({ initial: 'CONNECTING' });

			expect(() => h.reconnector.handleGoAway('5s')).not.toThrow();
			await vi.advanceTimersByTimeAsync(5000);

			expect(h.eventBus.publish).toHaveBeenCalledWith('session.goaway', {
				sessionId: 'sess_1',
				timeLeft: '5s',
			});
			expect(h.sm.transitionTo).not.toHaveBeenCalled();
			expect(h.clientTransport.startBuffering).not.toHaveBeenCalled();
			expect(h.transport.reconnect).not.toHaveBeenCalled();
			expect(h.sm.state).toBe('CONNECTING');
		});

		it.each(['close', 'hold'] as const)(
			'a transport close during the first dial (CONNECTING) starts no reconnect and leaves the failed connect to start() (policy %s)',
			async (upstreamLossPolicy) => {
				const h = makeHarness({
					initial: 'CONNECTING',
					upstreamLossPolicy,
					hostOwnsRecovery: () => true,
				});

				h.reconnector.handleTransportClose(1006, 'ENOTFOUND');
				await vi.advanceTimersByTimeAsync(5000);

				expect(h.sm.transitionTo).not.toHaveBeenCalled();
				expect(h.sm.closeWithReason).not.toHaveBeenCalled();
				expect(h.clientTransport.startBuffering).not.toHaveBeenCalled();
				expect(h.transport.reconnect).not.toHaveBeenCalled();
				expect(h.eventBus.publish).not.toHaveBeenCalledWith(
					'session.upstreamLost',
					expect.anything(),
				);
				expect(h.sm.state).toBe('CONNECTING');
			},
		);

		it('a response watchdog firing during the first dial (CONNECTING) starts no reconnect', async () => {
			const h = makeHarness({ initial: 'CONNECTING', watchdogMs: 100 });

			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(100 + 5000);

			expect(h.sm.transitionTo).not.toHaveBeenCalled();
			expect(h.transport.reconnect).not.toHaveBeenCalled();
			expect(h.sm.state).toBe('CONNECTING');
		});
	});

	describe('host recovery handover and upstream-lost policy', () => {
		/** Spend the whole automatic budget (three successful reconnects). */
		async function spendBudget(h: Harness): Promise<void> {
			for (let i = 0; i < 3; i++) {
				h.reconnector.triggerReconnect('transport-close');
				vi.advanceTimersByTime(4000);
				await vi.runAllTimersAsync();
			}
			expect(h.transport.reconnect).toHaveBeenCalledTimes(3);
		}

		it('beginHostRecovery cancels a pending backoff dial', async () => {
			const h = makeHarness({ upstreamLossPolicy: 'hold' });
			h.reconnector.triggerReconnect('transport-close');
			expect(h.sm.state).toBe('RECONNECTING');
			expect(vi.getTimerCount()).toBe(1); // the backoff

			expect(h.reconnector.beginHostRecovery()).toEqual({
				cancelledPendingDial: true,
				wasBuffering: true,
			});
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(10_000);

			expect(h.transport.reconnect).not.toHaveBeenCalled();
			expect(h.sm.closeWithReason).not.toHaveBeenCalled();
			expect(h.sm.state).toBe('RECONNECTING');
			// The client buffering was handed over, not ended here.
			expect(h.clientTransport.stopBuffering).not.toHaveBeenCalled();
			// Nothing is left to take over a second time.
			expect(h.reconnector.beginHostRecovery()).toEqual({
				cancelledPendingDial: false,
				wasBuffering: false,
			});
		});

		it.each(['resolves', 'rejects', 'hits the deadline'] as const)(
			'a host recovery that takes over while an automatic transport.reconnect() is in flight is not stranded when that reconnect later %s',
			async (outcome) => {
				const settle: { resolve?: () => void; reject?: (err: Error) => void } = {};
				const transport = fakeTransport({
					reconnect: vi.fn(
						() =>
							new Promise<void>((resolve, reject) => {
								settle.resolve = resolve;
								settle.reject = reject;
							}),
					),
					abortIncumbent: vi.fn(async () => 'closed' as const),
				});
				const h = makeHarness({ transport, upstreamLossPolicy: 'hold' });
				h.reconnector.handleGoAway('5s');
				expect(transport.reconnect).toHaveBeenCalledTimes(1);
				expect(vi.getTimerCount()).toBe(1); // the automatic attempt's deadline

				// The host takes over, then strands the incumbent itself and dials.
				expect(h.reconnector.beginHostRecovery()).toEqual({
					cancelledPendingDial: false,
					wasBuffering: true,
				});
				expect(vi.getTimerCount()).toBe(0); // the superseded attempt's deadline is cleared
				void transport.abortIncumbent?.();

				// The superseded automatic attempt settles while the host dial is pending.
				if (outcome === 'resolves') settle.resolve?.();
				if (outcome === 'rejects') settle.reject?.(new Error('superseded dial failed'));
				await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_DEADLINE_MS + 1);

				expect(transport.abortIncumbent).toHaveBeenCalledTimes(1); // the host's own
				expect(h.sm.closeWithReason).not.toHaveBeenCalled();
				expect(h.reportError).not.toHaveBeenCalled();
				expect(h.eventBus.publish).not.toHaveBeenCalledWith(
					'session.upstreamLost',
					expect.anything(),
				);
				expect(h.clientTransport.stopBuffering).not.toHaveBeenCalled();
				expect(h.sm.transitionTo).not.toHaveBeenCalledWith('ACTIVE');
				expect(h.sm.state).toBe('RECONNECTING');

				// The host dial completes and activates the session.
				h.sm.transitionTo('ACTIVE');
				await vi.runAllTimersAsync();
				expect(h.sm.state).toBe('ACTIVE');
				expect(h.sm.closeWithReason).not.toHaveBeenCalled();
			},
		);

		it('hostOwnsRecovery parks in UPSTREAM_LOST instead of dialing', async () => {
			const h = makeHarness({ upstreamLossPolicy: 'hold', hostOwnsRecovery: () => true });
			h.reconnector.handleTransportClose(1011, 'internal error');

			expect(h.sm.state).toBe('UPSTREAM_LOST');
			expect(h.eventBus.publish).toHaveBeenCalledWith('session.upstreamLost', {
				sessionId: 'sess_1',
				reason: 'host-owns-recovery',
				code: 1011,
				detail: 'internal error',
			});
			expect(h.clientTransport.startBuffering).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(h.transport.reconnect).not.toHaveBeenCalled();
			expect(h.sm.closeWithReason).not.toHaveBeenCalled();

			// Under policy 'close' the gate is inert: the automatic reconnect runs.
			const c = makeHarness({ upstreamLossPolicy: 'close', hostOwnsRecovery: () => true });
			c.reconnector.handleTransportClose(1011, 'internal error');
			expect(c.sm.state).toBe('RECONNECTING');
			await vi.advanceTimersByTimeAsync(1000);
			expect(c.transport.reconnect).toHaveBeenCalledTimes(1);
		});

		it('the gate is rechecked in the backoff callback: a host that starts owning recovery during the backoff parks instead of dialing and never closes', async () => {
			let hostOwns = false;
			const ct = fakeClientTransport([Buffer.from('mic')], { discardBuffered: true });
			const h = makeHarness({
				upstreamLossPolicy: 'hold',
				hostOwnsRecovery: () => hostOwns,
				clientTransport: ct,
			});
			h.reconnector.triggerReconnect('transport-close');
			expect(h.sm.state).toBe('RECONNECTING');
			expect(ct.startBuffering).toHaveBeenCalledTimes(1);

			hostOwns = true; // e.g. the host classified the close as terminal
			await vi.advanceTimersByTimeAsync(1000);

			expect(h.transport.reconnect).not.toHaveBeenCalled();
			expect(h.sm.state).toBe('UPSTREAM_LOST');
			expect(h.sm.closeWithReason).not.toHaveBeenCalled();
			expect(h.eventBus.publish).toHaveBeenCalledWith('session.upstreamLost', {
				sessionId: 'sess_1',
				reason: 'host-owns-recovery',
			});
			// The reconnect-window buffer is dropped, never drained to the model.
			expect(ct.discardBuffered).toHaveBeenCalledTimes(1);
			expect(ct.stopBuffering).not.toHaveBeenCalled();
			expect(h.transport.sendAudio).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(h.transport.reconnect).not.toHaveBeenCalled();
		});

		it('budget exhaustion parks under hold and closes under close', async () => {
			const hold = makeHarness({ upstreamLossPolicy: 'hold' });
			await spendBudget(hold);
			hold.reconnector.triggerReconnect('transport-close');
			expect(hold.sm.state).toBe('UPSTREAM_LOST');
			expect(hold.sm.closeWithReason).not.toHaveBeenCalled();
			expect(hold.eventBus.publish).toHaveBeenCalledWith('session.upstreamLost', {
				sessionId: 'sess_1',
				reason: 'reconnect-exhausted',
			});
			await vi.advanceTimersByTimeAsync(10_000);
			expect(hold.transport.reconnect).toHaveBeenCalledTimes(3);

			const close = makeHarness({ upstreamLossPolicy: 'close' });
			await spendBudget(close);
			close.reconnector.triggerReconnect('transport-close');
			expect(close.sm.closeWithReason).toHaveBeenCalledWith('reconnect_failed');
			expect(close.sm.state).toBe('CLOSED');
			expect(close.sm.transitionTo).not.toHaveBeenCalledWith('UPSTREAM_LOST');
			expect(close.eventBus.publish).not.toHaveBeenCalledWith(
				'session.upstreamLost',
				expect.anything(),
			);
		});

		it.each([
			['rejects', 'reconnect-failed', 'boom'],
			[
				'times out',
				'reconnect-timeout',
				`Reconnect timed out after ${DEFAULT_RECONNECT_DEADLINE_MS}ms`,
			],
		] as const)(
			'an automatic attempt that %s parks under hold instead of closing',
			async (_label, reason, detail) => {
				const transport = fakeTransport({
					reconnect: vi.fn(() =>
						reason === 'reconnect-failed'
							? Promise.reject(new Error('boom'))
							: new Promise<void>(() => {}),
					),
					abortIncumbent: vi.fn(async () => 'closed' as const),
				});
				const ct = fakeClientTransport([], { discardBuffered: true });
				const h = makeHarness({ transport, clientTransport: ct, upstreamLossPolicy: 'hold' });
				h.reconnector.triggerReconnect('transport-close');
				await vi.advanceTimersByTimeAsync(1000 + DEFAULT_RECONNECT_DEADLINE_MS);

				expect(h.reportError).toHaveBeenCalledWith(
					'reconnect',
					expect.objectContaining({ message: detail }),
				);
				expect(h.sm.state).toBe('UPSTREAM_LOST');
				expect(h.sm.closeWithReason).not.toHaveBeenCalled();
				expect(h.eventBus.publish).toHaveBeenCalledWith('session.upstreamLost', {
					sessionId: 'sess_1',
					reason,
					detail,
				});
				expect(ct.discardBuffered).toHaveBeenCalledTimes(1);
				expect(ct.stopBuffering).not.toHaveBeenCalled();
				expect(transport.abortIncumbent).toHaveBeenCalledTimes(
					reason === 'reconnect-timeout' ? 1 : 0,
				);
				expect(vi.getTimerCount()).toBe(0);
			},
		);

		it('a channel without discardBuffered falls back to stopBuffering() with a log', async () => {
			const transport = fakeTransport({
				reconnect: vi.fn().mockRejectedValue(new Error('boom')),
			});
			const ct = fakeClientTransport([Buffer.from('mic')]); // no discardBuffered
			const h = makeHarness({ transport, clientTransport: ct, upstreamLossPolicy: 'hold' });
			h.reconnector.triggerReconnect('transport-close');
			await vi.advanceTimersByTimeAsync(1000);

			expect(h.sm.state).toBe('UPSTREAM_LOST');
			expect(ct.stopBuffering).toHaveBeenCalledTimes(1);
			expect(h.log).toHaveBeenCalledWith(expect.stringContaining('stopBuffering()'));
			// The returned frames are dropped, never forwarded to the model.
			expect(transport.sendAudio).not.toHaveBeenCalled();
		});

		it('a watchdog fire while held returns hold-gate and re-fires on onSyntheticHoldReleased()', async () => {
			let held = true;
			const h = makeHarness({ watchdogMs: 100, isSyntheticHeld: () => held });
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(100);

			expect(h.reconnector.isRecoveryHeld()).toBe(true);
			expect(h.log).toHaveBeenCalledWith(
				expect.stringContaining('HELD (synthetic-output hold active'),
			);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(h.transport.reconnect).not.toHaveBeenCalled();
			expect(h.sm.transitionTo).not.toHaveBeenCalled();

			held = false;
			h.reconnector.onSyntheticHoldReleased();
			expect(h.reconnector.isRecoveryHeld()).toBe(false);
			expect(h.sm.state).toBe('RECONNECTING');
			await vi.advanceTimersByTimeAsync(1000);
			expect(h.transport.reconnect).toHaveBeenCalledTimes(1);
		});

		it('a greeting-suppression hold keeps its existing log text', async () => {
			const h = makeHarness({ watchdogMs: 100, isGreetingSuppressionArmed: () => true });
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(100);

			expect(h.log).toHaveBeenCalledWith(
				'[Watchdog] Model silent 100ms after user turn — HELD (greeting suppression armed; recovery resumes at gate release)',
			);
		});

		it('a throwing hostOwnsRecovery hook is logged and read as not owning, so automatic recovery goes on', async () => {
			const h = makeHarness({
				upstreamLossPolicy: 'hold',
				hostOwnsRecovery: () => {
					throw new Error('host hook broke');
				},
			});
			// Reached from the transport close callback, then from the backoff timer.
			expect(() => h.reconnector.handleTransportClose(1006, 'abnormal')).not.toThrow();
			expect(h.sm.state).toBe('RECONNECTING');
			await vi.advanceTimersByTimeAsync(1000);

			expect(h.transport.reconnect).toHaveBeenCalledTimes(1);
			expect(h.sm.state).toBe('ACTIVE');
			expect(h.eventBus.publish).not.toHaveBeenCalledWith(
				'session.upstreamLost',
				expect.anything(),
			);
			const hookLogs = h.log.mock.calls.filter(([m]) => String(m).includes('host hook broke'));
			expect(hookLogs).toHaveLength(2);
		});

		it('parkUpstreamLost cancels a pending backoff dial and strands an in-flight automatic attempt', async () => {
			// A pending backoff dial.
			const h = makeHarness({ upstreamLossPolicy: 'hold' });
			h.reconnector.triggerReconnect('transport-close');
			expect(vi.getTimerCount()).toBe(1); // the backoff
			h.reconnector.parkUpstreamLost('host-parked');
			expect(h.sm.state).toBe('UPSTREAM_LOST');
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(h.transport.reconnect).not.toHaveBeenCalled();

			// An automatic attempt in flight: its deadline is cleared, the incumbent
			// aborted once, and a late resolution never activates the parked session.
			let resolveDial: (() => void) | undefined;
			const transport = fakeTransport({
				reconnect: vi.fn(
					() =>
						new Promise<void>((resolve) => {
							resolveDial = resolve;
						}),
				),
				abortIncumbent: vi.fn(async () => 'closed' as const),
			});
			const g = makeHarness({ transport, upstreamLossPolicy: 'hold' });
			g.reconnector.handleGoAway('5s');
			expect(vi.getTimerCount()).toBe(1); // the attempt deadline
			g.reconnector.parkUpstreamLost('host-parked');
			expect(g.sm.state).toBe('UPSTREAM_LOST');
			expect(vi.getTimerCount()).toBe(0);
			expect(transport.abortIncumbent).toHaveBeenCalledTimes(1);

			resolveDial?.();
			await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_DEADLINE_MS + 1);
			expect(g.sm.transitionTo).not.toHaveBeenCalledWith('ACTIVE');
			expect(g.sm.state).toBe('UPSTREAM_LOST');
			expect(g.reportError).not.toHaveBeenCalled();
			expect(g.sm.closeWithReason).not.toHaveBeenCalled();
			expect(transport.abortIncumbent).toHaveBeenCalledTimes(1);
		});

		it('a watchdog stall the host owns parks without touching the still-connected transport', async () => {
			const transport = fakeTransport({
				isConnected: true,
				disconnect: vi.fn(async () => {}),
				abortIncumbent: vi.fn(async () => 'closed' as const),
			});
			const h = makeHarness({
				watchdogMs: 100,
				transport,
				upstreamLossPolicy: 'hold',
				hostOwnsRecovery: () => true,
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(100);

			expect(h.sm.state).toBe('UPSTREAM_LOST');
			expect(h.eventBus.publish).toHaveBeenCalledWith('session.upstreamLost', {
				sessionId: 'sess_1',
				reason: 'host-owns-recovery',
			});
			// The incumbent is left for the host's redial (or close()) to end.
			expect(transport.abortIncumbent).not.toHaveBeenCalled();
			expect(transport.disconnect).not.toHaveBeenCalled();
			expect(h.clientTransport.startBuffering).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(transport.reconnect).not.toHaveBeenCalled();
		});
	});

	describe('watchdog replay recovery (two stages)', () => {
		const WD = 100;

		function retained(utteranceId = 1) {
			return { pcm: Buffer.alloc(320, 1), sampleRateHz: 16000, utteranceId, sealedAtMs: 0 };
		}

		function replayTransport(impl?: () => boolean) {
			const replayUserTurn = vi.fn(impl ?? (() => true));
			return {
				transport: fakeTransport({
					isConnected: true,
					replayUserTurn,
				} as unknown as Partial<LLMTransport>),
				replayUserTurn,
			};
		}

		it('STAGE 1: first fire replays in-place with NO reconnect and re-arms the watchdog', async () => {
			const { transport, replayUserTurn } = replayTransport();
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				peekRetainedUtterance: () => retained(),
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD);

			expect(replayUserTurn).toHaveBeenCalledTimes(1);
			expect(replayUserTurn).toHaveBeenCalledWith(expect.objectContaining({ utteranceId: 1 }));
			expect(transport.reconnect).not.toHaveBeenCalled();
			expect(h.sm.transitionTo).not.toHaveBeenCalledWith('RECONNECTING');
		});

		it('correlated model activity (resetReplayState) makes the next stall replay in-place again', async () => {
			const { transport, replayUserTurn } = replayTransport();
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				peekRetainedUtterance: () => retained(),
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD); // stage 1
			h.reconnector.resetReplayState(); // model answered — "nothing extra"

			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD);
			expect(replayUserTurn).toHaveBeenCalledTimes(2);
			expect(transport.reconnect).not.toHaveBeenCalled();
		});

		it('STAGE 2: second fire reconnects and replays the SAME utterance once; further fires fall to tier 3', async () => {
			const { transport, replayUserTurn } = replayTransport();
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				peekRetainedUtterance: () => retained(),
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD); // fire 1 → stage 1 (in-place), re-armed
			await vi.advanceTimersByTimeAsync(WD); // fire 2 → stage 2: reconnect
			expect(h.sm.transitionTo).toHaveBeenCalledWith('RECONNECTING');
			await vi.advanceTimersByTimeAsync(1000); // backoff attempt 1

			expect(transport.reconnect).toHaveBeenCalledTimes(1);
			expect(replayUserTurn).toHaveBeenCalledTimes(2); // in-place + after-reconnect
			expect(h.transport.elicitResponse).not.toHaveBeenCalled();

			// Fire 3 (replay window after stage 2 elapsed, still silent): reconnect
			// again, but the utterance is NOT replayed a third time — tier 3 nudge.
			await vi.advanceTimersByTimeAsync(WD);
			await vi.advanceTimersByTimeAsync(2000); // backoff attempt 2
			expect(transport.reconnect).toHaveBeenCalledTimes(2);
			expect(replayUserTurn).toHaveBeenCalledTimes(2);
			expect(h.transport.elicitResponse).toHaveBeenCalledTimes(1);
		});

		it('a NEW utterance sealed mid-recovery restarts at stage 1 (identity keying)', async () => {
			const { transport, replayUserTurn } = replayTransport();
			let id = 1;
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				peekRetainedUtterance: () => retained(id),
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD); // stage 1 for utterance 1
			id = 2; // user spoke again; new sealed utterance
			await vi.advanceTimersByTimeAsync(WD); // fires again → stage 1 for utterance 2
			expect(replayUserTurn).toHaveBeenCalledTimes(2);
			expect(replayUserTurn).toHaveBeenLastCalledWith(expect.objectContaining({ utteranceId: 2 }));
			expect(transport.reconnect).not.toHaveBeenCalled();
		});

		it('a THROWING replayUserTurn logs and falls through to the reconnect path', async () => {
			const { transport, replayUserTurn } = replayTransport(() => {
				throw new Error('SDK rejected payload');
			});
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				peekRetainedUtterance: () => retained(),
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD);
			expect(replayUserTurn).toHaveBeenCalledTimes(1);
			expect(h.sm.transitionTo).toHaveBeenCalledWith('RECONNECTING');
			expect(h.log).toHaveBeenCalledWith(
				expect.stringContaining('Retained utterance replay failed in-place'),
			);
		});

		it('isConnected=false skips stage 1; the utterance is replayed after the reconnect', async () => {
			const replayUserTurn = vi.fn(() => true);
			const transport = fakeTransport({
				isConnected: false,
				replayUserTurn,
			} as unknown as Partial<LLMTransport>);
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				peekRetainedUtterance: () => retained(),
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD); // straight to reconnect
			expect(h.sm.transitionTo).toHaveBeenCalledWith('RECONNECTING');
			await vi.advanceTimersByTimeAsync(1000);
			expect(replayUserTurn).toHaveBeenCalledTimes(1); // after reconnect only
		});

		it('FRESH SPEECH WINS: drained speech suppresses the stage-2 replay (no replay, no nudge)', async () => {
			const replayUserTurn = vi.fn(() => true);
			const transport = fakeTransport({
				isConnected: false,
				replayUserTurn,
			} as unknown as Partial<LLMTransport>);
			const ct = fakeClientTransport([Buffer.alloc(320, 99)]);
			const detectSpeech = vi.fn(() => true);
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				clientTransport: ct,
				detectSpeech,
				peekRetainedUtterance: () => retained(),
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD);
			await vi.advanceTimersByTimeAsync(1000);
			expect(detectSpeech).toHaveBeenCalledTimes(1);
			expect(replayUserTurn).not.toHaveBeenCalled();
			expect(h.transport.elicitResponse).not.toHaveBeenCalled();
			expect(h.log).toHaveBeenCalledWith(
				expect.stringContaining('Skipping retained replay — user spoke during reconnect'),
			);
		});

		it('silence-only drained chunks (continuous client streaming) do NOT suppress the replay', async () => {
			const replayUserTurn = vi.fn(() => true);
			const transport = fakeTransport({
				isConnected: false,
				replayUserTurn,
			} as unknown as Partial<LLMTransport>);
			const ct = fakeClientTransport([Buffer.alloc(320, 0)]);
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				clientTransport: ct,
				detectSpeech: () => false,
				peekRetainedUtterance: () => retained(),
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD);
			await vi.advanceTimersByTimeAsync(1000);
			expect(replayUserTurn).toHaveBeenCalledTimes(1);
		});

		it('hosted-shape empty drain: detectSpeech is not consulted and the replay proceeds', async () => {
			const replayUserTurn = vi.fn(() => true);
			const transport = fakeTransport({
				isConnected: false,
				replayUserTurn,
			} as unknown as Partial<LLMTransport>);
			const detectSpeech = vi.fn(() => true);
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				clientTransport: fakeClientTransport([]),
				detectSpeech,
				peekRetainedUtterance: () => retained(),
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD);
			await vi.advanceTimersByTimeAsync(1000);
			expect(detectSpeech).not.toHaveBeenCalled();
			expect(replayUserTurn).toHaveBeenCalledTimes(1);
		});

		it('R7a: a mid-speech fire defers — no replay, no reconnect, stage unchanged, NO re-arm', async () => {
			const { transport, replayUserTurn } = replayTransport();
			let speaking = true;
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				peekRetainedUtterance: () => retained(),
				isSpeechActive: () => speaking,
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD); // fire while user is speaking

			expect(replayUserTurn).not.toHaveBeenCalled();
			expect(h.sm.transitionTo).not.toHaveBeenCalledWith('RECONNECTING');
			expect(h.log).toHaveBeenCalledWith(expect.stringContaining('deferred'));

			// NOT re-armed: nothing happens however long the speech continues.
			await vi.advanceTimersByTimeAsync(WD * 5);
			expect(replayUserTurn).not.toHaveBeenCalled();
			expect(h.sm.transitionTo).not.toHaveBeenCalledWith('RECONNECTING');

			// The deferring speech completes and seals a NEW utterance — its own
			// completion re-arms the watchdog (session calls armResponseWatchdog).
			speaking = false;
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD);
			expect(replayUserTurn).toHaveBeenCalledTimes(1); // stage 1 for the retained utterance
			expect(h.sm.transitionTo).not.toHaveBeenCalledWith('RECONNECTING');
		});

		it('R7a: notifySegmentAborted after a deferred fire re-arms for the ORIGINAL retained utterance', async () => {
			const { transport, replayUserTurn } = replayTransport();
			let speaking = true;
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				peekRetainedUtterance: () => retained(7),
				isSpeechActive: () => speaking,
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD); // deferred (mid-speech)
			expect(replayUserTurn).not.toHaveBeenCalled();

			// The deferring segment resolves as ignored / force-reset — the session
			// aborts it and notifies; recovery for the original utterance resumes.
			speaking = false;
			h.reconnector.notifySegmentAborted();
			await vi.advanceTimersByTimeAsync(WD);
			expect(replayUserTurn).toHaveBeenCalledTimes(1);
			expect(replayUserTurn).toHaveBeenCalledWith(expect.objectContaining({ utteranceId: 7 }));
			expect(h.sm.transitionTo).not.toHaveBeenCalledWith('RECONNECTING'); // stage unchanged → stage 1
		});

		it('R7a: notifySegmentAborted without a deferred fire does NOT arm the watchdog', async () => {
			const { transport, replayUserTurn } = replayTransport();
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				peekRetainedUtterance: () => retained(),
				isSpeechActive: () => false,
			});
			h.reconnector.notifySegmentAborted();
			await vi.advanceTimersByTimeAsync(WD * 3);
			expect(replayUserTurn).not.toHaveBeenCalled();
		});

		it('R7c: local drained speech skips the replay AND re-arms the watchdog for the fresh speech', async () => {
			const replayUserTurn = vi.fn(() => true);
			const transport = fakeTransport({
				isConnected: false,
				replayUserTurn,
			} as unknown as Partial<LLMTransport>);
			const ct = fakeClientTransport([Buffer.alloc(320, 99)]);
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				clientTransport: ct,
				detectSpeech: () => true,
				peekRetainedUtterance: () => retained(),
			});
			const arm = vi.spyOn(h.reconnector, 'armResponseWatchdog');
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD);
			await vi.advanceTimersByTimeAsync(1000);

			expect(replayUserTurn).not.toHaveBeenCalled();
			// Re-armed after the skip: the drained speech bypassed VAD bookkeeping,
			// so a second stall on it must still have a recovery timer.
			expect(arm).toHaveBeenCalledTimes(2); // initial + post-skip re-arm
		});

		it('R7c: hosted-speech verdict suppresses the stage-2 replay and the nudge', async () => {
			const replayUserTurn = vi.fn(() => true);
			const transport = fakeTransport({
				isConnected: false,
				replayUserTurn,
			} as unknown as Partial<LLMTransport>);
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				clientTransport: fakeClientTransport([]),
				hostedReconnectSpeech: () => 'hosted-speech',
				peekRetainedUtterance: () => retained(),
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD);
			await vi.advanceTimersByTimeAsync(1000);

			expect(replayUserTurn).not.toHaveBeenCalled();
			expect(h.transport.elicitResponse).not.toHaveBeenCalled();
			expect(h.log).toHaveBeenCalledWith(
				expect.stringContaining('hosted user spoke during reconnect'),
			);
		});

		it('R7c: unknown hosted freshness suppresses the stage-2 replay (unsafe to guess)', async () => {
			const replayUserTurn = vi.fn(() => true);
			const transport = fakeTransport({
				isConnected: false,
				replayUserTurn,
			} as unknown as Partial<LLMTransport>);
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				clientTransport: fakeClientTransport([]),
				hostedReconnectSpeech: () => 'unknown',
				peekRetainedUtterance: () => retained(),
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD);
			await vi.advanceTimersByTimeAsync(1000);

			expect(replayUserTurn).not.toHaveBeenCalled();
			expect(h.transport.elicitResponse).not.toHaveBeenCalled();
			expect(h.log).toHaveBeenCalledWith(
				expect.stringContaining('reconnect-window speech state unknown'),
			);
		});

		it('R7c: a proven hosted "none" verdict permits the stage-2 replay', async () => {
			const replayUserTurn = vi.fn(() => true);
			const transport = fakeTransport({
				isConnected: false,
				replayUserTurn,
			} as unknown as Partial<LLMTransport>);
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				clientTransport: fakeClientTransport([]),
				hostedReconnectSpeech: () => 'none',
				peekRetainedUtterance: () => retained(),
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD);
			await vi.advanceTimersByTimeAsync(1000);
			expect(replayUserTurn).toHaveBeenCalledTimes(1);
		});

		it('R7b: onReplayDispatched fires on stage-1 and stage-2 replay success, never on the nudge', async () => {
			const { transport, replayUserTurn } = replayTransport();
			const onReplayDispatched = vi.fn();
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				peekRetainedUtterance: () => retained(),
				onReplayDispatched,
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD); // stage 1
			expect(onReplayDispatched).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(WD); // stage 2: reconnect + replay
			await vi.advanceTimersByTimeAsync(1000);
			expect(replayUserTurn).toHaveBeenCalledTimes(2);
			expect(onReplayDispatched).toHaveBeenCalledTimes(2);

			// Fire 3 → tier-3 nudge only: no further dispatch callback.
			await vi.advanceTimersByTimeAsync(WD);
			await vi.advanceTimersByTimeAsync(2000);
			expect(h.transport.elicitResponse).toHaveBeenCalledTimes(1);
			expect(onReplayDispatched).toHaveBeenCalledTimes(2);
		});

		it('R7b: onReplayDispatched does NOT fire when the replay throws or is deferred', async () => {
			const { transport } = replayTransport(() => {
				throw new Error('boom');
			});
			const onReplayDispatched = vi.fn();
			let speaking = false;
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				peekRetainedUtterance: () => retained(),
				isSpeechActive: () => speaking,
				onReplayDispatched,
			});
			speaking = true;
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD); // deferred (mid-speech)
			expect(onReplayDispatched).not.toHaveBeenCalled();

			speaking = false;
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD); // stage 1 attempt → throws
			expect(onReplayDispatched).not.toHaveBeenCalled();
		});

		it('transport-close reconnect never replays (no recovery without a watchdog stall)', async () => {
			const { transport, replayUserTurn } = replayTransport();
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				peekRetainedUtterance: () => retained(),
			});
			h.reconnector.handleTransportClose(1006, 'gone');
			await vi.advanceTimersByTimeAsync(1000);
			expect(transport.reconnect).toHaveBeenCalledTimes(1);
			expect(replayUserTurn).not.toHaveBeenCalled();
			expect(h.transport.elicitResponse).not.toHaveBeenCalled();
		});

		it('absent replayUserTurn falls back to the reconnect + tier-3 nudge path', async () => {
			const transport = fakeTransport({ isConnected: true } as unknown as Partial<LLMTransport>);
			const h = makeHarness({
				watchdogMs: WD,
				transport,
				peekRetainedUtterance: () => retained(),
			});
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD);
			expect(h.sm.transitionTo).toHaveBeenCalledWith('RECONNECTING');
			await vi.advanceTimersByTimeAsync(1000);
			expect(h.transport.elicitResponse).toHaveBeenCalledTimes(1);
		});

		it('no retained utterance keeps today’s behavior (reconnect + nudge)', async () => {
			const h = makeHarness({ watchdogMs: WD, peekRetainedUtterance: () => null });
			h.reconnector.armResponseWatchdog();
			await vi.advanceTimersByTimeAsync(WD);
			expect(h.sm.transitionTo).toHaveBeenCalledWith('RECONNECTING');
			await vi.advanceTimersByTimeAsync(1000);
			expect(h.transport.elicitResponse).toHaveBeenCalledTimes(1);
		});
	});
});
