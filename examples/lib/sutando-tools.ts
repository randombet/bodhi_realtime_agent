/**
 * Sutando wiring for bodhi voice agents — the drop-in construct from
 * dev_docs/design-sutando-persistent-subagent.md.
 *
 * `createSutandoAgentConfig()` packages everything a bodhi app needs to use
 * the owner's Sutando (on their Mac, reached via the relay) as its execution
 * backend: the `ask_sutando` background tool, the persistent subagent config,
 * and a persona fragment — mirroring how createHermesSubagentConfig packages
 * the Hermes wiring.
 *
 * `validateSutandoWiring()` asserts every invariant the runtime silently
 * degrades without (see design §2): any single missing piece falls back to
 * non-persistent subagent execution instead of erroring, so the demo/app must
 * fail fast at construction time instead.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MainAgent, SubagentConfig } from '../../src/types/agent.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import type { SutandoRelayServer } from './sutando-relay-server.js';
import { type SutandoInstanceHooks, SutandoSubagentInstance } from './sutando-subagent-instance.js';

export const ASK_SUTANDO_TOOL_NAME = 'ask_sutando';

export interface CreateSutandoAgentConfigOptions {
	/** The in-process relay the Mac's bridge long-polls. */
	relay: SutandoRelayServer;
	/** Voice session identity — the factory closes over it (see design §2). */
	sessionId: string;
	userId?: string;
	/** Out-of-band hooks: notifySystem → publishSystemNotification, recordRaw → sidecar. */
	hooks?: SutandoInstanceHooks;
	watchdogMs?: number;
	taskTtlMs?: number;
	priority?: string;
	/** Whether the session declares the Google Search grounding tool. Drives the
	 *  persona's routing line only — the caller still enables the tool itself on
	 *  the agent/transport. Default true (matches the historical fragment). When
	 *  false, the fragment must not advertise a tool the model cannot call:
	 *  quick lookups then route to model knowledge or ask_sutando. */
	googleSearch?: boolean;
}

export interface SutandoAgentWiring {
	/** Model-facing background tool (name = registry key = persistent key). */
	tool: ToolDefinition;
	/** Register as subagentConfigs[ASK_SUTANDO_TOOL_NAME]. */
	subagentConfig: SubagentConfig;
	/** Persona fragment for the main agent's instructions. */
	personaFragment: string;
	/** Session-unique prefix of every task ID this wiring submits. */
	taskIdPrefix: string;
	/** The per-session nonce (channel key: bodhi-<nonce>). */
	nonce: string;
}

/**
 * Session-scoped builder. Build one per VoiceSession — never share a wiring
 * object between sessions (task-ID namespaces and continuity digests are
 * per-session by design).
 */
