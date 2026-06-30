import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ReconnectSessionManager,
	TransportReconnectorDeps,
} from '../../src/core/transport-reconnector.js';
import { TransportReconnector } from '../../src/core/transport-reconnector.js';
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

function fakeClientTransport(buffered: Buffer[] = []): IClientChannel & {
	startBuffering: ReturnType<typeof vi.fn>;
	stopBuffering: ReturnType<typeof vi.fn>;
} {
	return {
		sendAudioToClient: vi.fn(),
		sendJsonToClient: vi.fn(),
		startBuffering: vi.fn(),
		stopBuffering: vi.fn(() => buffered),
	} as unknown as IClientChannel & {
		startBuffering: ReturnType<typeof vi.fn>;
		stopBuffering: ReturnType<typeof vi.fn>;
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
	};
	const reconnector = new TransportReconnector(deps, opts.watchdogMs ?? 8000);
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
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('CLOSED');
			vi.advanceTimersByTime(4000);
			await vi.runAllTimersAsync();
			expect(h.transport.reconnect).toHaveBeenCalledTimes(3);
		});

		it('CLOSEs immediately when there is no resumption handle', () => {
			const h = makeHarness({ handle: null });
			h.reconnector.triggerReconnect('transport-close');
			expect(h.transport.reconnect).not.toHaveBeenCalled();
			expect(h.sm.transitionTo).toHaveBeenCalledWith('CLOSED');
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
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('CLOSED');
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
			expect(h.sm.transitionTo).toHaveBeenLastCalledWith('CLOSED');

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

		it('GoAway is unbudgeted: it reconnects even after triggerReconnect spent the budget', async () => {
			const h = makeHarness({});
			for (let i = 0; i < 3; i++) {
				h.reconnector.triggerReconnect('transport-close');
				vi.advanceTimersByTime(4000);
				await vi.runAllTimersAsync();
			}
			expect(h.transport.reconnect).toHaveBeenCalledTimes(3);

			// triggerReconnect now gives up (budget spent)…
			h.reconnector.triggerReconnect('transport-close');
			expect(h.transport.reconnect).toHaveBeenCalledTimes(3);

			// …but GoAway still reconnects immediately (its own path, no budget).
			h.reconnector.handleGoAway('3s');
			await vi.runAllTimersAsync();
			expect(h.transport.reconnect).toHaveBeenCalledTimes(4);
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
