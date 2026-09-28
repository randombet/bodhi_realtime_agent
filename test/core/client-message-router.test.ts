import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ClientMessageRouter,
	type ClientMessageRouterDeps,
	type PlaybackDeferArbiter,
} from '../../src/core/client-message-router.js';
import type { EventBus } from '../../src/core/event-bus.js';
import type { PlaybackGate } from '../../src/core/playback-gate.js';

function fakeGate(over: Partial<PlaybackGate> = {}): PlaybackGate {
	return {
		pending: true,
		timerArmed: true,
		id: 1,
		...over,
	} as never;
}

function makeRouter(over: Partial<ClientMessageRouterDeps> = {}) {
	const publish = vi.fn();
	const handleClientSet = vi.fn();
	const sendFile = vi.fn();
	const addUserMessage = vi.fn();
	const handleTextInput = vi.fn().mockResolvedValue(undefined);
	const onClientJson = vi.fn();
	const reportError = vi.fn();
	const feedSignaling = vi.fn();
	const finishOrDeferForVad = vi.fn();
	const arbiter: PlaybackDeferArbiter = { hasDeferred: false, finishOrDeferForVad };

	const deps: ClientMessageRouterDeps = {
		getDirectRtcChannel: () => null,
		getBehaviorManager: () => ({ handleClientSet }),
		eventBus: { publish } as unknown as EventBus,
		getSessionActive: () => true,
		conversationContext: { addUserMessage } as never,
		sendFile,
		getArbiter: () => arbiter,
		getLiveGate: () => fakeGate(),
		getPlaybackStateProtocolActive: () => true,
		sessionId: 'sess-1',
		getArtifactRegistry: () => undefined,
		handleTextInput,
		onClientJson,
		reportError,
		log: vi.fn(),
		...over,
	};

	return {
		router: new ClientMessageRouter(deps),
		publish,
		handleClientSet,
		sendFile,
		addUserMessage,
		handleTextInput,
		onClientJson,
		reportError,
		feedSignaling,
		finishOrDeferForVad,
		arbiter,
	};
}

