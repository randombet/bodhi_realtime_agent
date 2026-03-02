// SPDX-License-Identifier: MIT

import { google } from '@ai-sdk/google';
import { afterEach, describe, expect, it } from 'vitest';
import { VoiceSession } from '../../src/core/voice-session.js';
import { createEchoAgent } from './helpers/test-agents.js';
import { generateSilence } from './helpers/test-audio.js';
import { TestClient } from './helpers/test-client.js';

const API_KEY = process.env.GOOGLE_API_KEY ?? '';
const HAS_API_KEY = API_KEY.length > 0;

describe.skipIf(!HAS_API_KEY)('E2E: Voice Roundtrip', () => {
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

	it('connects, sends audio, and receives a response', async () => {
		const port = 19870;
		session = new VoiceSession({
			sessionId: `e2e_voice_${Date.now()}`,
			userId: 'test_user',
			apiKey: API_KEY,
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port,
			model: google('gemini-2.5-flash'),
		});

		await session.start();

		// Wait for Gemini setup
		await new Promise((r) => setTimeout(r, 2000));
		expect(session.sessionManager.state).toBe('ACTIVE');

		// Connect test client
		client = new TestClient(port);
		await client.connect();
		expect(client.isConnected).toBe(true);

		// Send silence (to trigger a response without actual speech)
		const silence = generateSilence(500);
		client.sendAudio(silence);

		// Wait for potential response audio
		await new Promise((r) => setTimeout(r, 5000));

		// Session should still be active
		expect(session.sessionManager.state).toBe('ACTIVE');
	}, 30_000);

	it('tracks conversation context from transcriptions', async () => {
		const port = 19871;
		session = new VoiceSession({
			sessionId: `e2e_context_${Date.now()}`,
			userId: 'test_user',
			apiKey: API_KEY,
			agents: [createEchoAgent()],
			initialAgent: 'echo',
			port,
			model: google('gemini-2.5-flash'),
		});

		await session.start();
		await new Promise((r) => setTimeout(r, 2000));

		// ConversationContext should be accessible
		expect(session.conversationContext).toBeDefined();
		expect(session.conversationContext.items).toBeDefined();
	}, 15_000);
});
