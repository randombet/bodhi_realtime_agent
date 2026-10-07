import type { LanguageModelV1 } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import type { IEventBus } from '../../src/core/event-bus.js';
import type { HooksManager } from '../../src/core/hooks.js';
import type { TranscriptSink } from '../../src/core/transcript-manager.js';
import { VoiceSession } from '../../src/core/voice-session.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';
import type { ClientTransport } from '../../src/transport/client-transport.js';
import type { MainAgent } from '../../src/types/agent.js';
import type {
	AnyServerToClientMessage,
	CoreServerToClientMessage,
	HostClientFrame,
} from '../../src/types/client-protocol.js';
import type { ToolContext } from '../../src/types/tool.js';
import type {
	AudioFormatSpec,
	LLMTransport,
	TransportCapabilities,
} from '../../src/types/transport.js';

// Compile-time contract for the host-frame escape hatch. The host-facing
// `sendJsonToClient` methods accept any JSON object whose `type`, if declared,
// is not a core frame type; core frames stay strict. The @ts-expect-error lines
// are the negative cases: if the signature ever widens to accept them, the
// unused-expect-error fails typecheck:tests.

// Never invoked: only type-checked.
function hostFrameContract(session: VoiceSession, ctx: ToolContext, ct: ClientTransport): void {
	// Application frames compile on every host-facing method.
	session.sendJsonToClient({ type: 'session_end' });
	session.sendJsonToClient({ type: 'agent.state', seq: 1 });
	ct.sendJsonToClient({ type: 'session_end' });

	// A bare Record<string, unknown> compiles.
	const bare: Record<string, unknown> = { anything: true };
	session.sendJsonToClient(bare);

	// The tool-context form compiles.
	ctx.sendJsonToClient?.({ type: 'tool.progress', percent: 50 });

	// A well-formed core frame compiles.
	session.sendJsonToClient({ type: 'audio.done', playbackId: 7 });
	ctx.sendJsonToClient?.({ type: 'audio.done', playbackId: 7 });

	// @ts-expect-error — audio.done without playbackId must not compile.
	session.sendJsonToClient({ type: 'audio.done' });

	// @ts-expect-error — turn.end with a non-string turnId must not compile.
	session.sendJsonToClient({ type: 'turn.end', turnId: 5 });

	// @ts-expect-error — the tool-context form is equally strict on core frames.
	ctx.sendJsonToClient?.({ type: 'audio.done' });

	// @ts-expect-error — the concrete ClientTransport is equally strict on core frames.
	ct.sendJsonToClient({ type: 'turn.end', turnId: 5 });

	// The type itself accepts a non-core `type` and rejects a core one.
	const frame: HostClientFrame<'app.custom'> = { type: 'app.custom', value: 1 };
	// @ts-expect-error — a core frame type cannot be declared as a host frame.
	const collides: HostClientFrame<'audio.done'> = { type: 'audio.done' };
	void frame;
	void collides;
}
void hostFrameContract;

// Compile-time contract for the callbacks a host hands in. A `TranscriptSink`
// and the `ToolExecutor` constructor's `sendJsonToClient` callback accept both
// an implementation that takes any JSON object and one typed against the
// protocol, so either shape compiles without a cast.

