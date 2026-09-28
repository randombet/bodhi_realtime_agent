/**
 * Packed-consumer declaration probe: the public API a host application builds against,
 * written as a registry consumer would import it.
 *
 * `scripts/verify-pack.mjs` compiles this file against the declarations of the installed
 * `bodhi-realtime-agent` tarball: once with `--module NodeNext` (ESM, `index.d.ts`) and once
 * inside a `"type": "commonjs"` package with `--module Node16` (`index.d.cts`). It is never
 * executed. `tsconfig.test.json` excludes it so the workspace typecheck never resolves the
 * package name. A change that adds public API appends its names here, so every one of them
 * is compiled from the published declarations. Until all names below exist, run the script
 * with `--skip-declarations`.
 */
import {
	CLOSE_CODE_CLIENT_BUSY,
	CLOSE_CODE_SUPERSEDED_BY_TAKEOVER,
	CLOSE_CODE_VERIFIER_PREEMPTED,
	CLOSE_REASON_CLIENT_BUSY,
	CLOSE_REASON_SUPERSEDED_BY_TAKEOVER,
	CLOSE_REASON_VERIFIER_PREEMPTED,
	type ClientConnectionRole,
	ClientTransport,
	type ClientTransportCallbacks,
	type ClientTransportOptions,
	type ConnectionLifecycleEvent,
	type HooksManager,
	type IEventBus,
	type LLMTransport,
	type LiveUsageMetadata,
	ToolExecutor,
	type TranscriptSink,
	type TransportDiagnostics,
	type TransportUsageMetadata,
	type UpstreamCounters,
	type UpstreamSlotCounters,
	VoiceSession,
	type VoiceSessionConfig,
	type VoiceSessionDiagnostics,
} from 'bodhi-realtime-agent';

declare const session: VoiceSession;
session.getDiagnostics();
session.getRecoveryCapabilities();
session.recoverUpstream({
	reason: 'active-silence',
	skipContextInjection: true,
	holdSyntheticUntilFreshSpeech: true,
});
session.isSyntheticHoldActive();
const connected: boolean = session.clientConnected;
session.sendJsonToClient({ type: 'agent.state', seq: 1 });
declare const config: VoiceSessionConfig;
config.onClientCommand;
config.onClientConnected;
config.suppressClientAutoActions;
config.onConnectionLifecycle;
config.onUsageMetadata;
config.probeState;
config.shadowSttProvider;
config.mediaResolution;
config.compressionConfig = {};
// The concrete ClientTransport accepts an application frame without importing a frame type.
declare const ct: ClientTransport;
ct.sendJsonToClient({ type: 'session_end' });
// A TranscriptSink and a ToolExecutor callback may take any JSON object.
const sink: TranscriptSink = {
	sendToClient: (msg: Record<string, unknown>): void => void msg,
	addUserMessage: (text: string): void => void text,
	addAssistantMessage: (text: string): void => void text,
};
declare const hooks: HooksManager;
declare const eventBus: IEventBus;
const executor = new ToolExecutor(
	hooks,
	eventBus,
	'sess',
	'main',
	(message: Record<string, unknown>): void => void message,
);
// The public per-attempt reconnect deadline is a static on VoiceSession.
const n: number = VoiceSession.RECONNECT_DEADLINE_MS;
// The diagnostics, connection-lifecycle and raw-usage types resolve from the root.
const diagnostics: VoiceSessionDiagnostics = session.getDiagnostics();
const upstream: UpstreamCounters | null = diagnostics.upstream;
const audioSlot: UpstreamSlotCounters | undefined = upstream?.audio;
declare const transportDiagnostics: TransportDiagnostics;
const generation: number = transportDiagnostics.transportGeneration;
config.onConnectionLifecycle = (event: ConnectionLifecycleEvent): void => {
	if (event.kind === 'generation-close') void event.transportGeneration;
};
config.onUsageMetadata = (usage: TransportUsageMetadata): void => {
	void (usage as LiveUsageMetadata).cachedContentTokenCount;
};
// A custom transport implements the widened onModelTurnStart and the generation start/end pair.
const customTransport: Pick<
	LLMTransport,
	'onModelTurnStart' | 'onGenerationStart' | 'onGenerationEnd'
> = {
	onModelTurnStart: (generationId?: string): void => void generationId,
	onGenerationStart: (generationId: string): void => void generationId,
	onGenerationEnd: (generationId, reason): void => {
		if (reason === 'superseded') void generationId;
	},
};
// ClientTransport is a root value: the five-argument constructor takes the verifier hooks and
// the probe option, the role getters are public, and the six close constants are exported.
const owned = new ClientTransport(
	9900,
	{ onVerifierConnected: (): void => {}, onVerifierDisconnected: (): void => {} },
	'127.0.0.1',
	10_000,
	{ probeState: () => ({ type: 'agent.state', v: 1, initialized: true }) },
);
const ownedCallbacks: ClientTransportCallbacks = { onClientConnected: (): void => {} };
const ownedOptions: ClientTransportOptions = { probeState: () => ({ initialized: true }) };
const ownedRole: ClientConnectionRole | null = owned.attachedRole;
const verifierAttached: boolean = owned.isVerifierConnected;
const closeCodes: readonly [number, number, number] = [
	CLOSE_CODE_CLIENT_BUSY,
	CLOSE_CODE_SUPERSEDED_BY_TAKEOVER,
	CLOSE_CODE_VERIFIER_PREEMPTED,
];
const closeReasons: readonly [string, string, string] = [
	CLOSE_REASON_CLIENT_BUSY,
	CLOSE_REASON_SUPERSEDED_BY_TAKEOVER,
	CLOSE_REASON_VERIFIER_PREEMPTED,
];
