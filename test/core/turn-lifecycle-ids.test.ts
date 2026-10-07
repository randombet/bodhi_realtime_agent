import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';

vi.mock('@google/genai', () => {
	let messageHandler: ((msg: unknown) => void) | null = null;
	return {
		GoogleGenAI: vi.fn().mockImplementation(() => ({
			live: {
				connect: vi.fn(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					messageHandler = cbs.onmessage as (msg: unknown) => void;
					setTimeout(() => messageHandler?.({ setupComplete: { sessionId: 'gs_1' } }), 5);
					return {
						sendRealtimeInput: vi.fn(),
						sendToolResponse: vi.fn(),
						sendClientContent: vi.fn(),
						close: vi.fn(),
					};
				}),
			},
		})),
		_getMessageHandler: () => messageHandler,
	};
});

vi.mock('ai', () => ({
	generateText: vi.fn(async (opts: { onStepFinish?: (step: unknown) => void }) => {
		opts.onStepFinish?.({ toolCalls: [], usage: { totalTokens: 10 } });
		return { text: 'done' };
	}),
}));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;
const echoAgent = (): MainAgent => ({ name: 'echo', instructions: 'echo', tools: [] });

/** A session on a host-owned client channel (no listener port to collide on). */
function createSession(sessionId: string): VoiceSession {
	return new VoiceSession({
		sessionId,
		userId: 'u',
		apiKey: 'k',
		agents: [echoAgent()],
		initialAgent: 'echo',
		model: mockModel,
		clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
	});
}

async function liveSocket(): Promise<(msg: unknown) => void> {
	const { _getMessageHandler } = await import('@google/genai');
	return (_getMessageHandler as unknown as () => (m: unknown) => void)();
}

