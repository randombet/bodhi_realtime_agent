// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	OutboundAudioGate,
	type OutboundAudioGateDeps,
} from '../../src/core/outbound-audio-gate.js';

/**
 * Pure unit characterization for OutboundAudioGate (design-outbound-audio-gate.md):
 * the echo-skip barge-in window and the post-interrupt trailing-audio mute, driven by an
 * injected clock + a controllable server-turn id (no VoiceSession / fake timers).
 */

function makeGate(over: Partial<OutboundAudioGateDeps> = {}) {
	const ctx = { now: 0, serverTurnId: 1 as number | undefined };
	const gate = new OutboundAudioGate({
		echoSkipMs: 400,
		getActiveServerTurnId: () => ctx.serverTurnId,
		now: () => ctx.now,
		...over,
	});
	return { gate, ctx };
}

describe('OutboundAudioGate — echo-skip barge-in window', () => {
	it('not interruptible before any audio', () => {
		const { gate } = makeGate();
		expect(gate.isInterruptible()).toBe(false);
	});

	it('not interruptible within the echo-skip window, interruptible after it', () => {
		const { gate, ctx } = makeGate();
		ctx.now = 1000;
		expect(gate.noteAudioChunk()).toBe(true); // first audio at t=1000
		ctx.now = 1399;
		expect(gate.isInterruptible()).toBe(false); // 399ms < 400
		ctx.now = 1400;
		expect(gate.isInterruptible()).toBe(true); // 400ms >= 400
	});

	it('first-audio time is sticky across chunks (window measured from the first)', () => {
		const { gate, ctx } = makeGate();
		ctx.now = 100;
		gate.noteAudioChunk();
		ctx.now = 300;
		gate.noteAudioChunk(); // does NOT reset the window
		ctx.now = 500; // 400ms after the FIRST chunk
		expect(gate.isInterruptible()).toBe(true);
	});

	it('onTurnFinalized closes the window; onTurnStart reopens fresh', () => {
		const { gate, ctx } = makeGate();
		ctx.now = 0;
		gate.noteAudioChunk();
		ctx.now = 500;
		expect(gate.isInterruptible()).toBe(true);
		gate.onTurnFinalized();
		expect(gate.isInterruptible()).toBe(false); // window closed
		gate.noteAudioChunk(); // new audio re-opens at t=500
		ctx.now = 800;
		expect(gate.isInterruptible()).toBe(false); // 300ms < 400
		ctx.now = 900;
		expect(gate.isInterruptible()).toBe(true);
	});
});

describe('OutboundAudioGate — trailing-audio mute', () => {
	it('drops audio of the muted server turn, forwards once the id changes', () => {
		const { gate, ctx } = makeGate();
		ctx.serverTurnId = 1;
		gate.noteAudioChunk(); // turn 1 audio — forwarded
		gate.muteCurrentServerTurn(); // mute turn 1
		expect(gate.noteAudioChunk()).toBe(false); // trailing turn-1 audio — dropped
		expect(gate.noteAudioChunk()).toBe(false);
		ctx.serverTurnId = 2; // new server turn
		expect(gate.noteAudioChunk()).toBe(true); // forwarded again (mute self-cleared)
		expect(gate.noteAudioChunk()).toBe(true);
	});

	it('onTurnStart clears the mute', () => {
		const { gate } = makeGate();
		gate.noteAudioChunk();
		gate.muteCurrentServerTurn();
		expect(gate.noteAudioChunk()).toBe(false);
		gate.onTurnStart();
		expect(gate.noteAudioChunk()).toBe(true); // mute cleared
	});

	it('a dropped (muted) chunk does not start the echo-skip window', () => {
		const { gate, ctx } = makeGate();
		gate.onTurnStart(); // fresh: no first-audio yet
		gate.muteCurrentServerTurn(); // mutes serverTurnId 1 (captured)
		ctx.now = 1000;
		expect(gate.noteAudioChunk()).toBe(false); // dropped — must NOT set first-audio
		ctx.now = 5000;
		expect(gate.isInterruptible()).toBe(false); // window never opened
	});

	it('mute is inert when the transport tracks no server-turn id', () => {
		const { gate } = makeGate({ getActiveServerTurnId: () => undefined });
		gate.noteAudioChunk();
		gate.muteCurrentServerTurn(); // captures null
		// null !== null is false → not treated as muted, so audio still forwards.
		expect(gate.noteAudioChunk()).toBe(true);
	});
});
