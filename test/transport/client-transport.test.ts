import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
	CLOSE_CODE_CLIENT_BUSY,
	CLOSE_CODE_SUPERSEDED_BY_TAKEOVER,
	CLOSE_CODE_VERIFIER_PREEMPTED,
	CLOSE_REASON_CLIENT_BUSY,
	CLOSE_REASON_SUPERSEDED_BY_TAKEOVER,
	CLOSE_REASON_VERIFIER_PREEMPTED,
	ClientTransport,
} from '../../src/transport/client-transport.js';

const TEST_PORT = 9876;

/** Open a WebSocket and resolve once the upgrade completes. */
function open(path = ''): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${TEST_PORT}${path}`);
		ws.on('open', () => resolve(ws));
		ws.on('error', reject);
	});
}

/** Connect, collecting text frames from socket creation (no listener race),
 *  and resolve with the frames + close code/reason once the socket closes. */
function connectAndDrain(path = ''): Promise<{ frames: string[]; code: number; reason: string }> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${TEST_PORT}${path}`);
		const frames: string[] = [];
		ws.on('message', (data, isBinary) => {
			if (!isBinary) frames.push(data.toString());
		});
		ws.on('close', (code, reason) => resolve({ frames, code, reason: reason.toString() }));
		ws.on('error', reject);
	});
}

/** Resolve with {code, reason} when the socket closes. */
function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
	return new Promise((resolve) => {
		ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
	});
}

