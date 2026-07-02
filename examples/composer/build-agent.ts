// SPDX-License-Identifier: MIT

/**
 * Agent Composer example — non-interactive.
 *
 * Drives the Composer generation pipeline over a canned requirement and writes a
 * runnable `AgentDefinitionV2` to a file store. A thin top-level consumer of
 * `composer/` (examples may import from composer/, src/, and app/; nothing in those
 * imports back from examples/).
 *
 * Run live (needs a Gemini key):
 *   GEMINI_API_KEY=... pnpm tsx examples/composer/build-agent.ts
 *
 * The hermetic test (examples/test/composer-build-agent.test.ts) injects a fake
 * generateObject so it runs with no keys.
 */

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { JsonUserAgentStore } from '../../app/server/stores/json-user-agent-store.js';
import type { UserAgentStore } from '../../app/server/stores/user-agent-store.js';
import {
	type ComposerRequirements,
	type GenerateObjectFn,
	type GenerateResult,
	generateAgentDefinition,
} from '../../composer/src/pipeline.js';
import { generationSchema } from '../../composer/src/schema.js';

/** The canned requirement this demo builds. */
export const EXAMPLE_REQUIREMENTS: ComposerRequirements = {
	purpose: 'a friendly cooking assistant that can do math and tell the time',
	desiredCapabilities: ['arithmetic', 'current time'],
	realtimeProviderConstraint: 'none',
	webSearchRequested: false,
	deferredRequirements: [],
	reducedScopeConfirmed: false,
};

export interface BuildExampleDeps {
	store: Pick<UserAgentStore, 'putIfAbsent'>;
	generateObjectFn: GenerateObjectFn;
	env: Record<string, string | undefined>;
}

/** Testable core: run the example requirement through the pipeline. */
export function buildExampleAgent(deps: BuildExampleDeps): Promise<GenerateResult> {
	return generateAgentDefinition(EXAMPLE_REQUIREMENTS, {
		env: deps.env,
		userId: 'cli-local',
		store: deps.store,
		generateObjectFn: deps.generateObjectFn,
	});
}

/** Live wiring: a `generateObjectFn` backed by Gemini via the Vercel AI SDK. */
export function createGeminiGenerationFn(
	apiKey: string,
	model = 'gemini-2.5-flash',
): GenerateObjectFn {
	const google = createGoogleGenerativeAI({ apiKey });
	const m = google(model);
	return async ({ system, prompt }) => {
		const { object } = await generateObject({ model: m, system, prompt, schema: generationSchema });
		return { object };
	};
}

async function main(): Promise<void> {
	const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
	if (!apiKey) {
		console.error('Set GEMINI_API_KEY (or GOOGLE_API_KEY) to run the live demo.');
		process.exit(1);
	}
	const storeDir = process.env.COMPOSER_STORE_DIR ?? './user-agents';
	const store = new JsonUserAgentStore(storeDir);
	const result = await buildExampleAgent({
		store,
		generateObjectFn: createGeminiGenerationFn(apiKey),
		env: process.env,
	});
	if (result.ok) {
		console.log(`✓ ${result.summary}`);
		console.log(`  saved: ${storeDir}/cli-local/${result.agentId}.json`);
	} else {
		console.error(`✗ ${result.code}: ${result.message}`);
		process.exit(1);
	}
}

// Run only when executed directly (not when imported by the hermetic test).
if (process.argv[1]?.endsWith('build-agent.ts')) {
	void main();
}
