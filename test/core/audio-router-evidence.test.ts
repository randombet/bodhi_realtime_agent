import { describe, expect, it, vi } from 'vitest';
import { AudioRouter, type AudioRouterDeps } from '../../src/core/audio-router.js';
import { VAD_FRAME } from '../../src/core/client-vad-detector.js';
import type { ClientVadDetector } from '../../src/core/client-vad-detector.js';
import type { VadTerminalDescriptor } from '../../src/core/client-vad-semantics.js';
import { UserTurnEvidenceLedger } from '../../src/core/user-turn-evidence.js';
import type { LLMTransport } from '../../src/types/transport.js';

/**
 * Phase-1 step 1.3: the router feeds ROUTED evidence with ONE gate read per
 * frame, updates the ledger's live record after the routing decision, and
 * finalizes terminal descriptors only after frame routing completes
 * (design-speech-evidence-architecture.md §1 route-outcome table).
 */

function pcm16(samples: number[]): Buffer {
	const b = Buffer.alloc(samples.length * 2);
	samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
	return b;
}
const FRAME = pcm16([100, -200, 300, -400, 500, -600]);

function mockTransport() {
	return {
		audioFormat: {
			inputSampleRate: 16000,
			outputSampleRate: 24000,
			channels: 1,
			bitDepth: 16,
			encoding: 'pcm',
		},
		sendAudio: vi.fn(),
	} as unknown as LLMTransport & { sendAudio: ReturnType<typeof vi.fn> };
}

/** Programmable VAD stub with the Phase-1 semantics surface. */
function stubVad() {
	const state = {
		flags: VAD_FRAME.NONE as number,
		segmentId: null as number | null,
		terminal: null as VadTerminalDescriptor | null,
	};
	const vad = {
		process: vi.fn(() => state.flags),
		takeTerminal: vi.fn(() => {
			const t = state.terminal;
			state.terminal = null;
			return t;
		}),
		get activeSegmentId() {
			return state.segmentId;
		},
	} as unknown as ClientVadDetector & { process: ReturnType<typeof vi.fn> };
	return { vad, state };
}

