import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectRtcClientChannel } from '../../src/transport/direct-rtc-client-channel.js';
import {
	type DirectRtcModule,
	type DirectRtcModuleLoader,
	LazyRtcAudioEngine,
	loadDirectRtcModule,
} from '../../src/transport/lazy-rtc-audio-engine.js';
import type { RtcAudioEngine, RtcAudioEngineOptions } from '../../src/types/rtc-engine.js';

/** The package's private engine import, which the default loader imports first. */
const ENGINE_IMPORT = '#direct-rtc';

interface FakeEngine extends RtcAudioEngine {
	mediaReady: boolean;
	handleClientSignaling: ReturnType<typeof vi.fn>;
	sendAssistantPcm: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
}

function makeOptions(overrides: Partial<RtcAudioEngineOptions> = {}): RtcAudioEngineOptions {
	return {
		iceServers: undefined,
		inputPcmSampleRate: 16000,
		outputPcmSampleRate: 24000,
		onInboundPcm: vi.fn(),
		emitServerJson: vi.fn(),
		onLog: vi.fn(),
		...overrides,
	};
}

/** Stub loader whose module builds a fake engine; `resolve` lets a test hold the load pending. */
function makeLoader(opts: { deferred?: boolean } = {}) {
	const engines: FakeEngine[] = [];
	const captured: RtcAudioEngineOptions[] = [];
	const mod = {
		createWeriftOpusRtcEngine: (options: RtcAudioEngineOptions) => {
			captured.push(options);
			const engine: FakeEngine = {
				mediaReady: false,
				handleClientSignaling: vi.fn(async () => {}),
				sendAssistantPcm: vi.fn(),
				dispose: vi.fn(async () => {}),
			};
			engines.push(engine);
			return engine;
		},
	} as unknown as DirectRtcModule;
	let release: () => void = () => {};
	const gate = opts.deferred
		? new Promise<void>((r) => {
				release = r;
			})
		: Promise.resolve();
	const loader = vi.fn<DirectRtcModuleLoader>(async () => {
		await gate;
		return mod;
	});
	return { loader, engines, captured, resolve: () => release() };
}

