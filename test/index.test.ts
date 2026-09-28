import { describe, expect, it } from 'vitest';
import type {
	ClientConnectionRole,
	ClientTransportCallbacks,
	ClientTransportOptions,
	ConnectionLifecycleEvent,
	LiveUsageMetadata,
	TransportDiagnostics,
	TransportUsageMetadata,
	UpstreamCounters,
	UpstreamSlotCounters,
	VoiceSessionDiagnostics,
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
});
