// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TtsPipeline, type TtsPipelineDeps } from '../../src/core/tts-pipeline.js';
import type { LLMTransport } from '../../src/types/transport.js';
import type { TTSAudioConfig, TTSProvider } from '../../src/types/tts.js';

/**
 * Unit characterization for the TtsPipeline extraction (Step 5b). Pins the
 * pipeline-owned wiring decisions that are NOT the gate's state machine (which
 * has its own test): the dictation-mode guard, the stale-requestId drop, the
 * resample-and-forward audio path, and the word-boundary forward. The
 * end-to-end finalize ordering is pinned separately by the oracle.
 */

const FMT_24K: TTSAudioConfig = { sampleRate: 24000, bitDepth: 16, channels: 1, encoding: 'pcm' };

function makeTransport(): LLMTransport {
	return {
		audioFormat: {
			inputSampleRate: 16000,
			outputSampleRate: 24000,
			channels: 1,
			bitDepth: 16,
			encoding: 'pcm',
		},
		capabilities: { frameworkOwnsInterrupt: true },
		cancelResponse: vi.fn(),
	} as unknown as LLMTransport;
}

function makeProvider(fmt: TTSAudioConfig = FMT_24K): TTSProvider {
	return {
		configure: vi.fn(() => fmt),
		synthesize: vi.fn(),
		cancel: vi.fn(),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
	} as unknown as TTSProvider;
}

function makeDeps(over: Partial<TtsPipelineDeps> = {}) {
	const sendAudioToClient = vi.fn();
	const sendJsonToClient = vi.fn();
	const sendJsonAfterAudio = vi.fn();
	const clientTransport = {
		sendAudioToClient,
		sendJsonToClient,
		sendJsonAfterAudio,
	} as never;
	const completionArbiter = {
		clearDefer: vi.fn(),
		completePlayback: vi.fn(),
		finishOrDeferForVad: vi.fn(),
	} as never;
	const deps: TtsPipelineDeps = {
		transport: makeTransport(),
		getClientTransport: () => clientTransport,
		hooks: {} as never,
		sessionId: 'sess_tts',
		fallbackMarginMs: 50,
		minPlaybackRate: 0.5,
		ensureCurrentTurn: vi.fn(),
		getCurrentTurn: () => null,
		handleTranscriptOutput: vi.fn(),
		isAgentMode: () => true,
		isPlaybackStateProtocolActive: () => true,
		getCompletionArbiter: () => completionArbiter,
		maybeArmGraceOnFirstAudio: vi.fn(),
		signalAudioStarted: vi.fn(),
		requestInterrupt: vi.fn(() => true),
		finalizeTurn: vi.fn(),
		close: vi.fn(),
		log: vi.fn(),
		...over,
	};
	return { deps, sendAudioToClient, sendJsonToClient, completionArbiter };
}

/** `ms` of 24 kHz PCM16 mono as base64 (48 bytes/ms). */
function pcm(ms: number): string {
	return Buffer.alloc(Math.round(ms * 48)).toString('base64');
}

function wirePipeline(over: Partial<TtsPipelineDeps> = {}) {
	const { deps, ...spies } = makeDeps(over);
	const provider = makeProvider();
	const pipeline = new TtsPipeline(provider, deps);
	pipeline.wire();
	return { pipeline, provider, transport: deps.transport, deps, ...spies };
}

describe('TtsPipeline — text path', () => {
	beforeEach(() => vi.useFakeTimers());

	it('begins a request and synthesizes the first non-empty agent-mode text', () => {
		const { provider, transport } = wirePipeline();
		transport.onTextOutput?.('Hello.');
		expect(provider.synthesize).toHaveBeenCalledWith('Hello.', 1);
	});

	it('dictation guard: drops text (no synthesize) when not in agent mode', () => {
		const { provider, transport, deps } = wirePipeline({ isAgentMode: () => false });
		transport.onTextOutput?.('Hello.');
		expect(deps.handleTranscriptOutput).toHaveBeenCalledWith('Hello.'); // transcript still flows
		expect(provider.synthesize).not.toHaveBeenCalled(); // but TTS does not
	});

	it('skips empty / whitespace-only text', () => {
		const { provider, transport } = wirePipeline();
		transport.onTextOutput?.('   ');
		expect(provider.synthesize).not.toHaveBeenCalled();
	});
});

