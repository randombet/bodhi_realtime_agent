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
