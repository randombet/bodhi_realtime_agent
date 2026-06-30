import { describe, expect, it, vi } from 'vitest';
import { AudioRouter, type AudioRouterDeps } from '../../src/core/audio-router.js';
import type { ClientVadDetector } from '../../src/core/client-vad-detector.js';
import type { LLMTransport } from '../../src/types/transport.js';

function makeDeps(overrides?: Partial<AudioRouterDeps>): AudioRouterDeps & {
	feedSpy: ReturnType<typeof vi.fn>;
	sendAudioSpy: ReturnType<typeof vi.fn>;
} {
	const feedSpy = vi.fn();
	const sendAudioSpy = vi.fn();
	const deps: AudioRouterDeps = {
		transport: {
			sendAudio: sendAudioSpy,
			audioFormat: {
				inputSampleRate: 16000,
				outputSampleRate: 24000,
				channels: 1,
				bitDepth: 16,
				encoding: 'pcm',
			},
		} as unknown as LLMTransport,
		vad: { process: vi.fn() } as unknown as ClientVadDetector,
		clientAudioInputRate: 16000,
		getSttProvider: () => undefined,
		getWhisperProvider: () => undefined,
		isSessionActive: () => true,
		isRtcAudioReady: () => false,
		getMode: () => 'agent' as const,
		shouldDropOutbound: () => false,
		routeExternalAudio: () => false,
		retainer: { feed: feedSpy },
		...overrides,
	};
	return Object.assign(deps, { feedSpy, sendAudioSpy });
}

const FRAME = Buffer.alloc(320, 7);

describe('AudioRouter — retention tee', () => {
	it('feeds the retainer the transport-normalized PCM on the agent path', () => {
		const deps = makeDeps();
		new AudioRouter(deps).handleFromClient(FRAME);
		expect(deps.feedSpy).toHaveBeenCalledTimes(1);
		expect(deps.feedSpy).toHaveBeenCalledWith(FRAME); // same rate → same buffer
		expect(deps.sendAudioSpy).toHaveBeenCalledTimes(1);
	});

	it('does NOT retain greeting-grace frames (shouldDropOutbound)', () => {
		const deps = makeDeps({ shouldDropOutbound: () => true });
		new AudioRouter(deps).handleFromClient(FRAME);
		expect(deps.feedSpy).not.toHaveBeenCalled();
		expect(deps.sendAudioSpy).not.toHaveBeenCalled();
	});

	it('does NOT retain transcription-mode frames', () => {
		const deps = makeDeps({ getMode: () => 'transcription' as const });
		new AudioRouter(deps).handleFromClient(FRAME);
		expect(deps.feedSpy).not.toHaveBeenCalled();
		expect(deps.sendAudioSpy).not.toHaveBeenCalled();
	});

	it('does NOT retain external-audio-agent frames', () => {
		const deps = makeDeps({ routeExternalAudio: () => true });
		new AudioRouter(deps).handleFromClient(FRAME);
		expect(deps.feedSpy).not.toHaveBeenCalled();
		expect(deps.sendAudioSpy).not.toHaveBeenCalled();
	});

	it('retains the resampled copy when client and transport rates differ', () => {
		const deps = makeDeps({ clientAudioInputRate: 48000 });
		new AudioRouter(deps).handleFromClient(Buffer.alloc(960, 7)); // 10 ms @48k
		expect(deps.feedSpy).toHaveBeenCalledTimes(1);
		const retained = deps.feedSpy.mock.calls[0]?.[0] as Buffer;
		expect(retained.length).toBe(320); // 10 ms @16k PCM16
	});

	it('works without a retainer (dep optional — dark rollout)', () => {
		const deps = makeDeps({ retainer: undefined });
		expect(() => new AudioRouter(deps).handleFromClient(FRAME)).not.toThrow();
		expect(deps.sendAudioSpy).toHaveBeenCalledTimes(1);
	});
});