describe('ClientMessageRouter', () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	it('routes RTC signaling to the direct channel and stops', () => {
		const feedSignaling = vi.fn();
		const { router, onClientJson } = makeRouter({
			getDirectRtcChannel: () => ({ feedSignaling }),
		});
		// A valid RTC signaling message (type 'rtc.offer' with sdp).
		router.dispatch({ type: 'rtc.offer', sdp: 'v=0' });
		expect(feedSignaling).toHaveBeenCalledTimes(1);
		expect(onClientJson).not.toHaveBeenCalled();
	});

	it('routes behavior.set to the behavior manager', () => {
		const { router, handleClientSet } = makeRouter();
		router.dispatch({ type: 'behavior.set', key: 'tone', preset: 'warm' });
		expect(handleClientSet).toHaveBeenCalledWith('tone', 'warm');
	});

	it('routes ui.response to the event bus', () => {
		const { router, publish } = makeRouter();
		const payload = { requestId: 'r1', selectedOptionId: 'opt' };
		router.dispatch({ type: 'ui.response', payload });
		expect(publish).toHaveBeenCalledWith('subagent.ui.response', {
			sessionId: 'sess-1',
			response: payload,
		});
	});

	it('routes file_upload to sendFile and records the upload', () => {
		const { router, sendFile, addUserMessage } = makeRouter();
		router.dispatch({
			type: 'file_upload',
			data: { base64: 'abc', mimeType: 'image/png', fileName: 'pic.png' },
		});
		expect(sendFile).toHaveBeenCalledWith('abc', 'image/png');
		expect(addUserMessage).toHaveBeenCalledWith('[Uploaded file: pic.png]');
	});

	it('routes audio uploads to sendFile', () => {
		const sendInlineFile = vi.fn();
		const { router, sendFile } = makeRouter({ sendInlineFile });
		router.dispatch({
			type: 'file_upload',
			data: { base64: 'abc', mimeType: 'audio/wav', fileName: 'memo.wav' },
		});
		expect(sendFile).toHaveBeenCalledWith('abc', 'audio/wav');
		expect(sendInlineFile).not.toHaveBeenCalled();
	});

	it('routes non-media uploads to sendInlineFile and still records the upload', () => {
		const sendInlineFile = vi.fn();
		const { router, sendFile, addUserMessage } = makeRouter({ sendInlineFile });
		router.dispatch({
			type: 'file_upload',
			data: { base64: 'abc', mimeType: 'application/pdf', fileName: 'doc.pdf' },
		});
		expect(sendInlineFile).toHaveBeenCalledWith('abc', 'application/pdf');
		expect(sendFile).not.toHaveBeenCalled();
		expect(addUserMessage).toHaveBeenCalledWith('[Uploaded file: doc.pdf]');
	});

	it('routes non-media uploads to sendFile when sendInlineFile is not wired', () => {
		const { router, sendFile } = makeRouter();
		router.dispatch({
			type: 'file_upload',
			data: { base64: 'abc', mimeType: 'application/pdf', fileName: 'doc.pdf' },
		});
		expect(sendFile).toHaveBeenCalledWith('abc', 'application/pdf');
	});

	it('a file_upload without mimeType is routed through the non-media path and does not throw', () => {
		const store = vi.fn();
		const sendInlineFile = vi.fn();
		const wired = makeRouter({ sendInlineFile, getArtifactRegistry: () => ({ store }) });
		expect(() =>
			wired.router.dispatch({ type: 'file_upload', data: { base64: 'abc', fileName: 'blob' } }),
		).not.toThrow();
		expect(sendInlineFile).toHaveBeenCalledWith('abc', undefined);
		expect(wired.sendFile).not.toHaveBeenCalled();
		expect(wired.addUserMessage).toHaveBeenCalledWith('[Uploaded file: blob]');
		expect(store).not.toHaveBeenCalled();

		const unwired = makeRouter({ getArtifactRegistry: () => ({ store }) });
		expect(() =>
			unwired.router.dispatch({ type: 'file_upload', data: { base64: 'abc' } }),
		).not.toThrow();
		expect(unwired.sendFile).toHaveBeenCalledWith('abc', undefined);
		expect(unwired.addUserMessage).toHaveBeenCalledWith('[Uploaded file: file]');
		expect(store).not.toHaveBeenCalled();
	});

	it('stores image uploads in the artifact registry when present', () => {
		const store = vi.fn();
		const { router } = makeRouter({ getArtifactRegistry: () => ({ store }) });
		router.dispatch({
			type: 'file_upload',
			data: { base64: 'abc', mimeType: 'image/png', fileName: 'pic.png' },
		});
		expect(store).toHaveBeenCalledWith('abc', 'image/png', 'pic.png', 'uploaded', 'pic.png');
	});

	it('drops file_upload when the session is inactive', () => {
		const { router, sendFile } = makeRouter({ getSessionActive: () => false });
		router.dispatch({
			type: 'file_upload',
			data: { base64: 'abc', mimeType: 'image/png' },
		});
		expect(sendFile).not.toHaveBeenCalled();
	});

	it('routes text_input to handleTextInput', () => {
		const { router, handleTextInput } = makeRouter();
		router.dispatch({ type: 'text_input', text: 'hello' });
		expect(handleTextInput).toHaveBeenCalledWith('hello');
	});

	it('routes playback.ended to the arbiter when the gate is live', () => {
		const { router, finishOrDeferForVad } = makeRouter();
		router.dispatch({ type: 'playback.ended', playbackId: 1 });
		expect(finishOrDeferForVad).toHaveBeenCalledWith('signal');
	});

	it('no-ops playback.ended when the protocol is inactive', () => {
		const { router, finishOrDeferForVad } = makeRouter({
			getPlaybackStateProtocolActive: () => false,
		});
		router.dispatch({ type: 'playback.ended', playbackId: 1 });
		expect(finishOrDeferForVad).not.toHaveBeenCalled();
	});

	it('forwards an unrecognized type to onClientJson', () => {
		const { router, onClientJson } = makeRouter();
		const msg = { type: 'set_transcription_mode', mode: 'agent' };
		router.dispatch(msg);
		expect(onClientJson).toHaveBeenCalledWith(msg);
	});

	it.each(['onClientJson', 'onClientCommand'] as const)(
		'a throwing %s is logged and reported, and the other host hook still receives the frame',
		(throwing) => {
			const hooks = {
				onClientJson: vi.fn(),
				onClientCommand: vi.fn(),
			};
			hooks[throwing].mockImplementation(() => {
				throw new Error(`${throwing} broke`);
			});
			const log = vi.fn();
			const { router, reportError } = makeRouter({ ...hooks, log });
			const msg = { type: 'app.retry' };

			expect(() => router.dispatch(msg)).not.toThrow();

			expect(hooks.onClientJson).toHaveBeenCalledWith(msg);
			expect(hooks.onClientCommand).toHaveBeenCalledWith(msg);
			expect(reportError).toHaveBeenCalledTimes(1);
			expect(reportError).toHaveBeenCalledWith(
				`hook.${throwing}`,
				expect.objectContaining({ message: `${throwing} broke` }),
			);
			expect(log).toHaveBeenCalledWith(`hook ${throwing} threw: ${throwing} broke`);
		},
	);

	it('does NOT forward a malformed recognized type (behavior.set without key)', () => {
		const { router, onClientJson, handleClientSet } = makeRouter();
		router.dispatch({ type: 'behavior.set', preset: 'warm' });
		expect(handleClientSet).not.toHaveBeenCalled();
		expect(onClientJson).not.toHaveBeenCalled();
	});

	it('does NOT forward a malformed recognized type (text_input without text)', () => {
		const { router, onClientJson, handleTextInput } = makeRouter();
		router.dispatch({ type: 'text_input', text: 42 });
		expect(handleTextInput).not.toHaveBeenCalled();
		expect(onClientJson).not.toHaveBeenCalled();
	});
});
