import { MIN_PLAYBACK_RATE } from '@bodhi/client-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	PcmAudio,
	downsample,
	float32ToInt16,
	int16ToFloat32,
} from '../../clients/web-voice/src/index.js';

describe('PCM math', () => {
	it('downsample is identity at equal rates', () => {
		const input = new Float32Array([0.1, -0.2, 0.3]);
		expect(downsample(input, 48000, 48000)).toBe(input);
	});

	it('downsample halves length at 2:1 with interpolation', () => {
		const input = new Float32Array([0, 1, 0, -1, 0, 1, 0, -1]);
		const out = downsample(input, 32000, 16000);
		expect(out.length).toBe(4);
		expect(out[0]).toBeCloseTo(0);
		expect(out[1]).toBeCloseTo(0);
	});

	it('float32→int16→float32 round-trips within quantization error', () => {
		const input = new Float32Array([0, 0.5, -0.5, 0.999, -1]);
		const round = int16ToFloat32(float32ToInt16(input).buffer as ArrayBuffer);
		for (let i = 0; i < input.length; i++) {
			// The encoder truncates (|0), so allow two quantization steps.
			expect(Math.abs(round[i] - input[i])).toBeLessThan(2 / 32767);
		}
	});

	it('float32ToInt16 clamps out-of-range samples', () => {
		const i16 = float32ToInt16(new Float32Array([2, -2]));
		expect(i16[0]).toBe(0x7fff);
		expect(i16[1]).toBe(-0x8000);
	});
});

describe('PcmAudio.playbackRate', () => {
	it('clamps to the protocol floor', () => {
		const audio = new PcmAudio();
		audio.playbackRate = 0.5;
		expect(audio.playbackRate).toBe(MIN_PLAYBACK_RATE);
		audio.playbackRate = 1.2;
		expect(audio.playbackRate).toBe(1.2);
	});
});

describe('PcmAudio lifecycle', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('stops a microphone stream granted after teardown without creating an audio graph', async () => {
		let resolvePermission!: (stream: MediaStream) => void;
		const permission = new Promise<MediaStream>((resolve) => {
			resolvePermission = resolve;
		});
		const stop = vi.fn();
		const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
		const AudioContextCtor = vi.fn();
		vi.stubGlobal('AudioContext', AudioContextCtor);
		vi.stubGlobal('navigator', {
			mediaDevices: { getUserMedia: vi.fn(() => permission) },
		});

		const audio = new PcmAudio();
		const start = audio.startMic(vi.fn());
		audio.teardown();
		resolvePermission(stream);
		await start;

		expect(stop).toHaveBeenCalledOnce();
		expect(AudioContextCtor).not.toHaveBeenCalled();
		expect(audio.contextState).toBe('none');
	});

	it('reuses the pending AudioContext when reconnecting inside the close window', () => {
		vi.useFakeTimers();
		const close = vi.fn(() => Promise.resolve());
		const resume = vi.fn(() => Promise.resolve());
		const context = {
			state: 'running',
			sampleRate: 48000,
			currentTime: 0,
			close,
			resume,
		} as unknown as AudioContext;
		const AudioContextCtor = vi.fn(() => context);
		vi.stubGlobal('AudioContext', AudioContextCtor);

		const audio = new PcmAudio();
		audio.primeAudioContext();
		audio.teardown();
		audio.primeAudioContext();
		vi.advanceTimersByTime(3000);

		expect(AudioContextCtor).toHaveBeenCalledOnce();
		expect(close).not.toHaveBeenCalled();
		expect(audio.contextState).toBe('running');
		expect(audio.contextSampleRate).toBe(48000);
	});
});