describe('TtsPipeline — audio path', () => {
	beforeEach(() => vi.useFakeTimers());

	it('forwards current-requestId audio to the client and notes it on the gate', () => {
		const { provider, transport, sendAudioToClient, deps } = wirePipeline();
		transport.onTextOutput?.('Hi.'); // requestId → 1
		provider.onAudio?.(pcm(100), 100, 1);
		expect(sendAudioToClient).toHaveBeenCalledTimes(1);
		expect(deps.signalAudioStarted).toHaveBeenCalled();
	});

	it('drops stale-requestId audio (no client send)', () => {
		const { provider, transport, sendAudioToClient } = wirePipeline();
		transport.onTextOutput?.('Hi.'); // requestId → 1
		provider.onAudio?.(pcm(100), 100, 0); // superseded id
		expect(sendAudioToClient).not.toHaveBeenCalled();
	});

	it('dictation guard: drops audio when not in agent mode', () => {
		const isAgent = { v: true };
		const { provider, transport, sendAudioToClient } = wirePipeline({
			isAgentMode: () => isAgent.v,
		});
		transport.onTextOutput?.('Hi.'); // requestId → 1 (agent mode)
		isAgent.v = false; // flip to dictation before audio arrives
		provider.onAudio?.(pcm(100), 100, 1);
		expect(sendAudioToClient).not.toHaveBeenCalled();
	});
});

describe('TtsPipeline — done path', () => {
	beforeEach(() => vi.useFakeTimers());

	it('a no-audio turn completes immediately on done', () => {
		const { provider, transport, completionArbiter } = wirePipeline();
		transport.onTextOutput?.('Hi.'); // requestId → 1, no audio
		provider.onDone?.(1);
		expect(completionArbiter.completePlayback).toHaveBeenCalledTimes(1);
	});

	it('an audio-bearing turn arms the fallback (never completes synchronously)', () => {
		const { provider, transport, completionArbiter } = wirePipeline();
		transport.onTextOutput?.('Hi.');
		provider.onAudio?.(pcm(100), 100, 1);
		provider.onDone?.(1);
		expect(completionArbiter.completePlayback).not.toHaveBeenCalled();
		// Fallback timer fires → defer-or-complete routing.
		vi.advanceTimersByTime(5000);
		expect(completionArbiter.finishOrDeferForVad).toHaveBeenCalledWith('fallback');
	});

	it('drops a stale-requestId done', () => {
		const { provider, transport, completionArbiter } = wirePipeline();
		transport.onTextOutput?.('Hi.'); // requestId → 1
		provider.onDone?.(0); // stale
		expect(completionArbiter.completePlayback).not.toHaveBeenCalled();
	});
});

describe('TtsPipeline — word boundaries', () => {
	beforeEach(() => vi.useFakeTimers());

	it('forwards current-requestId word boundaries to the client', () => {
		const { provider, transport, sendJsonToClient } = wirePipeline();
		transport.onTextOutput?.('Hi.'); // requestId → 1
		provider.onWordBoundary?.('Hi', 0, 1);
		expect(sendJsonToClient).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'word_boundary', word: 'Hi' }),
		);
	});

	it('drops stale-requestId word boundaries', () => {
		const { provider, transport, sendJsonToClient } = wirePipeline();
		transport.onTextOutput?.('Hi.');
		provider.onWordBoundary?.('stale', 0, 0);
		expect(sendJsonToClient).not.toHaveBeenCalled();
	});
});
