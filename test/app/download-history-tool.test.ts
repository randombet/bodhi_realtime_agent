// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { createBodhiSessionConfig } from '../../app/agents/bodhi-session.js';
import { resolveAgentWithKnowledgeBase } from '../../src/agent/agent-context.js';
import type { ConversationHistoryStore } from '../../src/types/history.js';
import type { ToolContext, ToolDefinition } from '../../src/types/tool.js';

/**
 * Build a minimal session config and extract the session_data_action tool
 * from the main agent's tools array.
 */
async function getSessionDataActionTool(
	conversationHistoryStore?: ConversationHistoryStore,
): Promise<ToolDefinition> {
	const config = await createBodhiSessionConfig({
		apiKey: 'test-key',
		memoryStore: {
			addFacts: vi.fn(),
			getAll: vi.fn(async () => []),
			replaceAll: vi.fn(),
			getDirectives: vi.fn(async () => null),
			setDirectives: vi.fn(),
		},
		clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
		sessionId: 'sess_test',
		userId: 'user_test',
		conversationHistoryStore,
		getSessionRef: () => null,
	});
	const mainAgent = config.agents[0];
	const tool = mainAgent.tools.find((t) => t.name === 'session_data_action');
	if (!tool) throw new Error('session_data_action tool not found');
	return tool;
}

function createMockCtx(overrides?: Partial<ToolContext>): ToolContext {
	return {
		toolCallId: 'tc_1',
		agentName: 'main',
		sessionId: 'sess_test',
		abortSignal: new AbortController().signal,
		sendJsonToClient: vi.fn(),
		...overrides,
	};
}

function createMockStore(overrides?: Partial<ConversationHistoryStore>): ConversationHistoryStore {
	return {
		createSession: vi.fn(),
		updateSession: vi.fn(),
		addItems: vi.fn(),
		saveSessionReport: vi.fn(),
		getSession: vi.fn(async () => ({
			id: 'sess_test',
			userId: 'user_test',
			initialAgentName: 'main',
			status: 'active' as const,
			startedAt: Date.now(),
		})),
		getSessionItems: vi.fn(async () => [
			{ role: 'assistant' as const, content: 'Hello!', timestamp: 1000 },
			{ role: 'user' as const, content: 'Hi there', timestamp: 2000 },
			{ role: 'assistant' as const, content: 'How can I help?', timestamp: 3000 },
			{ role: 'user' as const, content: 'What time is it?', timestamp: 4000 },
			{ role: 'assistant' as const, content: 'It is 3pm.', timestamp: 5000 },
		]),
		listUserSessions: vi.fn(async () => []),
		...overrides,
	};
}

