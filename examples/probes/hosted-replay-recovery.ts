/**
 * Probe — design-hosted-replay-recovery-rollout.md (H4, case A) and the
 * parent doc's R7a/R7b guards, end-to-end in the HOSTED session shape
 * (`clientSender` → ClientSenderAdapter, input via `feedAudioFromClient`)
 * against the real Gemini Live API. No microphone needed: the model speaks
 * the greeting, the probe captures that audio, resamples 24 k → 16 k, and
 * feeds it back as the "user" utterance.
 *
 * Scenarios (forced stall via a deliberately short response watchdog,
 * PROBE_WATCHDOG_MS, default 700 ms — fires before Gemini's typical
 * 1.3–2.8 s first token):
 *
 *   1. stage-1 replay  — barge-in utterance, then silence; the watchdog
 *      fires before the model responds → expect
 *      `[Watchdog] … replayed retained user utterance in-place (no reconnect)`
 *      followed by model audio, and (when a partial was pending) the R7b
 *      `Promoted pending input partial…` line.
 *   2. R7a deferral    — a second utterance is STILL STREAMING when the
 *      watchdog fires → expect `[Watchdog] … deferred (user speech in
 *      progress; no replay, no reconnect)`, then normal recovery after the
 *      utterance completes.
 *
 * Results are RECORDED (RESULT lines), not asserted — live-model timing can
 * race (if Gemini answers faster than the watchdog, the stall is not forced;
 * rerun or lower PROBE_WATCHDOG_MS).
 *
 * Run: pnpm tsx examples/probes/hosted-replay-recovery.ts
 * Env: GEMINI_API_KEY (or GOOGLE_API_KEY); optional PROBE_WATCHDOG_MS,
 *      GEMINI_LIVE_MODEL.
 */

import 'dotenv/config';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { resamplePcm } from '../../src/audio/resample.js';
import { VoiceSession } from '../../src/core/voice-session.js';
import { GeminiBatchSTTProvider } from '../../src/transport/gemini-batch-stt-provider.js';
import type { MainAgent } from '../../src/types/agent.js';

const API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
if (!API_KEY) {
	console.error('GEMINI_API_KEY required');
	process.exit(1);
}
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const WATCHDOG_MS = Number(process.env.PROBE_WATCHDOG_MS) || 700;

const FRAME_MS = 20;
const FRAME_BYTES = (16_000 * 2 * FRAME_MS) / 1000; // 640 B @16 kHz PCM16 mono

function ts(): string {
	return new Date().toISOString().slice(11, 23);
}

// Tee console.log so the probe can scan VoiceSession's [Watchdog] lines.
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

/** Feed PCM16 @16 kHz in real-time-paced frames through the hosted input path. */
async function feedPcm(session: VoiceSession, pcm: Buffer): Promise<void> {
	for (let off = 0; off < pcm.length; off += FRAME_BYTES) {
		session.feedAudioFromClient(pcm.subarray(off, off + FRAME_BYTES));
		await sleep(FRAME_MS);
	}
}

/** Feed silence frames (continuous client streaming) for `ms`. */
async function feedSilence(session: VoiceSession, ms: number): Promise<void> {
	const silent = Buffer.alloc(FRAME_BYTES);
	for (let t = 0; t < ms; t += FRAME_MS) {
		session.feedAudioFromClient(silent);
		await sleep(FRAME_MS);
	}
}

