// SPDX-License-Identifier: MIT

/**
 * Shared Studio background-tool reasoning settings (Zod + refinements).
 * Lives in its own module to avoid a circular import between `agent-definition` and `user-agent-record`.
 */

import { z } from 'zod';

/** Per–Studio-tool AI SDK model used for the relay subagent (`generateText`). */
export const STUDIO_REASONING_PROVIDERS = [
	'inherit',
	'google',
	'openai',
	'openai_compatible',
	'anthropic',
] as const;
export type StudioReasoningProvider = (typeof STUDIO_REASONING_PROVIDERS)[number];
export const studioReasoningProviderSchema = z.enum(STUDIO_REASONING_PROVIDERS);

/** Validates reasoning fields for a studio background tool (v2 worker or v1 record). */
export function refineStudioBackgroundToolReasoningPayload(
	data: {
		reasoningProvider?: StudioReasoningProvider | undefined;
		reasoningModel?: string | undefined;
		reasoningBaseUrl?: string | undefined;
	},
	ctx: z.RefinementCtx,
	pathPrefix: (string | number)[],
): void {
	const rp = data.reasoningProvider ?? 'inherit';
	if (rp === 'openai_compatible') {
		if (!data.reasoningBaseUrl?.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'reasoningBaseUrl is required when reasoningProvider is openai_compatible',
				path: [...pathPrefix, 'reasoningBaseUrl'],
			});
		}
		if (!data.reasoningModel?.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'reasoningModel is required when reasoningProvider is openai_compatible',
				path: [...pathPrefix, 'reasoningModel'],
			});
		}
	}
	if (rp === 'anthropic') {
		if (!data.reasoningModel?.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'reasoningModel is required when reasoningProvider is anthropic',
				path: [...pathPrefix, 'reasoningModel'],
			});
		}
	}
}
