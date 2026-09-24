import type { LanguageModelV1 } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { VoiceSession } from '../../src/core/voice-session.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { ClientMediaProfile } from '../../src/types/client-media.js';

declare module '@google/genai' {
	function _getMockSession(): Record<string, ReturnType<typeof vi.fn>> | null;
}

// Mock the external deps
vi.mock('@google/genai', () => {
	let messageHandler: ((msg: unknown) => void) | null = null;
	let mockSession: Record<string, ReturnType<typeof vi.fn>> | null = null;

	return {
		GoogleGenAI: vi.fn().mockImplementation(() => ({
			live: {
				connect: vi.fn(async (params: Record<string, unknown>) => {
					const cbs = params.callbacks as Record<string, (...args: unknown[]) => void>;
					messageHandler = cbs.onmessage as (msg: unknown) => void;
					// Fire setupComplete so connect() resolves (it awaits this)
					setTimeout(() => messageHandler?.({ setupComplete: { sessionId: 'gs_1' } }), 5);
					mockSession = {
						sendRealtimeInput: vi.fn(),
						sendToolResponse: vi.fn(),
						sendClientContent: vi.fn(),
						close: vi.fn(),
					};
					return mockSession;
				}),
			},
		})),
		_getMockSession: () => mockSession,
	};
});

vi.mock('ai', () => ({
	generateText: vi.fn(async () => ({ text: 'subagent done' })),
}));

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

const GREETING = '[System: Greet the user warmly.]';
const HOST_OWNED_WARNING = 'probe isolation must be implemented by the host';

function createGreetingAgent(): MainAgent {
	return {
		name: 'greeter',
		instructions: 'You are a greeting agent',
		greeting: GREETING,
		tools: [],
	};
}

/** Number of greeting sends that reached the mocked Gemini session. */
async function greetingSends(): Promise<number> {
	const { _getMockSession } = await import('@google/genai');
	const mockGeminiSession = _getMockSession();
	if (!mockGeminiSession) return 0;
	let count = 0;
	for (const [arg] of mockGeminiSession.sendRealtimeInput.mock.calls) {
		if ((arg as { text?: string }).text?.includes(GREETING)) count++;
	}
	for (const [arg] of mockGeminiSession.sendClientContent.mock.calls) {
		const turns = (arg as { turns?: Array<{ parts?: Array<{ text?: string }> }> }).turns;
		if (turns?.some((t) => t.parts?.some((p) => p.text?.includes(GREETING)))) count++;
	}
	return count;
}

/** Open a WebSocket, collecting its text frames from creation, and resolve once it is open. */
function openCollecting(url: string): Promise<{ ws: WebSocket; frames: string[] }> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const frames: string[] = [];
		ws.on('message', (data, isBinary) => {
			if (!isBinary) frames.push(data.toString());
		});
		ws.on('open', () => resolve({ ws, frames }));
		ws.on('error', reject);
	});
}

function closed(ws: WebSocket): Promise<{ code: number; frames: string[] }> {
	return new Promise((resolve) => {
		const frames: string[] = [];
		ws.on('message', (data, isBinary) => {
			if (!isBinary) frames.push(data.toString());
		});
		ws.on('close', (code) => resolve({ code, frames }));
	});
}

function frameTypes(frames: string[]): unknown[] {
	return frames.map((frame) => (JSON.parse(frame) as { type?: unknown }).type);
}

/** The session's attachment flag, read through the same name the public getter will use. */
function attached(session: VoiceSession): boolean {
	return (session as unknown as { clientConnected: boolean }).clientConnected;
}

const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

