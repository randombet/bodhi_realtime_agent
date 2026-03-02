// SPDX-License-Identifier: MIT

import { google } from '@ai-sdk/google';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession } from '../../src/core/voice-session.js';
import { createTransferableAgents } from './helpers/test-agents.js';
import { TestClient } from './helpers/test-client.js';

const API_KEY = process.env.GOOGLE_API_KEY ?? '';
const HAS_API_KEY = API_KEY.length > 0;

describe.skipIf(!HAS_API_KEY)('E2E: Agent Transfer', () => {
	let session: VoiceSession | null = null;
	let client: TestClient | null = null;

	afterEach(async () => {
		if (client) {
			await client.disconnect();
			client = null;
		}
		if (session) {
			await session.close();
			session = null;
		}
	});

	it('sets up session with transferable agents', async () => {
		const port = 19890;
		const agents = createTransferableAgents();

		session = new VoiceSession({
			sessionId: `e2e_transfer_${Date.now()}`,
			userId: 'test_user',
			apiKey: API_KEY,
			agents,
			initialAgent: 'general',
			port,
			model: google('gemini-2.5-flash'),
		});

		await session.start();
		await new Promise((r) => setTimeout(r, 2000));

		expect(session.sessionManager.state).toBe('ACTIVE');
	}, 15_000);

	it('can transfer between agents programmatically', async () => {
		const port = 19891;
		const agents = createTransferableAgents();
		const transferHandler = vi.fn();

		session = new VoiceSession({
			sessionId: `e2e_transfer_prog_${Date.now()}`,
			userId: 'test_user',
			apiKey: API_KEY,
			agents,
			initialAgent: 'general',
			port,
			model: google('gemini-2.5-flash'),
		});

		session.eventBus.subscribe('agent.transfer', transferHandler);

		await session.start();
		await new Promise((r) => setTimeout(r, 2000));

		// Connect client first
		client = new TestClient(port);
		await client.connect();

		// Programmatically transfer
		await session.transfer('booking');

		expect(transferHandler).toHaveBeenCalledWith(
			expect.objectContaining({
				fromAgent: 'general',
				toAgent: 'booking',
			}),
		);

		// Session should be back to ACTIVE after transfer
		expect(session.sessionManager.state).toBe('ACTIVE');
	}, 30_000);
});