export function createSutandoAgentConfig(
	options: CreateSutandoAgentConfigOptions,
): SutandoAgentWiring {
	const nonce = randomUUID().replace(/-/g, '').slice(0, 8);
	// One instance per (session, tool): the factory closes over session identity
	// because the PersistentSubagentFactory API only receives (key, config).
	let instance: SutandoSubagentInstance | null = null;

	const subagentConfig: SubagentConfig = {
		name: ASK_SUTANDO_TOOL_NAME,
		instructions: "Relay to the user's Sutando agent on their Mac.",
		tools: {},
		lifetime: 'persistent_session',
		persistentFactory: async (key) => {
			instance ??= new SutandoSubagentInstance(key, {
				relay: options.relay,
				sessionId: options.sessionId,
				nonce,
				userId: options.userId,
				hooks: options.hooks,
				watchdogMs: options.watchdogMs,
				taskTtlMs: options.taskTtlMs,
				priority: options.priority,
			});
			return instance;
		},
	};

	const tool: ToolDefinition = {
		name: ASK_SUTANDO_TOOL_NAME,
		description:
			"Delegate a task to the user's Sutando agent running on their Mac. " +
			'Use this for email, calendar, meetings, phone calls, screen/files on the Mac, coding, ' +
			'research, and any multi-step task that should run with the full capabilities of their ' +
			'personal agent. Sutando remembers prior delegated tasks within this voice session.',
		parameters: z.object({
			task: z
				.string()
				.describe(
					'A complete, self-contained brief for Sutando — include every specific the task needs',
				),
		}),
		execution: 'background',
		pendingMessage:
			"I'm passing that to your Sutando now — I'll let you know the moment it comes back.",
		execute: async () => {
			return { text: 'Routed to Sutando', stepCount: 0 };
		},
	};

	const personaFragment = [
		'TOOL ROUTING:',
		'- ask_sutando: Delegate complex or action-oriented tasks to the user’s Sutando agent on their Mac.',
		'  Use it for email, calendar, meetings, phone calls, files/screen on the Mac, coding, research,',
		'  and any multi-step task. Write a complete, self-contained brief — Sutando cannot see this conversation.',
		...(options.googleSearch !== false
			? ['- Google Search: quick factual lookups only (weather, news, facts) — never delegate these.']
			: []),
		'',
		'VOICE RULES:',
		'- Keep responses short and clear (2-3 sentences).',
		'- Do not read code, logs, or long markdown aloud; summarize the outcome.',
		'- If Sutando asks for clarification (a result starting with [needs-input]), relay one concise question to the user,',
		'  then send their answer back with ask_sutando.',
		'- Never claim Sutando completed an external action unless Sutando confirmed it.',
		'- Do not expose internal routing details unless the user asks how the system works.',
	].join('\n');

	return {
		tool,
		subagentConfig,
		personaFragment,
		taskIdPrefix: `task-bodhi-${nonce}`,
		nonce,
	};
}

/** Structural subset of VoiceSessionConfig that the validator inspects. */
export interface SutandoWiringConfig {
	orchestrationMode?: 'legacy' | 'actor';
	agents: MainAgent[];
	subagentConfigs?: Record<string, SubagentConfig>;
}

/**
 * Fail-fast assertion of every Sutando invariant. Call before constructing the
 * VoiceSession. Throws with an actionable message on the first violation.
 */
export function validateSutandoWiring(
	config: SutandoWiringConfig,
	toolName: string = ASK_SUTANDO_TOOL_NAME,
): void {
	if (config.orchestrationMode !== 'actor') {
		throw new Error(
			`Sutando wiring requires orchestrationMode: 'actor' — got ${JSON.stringify(
				config.orchestrationMode ?? 'legacy (default)',
			)}. The legacy router never consults the persistent manager; delegation would silently fall back to non-persistent subagent execution.`,
		);
	}

	const tool = config.agents.flatMap((agent) => agent.tools).find((t) => t.name === toolName);
	if (!tool) {
		throw new Error(
			`Sutando wiring: no agent carries a "${toolName}" tool — add wiring.tool to the main agent's tools.`,
		);
	}
	if (tool.execution !== 'background') {
		throw new Error(
			`Sutando wiring: "${toolName}" must be execution: 'background' — got '${tool.execution}'. An inline Sutando delegation would block the live voice turn for the whole round-trip.`,
		);
	}
	if (!tool.pendingMessage) {
		throw new Error(
			`Sutando wiring: "${toolName}" must define a pendingMessage — the immediate pending tool result is what lets the voice turn continue while Sutando works.`,
		);
	}

	const subagentConfig = config.subagentConfigs?.[toolName];
	if (!subagentConfig) {
		throw new Error(
			`Sutando wiring: subagentConfigs["${toolName}"] is missing — the registry key must equal the tool name (the runtime looks configs up by tool name).`,
		);
	}
	if (subagentConfig.lifetime !== 'persistent_session') {
		throw new Error(
			`Sutando wiring: subagentConfigs["${toolName}"].lifetime must be 'persistent_session' — got ${JSON.stringify(subagentConfig.lifetime ?? 'ephemeral (default)')}. Without it every delegation starts a fresh conversation with the core.`,
		);
	}
	if (typeof subagentConfig.persistentFactory !== 'function') {
		throw new Error(
			`Sutando wiring: subagentConfigs["${toolName}"].persistentFactory must be a function — without it the actor runtime falls back to normal (non-Sutando) handoff execution.`,
		);
	}
}
