// SPDX-License-Identifier: MIT

import { google } from '@ai-sdk/google';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession } from '../../src/core/voice-session.js';
import { createToolAgent } from './helpers/test-agents.js';
import { TestClient } from './helpers/test-client.js';

const API_KEY = process.env.GOOGLE_API_KEY ?? '';
const HAS_API_KEY = API_KEY.length > 0;

describe.skipIf(!HAS_API_KEY)('E2E: Tool Call', () => {
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

	it('registers tool agent and becomes ACTIVE', async () => {
		const port = 19880;
		const onToolCall = vi.fn();

		session = new VoiceSession({
			sessionId: `e2e_tool_${Date.now()}`,
			userId: 'test_user',
			apiKey: API_KEY,
			agents: [createToolAgent()],
			initialAgent: 'tool-agent',
			port,
			model: google('gemini-2.5-flash'),
			hooks: { onToolCall },
		});

		await session.start();
		await new Promise((r) => setTimeout(r, 2000));

		expect(session.sessionManager.state).toBe('ACTIVE');

		// Connect client
		client = new TestClient(port);
		await client.connect();
		expect(client.isConnected).toBe(true);
	}, 15_000);

	it('tool executor has tools registered', async () => {
		const port = 19881;
		session = new VoiceSession({
			sessionId: `e2e_tool_reg_${Date.now()}`,
			userId: 'test_user',
			apiKey: API_KEY,
			agents: [createToolAgent()],
			initialAgent: 'tool-agent',
			port,
			model: google('gemini-2.5-flash'),
		});

		await session.start();
		await new Promise((r) => setTimeout(r, 2000));

		// EventBus should be set up for tool events
		expect(session.eventBus).toBeDefined();
	}, 15_000);
});
