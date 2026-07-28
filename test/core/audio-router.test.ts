import { describe, expect, it, vi } from 'vitest';
import { AudioRouter, type AudioRouterDeps } from '../../src/core/audio-router.js';
import { VAD_FRAME } from '../../src/core/client-vad-detector.js';
import type { ClientVadDetector } from '../../src/core/client-vad-detector.js';
import { encodePcmToMulaw } from '../../src/telephony/audio-codec.js';
import type { LLMTransport, STTProvider } from '../../src/types/transport.js';

function pcm16(samples: number[]): Buffer {
	const b = Buffer.alloc(samples.length * 2);
	samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
	return b;
}

const FRAME = pcm16([100, -200, 300, -400, 500, -600]);

function mockTransport(inputSampleRate: number, encoding: 'pcm' | 'pcmu') {
	return {
		audioFormat: { inputSampleRate, outputSampleRate: 24000, channels: 1, bitDepth: 16, encoding },
		sendAudio: vi.fn(),
	} as unknown as LLMTransport & { sendAudio: ReturnType<typeof vi.fn> };
}

function makeRouter(over: Partial<AudioRouterDeps> & { transport: AudioRouterDeps['transport'] }) {
	const vad = { process: vi.fn() } as unknown as ClientVadDetector & {
		process: ReturnType<typeof vi.fn>;
	};
	const deps: AudioRouterDeps = {
		transport: over.transport,
		vad,
		clientAudioInputRate: over.clientAudioInputRate ?? 16000,
		getSttProvider: over.getSttProvider ?? (() => undefined),
		getWhisperProvider: over.getWhisperProvider ?? (() => undefined),
		isSessionActive: over.isSessionActive ?? (() => true),
		isRtcAudioReady: over.isRtcAudioReady ?? (() => false),
		getMode: over.getMode ?? (() => 'agent'),
		shouldDropOutbound: over.shouldDropOutbound ?? (() => false),
		routeExternalAudio: over.routeExternalAudio ?? (() => false),
	};
	return { router: new AudioRouter(deps), vad };
}

describe('AudioRouter — encode path', () => {
	it('forwards raw base64 PCM to a rate-matched PCM transport (no resample)', () => {
		const transport = mockTransport(16000, 'pcm');
		const { router, vad } = makeRouter({ transport, clientAudioInputRate: 16000 });
		router.handleFromClient(FRAME, 'websocket');
		expect(vad.process).toHaveBeenCalledWith(FRAME);
		expect(transport.sendAudio).toHaveBeenCalledTimes(1);
		expect(transport.sendAudio).toHaveBeenCalledWith(FRAME.toString('base64'));
	});

	it('μ-law-encodes for a telephony (pcmu) transport', () => {
		const transport = mockTransport(8000, 'pcmu');
		const { router } = makeRouter({ transport, clientAudioInputRate: 8000 });
		router.handleFromClient(FRAME, 'websocket');
		expect(transport.sendAudio).toHaveBeenCalledWith(encodePcmToMulaw(FRAME).toString('base64'));
	});
});

describe('AudioRouter — gates and dispatch', () => {
	it('drops outbound audio during the greeting grace window (VAD still runs)', () => {
		const transport = mockTransport(16000, 'pcm');
		const { router, vad } = makeRouter({ transport, shouldDropOutbound: () => true });
		router.handleFromClient(FRAME, 'websocket');
		expect(vad.process).toHaveBeenCalledTimes(1); // local VAD still processes
		expect(transport.sendAudio).not.toHaveBeenCalled(); // downstream gated
	});

	it('ignores websocket frames while the RTC audio plane is ready (before VAD)', () => {
		const transport = mockTransport(16000, 'pcm');
		const { router, vad } = makeRouter({ transport, isRtcAudioReady: () => true });
		router.handleFromClient(FRAME, 'websocket');
		expect(vad.process).not.toHaveBeenCalled();
		expect(transport.sendAudio).not.toHaveBeenCalled();
		// An RTC-sourced frame is still routed even when the plane is ready.
		router.handleFromClient(FRAME, 'rtc');
		expect(vad.process).toHaveBeenCalledTimes(1);
	});

	it('does nothing when the session is not active', () => {
		const transport = mockTransport(16000, 'pcm');
		const { router, vad } = makeRouter({ transport, isSessionActive: () => false });
		router.handleFromClient(FRAME, 'websocket');
		expect(vad.process).not.toHaveBeenCalled();
		expect(transport.sendAudio).not.toHaveBeenCalled();
	});

	it('hands a frame to the external-audio handler instead of the transport', () => {
		const transport = mockTransport(16000, 'pcm');
		const routeExternalAudio = vi.fn(() => true);
		const { router, vad } = makeRouter({ transport, routeExternalAudio });
		router.handleFromClient(FRAME, 'websocket');
		expect(vad.process).toHaveBeenCalledTimes(1);
		expect(routeExternalAudio).toHaveBeenCalledWith(FRAME);
		expect(transport.sendAudio).not.toHaveBeenCalled();
	});

	it('feeds the STT provider raw PCM at its native rate', () => {
		const transport = mockTransport(16000, 'pcm');
		const stt = { supportedEncodings: ['pcm'], feedAudio: vi.fn() } as unknown as STTProvider;
		const { router } = makeRouter({ transport, getSttProvider: () => stt });
		router.handleFromClient(FRAME, 'websocket');
		expect(stt.feedAudio as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
			FRAME.toString('base64'),
		);
	});
});