// Never invoked: only type-checked.
function hostCallbackContract(hooks: HooksManager, eventBus: IEventBus): void {
	const addUserMessage = (text: string): void => void text;
	const addAssistantMessage = (text: string): void => void text;

	// TranscriptSink: an implementation that accepts any JSON object.
	const sendAnyObject = (msg: Record<string, unknown>): void => void msg;
	const objectSink: TranscriptSink = {
		sendToClient: sendAnyObject,
		addUserMessage,
		addAssistantMessage,
	};
	const objectMethodSink: TranscriptSink = {
		sendToClient(msg: Record<string, unknown>): void {
			void msg;
		},
		addUserMessage,
		addAssistantMessage,
	};

	// TranscriptSink: an implementation typed against the core protocol frames.
	const sendCoreFrame = (msg: CoreServerToClientMessage): void => void msg;
	const coreSink: TranscriptSink = {
		sendToClient: sendCoreFrame,
		addUserMessage,
		addAssistantMessage,
	};
	const coreMethodSink: TranscriptSink = {
		sendToClient(msg: CoreServerToClientMessage): void {
			void msg;
		},
		addUserMessage,
		addAssistantMessage,
	};

	// An unannotated implementation still gets its parameter type from the slot.
	const inferredSink: TranscriptSink = {
		sendToClient: (msg) => void msg.type,
		addUserMessage,
		addAssistantMessage,
	};

	const numberSink: TranscriptSink = {
		// @ts-expect-error — an implementation that takes neither shape is still rejected.
		sendToClient: (msg: number): void => void msg,
		addUserMessage,
		addAssistantMessage,
	};

	// ToolExecutor: a callback that accepts any JSON object.
	const objectExecutor = new ToolExecutor(
		hooks,
		eventBus,
		'sess',
		'main',
		(message: Record<string, unknown>): void => void message,
	);

	// ToolExecutor: a callback typed against the protocol frames.
	const protocolExecutor = new ToolExecutor(
		hooks,
		eventBus,
		'sess',
		'main',
		(message: AnyServerToClientMessage): void => void message,
	);

	// An unannotated callback still gets its parameter type from the slot.
	const inferredExecutor = new ToolExecutor(
		hooks,
		eventBus,
		'sess',
		'main',
		(message) => void message.type,
	);

	const numberExecutor = new ToolExecutor(
		hooks,
		eventBus,
		'sess',
		'main',
		// @ts-expect-error — a callback that takes neither shape is still rejected.
		(message: number): void => void message,
	);

	void objectSink;
	void objectMethodSink;
	void coreSink;
	void coreMethodSink;
	void inferredSink;
	void numberSink;
	void objectExecutor;
	void protocolExecutor;
	void inferredExecutor;
	void numberExecutor;
}
void hostCallbackContract;

const mockModel = { modelId: 'test-model' } as unknown as LanguageModelV1;

function createAgent(): MainAgent {
	return { name: 'main', instructions: 'You are a concise assistant.', tools: [] };
}

function createMockTransport(): LLMTransport {
	return {
		capabilities: {
			messageTruncation: false,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: false,
			sessionResumption: true,
			contextCompression: true,
			groundingMetadata: true,
			textResponseModality: true,
		} satisfies TransportCapabilities,
		audioFormat: {
			inputSampleRate: 16000,
			outputSampleRate: 24000,
			channels: 1,
			bitDepth: 16,
			encoding: 'pcm',
		} satisfies AudioFormatSpec,
		isConnected: true,
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		reconnect: vi.fn().mockResolvedValue(undefined),
		sendAudio: vi.fn(),
		commitAudio: vi.fn(),
		clearAudio: vi.fn(),
		updateSession: vi.fn(async () => {}),
		transferSession: vi.fn().mockResolvedValue(undefined),
		sendContent: vi.fn(),
		sendFile: vi.fn(),
		sendToolResult: vi.fn(),
		triggerGeneration: vi.fn(),
	};
}

describe('HostClientFrame', () => {
	it('VoiceSession.sendJsonToClient delivers an application frame to clientSender.sendJson unchanged', () => {
		const sendJson = vi.fn();
		const session = new VoiceSession({
			sessionId: 'sess_host_frame',
			userId: 'user_1',
			apiKey: 'test-key',
			agents: [createAgent()],
			initialAgent: 'main',
			model: mockModel,
			transport: createMockTransport(),
			clientSender: { sendAudio: vi.fn(), sendJson },
		});

		const frame = { type: 'session_end' } as const;
		session.sendJsonToClient(frame);

		expect(sendJson).toHaveBeenCalledTimes(1);
		expect(sendJson.mock.calls[0]?.[0]).toBe(frame);
		expect(sendJson.mock.calls[0]?.[0]).toEqual({ type: 'session_end' });
	});
});