describe('turn lifecycle ids', () => {
	let session: VoiceSession | null = null;
	afterEach(async () => {
		if (session) {
			await session.close();
			session = null;
		}
	});

	it('start, interrupted and end of ONE turn all carry the SAME id', async () => {
		session = createSession('sess_ids');
		const starts: string[] = [];
		const interrupted: string[] = [];
		const ends: string[] = [];
		session.eventBus.subscribe('turn.start', (p) => starts.push(p.turnId));
		session.eventBus.subscribe('turn.interrupted', (p) => interrupted.push(p.turnId));
		session.eventBus.subscribe('turn.end', (p) => ends.push(p.turnId));

		await session.start();
		await new Promise((r) => setTimeout(r, 50));
		const fire = await liveSocket();

		fire({
			serverContent: {
				modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm' } }] },
			},
		});
		await new Promise((r) => setTimeout(r, 20));
		fire({ serverContent: { interrupted: true } });
		await new Promise((r) => setTimeout(r, 20));
		fire({ serverContent: { turnComplete: true } });
		await new Promise((r) => setTimeout(r, 50));

		expect(starts).toEqual(['turn_1']);
		expect(ends).toEqual(['turn_1']);
		expect(interrupted).toEqual(['turn_1']);
	});

	// ---- generation lifecycle -------------------------------------------------
	//
	// These assert a TRACE of the paired generation.start / generation.end
	// events, not a count. Counting is not enough: before the state machine,
	// `audio → turnComplete → toolCall → audio` also produced two starts, but as
	// one bogus start on the tool tail plus one real one, with the actual answer
	// credited to nothing. Same number, different composition.

	const AUDIO = {
		serverContent: {
			modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm' } }] },
		},
	};
	const TOOL_CALL = {
		toolCall: { functionCalls: [{ id: 'fc_1', name: 'get_weather', args: { city: 'Boston' } }] },
	};
	const TURN_COMPLETE = { serverContent: { turnComplete: true } };
	const GEN_COMPLETE = { serverContent: { generationComplete: true } };
	const INTERRUPTED = { serverContent: { interrupted: true } };

	async function lifecycleOf(
		sessionId: string,
		script: [string, unknown][],
	): Promise<{ openedOn: string[]; lifecycle: string[] }> {
		session = createSession(sessionId);
		const lifecycle: string[] = [];
		let opened = 0;
		session.eventBus.subscribe('generation.start', (p) => {
			opened++;
			lifecycle.push(`start:${p.generationId}`);
		});
		session.eventBus.subscribe('generation.end', (p) =>
			lifecycle.push(`end:${p.generationId}:${p.reason}`),
		);
		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		const fire = await liveSocket();
		const openedOn: string[] = [];
		for (const [label, msg] of script) {
			const before = opened;
			fire(msg);
			await new Promise((r) => setTimeout(r, 25));
			if (opened > before) openedOn.push(label);
		}
		await new Promise((r) => setTimeout(r, 40));
		return { openedOn, lifecycle };
	}

	it('a toolCall after turnComplete stays in the SAME generation', async () => {
		// The defect this exists for: turnComplete cleared the "a turn is
		// underway" boolean, so the tool call that finishes an answer was
		// relabelled the start of a new model turn — one answer, two candidates
		// downstream. Before: opened on ['audio', 'toolCall'].
		const { openedOn, lifecycle } = await lifecycleOf('sess_tail', [
			['audio', AUDIO],
			['turnComplete', TURN_COMPLETE],
			['toolCall', TOOL_CALL],
		]);
		expect(openedOn).toEqual(['audio']);
		expect(lifecycle).toEqual(['start:gen_0']); // draining, not ended
	});

	it('the answer built from a tool result IS a new generation', async () => {
		// Identity surviving turnComplete must not swallow the next real answer.
		const { openedOn, lifecycle } = await lifecycleOf('sess_answer', [
			['audio-1', AUDIO],
			['turnComplete', TURN_COMPLETE],
			['toolCall', TOOL_CALL],
			['audio-2', AUDIO],
		]);
		expect(openedOn).toEqual(['audio-1', 'audio-2']);
		expect(lifecycle).toEqual(['start:gen_0', 'end:gen_0:superseded', 'start:gen_1']);
	});

	it('generationComplete ends it; the next output opens a new one', async () => {
		const { lifecycle } = await lifecycleOf('sess_gen_terminal', [
			['audio', AUDIO],
			['generationComplete', GEN_COMPLETE],
			['turnComplete', TURN_COMPLETE],
			['toolCall', TOOL_CALL],
		]);
		expect(lifecycle).toEqual(['start:gen_0', 'end:gen_0:generationComplete', 'start:gen_1']);
	});

	it('an interrupt ends the generation', async () => {
		const { lifecycle } = await lifecycleOf('sess_interrupt', [
			['audio', AUDIO],
			['interrupted', INTERRUPTED],
			['toolCall', TOOL_CALL],
		]);
		expect(lifecycle).toEqual(['start:gen_0', 'end:gen_0:interrupted', 'start:gen_1']);
	});

	it('does not wedge when generationComplete never arrives', async () => {
		// The machine must not depend on generationComplete being reliable.
		// Three plain turns with only turnComplete must still be three
		// generations, each closed.
		const { openedOn, lifecycle } = await lifecycleOf('sess_no_gc', [
			['audio-1', AUDIO],
			['turnComplete-1', TURN_COMPLETE],
			['audio-2', AUDIO],
			['turnComplete-2', TURN_COMPLETE],
			['audio-3', AUDIO],
			['turnComplete-3', TURN_COMPLETE],
		]);
		expect(openedOn).toEqual(['audio-1', 'audio-2', 'audio-3']);
		expect(lifecycle).toEqual([
			'start:gen_0',
			'end:gen_0:superseded',
			'start:gen_1',
			'end:gen_1:superseded',
			'start:gen_2',
		]);
	});

	it('generationComplete reaches the transport callback', async () => {
		session = createSession('sess_gen');
		await session.start();
		await new Promise((r) => setTimeout(r, 50));

		let fired = 0;
		// WRAP, do not replace: replacing the transport's own handler would
		// disable whatever VoiceSession registered there.
		const t = (session as unknown as { transport: { onGenerationComplete?: () => void } })
			.transport;
		const prev = t.onGenerationComplete;
		t.onGenerationComplete = () => {
			fired++;
			prev?.();
		};

		const fire = await liveSocket();
		fire({ serverContent: { generationComplete: true } });
		await new Promise((r) => setTimeout(r, 30));

		expect(fired).toBe(1);
	});
});
