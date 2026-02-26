// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ClientTransport } from '../../src/transport/client-transport.js';

const TEST_PORT = 9876;

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

		transport.sendJsonToClient({ type: 'gui.update', payload: { foo: 'bar' } });

		await new Promise((r) => setTimeout(r, 50));

		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0])).toEqual({ type: 'gui.update', payload: { foo: 'bar' } });

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
