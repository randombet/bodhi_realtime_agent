import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { describe, expect, it } from 'vitest';
import { compileAgentDefinition } from '../../app/agents/runtime/compile-agent-definition.js';
import { createRemotePersistentWorkerSubagentConfig } from '../../app/agents/runtime/remote-persistent-worker.js';
import type { WorkerRuntimeContext } from '../../app/agents/runtime/worker-runtime-registry.js';
import { ArtifactRegistry } from '../../app/lib/media/artifact-registry.js';

function testCtx(): WorkerRuntimeContext {
	const googleApiKey = 'test-key';
	return {
		googleApiKey,
		defaultReasoningModel: createGoogleGenerativeAI({ apiKey: googleApiKey })('gemini-2.5-flash'),
		getSessionRef: () => null,
		artifactRegistry: new ArtifactRegistry(),
		userId: 'u1',
		sessionId: 'voice_sess_1',
	};
}

describe('remote_persistent_worker compile + factory', () => {
	it('compiles main agent tool and subagent config', () => {
		const { mainAgents, subagentConfigs } = compileAgentDefinition(
			{
				mainAgents: [
					{
						name: 'main',
						googleSearch: false,
						instructions: 'You are helpful.',
						toolIds: ['get_current_time', 'ask_remote_code'],
					},
				],
				workers: {
					ask_remote_code: {
						type: 'remote_persistent_worker',
						url: 'https://example.com/agent',
						token: 'tok',
					},
				},
			},
			{ ...testCtx(), isUserAgent: true },
		);

		const tool = mainAgents[0]?.tools.find((t) => t.name === 'ask_remote_code');
		expect(tool).toBeDefined();
		expect(tool?.execution).toBe('background');

		const sub = subagentConfigs.ask_remote_code;
		expect(sub?.lifetime).toBe('persistent_session');
		expect(sub?.persistentFactory).toBeDefined();
	});

	it('createRemotePersistentWorkerSubagentConfig returns persistent_session factory', async () => {
		const spec = {
			type: 'remote_persistent_worker' as const,
			url: 'https://x.test',
			token: 'secret',
		};
		const cfg = createRemotePersistentWorkerSubagentConfig('my_tool', spec, 'sessA');
		expect(cfg.lifetime).toBe('persistent_session');
		const inst = await cfg.persistentFactory?.('key1', cfg);
		expect(inst?.key).toBe('key1');
		await inst?.dispose();
	});
});
