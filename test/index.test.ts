// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

describe('module smoke test', () => {
	it('imports without throwing and exports key APIs', async () => {
		const mod = await import('../src/index.js');
		expect(mod).toBeDefined();

		// Core
		expect(mod.VoiceSession).toBeDefined();
		expect(mod.EventBus).toBeDefined();
		expect(mod.SessionManager).toBeDefined();
		expect(mod.ConversationContext).toBeDefined();
		expect(mod.ConversationHistoryWriter).toBeDefined();
		expect(mod.HooksManager).toBeDefined();
		expect(mod.InMemorySessionStore).toBeDefined();

		// Errors
		expect(mod.FrameworkError).toBeDefined();
		expect(mod.TransportError).toBeDefined();
		expect(mod.SessionError).toBeDefined();
		expect(mod.AgentError).toBeDefined();

		// Agent
		expect(mod.AgentRouter).toBeDefined();
		expect(mod.createAgentContext).toBeDefined();
		expect(mod.runSubagent).toBeDefined();

		// Tools
		expect(mod.ToolExecutor).toBeDefined();

		// Transport
		expect(mod.GeminiLiveTransport).toBeDefined();
		expect(mod.ClientTransport).toBeDefined();
		expect(mod.AudioBuffer).toBeDefined();
		expect(mod.zodToJsonSchema).toBeDefined();

		// Memory
		expect(mod.JsonMemoryStore).toBeDefined();
		expect(mod.MemoryDistiller).toBeDefined();

		// Types (constants)
		expect(mod.AUDIO_FORMAT).toBeDefined();
	});
});