describe('LazyRtcAudioEngine', () => {
	afterEach(() => {
		vi.doUnmock(ENGINE_IMPORT);
		vi.resetModules();
	});

	it('first rtc.offer triggers exactly one load and delegates signaling, also under concurrent signaling', async () => {
		const { loader, engines } = makeLoader();
		const lazy = new LazyRtcAudioEngine(makeOptions(), loader);
		expect(loader).not.toHaveBeenCalled();
		expect(lazy.mediaReady).toBe(false);

		const offer = { type: 'rtc.offer', sdp: 'v=0' } as const;
		const ice = { type: 'rtc.ice_candidate', candidate: { candidate: 'candidate:1' } } as const;
		// Concurrent signaling still loads once.
		await Promise.all([lazy.handleClientSignaling(offer), lazy.handleClientSignaling(ice)]);
		expect(loader).toHaveBeenCalledOnce();
		expect(engines).toHaveLength(1);
		expect(engines[0].handleClientSignaling).toHaveBeenNthCalledWith(1, offer);
		expect(engines[0].handleClientSignaling).toHaveBeenNthCalledWith(2, ice);

		engines[0].mediaReady = true;
		expect(lazy.mediaReady).toBe(true);
	});

	it('assistant PCM sent before the load is delivered after onMediaReady', async () => {
		// The channel always builds the lazy engine with its default loader; stub the
		// module that loader imports first and hold it pending.
		const { loader, engines, captured, resolve } = makeLoader({ deferred: true });
		vi.doMock(ENGINE_IMPORT, () => loader());
		const sender = { sendAudio: vi.fn(), sendJson: vi.fn() };
		const channel = new DirectRtcClientChannel({
			sender,
			weriftOpus: {
				inputPcmSampleRate: 16000,
				outputPcmSampleRate: 24000,
				onInboundPcm: vi.fn(),
			},
		});

		const offer = { type: 'rtc.offer', sdp: 'v=0' } as const;
		channel.feedSignaling(offer);
		const pcm = Buffer.from([1, 2, 3, 4]);
		channel.sendAudioToClient(pcm);
		expect(channel.isRtcAudioReady).toBe(false);

		resolve();
		await vi.waitFor(() => expect(engines[0]?.handleClientSignaling).toHaveBeenCalledWith(offer));
		expect(loader).toHaveBeenCalledOnce();
		expect(engines[0].sendAssistantPcm).not.toHaveBeenCalled();

		engines[0].mediaReady = true;
		captured[0].onMediaReady?.();
		expect(channel.isRtcAudioReady).toBe(true);
		expect(engines[0].sendAssistantPcm).toHaveBeenCalledOnce();
		expect(engines[0].sendAssistantPcm).toHaveBeenCalledWith(pcm);
		// Assistant audio never falls back to the WebSocket PCM path.
		expect(sender.sendAudio).not.toHaveBeenCalled();
	});

	it('a rejected load emits rtc.error once and logs the internal engine entry name', async () => {
		const loader = vi.fn<DirectRtcModuleLoader>(async () => {
			throw new Error('Cannot find package');
		});
		const options = makeOptions();
		const lazy = new LazyRtcAudioEngine(options, loader);

		await lazy.handleClientSignaling({ type: 'rtc.offer', sdp: 'v=0' });
		await lazy.handleClientSignaling({
			type: 'rtc.ice_candidate',
			candidate: { candidate: 'candidate:1' },
		});

		expect(loader).toHaveBeenCalledOnce();
		expect(options.emitServerJson).toHaveBeenCalledOnce();
		expect(options.emitServerJson).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'rtc.error' }),
		);
		expect(options.onLog).toHaveBeenCalledWith(expect.stringContaining(ENGINE_IMPORT));
		expect(lazy.mediaReady).toBe(false);
	});

	it('a load failing after dispose emits no rtc.error', async () => {
		let fail: (err: Error) => void = () => {};
		const loader = vi.fn<DirectRtcModuleLoader>(
			() =>
				new Promise<DirectRtcModule>((_, reject) => {
					fail = reject;
				}),
		);
		const options = makeOptions();
		const lazy = new LazyRtcAudioEngine(options, loader);

		const signaling = lazy.handleClientSignaling({ type: 'rtc.offer', sdp: 'v=0' });
		const disposing = lazy.dispose();
		fail(new Error('Cannot find package'));
		await Promise.all([signaling, disposing]);

		expect(loader).toHaveBeenCalledOnce();
		// The channel is being torn down: the failure stays in the server log only.
		expect(options.emitServerJson).not.toHaveBeenCalled();
		expect(options.onLog).toHaveBeenCalledWith(expect.stringContaining(ENGINE_IMPORT));
	});

	it('dispose during a pending load disposes the engine once it arrives', async () => {
		const { loader, engines, resolve } = makeLoader({ deferred: true });
		const lazy = new LazyRtcAudioEngine(makeOptions(), loader);

		const signaling = lazy.handleClientSignaling({ type: 'rtc.offer', sdp: 'v=0' });
		const disposing = lazy.dispose();
		resolve();
		await Promise.all([signaling, disposing]);

		expect(engines).toHaveLength(1);
		expect(engines[0].dispose).toHaveBeenCalledOnce();
		// Disposed before the engine arrived: the offer is not delegated to it.
		expect(engines[0].handleClientSignaling).not.toHaveBeenCalled();
	});

	it('with the default loader, a #direct-rtc miss falls back to the source module and yields createWeriftOpusRtcEngine', async () => {
		// Without a built dist the private import maps to a missing file under vitest. CI
		// builds before it tests, and a built dist would satisfy it, so force the miss to
		// keep this case on the source-module fallback that source-mode runs rely on.
		const missingEntry = vi.fn(() => {
			throw Object.assign(new Error(`Cannot find module '${ENGINE_IMPORT}'`), {
				code: 'ERR_MODULE_NOT_FOUND',
			});
		});
		vi.doMock(ENGINE_IMPORT, missingEntry);

		const mod = await loadDirectRtcModule();
		const source = await import('../../src/direct-rtc/index.js');
		// The private package import is tried first.
		expect(missingEntry).toHaveBeenCalledOnce();
		expect(typeof mod.createWeriftOpusRtcEngine).toBe('function');
		expect(mod.createWeriftOpusRtcEngine).toBe(source.createWeriftOpusRtcEngine);
	});
});
