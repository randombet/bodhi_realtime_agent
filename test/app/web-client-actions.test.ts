import { PcmAudio } from '@bodhi/web-voice-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { endCall } from '../../app/web-client/src/actions.js';
import { state } from '../../app/web-client/src/state.js';
import { connectWs } from '../../app/web-client/src/ws.js';

describe('web-client call teardown', () => {
	const originalPcm = state.pcm;
	const originalWsUrl = state.wsUrl;

	afterEach(() => {
		state.ws = null;
		state.pcm = originalPcm;
		state.wsUrl = originalWsUrl;
		state.connected = false;
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('invalidates pending microphone permission synchronously when End is clicked', async () => {
		let resolvePermission!: (stream: MediaStream) => void;
		const permission = new Promise<MediaStream>((resolve) => {
			resolvePermission = resolve;
		});
		const stopTrack = vi.fn();
		const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
		const AudioContextCtor = vi.fn();
		vi.stubGlobal('AudioContext', AudioContextCtor);
		vi.stubGlobal('navigator', {
			mediaDevices: { getUserMedia: vi.fn(() => permission) },
		});

		const pcm = new PcmAudio();
		state.pcm = pcm;
		const micStart = pcm.startMic(vi.fn());
		const close = vi.fn();
		const staleOpen = vi.fn();
		const ws = { close, onopen: staleOpen } as unknown as WebSocket;
		state.ws = ws;
		state.connected = true;

		endCall();

		expect(close).toHaveBeenCalledOnce();
		expect(ws.onopen).toBeNull();
		expect(state.ws).toBeNull();
		expect(state.connected).toBe(false);

		resolvePermission(stream);
		await micStart;

		expect(stopTrack).toHaveBeenCalledOnce();
		expect(AudioContextCtor).not.toHaveBeenCalled();
		expect(pcm.contextState).toBe('none');
	});

	it('ignores close callbacks from a socket superseded by a fast reconnect', () => {
		vi.useFakeTimers();
		class FakeAudioContext {
			state: AudioContextState = 'running';
			sampleRate = 48_000;
			currentTime = 0;
			readonly close = vi.fn(async () => {
				this.state = 'closed';
			});
			readonly resume = vi.fn(async () => {});
		}
		class ControlledWebSocket {
			static readonly OPEN = 1;
			static readonly CLOSED = 3;
			static readonly instances: ControlledWebSocket[] = [];
			binaryType = '';
			readyState = 0;
			onopen: (() => Promise<void>) | null = null;
			onmessage: ((event: MessageEvent<ArrayBuffer | string>) => void) | null = null;
			onclose: (() => void) | null = null;
			onerror: (() => void) | null = null;
			readonly send = vi.fn();
			readonly close = vi.fn(() => {
				this.readyState = ControlledWebSocket.CLOSED;
			});

			constructor(_url: string) {
				ControlledWebSocket.instances.push(this);
			}
		}
		vi.stubGlobal('AudioContext', FakeAudioContext);
		vi.stubGlobal('WebSocket', ControlledWebSocket);
		state.pcm = new PcmAudio();
		state.wsUrl = 'ws://example.test/voice';
		state.connected = true;

		connectWs();
		const oldSocket = ControlledWebSocket.instances[0];
		expect(oldSocket).toBeDefined();
		endCall();

		state.connected = true;
		connectWs();
		const newSocket = ControlledWebSocket.instances[1];
		expect(newSocket).toBeDefined();
		expect(state.ws).toBe(newSocket);

		oldSocket?.onclose?.();

		expect(state.ws).toBe(newSocket);
		expect(state.connected).toBe(true);
		expect(state.statusState).toBe('connecting');
		endCall();
	});
});
