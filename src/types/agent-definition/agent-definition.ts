// SPDX-License-Identifier: MIT

/**
 * Versioned persisted agent document (Agent Studio + server).
 * v2 is the single source for main agents + worker bindings; v1 remains supported via compat.
 */

import { z } from 'zod';
import { REALTIME_LLM_PROVIDERS } from './realtime-llm-provider.js';
import {
	refineStudioBackgroundToolReasoningPayload,
	studioReasoningProviderSchema,
} from './studio-reasoning-schema.js';
import { persistedStudioTelephonySchema } from './studio-telephony.js';
import { persistedTtsConfigSchema } from './tts-config.js';
import {
	GEMINI_VOICE_NAMES,
	OPENAI_REALTIME_VOICES,
	USER_AGENT_STT_MODELS,
} from './voice-names.js';

export {
	STUDIO_REASONING_PROVIDERS,
	type StudioReasoningProvider,
	refineStudioBackgroundToolReasoningPayload,
	studioReasoningProviderSchema,
} from './studio-reasoning-schema.js';

export const AGENT_DEFINITION_SCHEMA_VERSION = 2 as const;

const geminiVoiceEnum = z.enum(GEMINI_VOICE_NAMES);
const openaiVoiceEnum = z.enum(OPENAI_REALTIME_VOICES);
const sttModelEnum = z.enum(USER_AGENT_STT_MODELS);
const realtimeLlmProviderEnum = z.enum(REALTIME_LLM_PROVIDERS);

/** Built-in image/video/read workers implemented in `bodhi-subagents.ts`. */
export const bodhiBuiltinSubagentWorkerSchema = z.object({
	type: z.literal('bodhi_builtin_subagent'),
	variant: z.enum(['generate_image', 'generate_video', 'read_image']),
});

export const bodhiPersistentClaudeWorkerSchema = z.object({
	type: z.literal('bodhi_persistent_claude'),
});

export const bodhiPersistentNanoclawWorkerSchema = z.object({
	type: z.literal('bodhi_persistent_nanoclaw'),
});

/** Background work delegated to an HTTP endpoint; result text is returned to Gemini via normal completion path. */
export const externalHttpWorkerSchema = z.object({
	type: z.literal('external_http'),
	url: z.string().url(),
	method: z.enum(['GET', 'POST', 'PUT']).default('POST'),
	headers: z.record(z.string(), z.string()).optional(),
	/** Optional JSON pointer–like path (dot segments) into JSON response for the string to return. */
	resultTextPath: z.string().optional(),
});

/**
 * Persistent coding / task worker on the user's HTTPS server.
 * Bodhi POSTs `{ sessionId, task }` to `{url}/task` with `Authorization: Bearer {token}`.
 */
export const remotePersistentWorkerSchema = z.object({
	type: z.literal('remote_persistent_worker'),
	/** Base URL (no trailing path); Bodhi appends `/task`. */
	url: z.string().url(),
	token: z.string().min(1).max(4096),
	pendingMessage: z.string().max(500).optional(),
	description: z.string().min(1).max(4000).optional(),
});

/** First-class Agent Studio background tool (one voice tool name = one worker entry). */
export const studioBackgroundToolWorkerSchema = z
	.object({
		type: z.literal('studio_background_tool'),
		description: z.string().min(1).max(4000),
		parametersSchema: z.record(z.string(), z.unknown()),
		pendingMessage: z.string().max(500).optional(),
		instructions: z.string().min(1).max(48000),
		code: z.string().min(1).max(120_000),
		reasoningProvider: studioReasoningProviderSchema.optional(),
		reasoningModel: z.string().min(1).max(256).optional(),
		/** Env var name or vault key name resolved server-side (e.g. GOOGLE_API_KEY, OPENAI_API_KEY). */
		reasoningApiKeyName: z.string().min(1).max(128).optional(),
		reasoningBaseUrl: z.string().url().max(4096).optional(),
		reasoningHeaders: z.record(z.string(), z.string()).optional(),
	})
	.superRefine((data, ctx) => {
		refineStudioBackgroundToolReasoningPayload(data, ctx, []);
	});

/** @internal Legacy v2 worker (pre–background-tool redesign). */
type LegacyStudioEphemeralWorker = {
	type: 'studio_ephemeral_subagent';
	displayName: string;
	instructions: string;
	allowedToolIds: string[];
	customInnerTools?: Array<{
		name: string;
		description: string;
		parametersSchema: Record<string, unknown>;
		code: string;
	}>;
	pendingMessage?: string;
};