describe('session_data_action tool (download_history)', () => {
	it('sends conversation history to client and returns success', async () => {
		const store = createMockStore();
		const tool = await getSessionDataActionTool(store);
		const ctx = createMockCtx();
		const before = Date.now();

		const result = await tool.execute({ action: 'download_history' }, ctx);

		expect(ctx.sendJsonToClient).toHaveBeenCalledOnce();
		const call = (ctx.sendJsonToClient as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.type).toBe('conversation_history');
		expect(call.data.sessionId).toBe('sess_test');
		expect(call.data.itemCount).toBe(5);
		expect(call.data.items).toHaveLength(5);
		expect(call.data.generatedAt).toBeGreaterThanOrEqual(before);
		expect(call.data.generatedAt).toBeLessThanOrEqual(Date.now());
		expect(call.data.session).toBeDefined();
		expect(result).toEqual({
			status: 'sent',
			itemCount: 5,
			message: 'Sent 5 conversation items to your screen for download.',
		});
	});

	it('returns error when conversationHistoryStore is undefined', async () => {
		const tool = await getSessionDataActionTool(undefined);
		const ctx = createMockCtx();

		const result = await tool.execute({ action: 'download_history' }, ctx);

		expect(result).toEqual({
			status: 'error',
			message: 'Conversation history is not enabled.',
		});
		expect(ctx.sendJsonToClient).not.toHaveBeenCalled();
	});

	it('returns error when sendJsonToClient is unavailable', async () => {
		const store = createMockStore();
		const tool = await getSessionDataActionTool(store);
		const ctx = createMockCtx({ sendJsonToClient: undefined });

		const result = await tool.execute({ action: 'download_history' }, ctx);

		expect(result).toEqual({
			status: 'error',
			message: 'No web client connection available for download.',
		});
	});

	it('handles empty session (null session, no items)', async () => {
		const store = createMockStore({
			getSession: vi.fn(async () => null),
			getSessionItems: vi.fn(async () => []),
		});
		const tool = await getSessionDataActionTool(store);
		const ctx = createMockCtx();

		const result = await tool.execute({ action: 'download_history' }, ctx);

		expect(ctx.sendJsonToClient).toHaveBeenCalledOnce();
		const call = (ctx.sendJsonToClient as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(call.data.itemCount).toBe(0);
		expect(call.data.session).toBeNull();
		expect(call.data.items).toEqual([]);
		expect(result).toEqual({
			status: 'sent',
			itemCount: 0,
			message: 'Sent 0 conversation items to your screen for download.',
		});
	});

	it('returns error when payload exceeds MAX_EXPORT_BYTES', async () => {
		// Create items large enough to exceed 5MB
		const largeContent = 'x'.repeat(100_000);
		const largeItems = Array.from({ length: 60 }, (_, i) => ({
			role: 'assistant' as const,
			content: largeContent,
			timestamp: i,
		}));
		const store = createMockStore({
			getSessionItems: vi.fn(async () => largeItems),
		});
		const tool = await getSessionDataActionTool(store);
		const ctx = createMockCtx();

		const result = (await tool.execute({ action: 'download_history' }, ctx)) as {
			status: string;
			message: string;
		};

		expect(result.status).toBe('error');
		expect(result.message).toMatch(/too large/);
		expect(ctx.sendJsonToClient).not.toHaveBeenCalled();
	});

	it('calls getSession and getSessionItems with ctx.sessionId', async () => {
		const store = createMockStore();
		const tool = await getSessionDataActionTool(store);
		const ctx = createMockCtx();

		await tool.execute({ action: 'download_history' }, ctx);

		expect(store.getSession).toHaveBeenCalledWith('sess_test');
		expect(store.getSessionItems).toHaveBeenCalledWith('sess_test');
	});
});

describe('artifact registry wiring in bodhi session config', () => {
	it('creates an artifactRegistry on session config', async () => {
		const config = await createBodhiSessionConfig({
			apiKey: 'test-key',
			memoryStore: {
				addFacts: vi.fn(),
				getAll: vi.fn(async () => []),
				replaceAll: vi.fn(),
				getDirectives: vi.fn(async () => null),
				setDirectives: vi.fn(),
			},
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			sessionId: 'sess_artifacts',
			userId: 'user_test',
			getSessionRef: () => null,
		});

		expect(config.artifactRegistry).toBeDefined();
		expect(typeof config.artifactRegistry?.store).toBe('function');
		expect(typeof config.artifactRegistry?.dispose).toBe('function');
	});

	it('exposes list_artifacts tool that returns session artifacts', async () => {
		const config = await createBodhiSessionConfig({
			apiKey: 'test-key',
			memoryStore: {
				addFacts: vi.fn(),
				getAll: vi.fn(async () => []),
				replaceAll: vi.fn(),
				getDirectives: vi.fn(async () => null),
				setDirectives: vi.fn(),
			},
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			sessionId: 'sess_artifacts',
			userId: 'user_test',
			getSessionRef: () => null,
		});
		const listArtifactsTool = config.agents[0]?.tools.find((t) => t.name === 'list_artifacts');
		expect(listArtifactsTool).toBeDefined();

		config.artifactRegistry?.store('ZmFrZQ==', 'image/png', 'test image', 'generated');
		const result = (await listArtifactsTool?.execute({}, createMockCtx())) as {
			artifacts: Array<{ id: string }>;
		};

		expect(Array.isArray(result.artifacts)).toBe(true);
		expect(result.artifacts.length).toBe(1);
		expect(result.artifacts[0]?.id.startsWith('art_')).toBe(true);
	});

	it('list_artifacts returns empty array before any artifact is stored', async () => {
		const config = await createBodhiSessionConfig({
			apiKey: 'test-key',
			memoryStore: {
				addFacts: vi.fn(),
				getAll: vi.fn(async () => []),
				replaceAll: vi.fn(),
				getDirectives: vi.fn(async () => null),
				setDirectives: vi.fn(),
			},
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			sessionId: 'sess_artifacts_empty',
			userId: 'user_test',
			getSessionRef: () => null,
		});
		const listArtifactsTool = config.agents[0]?.tools.find((t) => t.name === 'list_artifacts');
		expect(listArtifactsTool).toBeDefined();

		const result = (await listArtifactsTool?.execute({}, createMockCtx())) as {
			artifacts: Array<{ id: string }>;
		};
		expect(result.artifacts).toEqual([]);
	});

	it('injects list_artifacts for standard, claude_code, and nanoclaw profiles', async () => {
		const baseOptions = {
			apiKey: 'test-key',
			memoryStore: {
				addFacts: vi.fn(),
				getAll: vi.fn(async () => []),
				replaceAll: vi.fn(),
				getDirectives: vi.fn(async () => null),
				setDirectives: vi.fn(),
			},
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			sessionId: 'sess_profiles',
			userId: 'user_test',
			getSessionRef: () => null,
		};

		const standard = await createBodhiSessionConfig({
			...baseOptions,
			agentProfile: 'standard',
		});
		const claude = await createBodhiSessionConfig({
			...baseOptions,
			agentProfile: 'claude_code',
		});
		const nanoclaw = await createBodhiSessionConfig({
			...baseOptions,
			agentProfile: 'nanoclaw',
		});

		expect(standard.agents[0]?.tools.some((t) => t.name === 'list_artifacts')).toBe(true);
		expect(claude.agents[0]?.tools.some((t) => t.name === 'list_artifacts')).toBe(true);
		expect(nanoclaw.agents[0]?.tools.some((t) => t.name === 'list_artifacts')).toBe(true);
	});

	it('structured_screening profile uses knowledgeBase config and resolves documents at session time', async () => {
		const config = await createBodhiSessionConfig({
			apiKey: 'test-key',
			memoryStore: {
				addFacts: vi.fn(),
				getAll: vi.fn(async () => []),
				replaceAll: vi.fn(),
				getDirectives: vi.fn(async () => null),
				setDirectives: vi.fn(),
			},
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			sessionId: 'sess_structured_screening_profile',
			userId: 'user_test',
			getSessionRef: () => null,
			agentProfile: 'structured_screening',
		});

		const mainAgent = config.agents[0];
		// structured_screening uses knowledgeBase instead of legacy augmentation
		expect(mainAgent?.knowledgeBase).toBeDefined();
		expect(mainAgent?.knowledgeBase?.documents).toHaveLength(3);
		expect(mainAgent?.knowledgeBase?.documents.map((d) => d.name)).toEqual([
			'Company Profile',
			'Job Description',
			'Candidate Resume',
		]);

		// Documents are injected at session connect time via resolveAgentWithKnowledgeBase,
		// so the base instructions don't contain file content. Verify via the resolver:
		// biome-ignore lint/style/noNonNullAssertion: test assertion already checks mainAgent exists
		const resolved = resolveAgentWithKnowledgeBase(mainAgent!);
		expect(resolved.instructions).toContain('Calendly');
		expect(resolved.instructions).toContain('Full Stack Engineer, Commerce');
		expect(resolved.instructions).toContain('YIXUAN ZHAI');
	});

	it('injects read_image for standard, claude_code, and nanoclaw profiles', async () => {
		const baseOptions = {
			apiKey: 'test-key',
			memoryStore: {
				addFacts: vi.fn(),
				getAll: vi.fn(async () => []),
				replaceAll: vi.fn(),
				getDirectives: vi.fn(async () => null),
				setDirectives: vi.fn(),
			},
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			sessionId: 'sess_read_image_profiles',
			userId: 'user_test',
			getSessionRef: () => null,
		};

		const standard = await createBodhiSessionConfig({
			...baseOptions,
			agentProfile: 'standard',
		});
		const claude = await createBodhiSessionConfig({
			...baseOptions,
			agentProfile: 'claude_code',
		});
		const nanoclaw = await createBodhiSessionConfig({
			...baseOptions,
			agentProfile: 'nanoclaw',
		});

		expect(standard.agents[0]?.tools.some((t) => t.name === 'read_image')).toBe(true);
		expect(claude.agents[0]?.tools.some((t) => t.name === 'read_image')).toBe(true);
		expect(nanoclaw.agents[0]?.tools.some((t) => t.name === 'read_image')).toBe(true);
	});

	it('configures read_image as background tool with a pending message', async () => {
		const config = await createBodhiSessionConfig({
			apiKey: 'test-key',
			memoryStore: {
				addFacts: vi.fn(),
				getAll: vi.fn(async () => []),
				replaceAll: vi.fn(),
				getDirectives: vi.fn(async () => null),
				setDirectives: vi.fn(),
			},
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			sessionId: 'sess_read_image_tool',
			userId: 'user_test',
			getSessionRef: () => null,
		});
		const readImageTool = config.agents[0]?.tools.find((t) => t.name === 'read_image');
		expect(readImageTool).toBeDefined();
		expect(readImageTool?.execution).toBe('background');
		expect(readImageTool?.pendingMessage).toContain("I'm analyzing your image now.");
	});

	it('registers read_image subagent and returns missing-artifact error', async () => {
		const config = await createBodhiSessionConfig({
			apiKey: 'test-key',
			memoryStore: {
				addFacts: vi.fn(),
				getAll: vi.fn(async () => []),
				replaceAll: vi.fn(),
				getDirectives: vi.fn(async () => null),
				setDirectives: vi.fn(),
			},
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			sessionId: 'sess_read_image_subagent',
			userId: 'user_test',
			getSessionRef: () => null,
		});

		const readImageSubagent = config.subagentConfigs.read_image;
		expect(readImageSubagent).toBeDefined();
		expect(readImageSubagent?.name).toBe('image_reader');

		type AnalyzeImageTool = {
			execute: (args: { artifactId: string; question: string }) => Promise<unknown>;
		};
		const analyzeImageTool = (
			readImageSubagent?.tools as Record<string, AnalyzeImageTool> | undefined
		)?.analyze_image;
		expect(analyzeImageTool).toBeDefined();

		const result = await analyzeImageTool?.execute({
			artifactId: 'art_missing',
			question: 'What is in this image?',
		});

		expect(result).toEqual({
			status: 'error',
			error: 'Image artifact art_missing not found. It may have expired.',
		});
	});
});
