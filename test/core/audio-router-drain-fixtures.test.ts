import { describe, expect, it, vi } from 'vitest';
import { resamplePcm } from '../../src/audio/resample.js';
import { AudioRouter } from '../../src/core/audio-router.js';
import { ClientVadDetector } from '../../src/core/client-vad-detector.js';
import { encodePcmToMulaw } from '../../src/telephony/audio-codec.js';
import type { LLMTransport } from '../../src/types/transport.js';

/** Design G5 transport-specific output fixtures for H2 drain normalization:
 *  `sendPreAdmitted` must transform drained frames exactly like the live
 *  agent path — rate-match passthrough, resample, and G.711 µ-law encode. */

function makeRouter(audioFormat: {
	inputSampleRate: number;
	encoding: 'pcm' | 'pcmu';
}): { router: AudioRouter; sendAudio: ReturnType<typeof vi.fn> } {
	const sendAudio = vi.fn();
	const transport = {
		audioFormat: {
			inputSampleRate: audioFormat.inputSampleRate,
			outputSampleRate: 24000,
			channels: 1,
			bitDepth: 16,
			encoding: audioFormat.encoding,
		},
		sendAudio,
	} as unknown as LLMTransport;
	const router = new AudioRouter({
		transport,
		vad: new ClientVadDetector(
			{ onSpeechStart: vi.fn(), onVoicedFrame: vi.fn(), onSegmentResolved: vi.fn() },
			vi.fn(),
		),
		clientAudioInputRate: 16000,
		getSttProvider: () => undefined,
		getWhisperProvider: () => undefined,
		isSessionActive: () => true,
		isRtcAudioReady: () => false,
		getMode: () => 'agent',
		shouldDropOutbound: () => false,
		routeExternalAudio: () => false,
	});
	return { router, sendAudio };
}

function pcmFrame(): Buffer {
	const b = Buffer.alloc(480 * 2);
	for (let i = 0; i < b.length; i += 2) b.writeInt16LE(1000 + i, i);
	return b;
}

describe('sendPreAdmitted output fixtures', () => {
	it('PCM transport at the client rate: byte-for-byte passthrough', () => {
		const { router, sendAudio } = makeRouter({ inputSampleRate: 16000, encoding: 'pcm' });
		const frame = pcmFrame();
		router.sendPreAdmitted(frame);
		expect(sendAudio).toHaveBeenCalledWith(frame.toString('base64'));
	});

	it('PCM transport at a different rate: resampled like the live path', () => {
		const { router, sendAudio } = makeRouter({ inputSampleRate: 24000, encoding: 'pcm' });
		const frame = pcmFrame();
		router.sendPreAdmitted(frame);
		const expected = resamplePcm(frame, 16000, 24000, 16).toString('base64');
		expect(sendAudio).toHaveBeenCalledWith(expected);
	});

	it('G.711 µ-law transport: resampled to 8 kHz then µ-law encoded', () => {
		const { router, sendAudio } = makeRouter({ inputSampleRate: 8000, encoding: 'pcmu' });
		const frame = pcmFrame();
		router.sendPreAdmitted(frame);
		const expected = encodePcmToMulaw(resamplePcm(frame, 16000, 8000, 16)).toString('base64');
		expect(sendAudio).toHaveBeenCalledWith(expected);
	});
});
