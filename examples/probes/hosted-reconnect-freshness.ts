/**
 * Probe — R7c reconnect-window freshness verdicts on a REAL Gemini reconnect
 * (design-retained-user-content-recovery.md R7c; rollout doc P5), in the
 * hosted session shape. No microphone: the model's spoken greeting is
 * captured and re-fed as the "user" speech.
 *
 * For each scenario the probe seals a retained utterance, then forces an
 * actual resumption-handle reconnect (private `reconnector.triggerReconnect`
 * — acceptable in a probe; there is no public way to force one) and controls
 * what flows through `feedAudioFromClient` during the RECONNECTING window:
 *
 *   silence — zero-PCM frames keep streaming (a normal idle client)
 *             → verdict 'none'        → expect stage-2 replay (or tier-3
 *               nudge if the model already answered and cleared the retainer)
 *   speech  — the captured utterance streams into the window
 *             → verdict 'hosted-speech' → expect
 *               `Skipping retained replay — hosted user spoke during reconnect`
 *   none    — nothing flows (forwarding died)
 *             → verdict 'unknown'     → expect
 *               `Skipping retained replay — reconnect-window speech state unknown`
 *
 * Results are RECORDED (RESULT lines), not asserted — live-model timing can
 * race (the model may answer the utterance before the reconnect starts,
 * which clears the retained candidate; the verdict logs still appear).
 *
 * Run: pnpm tsx examples/probes/hosted-reconnect-freshness.ts [silence|speech|none|all]
 * Env: GEMINI_API_KEY (or GOOGLE_API_KEY); optional GEMINI_LIVE_MODEL.
 */

import 'dotenv/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { resamplePcm } from '../../src/audio/resample.js';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';

const API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
if (!API_KEY) {
	console.error('GEMINI_API_KEY required');
	process.exit(1);
}
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const CASE = (process.argv[2] ?? 'all') as 'silence' | 'speech' | 'none' | 'all';

const FRAME_MS = 20;
const FRAME_BYTES = (16_000 * 2 * FRAME_MS) / 1000;

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

const capturedLines: string[] = [];
const origLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
	capturedLines.push(args.map(String).join(' '));
	origLog(...args);
};
const sawLine = (needle: string, since = 0): boolean =>
	capturedLines.slice(since).some((l) => l.includes(needle));

async function sleep(ms: number): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

/** Probe-only access to session internals (no public force-reconnect exists). */
interface SessionInternals {
	reconnector: { triggerReconnect(reason: string, elicit?: boolean): void };
	sessionManager: { state: string; resumptionHandle: string | null };
}
const internals = (s: VoiceSession) => s as unknown as SessionInternals;

async function runScenario(kind: 'silence' | 'speech' | 'none'): Promise<void> {
	origLog(`${ts()} ── scenario "${kind}" (model=${MODEL}) ──`);
	const assistantChunks: Buffer[] = [];
	let captureAssistant = true;

	const probeAgent: MainAgent = {
		name: 'main',
		instructions: 'You are a concise voice assistant. Answer every question in one short sentence.',
		greeting: 'Say exactly: "What is the largest planet in our solar system?" and nothing else.',
		tools: [],
	};
	const google = createGoogleGenerativeAI({ apiKey: API_KEY });
	const session = new VoiceSession({
		sessionId: `probe_${kind}_${Date.now()}`,
		userId: 'probe_user',
		apiKey: API_KEY,
		agents: [probeAgent],
		initialAgent: 'main',
		model: google('gemini-2.5-flash'),
		geminiModel: MODEL,
		clientSender: {
			sendAudio: (data: Buffer) => {
				if (captureAssistant) assistantChunks.push(data);
			},
			sendJson: () => {},
		},
		watchdogReplayRecovery: true,
		// Keep the watchdog out of the way — this probe drives the reconnect
		// directly; only the post-reconnect verdict path is under test.
		responseWatchdogMs: 30_000,
		speechConfig: { voiceName: 'Puck' },
	});

	await session.start();
	session.notifyClientConnected();
	await sleep(9_000); // greeting = speech source
	captureAssistant = false;
	const speech24k = Buffer.concat(assistantChunks);
	if (speech24k.length < 48_000) {
		origLog(`${ts()} FATAL: captured only ${speech24k.length}B of greeting audio`);
		await session.close('user_hangup');
		return;
	}
	const speech16k = resamplePcm(speech24k, 24_000, 16_000, 16);

	// Wait for a resumption handle (required for reconnect-with-state).
	const i = internals(session);
	const deadline = Date.now() + 20_000;
	while (!i.sessionManager.resumptionHandle && Date.now() < deadline) await sleep(250);
	if (!i.sessionManager.resumptionHandle) {
		origLog(`${ts()} FATAL: no resumption handle arrived — cannot probe reconnect`);
		await session.close('user_hangup');
		return;
	}

	// Seal a retained utterance: feed the speech + enough silence for the VAD
	// to complete, then IMMEDIATELY force the reconnect (racing the model's
	// answer — if the model wins, the retainer is cleared and the 'none'
	// scenario falls to the tier-3 nudge; recorded either way).
	for (let off = 0; off < speech16k.length; off += FRAME_BYTES) {
		session.feedAudioFromClient(speech16k.subarray(off, off + FRAME_BYTES));
		await sleep(FRAME_MS);
	}
	const silent = Buffer.alloc(FRAME_BYTES);
	for (let t = 0; t < 620; t += FRAME_MS) {
		session.feedAudioFromClient(silent);
		await sleep(FRAME_MS);
	}

	const mark = capturedLines.length;
	i.reconnector.triggerReconnect('response-watchdog', true);

	// Drive the reconnect window per scenario until the reconnect completes.
	const windowDeadline = Date.now() + 15_000;
	let speechOffset = 0;
	while (!sawLine('Reconnect complete', mark) && Date.now() < windowDeadline) {
		if (kind === 'silence') {
			session.feedAudioFromClient(silent);
		} else if (kind === 'speech') {
			session.feedAudioFromClient(speech16k.subarray(speechOffset, speechOffset + FRAME_BYTES));
			speechOffset = (speechOffset + FRAME_BYTES) % Math.max(FRAME_BYTES, speech16k.length);
		} // 'none': feed nothing — forwarding went dark
		await sleep(FRAME_MS);
	}
	await sleep(4_000); // let post-reconnect recovery act

	const reconnected = sawLine('Reconnect complete', mark);
	const replayedAfter = sawLine('Replayed retained user utterance after reconnect', mark);
	const skippedHosted = sawLine('hosted user spoke during reconnect', mark);
	const skippedUnknown = sawLine('reconnect-window speech state unknown', mark);
	const nudged = sawLine('Re-eliciting model response after reconnect', mark);
	origLog(
		`RESULT scenario=${kind} reconnected=${reconnected ? 'YES' : 'NO'} ` +
			`stage2Replay=${replayedAfter ? 'YES' : 'NO'} skipHostedSpeech=${skippedHosted ? 'YES' : 'NO'} ` +
			`skipUnknown=${skippedUnknown ? 'YES' : 'NO'} tier3Nudge=${nudged ? 'YES' : 'NO'}`,
	);
	await session.close('user_hangup');
	await sleep(500);
}

async function main() {
	const cases: Array<'silence' | 'speech' | 'none'> =
		CASE === 'all' ? ['silence', 'speech', 'none'] : [CASE];
	for (const c of cases) await runScenario(c);
	origLog(`${ts()} probe complete`);
	process.exit(0);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
