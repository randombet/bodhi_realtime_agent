// SPDX-License-Identifier: MIT

import { z } from 'zod';

const ttsApiKeyNameSchema = z
	.string()
	.regex(/^[A-Z][A-Z0-9_]*$/)
	.max(128);

export const persistedTtsConfigSchema = z.discriminatedUnion('provider', [
	z.object({
		provider: z.literal('native'),
	}),
	z.object({
		provider: z.literal('cartesia'),
		voiceId: z.string().trim().min(1).max(128).optional(),
		modelId: z.string().trim().min(1).max(64).optional(),
		language: z.string().trim().min(1).max(16).optional(),
		speed: z
			.union([z.enum(['slowest', 'slow', 'normal', 'fast', 'fastest']), z.number()])
			.optional(),
		emotion: z.array(z.string().trim().min(1).max(64)).max(12).optional(),
		apiKeyName: ttsApiKeyNameSchema.optional(),
	}),
	z.object({
		provider: z.literal('elevenlabs'),
		voiceId: z.string().trim().min(1).max(128).optional(),
		modelId: z.string().trim().min(1).max(128).optional(),
		stability: z.number().min(0).max(1).optional(),
		similarityBoost: z.number().min(0).max(1).optional(),
		style: z.number().min(0).max(1).optional(),
		useSpeakerBoost: z.boolean().optional(),
		languageCode: z.string().trim().min(1).max(32).optional(),
		apiKeyName: ttsApiKeyNameSchema.optional(),
	}),
	z.object({
		provider: z.literal('hume'),
		voiceName: z.string().trim().min(1).max(128).optional(),
		voiceId: z.string().trim().min(1).max(128).optional(),
		voiceProvider: z.enum(['HUME_AI', 'CUSTOM_VOICE']).optional(),
		description: z.string().trim().min(1).max(1000).optional(),
		version: z.enum(['1', '2']).optional(),
		speed: z.number().min(0.25).max(4).optional(),
		apiKeyName: ttsApiKeyNameSchema.optional(),
	}),
]);

export type PersistedTtsConfig = z.infer<typeof persistedTtsConfigSchema>;
