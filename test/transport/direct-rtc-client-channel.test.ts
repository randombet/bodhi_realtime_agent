import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectRtcClientChannel } from '../../src/transport/direct-rtc-client-channel.js';
import type { RtcAudioEngine, RtcAudioEngineOptions } from '../../src/types/rtc-engine.js';

/** The private package import the channel's lazy engine loads the shipped engine from. */
const ENGINE_IMPORT = '#direct-rtc';

/** In-memory `RtcAudioEngine`: records calls and the options it was built with. */
class FakeRtcEngine implements RtcAudioEngine {
	mediaReady = false;
	readonly handleClientSignaling = vi.fn(async (_msg: unknown) => {});
	readonly sendAssistantPcm = vi.fn((_pcm: Buffer) => {});
	readonly dispose = vi.fn(async () => {});
	constructor(readonly options: RtcAudioEngineOptions) {}
}

/**
 * A `werift_opus` channel whose engine module is stubbed at the `#direct-rtc` import, so
 * neither werift nor `@evan/opus` is loaded. The engine is built on the first signaling
 * message; `loadEngine` sends an offer and resolves once it exists.
 */
function makeEngineChannel() {
	const engines: FakeRtcEngine[] = [];
	const createWeriftOpusRtcEngine = vi.fn((options: RtcAudioEngineOptions) => {
		const engine = new FakeRtcEngine(options);
		engines.push(engine);
		return engine;
	});
	vi.doMock(ENGINE_IMPORT, () => ({ createWeriftOpusRtcEngine }));
	const sender = { sendAudio: vi.fn(), sendJson: vi.fn() };
	const channel = new DirectRtcClientChannel({
		sender,
		weriftOpus: {
			iceServers: [{ urls: 'stun:stun.example:3478' }],
			inputPcmSampleRate: 16000,
			outputPcmSampleRate: 24000,
			onInboundPcm: vi.fn(),
		},
	});
	const offer = { type: 'rtc.offer' as const, sdp: 'v=0' };
	const loadEngine = async (): Promise<FakeRtcEngine> => {
		channel.feedSignaling(offer);
		await vi.waitFor(() => expect(engines[0]?.handleClientSignaling).toHaveBeenCalledWith(offer));
		return engines[0];
	};
	return { channel, sender, createWeriftOpusRtcEngine, offer, loadEngine };
}

describe('DirectRtcClientChannel', () => {
	it('forwards JSON via sender', () => {
		const sendJson = vi.fn();
		const sendAudio = vi.fn();
		const ch = new DirectRtcClientChannel({
			sender: { sendAudio, sendJson },
		});
		ch.sendJsonToClient({
			type: 'session.config',
			audioFormat: {
				inputSampleRate: 16000,
				outputSampleRate: 24000,
				channels: 1,
				bitDepth: 16,
				encoding: 'pcm',
			},
			clientMedia: { kind: 'websocket' },
			clientSignalSource: 'websocket_json',
			clientAudioSource: 'websocket_pcm',
		});
		expect(sendJson).toHaveBeenCalledOnce();
	});

	it('records feedSignaling', () => {
		const ch = new DirectRtcClientChannel({
			sender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		});
		const msg = { type: 'rtc.offer' as const, sdp: 'v=0' };
		ch.feedSignaling(msg);
		expect(ch.lastClientSignaling).toEqual(msg);
	});

	it('stopBuffering() flushes buffered assistant audio to the client sink and returns []', () => {
		// H1 (design-hosted-replay-recovery-rollout.md P1): buffered audio is
		// OUTBOUND assistant speech — it must reach the client, never the
		// reconnect drain (which pumps returned chunks into the LLM as input).
		const sendAudio = vi.fn();
		const ch = new DirectRtcClientChannel({
			sender: { sendAudio, sendJson: vi.fn() },
		});

		ch.startBuffering();
		ch.sendAudioToClient(Buffer.from('assistant-one'));
		ch.sendAudioToClient(Buffer.from('assistant-two'));
		expect(sendAudio).not.toHaveBeenCalled(); // held while buffering

		const drained = ch.stopBuffering();
		expect(drained).toEqual([]);
		expect(sendAudio.mock.calls.map((c) => c[0])).toEqual([
			Buffer.from('assistant-one'),
			Buffer.from('assistant-two'),
		]);
	});

	it('audio sent after stopBuffering() flows to the sink directly (no re-buffer)', () => {
		const sendAudio = vi.fn();
		const ch = new DirectRtcClientChannel({
			sender: { sendAudio, sendJson: vi.fn() },
		});
		ch.startBuffering();
		ch.stopBuffering();
		ch.sendAudioToClient(Buffer.from('live'));
		expect(sendAudio).toHaveBeenCalledWith(Buffer.from('live'));
	});

	describe('with werift_opus RTC audio (engine stubbed at the #direct-rtc import)', () => {
		afterEach(() => {
			vi.doUnmock(ENGINE_IMPORT);
			vi.resetModules();
		});

		it('builds the engine with the configured PCM rates and an emitServerJson that reaches sender.sendJson', async () => {
			const { createWeriftOpusRtcEngine, loadEngine, sender } = makeEngineChannel();
			const engine = await loadEngine();
			expect(createWeriftOpusRtcEngine).toHaveBeenCalledOnce();
			expect(engine.options.inputPcmSampleRate).toBe(16000);
			expect(engine.options.outputPcmSampleRate).toBe(24000);
			expect(engine.options.iceServers).toEqual([{ urls: 'stun:stun.example:3478' }]);

			engine.options.emitServerJson({ type: 'rtc.answer', sdp: 'v=0' });
			expect(sender.sendJson).toHaveBeenCalledWith({ type: 'rtc.answer', sdp: 'v=0' });
		});

		it('feedSignaling(rtc.offer) reaches the engine and is recorded', async () => {
			const { channel, loadEngine, offer } = makeEngineChannel();
			const engine = await loadEngine();
			expect(engine.handleClientSignaling).toHaveBeenCalledOnce();
			expect(engine.handleClientSignaling).toHaveBeenCalledWith(offer);
			expect(channel.lastClientSignaling).toEqual(offer);
		});

		it('buffers assistant PCM before media-ready and flushes it once on onMediaReady', async () => {
			const { channel, loadEngine, sender } = makeEngineChannel();
			// One chunk before the engine exists, one after it loaded but before media.
			channel.sendAudioToClient(Buffer.from('one'));
			const engine = await loadEngine();
			channel.sendAudioToClient(Buffer.from('two'));
			expect(engine.sendAssistantPcm).not.toHaveBeenCalled();
			expect(sender.sendAudio).not.toHaveBeenCalled(); // never the WebSocket PCM path
			expect(channel.isRtcAudioReady).toBe(false);

			engine.mediaReady = true;
			engine.options.onMediaReady?.();
			expect(channel.isRtcAudioReady).toBe(true);
			expect(engine.sendAssistantPcm).toHaveBeenCalledOnce();
			expect(engine.sendAssistantPcm).toHaveBeenCalledWith(Buffer.from('onetwo'));

			channel.sendAudioToClient(Buffer.from('live'));
			expect(engine.sendAssistantPcm).toHaveBeenCalledTimes(2);
			expect(engine.sendAssistantPcm).toHaveBeenLastCalledWith(Buffer.from('live'));
			expect(sender.sendAudio).not.toHaveBeenCalled();
		});

		it('stop() disposes the engine', async () => {
			const { channel, loadEngine } = makeEngineChannel();
			const engine = await loadEngine();
			await channel.stop();
			expect(engine.dispose).toHaveBeenCalledOnce();
		});
	});
});
