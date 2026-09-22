// SPDX-License-Identifier: MIT

/**
 * Optional telephony metadata persisted on Studio user agents (`user_agents.agent` jsonb).
 * Verified outbound caller IDs are scoped per saved agent (ua_*).
 */

import { z } from 'zod';

export const studioVerifiedCallerIdEntrySchema = z.object({
	sid: z.string().min(2).max(40),
	phoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/),
	friendlyName: z.string().max(256).optional(),
	verifiedAt: z.number().int().nonnegative(),
});

export type StudioVerifiedCallerIdEntry = z.infer<typeof studioVerifiedCallerIdEntrySchema>;

export const persistedStudioTelephonySchema = z.object({
	verifiedCallerIds: z.array(studioVerifiedCallerIdEntrySchema).max(24).default([]),
	/** E.164 selected for outbound dial; empty string = platform default (`TWILIO_OUTBOUND_FROM`). */
	outboundCallerIdPhone: z
		.union([z.literal(''), z.string().regex(/^\+[1-9]\d{6,14}$/)])
		.optional()
		.default(''),
});

export type PersistedStudioTelephony = z.infer<typeof persistedStudioTelephonySchema>;

export function defaultStudioTelephony(): PersistedStudioTelephony {
	return { verifiedCallerIds: [], outboundCallerIdPhone: '' };
}

export function parsePersistedStudioTelephony(raw: unknown): PersistedStudioTelephony | null {
	const r = persistedStudioTelephonySchema.safeParse(raw);
	return r.success ? r.data : null;
}

export function normalizeE164Key(s: string): string {
	return s.trim().replace(/[^0-9+]/g, '');
}