function migrateLegacyEphemeralWorkerToBackground(
	toolName: string,
	w: LegacyStudioEphemeralWorker,
): z.infer<typeof studioBackgroundToolWorkerSchema> {
	const first = w.customInnerTools?.[0];
	if (first) {
		return {
			type: 'studio_background_tool',
			description: `${w.displayName}: ${first.description}`.slice(0, 4000),
			parametersSchema: { ...first.parametersSchema },
			pendingMessage: w.pendingMessage,
			instructions: w.instructions,
			code: first.code,
		};
	}
	return {
		type: 'studio_background_tool',
		description: `${w.displayName}. Migrated from older Agent Studio; add implementation code.`,
		parametersSchema: { type: 'object', additionalProperties: true },
		pendingMessage: w.pendingMessage,
		instructions: w.instructions,
		code: `throw new Error('[Agent Studio migration] Add implementation code for background tool "${toolName}".');`,
	};
}

function preprocessAgentDefinitionV2Workers(raw: unknown): unknown {
	if (raw === null || typeof raw !== 'object') return raw;
	const o = { ...(raw as Record<string, unknown>) };
	const workersIn = (o.workers as Record<string, unknown>) ?? {};
	const workersOut: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(workersIn)) {
		if (
			v &&
			typeof v === 'object' &&
			(v as { type?: string }).type === 'studio_ephemeral_subagent'
		) {
			workersOut[k] = migrateLegacyEphemeralWorkerToBackground(k, v as LegacyStudioEphemeralWorker);
		} else {
			workersOut[k] = v;
		}
	}
	o.workers = workersOut;
	return o;
}

/** `z.union` (not `discriminatedUnion`): `studio_background_tool` uses `.superRefine()` → `ZodEffects`. */
export const workerSpecSchema = z.union([
	bodhiBuiltinSubagentWorkerSchema,
	bodhiPersistentClaudeWorkerSchema,
	bodhiPersistentNanoclawWorkerSchema,
	externalHttpWorkerSchema,
	remotePersistentWorkerSchema,
	studioBackgroundToolWorkerSchema,
]);

export type WorkerSpec = z.infer<typeof workerSpecSchema>;

export const mainAgentDefinitionSchema = z.object({
	name: z.string().min(1).max(64),
	greeting: z.string().min(1).max(4000).optional(),
	instructions: z.string().min(1).max(96000),
	googleSearch: z.boolean().optional().default(true),
	/** Tool names must exist in the Bodhi tool library (or compiler errors). */
	toolIds: z.array(z.string().min(1).max(64)).min(1),
});

export type MainAgentDefinition = z.infer<typeof mainAgentDefinitionSchema>;

/**
 * Persisted knowledge-base document for Agent Studio (resolved to framework
 * `KnowledgeBaseConfig` at session start on the server).
 */
/**
 * High-level user-facing source families for KB documents.
 *
 * `inline_text`     — typed directly into Studio.
 * `uploaded_file`   — binary file uploaded to Supabase Storage and ingested.
 * `google_drive_doc`— Google Doc resolved via the Drive connector.
 * `google_drive_file`— Generic Drive file (PDF/DOCX/etc.) via the Drive connector.
 *
 * This is **persisted alongside** `sourceKind` (which describes the storage
 * representation) because the same `supabase_storage` row may originate from
 * very different upstream sources, and the UI / lifecycle differs.
 */
export const knowledgeSourceTypeEnum = z.enum([
	'inline_text',
	'uploaded_file',
	'google_drive_doc',
	'google_drive_file',
]);

export const ingestionJobStatusEnum = z.enum(['pending', 'processing', 'ready', 'failed']);

export const ingestionProviderIdEnum = z.enum(['none', 'unstructured', 'llamaparse', 'docling']);

export const connectorProviderIdEnum = z.enum(['google_drive']);

export const persistedKbDocumentSchema = z.object({
	id: z.string().min(1).max(128),
	name: z.string().min(1).max(256),
	mode: z.enum(['prompt', 'tool', 'auto']).optional(),
	/** Storage representation of the document content. */
	sourceKind: z.enum(['inline_text', 'supabase_storage', 'session_file']),
	/** When `sourceKind` is `inline_text`. No artificial max in Zod — hosts should enforce DB / payload limits. */
	text: z.string().optional(),
	/** Supabase Storage bucket (when `sourceKind` is `supabase_storage`). */
	bucket: z.string().min(1).max(128).optional(),
	/** Object path inside the bucket. */
	objectPath: z.string().min(1).max(2048).optional(),
	mimeType: z.string().max(128).optional(),
	/** Relative path under the per-session KB staging dir (reserved; v1 Studio may omit). */
	sessionRelativePath: z.string().max(1024).optional(),
	/**
	 * Logical upstream source family (independent of where the bytes are stored).
	 * Defaults to `inline_text` for legacy rows; new rows from uploads or connectors
	 * MUST set this so the Studio UI can render the correct affordances.
	 */
	sourceType: knowledgeSourceTypeEnum.optional(),
	/** Lifecycle of the ingestion job for this document. Defaults to `ready` for legacy rows. */
	ingestionStatus: ingestionJobStatusEnum.optional(),
	/** Parser adapter that produced (or last attempted to produce) the normalized text. */
	ingestionProviderId: ingestionProviderIdEnum.optional(),
	/** Connector adapter when the source originated from a connector. */
	connectorId: connectorProviderIdEnum.optional(),
	/** Storage object path containing the **normalized** UTF-8 text/markdown for this doc. */
	normalizedTextObjectPath: z.string().max(2048).optional(),
	/** Bytes of the normalized text artifact (post-parse), for size accounting. */
	normalizedTextBytes: z.number().int().nonnegative().optional(),
	/** Original URL when the source came from a connector (e.g. Drive web link). */
	sourceUrl: z.string().max(2048).optional(),
	/** External provider id (e.g. Google Drive file id) for re-sync / dedupe. */
	externalId: z.string().max(512).optional(),
	/** Last successful sync time, ms since epoch. */
	lastSyncedAt: z.number().int().nonnegative().optional(),
	/** Failure message when `ingestionStatus === 'failed'`. */
	errorMessage: z.string().max(2000).optional(),
});