async function main() {
	origLog(`${ts()} hosted replay-recovery probe (model=${MODEL}, watchdog=${WATCHDOG_MS}ms)`);

	// Hosted shape: the probe plays the role of the multi-user server — it owns
	// the (virtual) client socket and registers an outbound-only sender.
	const assistantChunks: Buffer[] = [];
	let captureAssistant = true;
	let assistantBytesSinceMark = 0;

	const probeAgent: MainAgent = {
		name: 'main',
		instructions: 'You are a concise voice assistant. Answer every question in one short sentence.',
		greeting: 'Say exactly: "What is the largest planet in our solar system?" and nothing else.',
		tools: [],
	};

	const google = createGoogleGenerativeAI({ apiKey: API_KEY });
	const session = new VoiceSession({
		sessionId: `probe_${Date.now()}`,
		userId: 'probe_user',
		apiKey: API_KEY,
		agents: [probeAgent],
		initialAgent: 'main',
		model: google('gemini-2.5-flash'),
		geminiModel: MODEL,
		clientSender: {
			sendAudio: (data: Buffer) => {
				if (captureAssistant) assistantChunks.push(data);
				assistantBytesSinceMark += data.length;
			},
			sendJson: () => {},
		},
		watchdogReplayRecovery: true,
		responseWatchdogMs: WATCHDOG_MS, // deliberately below first-token latency: forces the stall path
		sttProvider: new GeminiBatchSTTProvider({ apiKey: API_KEY, model: 'gemini-3-flash-preview' }),
		speechConfig: { voiceName: 'Puck' },
	});

	await session.start();
	session.notifyClientConnected();
	origLog(`${ts()} waiting for the greeting (speech source)...`);
	await sleep(9_000); // let the greeting stream fully
	captureAssistant = false;
	const speech24k = Buffer.concat(assistantChunks);
	if (speech24k.length < 48_000) {
		origLog(`${ts()} FATAL: captured only ${speech24k.length}B of greeting audio`);
		await session.close('user_hangup');
		process.exit(1);
	}
	const speech16k = resamplePcm(speech24k, 24_000, 16_000, 16);
	origLog(`${ts()} speech source ready: ${speech24k.length}B @24k → ${speech16k.length}B @16k`);

	// ── Scenario 1: forced stall → stage-1 in-place replay ────────────────────
	origLog(`${ts()} SCENARIO 1: utterance + silence; watchdog should beat the model...`);
	let mark = capturedLines.length;
	await feedPcm(session, speech16k); // barge-in during/after greeting tail
	await feedSilence(session, 700); // VAD completes at 500 ms silence → seal + arm
	assistantBytesSinceMark = 0;
	await feedSilence(session, WATCHDOG_MS + 1_500); // watchdog window + margin
	await sleep(6_000); // wait for the replayed turn's response

	const s1Replayed = sawLine('replayed retained user utterance in-place', mark);
	const s1Promoted = sawLine('Promoted pending input partial', mark);
	const s1Reconnect = sawLine('Reconnect attempt', mark);
	const s1ModelAnswered = assistantBytesSinceMark > 10_000;
	origLog(
		`RESULT scenario=stage1 replayedInPlace=${s1Replayed ? 'YES' : 'NO'} ` +
			`transcriptPromoted=${s1Promoted ? 'YES' : 'NO'} modelAnswered=${s1ModelAnswered ? 'YES' : 'NO'} ` +
			`reconnect=${s1Reconnect ? 'YES (unexpected)' : 'NO (expected)'} ` +
			`[assistantAudio=${assistantBytesSinceMark}B]` +
			(s1Replayed
				? ''
				: ' — stall not forced (model beat the watchdog); rerun or lower PROBE_WATCHDOG_MS'),
	);
	await feedSilence(session, 500);
	await sleep(2_000);

	// ── Scenario 2: R7a mid-speech deferral ───────────────────────────────────
	// Utterance A completes (arms the watchdog), utterance B starts immediately
	// and is still streaming when the watchdog fires → deferral, no replay, no
	// reconnect; B's own completion re-arms and recovery proceeds.
	origLog(`${ts()} SCENARIO 2: watchdog fires while a second utterance is mid-speech...`);
	mark = capturedLines.length;
	await feedPcm(session, speech16k); // utterance A
	await feedSilence(session, 620); // A completes → watchdog armed
	await feedPcm(session, speech16k); // utterance B spans the watchdog window
	const s2Deferred = sawLine('deferred (user speech in progress', mark);
	await feedSilence(session, 700); // B completes → re-arm
	assistantBytesSinceMark = 0;
	await feedSilence(session, WATCHDOG_MS + 1_500);
	await sleep(6_000);

	const s2RecoveredAfter =
		sawLine('replayed retained user utterance in-place', mark) || assistantBytesSinceMark > 10_000;
	origLog(
		`RESULT scenario=r7a-deferral deferredMidSpeech=${s2Deferred ? 'YES' : 'NO'} ` +
			`recoveredAfterCompletion=${s2RecoveredAfter ? 'YES' : 'NO'} ` +
			`[assistantAudio=${assistantBytesSinceMark}B]` +
			(s2Deferred ? '' : ' — deferral not observed (model answered A before B started); rerun'),
	);

	await session.close('user_hangup');
	origLog(`${ts()} probe complete`);
	process.exit(0);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