describe('VoiceSession client connection roles', () => {
	let session: VoiceSession | null = null;

	afterEach(async () => {
		if (session) {
			await session.close();
			session = null;
		}
	});

	it('a probe during an ACTIVE call changes nothing: greeting count, attachment and session state', async () => {
		const probeState = vi.fn(() => ({ type: 'agent.state', v: 1, initialized: true }));
		session = new VoiceSession({
			sessionId: 'sess_probe',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createGreetingAgent()],
			initialAgent: 'greeter',
			port: 9960,
			model: mockModel,
			probeState,
			log: () => {},
		});
		await session.start();
		expect(session.sessionManager.state).toBe('ACTIVE');

		const real = await openCollecting('ws://localhost:9960');
		await tick();
		expect(await greetingSends()).toBe(1);
		expect(attached(session)).toBe(true);
		const realFramesBeforeProbe = real.frames.length;
		expect(frameTypes(real.frames)).toContain('session.config');

		const probe = new WebSocket('ws://localhost:9960/?probe=1');
		const { code, frames } = await closed(probe);
		expect(code).toBe(1000);
		expect(frames.map((frame) => JSON.parse(frame))).toEqual([
			{ type: 'agent.state', v: 1, initialized: true },
		]);
		expect(probeState).toHaveBeenCalledOnce();

		await tick();
		expect(await greetingSends()).toBe(1);
		expect(attached(session)).toBe(true);
		expect(session.sessionManager.state).toBe('ACTIVE');
		// The attached client saw no second bootstrap and is still open.
		expect(real.frames).toHaveLength(realFramesBeforeProbe);
		expect(real.ws.readyState).toBe(WebSocket.OPEN);

		real.ws.close();
		await new Promise<void>((r) => real.ws.on('close', () => r()));
	});

	it('a verifier fires onVerifierConnected/onVerifierDisconnected and never greets', async () => {
		const onVerifierConnected = vi.fn();
		const onVerifierDisconnected = vi.fn();
		session = new VoiceSession({
			sessionId: 'sess_verify',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createGreetingAgent()],
			initialAgent: 'greeter',
			port: 9961,
			model: mockModel,
			onVerifierConnected,
			onVerifierDisconnected,
			log: () => {},
		});
		await session.start();
		expect(session.sessionManager.state).toBe('ACTIVE');

		const verifier = await openCollecting('ws://localhost:9961/?verify=1');
		await tick();
		expect(onVerifierConnected).toHaveBeenCalledOnce();
		expect(await greetingSends()).toBe(0);
		expect(attached(session)).toBe(false);
		// No real-client bootstrap ran for the verifier.
		expect(frameTypes(verifier.frames)).not.toContain('session.config');

		verifier.ws.close();
		await new Promise<void>((r) => verifier.ws.on('close', () => r()));
		await tick();
		expect(onVerifierDisconnected).toHaveBeenCalledOnce();
		expect(await greetingSends()).toBe(0);
		expect(attached(session)).toBe(false);
		expect(session.sessionManager.state).toBe('ACTIVE');
	});

	it.each<[string, ClientMediaProfile]>([
		['a host-owned WebSocket channel', { kind: 'websocket' }],
		['a direct-RTC channel', { kind: 'direct_rtc' }],
	])(
		'logs once that probe isolation belongs to the host when probeState or verifier hooks are supplied on %s',
		(_label, clientMedia) => {
			const lines: string[] = [];
			session = new VoiceSession({
				sessionId: 'sess_hosted',
				userId: 'user_1',
				apiKey: 'test-key',
				agents: [createGreetingAgent()],
				initialAgent: 'greeter',
				model: mockModel,
				clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
				clientMedia,
				probeState: () => ({ type: 'agent.state' }),
				onVerifierConnected: vi.fn(),
				onVerifierDisconnected: vi.fn(),
				log: (line) => lines.push(line),
			});

			const warnings = lines.filter((line) => line.includes(HOST_OWNED_WARNING));
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain('probeState, onVerifierConnected, onVerifierDisconnected');
		},
	);

	it('does not log the host-owned warning on the owned channel or when no role option is supplied', async () => {
		const lines: string[] = [];
		const owned = new VoiceSession({
			sessionId: 'sess_owned',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createGreetingAgent()],
			initialAgent: 'greeter',
			model: mockModel,
			port: 9962,
			probeState: () => ({ type: 'agent.state' }),
			onVerifierConnected: vi.fn(),
			log: (line) => lines.push(line),
		});
		const hosted = new VoiceSession({
			sessionId: 'sess_hosted_plain',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createGreetingAgent()],
			initialAgent: 'greeter',
			model: mockModel,
			clientSender: { sendAudio: vi.fn(), sendJson: vi.fn() },
			log: (line) => lines.push(line),
		});

		expect(lines.filter((line) => line.includes(HOST_OWNED_WARNING))).toEqual([]);
		await owned.close();
		await hosted.close();
	});

	it('keeps probeState in the VoiceSession class source for String(VoiceSession) feature detection', () => {
		expect(String(VoiceSession)).toContain('probeState');
	});
});