/** Collect text frames received on a socket. */
function collectText(ws: WebSocket): string[] {
	const frames: string[] = [];
	ws.on('message', (data, isBinary) => {
		if (!isBinary) frames.push(data.toString());
	});
	return frames;
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

/**
 * A single health probe written the way a desktop supervisor checks a local voice
 * agent: open `ws://127.0.0.1:<port>/?probe=1`, ignore every frame whose `type` is not
 * `agent.state`, report healthy only when that frame carries `initialized: true`, close
 * the socket itself, and report a close that arrives before any such frame as
 * `closed-early`.
 */
function supervisorProbeOnce(
	timeoutMs = 2000,
): Promise<{ ok: boolean; state: Record<string, unknown> | null; reason?: string }> {
	return new Promise((resolve) => {
		let settled = false;
		let upgraded = false;
		const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/?probe=1`);
		const done = (result: {
			ok: boolean;
			state?: Record<string, unknown>;
			reason?: string;
		}): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				ws.close();
			} catch {
				// already closed
			}
			resolve({ state: null, ...result });
		};
		const timer = setTimeout(
			() => done({ ok: false, reason: upgraded ? 'no-frame' : 'timeout' }),
			timeoutMs,
		);
		ws.on('open', () => {
			upgraded = true;
		});
		ws.on('message', (data, isBinary) => {
			let frame: Record<string, unknown> | null = null;
			try {
				frame = isBinary ? null : (JSON.parse(data.toString()) as Record<string, unknown>);
			} catch {
				frame = null;
			}
			if (frame?.type === 'agent.state') done({ ok: frame.initialized === true, state: frame });
		});
		ws.on('error', () => done({ ok: false, reason: upgraded ? 'socket-error' : 'refused' }));
		ws.on('close', () => done({ ok: false, reason: upgraded ? 'closed-early' : 'refused' }));
	});
}

describe('ClientTransport', () => {
	let transport: ClientTransport | null = null;

	afterEach(async () => {
		if (transport) {
			await transport.stop();
			transport = null;
		}
	});

	it('starts and accepts connections', async () => {
		const onClientConnected = vi.fn();
		transport = new ClientTransport(TEST_PORT, { onClientConnected });
		await transport.start();

		const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
		await new Promise<void>((r) => ws.on('open', r));

		expect(onClientConnected).toHaveBeenCalledOnce();
		expect(transport.isClientConnected).toBe(true);

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('receives audio from client', async () => {
		const onAudioFromClient = vi.fn();
		transport = new ClientTransport(TEST_PORT, { onAudioFromClient });
		await transport.start();

		const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
		await new Promise<void>((r) => ws.on('open', r));

		const audioData = Buffer.alloc(320, 42);
		ws.send(audioData);

		// Wait for message delivery
		await new Promise((r) => setTimeout(r, 50));

		expect(onAudioFromClient).toHaveBeenCalledOnce();
		expect(onAudioFromClient.mock.calls[0][0]).toEqual(audioData);

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('sends audio to client', async () => {
		transport = new ClientTransport(TEST_PORT, {});
		await transport.start();

		const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
		await new Promise<void>((r) => ws.on('open', r));

		const received: Buffer[] = [];
		ws.on('message', (data) => received.push(data as Buffer));

		const audioData = Buffer.alloc(320, 99);
		transport.sendAudioToClient(audioData);

		await new Promise((r) => setTimeout(r, 50));

		expect(received).toHaveLength(1);
		expect(received[0]).toEqual(audioData);

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('buffers audio during startBuffering/stopBuffering', async () => {
		const onAudioFromClient = vi.fn();
		transport = new ClientTransport(TEST_PORT, { onAudioFromClient });
		await transport.start();

		const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
		await new Promise<void>((r) => ws.on('open', r));

		transport.startBuffering();
		expect(transport.buffering).toBe(true);

		ws.send(Buffer.alloc(100, 1));
		ws.send(Buffer.alloc(100, 2));
		await new Promise((r) => setTimeout(r, 50));

		// Should NOT have called onAudioFromClient while buffering
		expect(onAudioFromClient).not.toHaveBeenCalled();

		const buffered = transport.stopBuffering();
		expect(buffered).toHaveLength(2);
		expect(transport.buffering).toBe(false);

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('sends JSON to client as a text frame', async () => {
		transport = new ClientTransport(TEST_PORT, {});
		await transport.start();

		const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
		await new Promise<void>((r) => ws.on('open', r));

		const received: string[] = [];
		ws.on('message', (data, isBinary) => {
			if (!isBinary) received.push(data.toString());
		});

		transport.sendJsonToClient({
			type: 'gui.update',
			payload: { sessionId: 's1', data: { foo: 'bar' } },
		});

		await new Promise((r) => setTimeout(r, 50));

		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0])).toEqual({
			type: 'gui.update',
			payload: { sessionId: 's1', data: { foo: 'bar' } },
		});

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('sendJsonAfterAudio delivers JSON after audio, and reports protocol support', async () => {
		transport = new ClientTransport(TEST_PORT, {});
		await transport.start();

		const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
		await new Promise<void>((r) => ws.on('open', r));

		const frames: Array<{ binary: boolean; text: string }> = [];
		ws.on('message', (data, isBinary) => {
			frames.push({ binary: isBinary, text: isBinary ? '' : data.toString() });
		});

		transport.sendAudioToClient(Buffer.from([1, 2, 3, 4]));
		transport.sendJsonAfterAudio({ type: 'audio.done', playbackId: 1 });

		await new Promise((r) => setTimeout(r, 50));

		expect(frames).toHaveLength(2);
		expect(frames[0].binary).toBe(true);
		expect(frames[1].binary).toBe(false);
		expect(JSON.parse(frames[1].text)).toEqual({ type: 'audio.done', playbackId: 1 });
		expect(transport.supportsPlaybackStateProtocol).toBe(true);

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('receives JSON text frames from client via onJsonFromClient', async () => {
		const onJsonFromClient = vi.fn();
		transport = new ClientTransport(TEST_PORT, { onJsonFromClient });
		await transport.start();

		const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
		await new Promise<void>((r) => ws.on('open', r));

		ws.send(JSON.stringify({ type: 'ui.response', payload: { requestId: 'r1' } }));

		await new Promise((r) => setTimeout(r, 50));

		expect(onJsonFromClient).toHaveBeenCalledOnce();
		expect(onJsonFromClient.mock.calls[0][0]).toEqual({
			type: 'ui.response',
			payload: { requestId: 'r1' },
		});

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('binary frames still go to onAudioFromClient (not onJsonFromClient)', async () => {
		const onAudioFromClient = vi.fn();
		const onJsonFromClient = vi.fn();
		transport = new ClientTransport(TEST_PORT, { onAudioFromClient, onJsonFromClient });
		await transport.start();

		const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
		await new Promise<void>((r) => ws.on('open', r));

		ws.send(Buffer.alloc(100, 0xab));
		await new Promise((r) => setTimeout(r, 50));

		expect(onAudioFromClient).toHaveBeenCalledOnce();
		expect(onJsonFromClient).not.toHaveBeenCalled();

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('buffering only affects binary frames, text frames still deliver', async () => {
		const onAudioFromClient = vi.fn();
		const onJsonFromClient = vi.fn();
		transport = new ClientTransport(TEST_PORT, { onAudioFromClient, onJsonFromClient });
		await transport.start();

		const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
		await new Promise<void>((r) => ws.on('open', r));

		transport.startBuffering();

		ws.send(Buffer.alloc(100, 1));
		ws.send(JSON.stringify({ type: 'test', data: 123 }));
		await new Promise((r) => setTimeout(r, 50));

		expect(onAudioFromClient).not.toHaveBeenCalled();
		expect(onJsonFromClient).toHaveBeenCalledOnce();
		expect(onJsonFromClient.mock.calls[0][0]).toEqual({ type: 'test', data: 123 });

		const buffered = transport.stopBuffering();
		expect(buffered).toHaveLength(1);

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
	});

	it('stop() clears buffering state and audio buffer', async () => {
		transport = new ClientTransport(TEST_PORT, {});
		await transport.start();

		const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
		await new Promise<void>((r) => ws.on('open', r));

		transport.startBuffering();
		ws.send(Buffer.alloc(100, 1));
		await new Promise((r) => setTimeout(r, 50));

		expect(transport.buffering).toBe(true);

		ws.close();
		await new Promise<void>((r) => ws.on('close', r));
		await transport.stop();

		expect(transport.buffering).toBe(false);
		// After stop + restart, stopBuffering should return empty
		transport = new ClientTransport(TEST_PORT, {});
		await transport.start();
		const buffered = transport.stopBuffering();
		expect(buffered).toHaveLength(0);
	});

	it('fires onClientDisconnected on close', async () => {
		const onClientDisconnected = vi.fn();
		transport = new ClientTransport(TEST_PORT, { onClientDisconnected });
		await transport.start();

		const ws = new WebSocket(`ws://localhost:${TEST_PORT}`);
		await new Promise<void>((r) => ws.on('open', r));

		ws.close();
		await new Promise((r) => setTimeout(r, 50));

		expect(onClientDisconnected).toHaveBeenCalledOnce();
	});
});