function makeRouter(
	over: Partial<AudioRouterDeps> & {
		transport: AudioRouterDeps['transport'];
		ledger: UserTurnEvidenceLedger;
	},
) {
	const { vad, state } = stubVad();
	let now = 0;
	const deps: AudioRouterDeps = {
		transport: over.transport,
		vad,
		clientAudioInputRate: 16000,
		getSttProvider: over.getSttProvider ?? (() => undefined),
		getWhisperProvider: over.getWhisperProvider ?? (() => undefined),
		isSessionActive: () => true,
		isRtcAudioReady: () => false,
		getMode: over.getMode ?? (() => 'agent'),
		shouldDropOutbound: over.shouldDropOutbound ?? (() => false),
		routeExternalAudio: over.routeExternalAudio ?? (() => false),
		ledger: over.ledger,
		getResponseEpoch: over.getResponseEpoch ?? (() => 0),
		nowMs: () => now,
	};
	return {
		router: new AudioRouter(deps),
		vad,
		state,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const START_VOICED = VAD_FRAME.SEGMENT_STARTED | VAD_FRAME.VOICED;

describe('AudioRouter → ledger routed evidence', () => {
	it('agent-mode gate-open voiced frames set routed.llm (and no other bit)', () => {
		const ledger = new UserTurnEvidenceLedger();
		const r = makeRouter({ transport: mockTransport(), ledger });
		r.state.segmentId = 1;
		r.state.flags = START_VOICED;
		r.router.handleFromClient(FRAME, 'websocket');
		const snap = ledger.getActiveSnapshot();
		expect(snap?.segmentId).toBe(1);
		expect(snap?.routed).toEqual({ llm: true, external: false, stt: false });
		expect(snap?.voicedFrames).toBe(1);
	});

	it('gate-drop frames set NO route bit', () => {
		const ledger = new UserTurnEvidenceLedger();
		const r = makeRouter({
			transport: mockTransport(),
			ledger,
			shouldDropOutbound: () => true,
		});
		r.state.segmentId = 1;
		r.state.flags = START_VOICED;
		r.router.handleFromClient(FRAME, 'websocket');
		expect(ledger.getActiveSnapshot()?.routed).toEqual({
			llm: false,
			external: false,
			stt: false,
		});
		expect(ledger.getActiveSnapshot()?.gateActiveAtSegmentStart).toBe(true);
	});

	it('external-audio mode sets routed.external before the gate', () => {
		const ledger = new UserTurnEvidenceLedger();
		const r = makeRouter({
			transport: mockTransport(),
			ledger,
			shouldDropOutbound: () => true,
			routeExternalAudio: () => true,
		});
		r.state.segmentId = 1;
		r.state.flags = START_VOICED;
		r.router.handleFromClient(FRAME, 'websocket');
		expect(ledger.getActiveSnapshot()?.routed).toEqual({
			llm: false,
			external: true,
			stt: false,
		});
	});

	it('transcription mode sets routed.stt even with whisper absent; transition buffering counts too', () => {
		const ledger = new UserTurnEvidenceLedger();
		const r = makeRouter({
			transport: mockTransport(),
			ledger,
			getMode: () => 'transcription',
		});
		r.state.segmentId = 1;
		r.state.flags = START_VOICED;
		r.router.handleFromClient(FRAME, 'websocket'); // no whisper provider
		expect(ledger.getActiveSnapshot()?.routed.stt).toBe(true);

		const ledger2 = new UserTurnEvidenceLedger();
		const r2 = makeRouter({
			transport: mockTransport(),
			ledger: ledger2,
			getMode: () => 'starting_transcription',
		});
		r2.state.segmentId = 1;
		r2.state.flags = START_VOICED;
		r2.router.handleFromClient(FRAME, 'websocket'); // buffered, maybe evicted later
		expect(ledger2.getActiveSnapshot()?.routed.stt).toBe(true);
	});

	it('a straddling segment keeps routed.llm once any voiced frame passes', () => {
		const ledger = new UserTurnEvidenceLedger();
		let gated = true;
		const r = makeRouter({
			transport: mockTransport(),
			ledger,
			shouldDropOutbound: () => gated,
		});
		r.state.segmentId = 1;
		r.state.flags = START_VOICED;
		r.router.handleFromClient(FRAME, 'websocket'); // gated head
		expect(ledger.getActiveSnapshot()?.routed.llm).toBe(false);
		gated = false;
		r.state.flags = VAD_FRAME.VOICED;
		r.router.handleFromClient(FRAME, 'websocket'); // routed tail
		expect(ledger.getActiveSnapshot()?.routed.llm).toBe(true);
	});

	it('the routed bit records the SAME gate decision used for routing (grace-expiry atomicity)', () => {
		const ledger = new UserTurnEvidenceLedger();
		// A gate whose value flips on every read: any second read would disagree.
		let reads = 0;
		const transport = mockTransport();
		const r = makeRouter({
			transport,
			ledger,
			shouldDropOutbound: () => reads++ % 2 === 0, // first read: drop
		});
		r.state.segmentId = 1;
		r.state.flags = START_VOICED;
		r.router.handleFromClient(FRAME, 'websocket');
		expect(reads).toBe(1); // exactly one read
		// First read said DROP → frame not sent AND not marked routed.
		expect(transport.sendAudio).not.toHaveBeenCalled();
		expect(ledger.getActiveSnapshot()?.routed.llm).toBe(false);
	});
});

describe('AudioRouter → ledger terminal finalization', () => {
	it('a TERMINAL frame finalizes the ledger AFTER routing that frame', () => {
		const ledger = new UserTurnEvidenceLedger();
		const transport = mockTransport();
		const r = makeRouter({ transport, ledger });
		r.state.segmentId = 1;
		r.state.flags = START_VOICED;
		r.router.handleFromClient(FRAME, 'websocket');

		const order: string[] = [];
		transport.sendAudio.mockImplementation(() => order.push('route'));
		ledger.observeTerminal(() => order.push('terminal'));

		r.state.segmentId = null; // detector closed the segment inside process()
		r.state.flags = VAD_FRAME.TERMINAL;
		r.state.terminal = {
			segmentId: 1,
			outcome: 'completed',
			terminalCause: 'silence',
			startedAtMs: 0,
			firstVoicedAtMs: 0,
			lastVoicedAtMs: 100,
			resolvedAtMs: 600,
		};
		r.router.handleFromClient(FRAME, 'websocket'); // the completing silent frame
		expect(order).toEqual(['route', 'terminal']);
		expect(ledger.getTerminalSnapshot(1)?.outcome).toBe('completed');
		expect(ledger.getTerminalSnapshot(1)?.routed.llm).toBe(true);
		expect(ledger.getActiveSnapshot()).toBeNull();
	});
});
