import { describe, expect, it } from 'vitest';
import type {
	ClientConnectionRole,
	ClientTransportCallbacks,
	ClientTransportOptions,
	ConnectionLifecycleEvent,
	ConversationSnapshot,
	EchoCheckResult,
	EchoEnvEntry,
	EchoGuardConfig,
	GeminiLiveTranscribeLifecycleEvent,
	GeminiLiveTranscribeSTTOptions,
	GeminiLiveTranscribeSTTProviderConfig,
	KnownSessionEndReason,
	LiveUsageMetadata,
	PostSessionCapabilities,
	PostSessionContext,
	PostSessionDispatchInput,
	PostSessionEvents,
	PostSessionPipeline,
	PostSessionPipelineOptions,
	PostSessionReport,
	PostSessionResult,
	PostSessionRun,
	PostSessionSkip,
	PostSessionSnapshot,
	PostSessionSnapshotBuilder,
	PostSessionStats,
	PostSessionStores,
	RunFailureReason,
	RunOutcome,
	SessionEndReason,
	SessionMetricsSnapshot,
	TransportDiagnostics,
	TransportUsageMetadata,
	UpstreamCounters,
	UpstreamSlotCounters,
	VoiceSessionConfig,
	VoiceSessionDiagnostics,
} from '../src/index.js';
import {
	InMemoryPostSessionPipeline,
	PostSessionProcessor,
	isPostSessionSkip,
	postSessionSkip,
} from '../src/index.js';

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
		expect(mod.MultiClientTransport).toBeDefined();
		expect(mod.ClientSenderAdapter).toBeDefined();
		expect(mod.AudioBuffer).toBeDefined();
		expect(mod.zodToJsonSchema).toBeDefined();

		// Memory
		expect(mod.JsonMemoryStore).toBeDefined();
		expect(mod.MemoryDistiller).toBeDefined();

		// Types (constants)
		expect(mod.AUDIO_FORMAT).toBeDefined();
	});

	it('root-exports the diagnostics and lifecycle types; the lifecycle ledger stays internal', async () => {
		// Type-level: fails typecheck:tests if any name stops resolving from the root.
		const slot: UpstreamSlotCounters = {
			attempted: 0,
			queued: 0,
			skippedNoSession: 0,
			threw: 0,
			attemptedRawBytes: 0,
			queuedRawBytes: 0,
			attemptedWireBytesEstimate: 0,
			queuedWireBytesEstimate: 0,
			lastAttemptedAt: null,
			lastQueuedAt: null,
			lastSkippedAt: null,
			lastThrewAt: null,
		};
		const upstream: UpstreamCounters = {
			audio: slot,
			video: { ...slot, unsupportedMime: 0 },
			text: { ...slot, skippedEmpty: 0 },
		};
		const transport: TransportDiagnostics = { upstream, transportGeneration: 1 };
		const session: VoiceSessionDiagnostics = { ...transport, echoSuppressed: 0 };
		const event: ConnectionLifecycleEvent = {
			kind: 'setup-ok',
			connectAttemptId: 'att_1',
			transportGeneration: 1,
		};
		const usage: TransportUsageMetadata = { promptTokenCount: 1 };
		const live: LiveUsageMetadata = { ...usage, cachedContentTokenCount: 0 };
		expect([session.transportGeneration, event.kind, live.promptTokenCount]).toEqual([
			1,
			'setup-ok',
			1,
		]);

		const mod = await import('../src/index.js');
		expect('ConnectionLifecycleLedger' in mod).toBe(false);
	});

	it('root-exports ClientTransport, its option and role types and the client close codes', async () => {
		const mod = await import('../src/index.js');
		expect(typeof mod.ClientTransport).toBe('function');
		expect(mod.CLOSE_CODE_CLIENT_BUSY).toBe(4409);
		expect(mod.CLOSE_REASON_CLIENT_BUSY).toBe('client-busy');
		expect(mod.CLOSE_CODE_SUPERSEDED_BY_TAKEOVER).toBe(4410);
		expect(mod.CLOSE_REASON_SUPERSEDED_BY_TAKEOVER).toBe('superseded-by-takeover');
		expect(mod.CLOSE_CODE_VERIFIER_PREEMPTED).toBe(4411);
		expect(mod.CLOSE_REASON_VERIFIER_PREEMPTED).toBe('verifier-preempted');

		// Type-level: fails typecheck:tests if any name stops resolving from the root.
		const role: ClientConnectionRole = 'verify';
		const callbacks: ClientTransportCallbacks = { onVerifierConnected: () => {} };
		const options: ClientTransportOptions = { probeState: () => ({ type: 'agent.state' }) };
		expect([role, typeof callbacks.onVerifierConnected, typeof options.probeState]).toEqual([
			'verify',
			'function',
			'function',
		]);
	});

	it('root-exports EchoGuard, its envelope helpers and its config and result types', async () => {
		const mod = await import('../src/index.js');
		expect(typeof mod.EchoGuard).toBe('function');
		expect(typeof mod.envelopePearson).toBe('function');
		expect(typeof mod.bestEnvelopeLag).toBe('function');

		// Type-level: fails typecheck:tests if any name stops resolving from the root.
		const config: EchoGuardConfig = { enabled: true };
		const entry: EchoEnvEntry = { rms: 0.5, at: 0 };
		const result: EchoCheckResult = { suppress: false, corr: 0, lagMs: -1 };
		expect([config.enabled, entry.rms, result.suppress]).toEqual([true, 0.5, false]);
	});

	it('root-exports GeminiLiveTranscribeSTTProvider with its credential config and lifecycle types', async () => {
		const mod = await import('../src/index.js');
		expect(typeof mod.GeminiLiveTranscribeSTTProvider).toBe('function');

		// Type-level: fails typecheck:tests if any name stops resolving from the root.
		const options: GeminiLiveTranscribeSTTOptions = { connectTimeoutMs: 30_000 };
		const config: GeminiLiveTranscribeSTTProviderConfig = {
			...options,
			credentialProvider: async () => ({ apiKey: 'auth_tokens/t', expiresAtMs: 0 }),
		};
		const event: GeminiLiveTranscribeLifecycleEvent = { phase: 'setup-ok', connectionId: 1 };
		expect([typeof config.credentialProvider, event.phase]).toEqual(['function', 'setup-ok']);
	});

	it('root-exports the post-session pipeline, the processor base and the post-session types; the default pipeline and built-in processors stay internal', async () => {
		const mod = await import('../src/index.js');
		expect(typeof mod.InMemoryPostSessionPipeline).toBe('function');
		expect(typeof mod.PostSessionProcessor).toBe('function');
		for (const internal of [
			'createDefaultPostSessionPipeline',
			'getDefaultPostSessionPipeline',
			'MemoryDistillationProcessor',
			'AnalyticsProcessor',
		]) {
			expect(internal in mod, internal).toBe(false);
		}

		// A host-style processor and pipeline, built only from root names. Type-level: fails
		// typecheck:tests if any name stops resolving from the root.
		class CountItems extends PostSessionProcessor {
			readonly name = 'count-items';
			override shouldRun(ctx: PostSessionContext): boolean {
				return ctx.reason !== 'error';
			}
			async run(ctx: PostSessionContext): Promise<Record<string, unknown>> {
				return { items: ctx.conversation.items.length, closed: ctx.signal.aborted };
			}
		}
		const options: PostSessionPipelineOptions = { runBudgetMs: 5_000, maxConcurrentRuns: 4 };
		const pipeline = new InMemoryPostSessionPipeline(options);
		pipeline.register(new CountItems());
		pipeline.freeze();
		const asContract: PostSessionPipeline = pipeline;
		const asConfig: VoiceSessionConfig['postSessionPipeline'] = pipeline;
		const events: PostSessionEvents = asContract.events;
		const processed: PostSessionReport[] = [];
		const unsubscribe = events.onProcessed((r) => processed.push(r));

		const known: KnownSessionEndReason = 'user_hangup';
		const reason: SessionEndReason = 'host_defined_reason';
		const conversation: ConversationSnapshot = { items: [] };
		const metrics: SessionMetricsSnapshot = {
			turnCount: 0,
			toolCallCount: 0,
			agentTransferCount: 0,
		};
		const stores: PostSessionStores = {};
		const build: PostSessionSnapshotBuilder = (r) => {
			const snapshot: PostSessionSnapshot = {
				sessionId: 'sess_1',
				userId: 'user_1',
				initialAgentName: 'main',
				finalAgentName: 'main',
				transferPath: ['main'],
				reason: r,
				startedAt: 0,
				endedAt: 1,
				durationMs: 1,
				metadata: { tenant: 'example' },
				conversation,
				metrics,
			};
			return { snapshot, stores };
		};
		const input: PostSessionDispatchInput = { sessionId: 'sess_1', reason, build };
		const run: PostSessionRun = asContract.dispatch(input);
		const report: PostSessionReport = await run.report;
		const first: PostSessionResult | undefined = report.results[0];
		const outcome: RunOutcome = report.outcome;
		const stats: PostSessionStats = pipeline.stats();
		unsubscribe();

		expect([known, outcome, first?.status, first?.detail]).toEqual([
			'user_hangup',
			'accepted',
			'completed',
			{ items: 0, closed: false },
		]);
		expect(processed).toEqual([report]);
		expect(asConfig).toBe(pipeline);
		expect(stats.completed).toBe(1);

		// Capabilities are the live half of the context; RunFailureReason is open to
		// reasons a later release adds.
		const capabilities: PostSessionCapabilities = {
			stores,
			signal: new AbortController().signal,
		};
		const futureReason: RunFailureReason = 'a_reason_added_later';
		const knownReason: RunFailureReason = 'queue_overflow';
		expect([capabilities.signal.aborted, futureReason, knownReason]).toEqual([
			false,
			'a_reason_added_later',
			'queue_overflow',
		]);
	});

	it('root-exports postSessionSkip, isPostSessionSkip and the PostSessionSkip type; the brand symbol stays internal', async () => {
		const mod = await import('../src/index.js');
		expect(typeof mod.postSessionSkip).toBe('function');
		expect(typeof mod.isPostSessionSkip).toBe('function');
		expect('POST_SESSION_SKIP' in mod).toBe(false);

		class OptOutAware extends PostSessionProcessor {
			readonly name = 'opt-out-aware';
			async run(ctx: PostSessionContext): Promise<Record<string, unknown> | PostSessionSkip> {
				if (ctx.metadata?.optedOut === true) return postSessionSkip('user opted out');
				return { exported: true };
			}
		}
		const pipeline = new InMemoryPostSessionPipeline();
		pipeline.register(new OptOutAware());
		pipeline.freeze();
		const report = await pipeline.dispatch({
			sessionId: 'sess_1',
			reason: 'normal',
			build: (reason) => ({
				snapshot: {
					sessionId: 'sess_1',
					userId: 'user_1',
					initialAgentName: 'main',
					finalAgentName: 'main',
					transferPath: ['main'],
					reason,
					startedAt: 0,
					endedAt: 1,
					durationMs: 1,
					metadata: { optedOut: true },
					conversation: { items: [] },
					metrics: { turnCount: 0, toolCallCount: 0, agentTransferCount: 0 },
				},
				stores: {},
			}),
		}).report;
		expect(report.results[0]).toMatchObject({
			status: 'skipped',
			detail: { reason: 'run_skipped', skipReason: 'user opted out' },
		});

		const skip: PostSessionSkip = postSessionSkip('consent lookup failed', { attempt: 1 });
		expect(isPostSessionSkip(skip)).toBe(true);
		// Type-level: only postSessionSkip() (or a deliberate cast) produces the branded type.
		// @ts-expect-error a plain object lacks the brand
		const plain: PostSessionSkip = { reason: 'consent lookup failed' };
		expect(isPostSessionSkip(plain)).toBe(false);
	});
});