describe('ClientTransport pre-client interception', () => {
	let transport: ClientTransport | null = null;

	afterEach(async () => {
		if (transport) {
			await transport.stop();
			transport = null;
		}
	});

	describe('?probe=1', () => {
		it('sends one probeState JSON frame and closes 1000, without attaching', async () => {
			const onClientConnected = vi.fn();
			const onClientDisconnected = vi.fn();
			const probeState = vi.fn(() => ({ type: 'agent.state', v: 1, initialized: true }));
			transport = new ClientTransport(
				TEST_PORT,
				{ onClientConnected, onClientDisconnected },
				'0.0.0.0',
				10_000,
				{ probeState },
			);
			await transport.start();

			const { frames, code } = await connectAndDrain('/?probe=1');

			expect(code).toBe(1000);
			expect(frames).toHaveLength(1);
			expect(JSON.parse(frames[0])).toEqual({ type: 'agent.state', v: 1, initialized: true });
			expect(probeState).toHaveBeenCalledOnce();
			// Probe never attaches, never fires callbacks, never counts.
			expect(onClientConnected).not.toHaveBeenCalled();
			expect(onClientDisconnected).not.toHaveBeenCalled();
			expect(transport.isClientConnected).toBe(false);
			expect(transport.attachedRole).toBeNull();
		});

		it('without probeState: upgrade completes and closes 1000 with no frame', async () => {
			const onClientConnected = vi.fn();
			transport = new ClientTransport(TEST_PORT, { onClientConnected });
			await transport.start();

			const { frames, code } = await connectAndDrain('/?probe=1');

			expect(code).toBe(1000);
			expect(frames).toHaveLength(0);
			expect(onClientConnected).not.toHaveBeenCalled();
			expect(transport.isClientConnected).toBe(false);
		});

		it('does not steal a live client: real socket stays selected, no disconnect, audio still flows', async () => {
			const onClientDisconnected = vi.fn();
			const onAudioFromClient = vi.fn();
			transport = new ClientTransport(
				TEST_PORT,
				{ onClientDisconnected, onAudioFromClient },
				'0.0.0.0',
				10_000,
				{ probeState: () => ({ type: 'agent.state', v: 1 }) },
			);
			await transport.start();

			const real = await open();
			await tick();
			expect(transport.isClientConnected).toBe(true);

			// Probe connects and closes mid-session.
			const probe = await open('/?probe=1');
			const { code } = await closed(probe);
			expect(code).toBe(1000);

			// Real socket untouched: still attached, no disconnect callback fired.
			expect(transport.isClientConnected).toBe(true);
			expect(onClientDisconnected).not.toHaveBeenCalled();

			// Audio still flows in both directions after the probe.
			const receivedByReal: Buffer[] = [];
			real.on('message', (data, isBinary) => {
				if (isBinary) receivedByReal.push(data as Buffer);
			});
			real.send(Buffer.alloc(320, 7));
			transport.sendAudioToClient(Buffer.alloc(320, 9));
			await tick();
			expect(onAudioFromClient).toHaveBeenCalledOnce();
			expect(receivedByReal).toHaveLength(1);
			expect(receivedByReal[0]).toEqual(Buffer.alloc(320, 9));

			real.close();
			await closed(real);
		});

		it('a supervisor health probe reads agent.state with initialized: true before the server closes, and the attached client stays attached', async () => {
			const onClientConnected = vi.fn();
			const onClientDisconnected = vi.fn();
			// The agent.state frame a desktop voice agent reports to its supervisor.
			const agentState = {
				type: 'agent.state',
				v: 1,
				initialized: true,
				upstream: 'live',
				clientAttached: true,
				credentialSource: 'managed',
			};
			transport = new ClientTransport(
				TEST_PORT,
				{ onClientConnected, onClientDisconnected },
				'0.0.0.0',
				10_000,
				{ probeState: () => agentState },
			);
			await transport.start();

			const real = await open();
			await tick();
			expect(onClientConnected).toHaveBeenCalledOnce();

			const result = await supervisorProbeOnce();
			expect(result).toEqual({ ok: true, state: agentState });

			await tick();
			expect(transport.isClientConnected).toBe(true);
			expect(transport.attachedRole).toBe('real');
			expect(real.readyState).toBe(WebSocket.OPEN);
			expect(onClientConnected).toHaveBeenCalledOnce();
			expect(onClientDisconnected).not.toHaveBeenCalled();

			real.close();
			await closed(real);
		});
	});

	describe('client-busy', () => {
		it('rejects a second real client with 4409 client-busy, incumbent unaffected', async () => {
			const onClientConnected = vi.fn();
			const onClientDisconnected = vi.fn();
			transport = new ClientTransport(TEST_PORT, { onClientConnected, onClientDisconnected });
			await transport.start();

			const first = await open();
			await tick();
			expect(onClientConnected).toHaveBeenCalledOnce();

			const second = await open();
			const { code, reason } = await closed(second);
			expect(code).toBe(CLOSE_CODE_CLIENT_BUSY);
			expect(reason).toBe(CLOSE_REASON_CLIENT_BUSY);

			// Incumbent still attached; no spurious callbacks.
			expect(transport.isClientConnected).toBe(true);
			expect(onClientConnected).toHaveBeenCalledOnce();
			expect(onClientDisconnected).not.toHaveBeenCalled();

			first.close();
			await closed(first);
			await tick();
			expect(onClientDisconnected).toHaveBeenCalledOnce();
		});

		it('a stale incumbent whose socket already closed does not 4409 the same user immediate reconnect', async () => {
			const onClientConnected = vi.fn();
			const onClientDisconnected = vi.fn();
			transport = new ClientTransport(TEST_PORT, { onClientConnected, onClientDisconnected });
			await transport.start();

			const first = await open();
			await tick();
			expect(onClientConnected).toHaveBeenCalledOnce();

			// Close the incumbent and, WITHOUT waiting for the server to finish
			// processing its 'close', immediately open a fresh real connection. By the
			// time the newcomer is processed the incumbent socket is CLOSING/CLOSED
			// (its 'close' may not have fired yet); a non-OPEN incumbent must be
			// treated as absent so the newcomer attaches instead of hitting 4409.
			first.close();
			const second = new WebSocket(`ws://localhost:${TEST_PORT}`);
			let rejected: { code: number; reason: string } | null = null;
			second.on('close', (code, reason) => {
				rejected = { code, reason: reason.toString() };
			});
			await new Promise<void>((resolve, reject) => {
				second.on('open', () => resolve());
				second.on('error', reject);
			});
			await tick();

			// The newcomer attached — never rejected with client-busy.
			expect(rejected).toBeNull();
			expect(transport.isClientConnected).toBe(true);
			expect(onClientConnected).toHaveBeenCalledTimes(2);

			second.close();
			await closed(second);
		});
	});

	describe('?takeover=1', () => {
		it('closes the incumbent with superseded-by-takeover, then attaches the challenger', async () => {
			const onClientConnected = vi.fn();
			const onClientDisconnected = vi.fn();
			transport = new ClientTransport(TEST_PORT, { onClientConnected, onClientDisconnected });
			await transport.start();

			const incumbent = await open();
			await tick();
			expect(onClientConnected).toHaveBeenCalledOnce();

			const challenger = await open('/?takeover=1');
			const { code, reason } = await closed(incumbent);
			expect(code).toBe(CLOSE_CODE_SUPERSEDED_BY_TAKEOVER);
			expect(reason).toBe(CLOSE_REASON_SUPERSEDED_BY_TAKEOVER);

			await tick();
			// Handshake completed: incumbent detached (one disconnect), challenger attached.
			expect(onClientDisconnected).toHaveBeenCalledOnce();
			expect(onClientConnected).toHaveBeenCalledTimes(2);
			expect(transport.isClientConnected).toBe(true);

			// The challenger is now the selected client.
			const receivedByChallenger: Buffer[] = [];
			challenger.on('message', (data, isBinary) => {
				if (isBinary) receivedByChallenger.push(data as Buffer);
			});
			transport.sendAudioToClient(Buffer.alloc(64, 5));
			await tick();
			expect(receivedByChallenger).toHaveLength(1);

			challenger.close();
			await closed(challenger);
			await tick();
			expect(onClientDisconnected).toHaveBeenCalledTimes(2);
		});

		it('with no incumbent, a ?takeover=1 connection simply attaches', async () => {
			const onClientConnected = vi.fn();
			transport = new ClientTransport(TEST_PORT, { onClientConnected });
			await transport.start();

			const ws = await open('/?takeover=1');
			await tick();
			expect(onClientConnected).toHaveBeenCalledOnce();
			expect(transport.isClientConnected).toBe(true);

			ws.close();
			await closed(ws);
		});

		it('a superseded incumbent injects ZERO frames after the takeover detach boundary', async () => {
			let detached = false;
			let leakedAfterDetach = 0;
			const onAudioFromClient = vi.fn(() => {
				if (detached) leakedAfterDetach++;
			});
			const onJsonFromClient = vi.fn(() => {
				if (detached) leakedAfterDetach++;
			});
			const onClientConnected = vi.fn();
			const onClientDisconnected = vi.fn(() => {
				// The incumbent's takeover detach is the boundary: any inbound frame
				// delivered from here on is a leak from a socket that lost the slot.
				detached = true;
			});
			transport = new ClientTransport(TEST_PORT, {
				onAudioFromClient,
				onJsonFromClient,
				onClientConnected,
				onClientDisconnected,
			});
			await transport.start();

			const incumbent = await open();
			await tick();
			expect(onClientConnected).toHaveBeenCalledOnce();

			// Flood binary + JSON from the incumbent continuously across the takeover
			// boundary. Frames the server reads before detach deliver legitimately
			// (detached === false); any delivery seen while detached === true is a leak.
			const flood = setInterval(() => {
				if (incumbent.readyState !== WebSocket.OPEN) return;
				try {
					incumbent.send(Buffer.alloc(64, 3));
					incumbent.send(JSON.stringify({ type: 'ui.response', from: 'incumbent' }));
				} catch {
					// socket transitioning to closed — ignore
				}
			}, 1);

			const challenger = await open('/?takeover=1');
			const { code } = await closed(incumbent);
			expect(code).toBe(CLOSE_CODE_SUPERSEDED_BY_TAKEOVER);

			await tick();
			clearInterval(flood);
			await tick();

			// The takeover really happened: the challenger is the attached real client.
			expect(onClientDisconnected).toHaveBeenCalledOnce();
			expect(onClientConnected).toHaveBeenCalledTimes(2);
			expect(transport.isClientConnected).toBe(true);
			// The superseded incumbent delivered nothing after losing the slot.
			expect(leakedAfterDetach).toBe(0);

			challenger.close();
			await closed(challenger);
		});

		it("a superseded incumbent's frames are not captured by the inbound classifier after detach", async () => {
			let detached = false;
			let capturedBeforeDetach = 0;
			let capturedAfterDetach = 0;
			const onClientDisconnected = vi.fn(() => {
				detached = true;
			});
			transport = new ClientTransport(TEST_PORT, { onClientDisconnected });
			await transport.start();

			const incumbent = await open();
			await tick();

			// The session's capture window: every buffered frame is tagged at ingress.
			transport.installInboundCaptureClassifier(() => {
				if (detached) capturedAfterDetach++;
				else capturedBeforeDetach++;
				return { voiced: true, gateActive: false };
			});
			transport.startBuffering();
			incumbent.send(Buffer.alloc(64, 1));
			await tick();
			expect(capturedBeforeDetach).toBe(1);

			// Hold the incumbent's next frames in the server-side socket so they are
			// read only after the takeover has detached it.
			const serverSide = (transport as unknown as { client: WebSocket }).client;
			serverSide.pause();
			for (let i = 0; i < 5; i++) incumbent.send(Buffer.alloc(64, 3));
			await tick();

			const challenger = await open('/?takeover=1');
			expect(onClientDisconnected).toHaveBeenCalledOnce();
			const incumbentClosed = closed(incumbent);
			serverSide.resume();
			const { code } = await incumbentClosed;
			expect(code).toBe(CLOSE_CODE_SUPERSEDED_BY_TAKEOVER);
			await tick();

			// Nothing from the superseded socket was classified after it lost the slot,
			// and the only buffered frame is the one tagged before the detach.
			expect(capturedAfterDetach).toBe(0);
			const captured = transport.stopInboundCapture();
			expect(captured).toHaveLength(1);
			expect(captured[0]).toMatchObject({ voiced: true, gateActiveAtCapture: false });

			challenger.close();
			await closed(challenger);
		});
	});

	describe('?verify=1', () => {
		it('is rejected 4409 client-busy while a real client is attached', async () => {
			const onVerifierConnected = vi.fn();
			const onClientDisconnected = vi.fn();
			transport = new ClientTransport(TEST_PORT, { onVerifierConnected, onClientDisconnected });
			await transport.start();

			const real = await open();
			await tick();

			const verifier = await open('/?verify=1');
			const { code, reason } = await closed(verifier);
			expect(code).toBe(CLOSE_CODE_CLIENT_BUSY);
			expect(reason).toBe(CLOSE_REASON_CLIENT_BUSY);
			expect(onVerifierConnected).not.toHaveBeenCalled();
			expect(onClientDisconnected).not.toHaveBeenCalled();
			expect(transport.isClientConnected).toBe(true);

			real.close();
			await closed(real);
		});

		it('is preempted with a distinct close when a real client arrives', async () => {
			const onClientConnected = vi.fn();
			const onClientDisconnected = vi.fn();
			const onVerifierConnected = vi.fn();
			const onVerifierDisconnected = vi.fn();
			transport = new ClientTransport(TEST_PORT, {
				onClientConnected,
				onClientDisconnected,
				onVerifierConnected,
				onVerifierDisconnected,
			});
			await transport.start();

			const verifier = await open('/?verify=1');
			await tick();
			expect(onVerifierConnected).toHaveBeenCalledOnce();
			expect(transport.isVerifierConnected).toBe(true);

			const real = await open();
			const { code, reason } = await closed(verifier);
			expect(code).toBe(CLOSE_CODE_VERIFIER_PREEMPTED);
			expect(reason).toBe(CLOSE_REASON_VERIFIER_PREEMPTED);

			await tick();
			// A background verification must never cause the user to see client-busy.
			expect(onClientConnected).toHaveBeenCalledOnce();
			expect(transport.isClientConnected).toBe(true);
			// Verifier detach fired its own hook — never the real disconnect wrapper.
			expect(onVerifierDisconnected).toHaveBeenCalledOnce();
			expect(onClientDisconnected).not.toHaveBeenCalled();

			real.close();
			await closed(real);
		});

		it('never fires real connect/disconnect callbacks and never counts as clientAttached', async () => {
			const onClientConnected = vi.fn();
			const onClientDisconnected = vi.fn();
			const onAudioFromClient = vi.fn();
			const onJsonFromClient = vi.fn();
			const onVerifierConnected = vi.fn();
			const onVerifierDisconnected = vi.fn();
			transport = new ClientTransport(TEST_PORT, {
				onClientConnected,
				onClientDisconnected,
				onAudioFromClient,
				onJsonFromClient,
				onVerifierConnected,
				onVerifierDisconnected,
			});
			await transport.start();

			const verifier = await open('/?verify=1');
			const frames = collectText(verifier);
			await tick();

			expect(onVerifierConnected).toHaveBeenCalledOnce();
			expect(onClientConnected).not.toHaveBeenCalled();
			expect(transport.isClientConnected).toBe(false);
			expect(transport.isVerifierConnected).toBe(true);
			expect(transport.attachedRole).toBe('verify');

			// Outbound state frames reach the verifier (it observes agent.state).
			transport.sendJsonToClient({ type: 'agent.state', v: 1, upstream: 'live' });
			await tick();
			expect(frames).toHaveLength(1);
			expect(JSON.parse(frames[0])).toEqual({ type: 'agent.state', v: 1, upstream: 'live' });

			// Inbound frames from the verifier never reach user-side callbacks.
			verifier.send(Buffer.alloc(64, 1));
			verifier.send(JSON.stringify({ type: 'ui.response' }));
			await tick();
			expect(onAudioFromClient).not.toHaveBeenCalled();
			expect(onJsonFromClient).not.toHaveBeenCalled();

			verifier.close();
			await closed(verifier);
			await tick();
			expect(onVerifierDisconnected).toHaveBeenCalledOnce();
			expect(onClientDisconnected).not.toHaveBeenCalled();
		});

		it('a second verifier is rejected 4409 while one is attached', async () => {
			const onVerifierConnected = vi.fn();
			transport = new ClientTransport(TEST_PORT, { onVerifierConnected });
			await transport.start();

			const v1 = await open('/?verify=1');
			await tick();
			const v2 = await open('/?verify=1');
			const { code, reason } = await closed(v2);
			expect(code).toBe(CLOSE_CODE_CLIENT_BUSY);
			expect(reason).toBe(CLOSE_REASON_CLIENT_BUSY);
			expect(onVerifierConnected).toHaveBeenCalledOnce();
			expect(transport.isVerifierConnected).toBe(true);

			v1.close();
			await closed(v1);
		});
	});
});
