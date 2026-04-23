// SPDX-License-Identifier: MIT

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { describe, expect, it } from 'vitest';
import {
	createReasoningApiKeyResolver,
	materializeStudioReasoningModel,
} from '../../app/agents/runtime/reasoning-provider-registry.js';

describe('reasoning-provider-registry', () => {
	it('createReasoningApiKeyResolver maps standard names and custom vault keys', () => {
		const r = createReasoningApiKeyResolver({
			googleApiKey: 'G',
			openAiApiKey: 'O',
			userKeyMap: new Map([['CUSTOM_KEY', 'secret']]),
		});
		expect(r('GOOGLE_API_KEY')).toBe('G');
		expect(r('OPENAI_API_KEY')).toBe('O');
		expect(r('CUSTOM_KEY')).toBe('secret');
	});

	it('materializeStudioReasoningModel uses inherit and distinct google model', () => {
		const defaultReasoningModel = createGoogleGenerativeAI({ apiKey: 'gk' })('gemini-2.5-flash');
		const baseSpec = {
			type: 'studio_background_tool' as const,
			description: 'd',
			parametersSchema: {},
			instructions: 'i',
			code: 'return 1;',
		};
		const ctx = {
			defaultReasoningModel,
			googleApiKey: 'gk',
			openAiApiKey: 'ok',
		};
		expect(materializeStudioReasoningModel(baseSpec, ctx)).toBe(defaultReasoningModel);
		const m = materializeStudioReasoningModel(
			{
				...baseSpec,
				reasoningProvider: 'google',
				reasoningModel: 'gemini-2.0-flash',
			},
			ctx,
		);
		expect(m).not.toBe(defaultReasoningModel);
	});
});
