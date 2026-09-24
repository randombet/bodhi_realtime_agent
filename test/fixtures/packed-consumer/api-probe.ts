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
	type ClientTransport,
	type ConnectionLifecycleEvent,
	type HooksManager,
	type IEventBus,
	ToolExecutor,
	type TranscriptSink,
	type UpstreamCounters,
	VoiceSession,
	type VoiceSessionConfig,
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
// The connection-lifecycle event type resolves from the root and narrows by kind.
config.onConnectionLifecycle = (event: ConnectionLifecycleEvent): void => {
	if (event.kind === 'generation-close') void event.transportGeneration;
};
