// SPDX-License-Identifier: MIT

import { WebSocket } from 'ws';

/**
 * WebSocket test client that connects to the ClientTransport server
 * and provides helpers for sending/receiving audio.
 */
export class TestClient {
	private ws: WebSocket | null = null;
	private receivedChunks: Buffer[] = [];
	private connectPromise: Promise<void> | null = null;

	constructor(private port: number) {}

	async connect(): Promise<void> {
		if (this.connectPromise) return this.connectPromise;

		this.connectPromise = new Promise<void>((resolve, reject) => {
			this.ws = new WebSocket(`ws://localhost:${this.port}`);

			this.ws.on('open', () => resolve());
			this.ws.on('error', (err) => reject(err));
			this.ws.on('message', (data: Buffer) => {
				this.receivedChunks.push(Buffer.from(data));
			});
		});

		return this.connectPromise;
	}

	sendAudio(data: Buffer): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('TestClient not connected');
		}
		this.ws.send(data);
	}

	getReceivedAudio(): Buffer[] {
		return [...this.receivedChunks];
	}

	clearReceived(): void {
		this.receivedChunks = [];
	}

	async disconnect(): Promise<void> {
		if (!this.ws) return;

		return new Promise<void>((resolve) => {
			if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
				resolve();
				return;
			}
			this.ws.on('close', () => resolve());
			this.ws.close();
		});
	}

	get isConnected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}
}