export type PersistedKbDocument = z.infer<typeof persistedKbDocumentSchema>;

export const persistedKbBundleSchema = z.object({
	documents: z.array(persistedKbDocumentSchema).max(32),
});

export type PersistedKbBundle = z.infer<typeof persistedKbBundleSchema>;

/**
 * Optional client-leg media preference for app/server surfaces.
 * This is separate from `realtimeProvider` (Gemini vs OpenAI vendor transport).
 * `iceServers` remain surface/operator concerns and are not persisted per agent.
 */
export const persistedClientMediaConfigSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('websocket'),
	}),
	z.object({
		kind: z.literal('direct_rtc'),
		rtcAudio: z.enum(['none', 'werift_opus']).optional(),
	}),
]);

export type PersistedClientMediaConfig = z.infer<typeof persistedClientMediaConfigSchema>;

export { persistedTtsConfigSchema, type PersistedTtsConfig } from './tts-config.js';

/**
 * Optional Spatial Real (or future) avatar presentation for a saved Studio agent.
 * Stored in `user_agents.agent` jsonb; not used by voice compilation.
 */
export const persistedAvatarConfigSchema = z.object({
	enabled: z.boolean(),
	/** Catalog provider id (currently `spatialreal`, future providers may be added). */
	providerId: z.string().trim().min(1).max(128).default('spatialreal'),
	presetId: z.string().min(1).max(256),
});

export type PersistedAvatarConfig = z.infer<typeof persistedAvatarConfigSchema>;

export const agentDefinitionV2Schema = z.object({
	schemaVersion: z.literal(AGENT_DEFINITION_SCHEMA_VERSION),
	id: z.string().regex(/^ua_[a-f0-9]{16}$/),
	userId: z.string().min(1).max(256),
	name: z.string().min(1).max(120),
	description: z.string().max(2000).optional().default(''),
	realtimeProvider: realtimeLlmProviderEnum.optional(),
	clientMedia: persistedClientMediaConfigSchema.optional(),
	geminiVoiceName: geminiVoiceEnum.optional(),
	openaiVoice: openaiVoiceEnum.optional(),
	geminiSttModel: sttModelEnum.optional(),
	/** Optional external TTS provider. Omit or set `native` to use the live model's built-in audio. */
	ttsConfig: persistedTtsConfigSchema.optional(),
	mainAgents: z.array(mainAgentDefinitionSchema).min(1),
	/** Key = Gemini tool name; value = how to execute background work for that tool. */
	workers: z.record(z.string(), workerSpecSchema).default({}),
	/**
	 * Optional per-main-agent knowledge base attachments (Studio + Supabase storage).
	 * Key = `MainAgent.name` (typically `main`). Materialized server-side into
	 * framework `KnowledgeBaseConfig` before `compileAgentDefinition`.
	 */
	knowledgeBaseByAgentName: z.record(z.string(), persistedKbBundleSchema).optional(),
	/** Optional Talk + Avatar / embed presentation (browser Spatial Real). */
	avatarConfig: persistedAvatarConfigSchema.optional(),
	/** Optional verified outbound caller IDs for this saved agent (Recruiting studio). */
	studioTelephony: persistedStudioTelephonySchema.optional(),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
});

export type AgentDefinitionV2 = z.infer<typeof agentDefinitionV2Schema>;

export function parseAgentDefinitionV2(raw: unknown): AgentDefinitionV2 | null {
	const r = agentDefinitionV2Schema.safeParse(preprocessAgentDefinitionV2Workers(raw));
	return r.success ? r.data : null;
}

export const agentDefinitionV2PatchSchema = agentDefinitionV2Schema
	.omit({ id: true, userId: true, createdAt: true })
	.partial()
	.extend({
		id: z.string().regex(/^ua_[a-f0-9]{16}$/),
		userId: z.string().min(1).max(256),
		createdAt: z.number().int().nonnegative(),
	});

export type AgentDefinitionV2Patch = z.infer<typeof agentDefinitionV2PatchSchema>;