describe('AudioRouter — transcription mode', () => {
	it('routes to whisper in transcription mode and not to the transport', () => {
		const transport = mockTransport(16000, 'pcm');
		const whisper = { feedAudio: vi.fn() } as unknown as STTProvider;
		const { router } = makeRouter({
			transport,
			getMode: () => 'transcription',
			getWhisperProvider: () => whisper,
			clientAudioInputRate: 24000, // matches whisper's rate → no resample
		});
		router.handleFromClient(FRAME, 'websocket');
		expect(whisper.feedAudio as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
			FRAME.toString('base64'),
		);
		expect(transport.sendAudio).not.toHaveBeenCalled();
	});

	it('buffers frames during starting_transcription, then drains them FIFO to whisper', () => {
		const transport = mockTransport(16000, 'pcm');
		const whisper = { feedAudio: vi.fn() } as unknown as STTProvider;
		let mode: 'starting_transcription' | 'transcription' = 'starting_transcription';
		const { router } = makeRouter({
			transport,
			getMode: () => mode,
			getWhisperProvider: () => whisper,
			clientAudioInputRate: 24000,
		});
		const a = pcm16([1, 2]);
		const b = pcm16([3, 4]);
		router.handleFromClient(a, 'websocket');
		router.handleFromClient(b, 'websocket');
		expect(whisper.feedAudio).not.toHaveBeenCalled(); // buffered, not yet flushed

		mode = 'transcription';
		router.drainTransitionBufferToWhisper();
		const calls = (whisper.feedAudio as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
		expect(calls).toEqual([a.toString('base64'), b.toString('base64')]); // FIFO order
	});
});

describe('AudioRouter — per-segment route flag (Phase 0 tactical contract)', () => {
	const VOICED_START = VAD_FRAME.SEGMENT_STARTED | VAD_FRAME.VOICED;

	it('investigation 8b: the flag resets on every segment start and never leaks into a gated segment', () => {
		const transport = mockTransport(16000, 'pcm');
		let gated = true;
		const { router, vad } = makeRouter({ transport, shouldDropOutbound: () => gated });

		// Gated segment: voiced frames dropped → flag stays false.
		vad.process.mockReturnValueOnce(VOICED_START);
		router.handleFromClient(FRAME, 'websocket');
		expect(router.wasSegmentVoicedPastGate()).toBe(false);
		vad.process.mockReturnValueOnce(VAD_FRAME.VOICED);
		router.handleFromClient(FRAME, 'websocket');
		expect(router.wasSegmentVoicedPastGate()).toBe(false);

		// Ungated segment: routed voiced frame → flag true.
		gated = false;
		vad.process.mockReturnValueOnce(VOICED_START);
		router.handleFromClient(FRAME, 'websocket');
		expect(router.wasSegmentVoicedPastGate()).toBe(true);

		// Next gated segment: SEGMENT_STARTED resets — no stale true.
		gated = true;
		vad.process.mockReturnValueOnce(VOICED_START);
		router.handleFromClient(FRAME, 'websocket');
		expect(router.wasSegmentVoicedPastGate()).toBe(false);
	});

	it('trailing-silence frames routed after release do not set the flag (voiced-only)', () => {
		const transport = mockTransport(16000, 'pcm');
		let gated = true;
		const { router, vad } = makeRouter({ transport, shouldDropOutbound: () => gated });

		vad.process.mockReturnValueOnce(VOICED_START);
		router.handleFromClient(FRAME, 'websocket'); // gated voiced
		gated = false; // release during trailing silence
		vad.process.mockReturnValueOnce(VAD_FRAME.NONE);
		router.handleFromClient(FRAME, 'websocket'); // routed SILENT frame
		expect(transport.sendAudio).toHaveBeenCalledTimes(1);
		expect(router.wasSegmentVoicedPastGate()).toBe(false);
	});

	it('external-audio consumption sets the flag pre-gate (exemption preserved)', () => {
		const transport = mockTransport(16000, 'pcm');
		const { router, vad } = makeRouter({
			transport,
			shouldDropOutbound: () => true,
			routeExternalAudio: () => true,
		});
		vad.process.mockReturnValueOnce(VOICED_START);
		router.handleFromClient(FRAME, 'websocket');
		expect(router.wasSegmentVoicedPastGate()).toBe(true);
	});

	it('transcription-mode routing sets the flag even with the gate armed', () => {
		const transport = mockTransport(16000, 'pcm');
		const { router, vad } = makeRouter({
			transport,
			shouldDropOutbound: () => true,
			getMode: () => 'transcription',
		});
		vad.process.mockReturnValueOnce(VOICED_START);
		router.handleFromClient(FRAME, 'websocket');
		expect(router.wasSegmentVoicedPastGate()).toBe(true);
	});

	it('investigation 8 (atomicity): exactly ONE shouldDropOutbound read per agent-mode frame', () => {
		const transport = mockTransport(16000, 'pcm');
		const gate = vi.fn(() => false);
		const { router, vad } = makeRouter({ transport, shouldDropOutbound: gate });
		vad.process.mockReturnValueOnce(VOICED_START);
		router.handleFromClient(FRAME, 'websocket');
		expect(gate).toHaveBeenCalledTimes(1);
		vad.process.mockReturnValueOnce(VAD_FRAME.VOICED);
		router.handleFromClient(FRAME, 'websocket');
		expect(gate).toHaveBeenCalledTimes(2);
	});
});
