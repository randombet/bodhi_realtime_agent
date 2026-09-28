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
	type BackgroundNotificationQueue,
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
	type EchoCheckResult,
	type EchoEnvEntry,
	EchoGuard,
	type EchoGuardConfig,
	type GeminiBatchSTTProvider,
	type HooksManager,
	type IEventBus,
	type LLMTransport,
	type LiveUsageMetadata,
	RECOVERY_CAPABILITIES,
	type RecoverUpstreamArgs,
	type RecoverUpstreamResult,
	type RecoveryCapabilities,
	type SendOrQueueOptions,
	type SessionManager,
	ToolExecutor,
	type TranscriptSink,
	type TransportDiagnostics,
	type TransportUsageMetadata,
	type UpstreamCounters,
	type UpstreamSlotCounters,
	VoiceSession,
	type VoiceSessionConfig,
	type VoiceSessionDiagnostics,
	bestEnvelopeLag,
	envelopePearson,
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
// Gemini server-VAD settings sent verbatim as realtimeInputConfig.automaticActivityDetection.
config.vadConfig = { silenceDurationMs: 200, prefixPaddingMs: 0 };
// The host recovery descriptor and types resolve from the root, and the legacy notification
// queue can be held.
const fullRecovery: RecoveryCapabilities = RECOVERY_CAPABILITIES;
const recoverArgs: RecoverUpstreamArgs = {
	reason: 'human-retry',
	skipContextInjection: false,
	holdSyntheticUntilFreshSpeech: false,
};
const recovery: RecoverUpstreamResult = session.recoverUpstream(recoverArgs);
const recoveryEpoch: number = recovery.attemptEpoch;
declare const notificationQueue: BackgroundNotificationQueue;
notificationQueue.setHeld(true);
// The real-client detach edge is a host hook, beside the attach hook above.
config.onClientDisconnected;
// A standalone SessionManager can be reset after a close, and a background notification can
// name the tool call it reports so a duplicate for the same call is dropped.
declare const standaloneManager: SessionManager;
standaloneManager.reset();
const dedupOptions: SendOrQueueOptions = { priority: 'normal', toolCallId: 'call_1' };
notificationQueue.sendOrQueue([{ role: 'user', parts: [{ text: 'done' }] }], true, dedupOptions);
// Shadow transcription reports where it disagrees with the model's own hearing, and can be set
// to correct the answer.
config.onTranscriptionDivergence = (liveText: string, shadowText: string, turnId?: number): void =>
	void [liveText, shadowText, turnId];
config.divergenceCorrection = true;
// Echo suppression: the guard and its envelope helpers are root values, and a session enables
// the guard through its config.
const echoConfig: EchoGuardConfig = { enabled: true, corrThreshold: 0.75 };
config.echoGuard = echoConfig;
const echoGuard = new EchoGuard(echoConfig);
declare const micPcm: Parameters<EchoGuard['check']>[0];
echoGuard.feedReference(micPcm, 24000);
const echoCheck: EchoCheckResult = echoGuard.check(micPcm, 16000);
const echoSuppressedWindows: number = echoGuard.suppressedCount;
const echoEntry: EchoEnvEntry = { rms: 0.5, at: 0 };
const envelopeCorr: number = envelopePearson([echoEntry.rms], [echoEntry.rms]);
const envelopeLag: { corr: number; lagMs: number } = bestEnvelopeLag(
	[echoEntry.rms],
	[echoEntry],
	0,
	12,
	1500,
	20,
);
// Batch transcription takes a vocabulary hint after construction, static or re-read per commit,
// and exposes the prompt it sends.
declare const batchStt: GeminiBatchSTTProvider;
batchStt.setContextHint(() => 'KDA, delta rule');
const batchSttPrompt: string = batchStt.buildPrompt();
