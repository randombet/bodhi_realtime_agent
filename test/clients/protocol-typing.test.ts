import { describe, expect, it } from 'vitest';
import type {
	AnyServerToClientMessage,
	CoreClientToServerMessage,
} from '../../src/types/client-protocol.js';

// Compile-time contract tests for the client-protocol unions (plan step A5).
// The @ts-expect-error lines are the negative cases: if the contract ever
// widens to accept these, the unused-expect-error turns into a compile error
// in typecheck:tests and CI catches the regression.

// Local extension registration — proves module augmentation composes without
// touching the core package (the peer/app mechanism, e.g. peer.*).
declare module '@bodhi/client-protocol' {
	interface ClientProtocolServerExtensions {
		testProtocolTypingProbe: { type: 'test.protocol_probe'; note: string };
	}
}

function acceptServerFrame(msg: AnyServerToClientMessage): AnyServerToClientMessage {
	return msg;
}
function acceptClientFrame(msg: CoreClientToServerMessage): CoreClientToServerMessage {
	return msg;
}

describe('client-protocol compile-time contract', () => {
	it('accepts core frames, registered extensions, and rejects unregistered/malformed frames', () => {
		// Core frames compile.
		acceptServerFrame({ type: 'turn.interrupted' });
		acceptServerFrame({ type: 'audio.done', playbackId: 7 });
		acceptServerFrame({ type: 'transcript', role: 'assistant', text: 'hi', partial: true });
		acceptClientFrame({ type: 'text_input', text: 'hello' });
		acceptClientFrame({ type: 'playback.ended', playbackId: 7 });

		// A frame registered via module augmentation compiles.
		acceptServerFrame({ type: 'test.protocol_probe', note: 'registered' });

		// @ts-expect-error — unregistered frame type must not compile.
		acceptServerFrame({ type: 'totally.unregistered_frame' });

		// @ts-expect-error — audio.done without playbackId must not compile.
		acceptServerFrame({ type: 'audio.done' });

		// @ts-expect-error — rtc.answer is server→client, not a legal client send.
		acceptClientFrame({ type: 'rtc.answer', sdp: 'v=0' });

		// @ts-expect-error — server frames are not client frames.
		acceptClientFrame({ type: 'transcript', role: 'user', text: 'x' });

		expect(true).toBe(true);
	});
});
