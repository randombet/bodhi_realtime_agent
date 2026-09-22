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
