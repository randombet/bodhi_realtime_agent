// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import type {
	AudioFormatSpec,
	ContentTurn,
	LLMTransport,
	LLMTransportConfig,
	LLMTransportError,
	ReconnectState,
	ReplayItem,
	SessionUpdate,
	TTSAudioConfig,
	TTSProvider,
	TransportCapabilities,
	TransportPendingToolCall,
	TransportToolCall,
	TransportToolResult,
} from '../../src/types/index.js';

describe('LLMTransport type definitions', () => {
	it('TransportCapabilities has all 7 boolean fields', () => {
		const caps: TransportCapabilities = {
			messageTruncation: false,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: false,
			sessionResumption: true,
			contextCompression: true,
			groundingMetadata: true,
		};
		expect(Object.keys(caps)).toHaveLength(7);
	});

	it('ContentTurn accepts user and assistant roles', () => {
		const user: ContentTurn = { role: 'user', text: 'hello' };
		const assistant: ContentTurn = { role: 'assistant', text: 'hi' };
		expect(user.role).toBe('user');
		expect(assistant.role).toBe('assistant');
	});

	it('ReplayItem discriminated union covers all types', () => {
		const items: ReplayItem[] = [
			{ type: 'text', role: 'user', text: 'hello' },
			{ type: 'text', role: 'assistant', text: 'hi' },
			{ type: 'tool_call', id: 'tc_1', name: 'search', args: { q: 'test' } },
			{ type: 'tool_result', id: 'tc_1', name: 'search', result: 'found' },
			{ type: 'tool_result', id: 'tc_2', name: 'broken', result: null, error: 'failed' },
			{ type: 'file', role: 'user', base64Data: 'abc', mimeType: 'image/png' },
			{ type: 'transfer', fromAgent: 'general', toAgent: 'booking' },
		];
		expect(items).toHaveLength(7);
	});

	it('AudioFormatSpec specifies PCM audio format', () => {
		const format: AudioFormatSpec = {
			sampleRate: 16000,
			channels: 1,
			bitDepth: 16,
			encoding: 'pcm',
		};
		expect(format.encoding).toBe('pcm');
	});

	it('TransportToolCall has id, name, args', () => {
		const call: TransportToolCall = { id: 'tc_1', name: 'search', args: { q: 'test' } };
		expect(call.id).toBe('tc_1');
	});

	it('TransportToolResult supports scheduling hints', () => {
		const result: TransportToolResult = {
			id: 'tc_1',
			name: 'search',
			result: { found: true },
			scheduling: 'when_idle',
		};
		expect(result.scheduling).toBe('when_idle');
	});

	it('TransportPendingToolCall has all recovery fields', () => {
		const pending: TransportPendingToolCall = {
			id: 'tc_1',
			name: 'search',
			args: { q: 'test' },
			status: 'executing',
			startedAt: Date.now(),
			timeoutMs: 30000,
			execution: 'background',
			agentName: 'general',
		};
		expect(pending.status).toBe('executing');
	});

	it('LLMTransportError carries recoverable flag', () => {
		const err: LLMTransportError = { error: new Error('fail'), recoverable: true };
		expect(err.recoverable).toBe(true);
	});

	it('ReconnectState is optional fields', () => {
		const empty: ReconnectState = {};
		const full: ReconnectState = {
			conversationHistory: [{ type: 'text', role: 'user', text: 'hello' }],
			pendingToolCalls: [],
		};
		expect(empty.conversationHistory).toBeUndefined();
		expect(full.conversationHistory).toHaveLength(1);
	});

	it('stub object satisfies LLMTransport interface', () => {
		const stub: LLMTransport = {
			capabilities: {
				messageTruncation: false,
				turnDetection: true,
				userTranscription: true,
				inPlaceSessionUpdate: false,
				sessionResumption: false,
				contextCompression: false,
				groundingMetadata: false,
			},
			audioFormat: {
				inputSampleRate: 16000,
				outputSampleRate: 24000,
				channels: 1,
				bitDepth: 16,
				encoding: 'pcm',
			},
			isConnected: false,
			connect: vi.fn(),
			disconnect: vi.fn(),
			reconnect: vi.fn(),
			sendAudio: vi.fn(),
			commitAudio: vi.fn(),
			clearAudio: vi.fn(),
			updateSession: vi.fn(),
			transferSession: vi.fn(),
			sendContent: vi.fn(),
			sendFile: vi.fn(),
			sendToolResult: vi.fn(),
			triggerGeneration: vi.fn(),
		};

		expect(stub.capabilities.turnDetection).toBe(true);
		expect(stub.audioFormat.inputSampleRate).toBe(16000);
		expect(stub.audioFormat.outputSampleRate).toBe(24000);
	});

	it('LLMTransportConfig supports all auth types', () => {
		const apiKeyConfig: LLMTransportConfig = {
			auth: { type: 'api_key', apiKey: 'test' },
			model: 'gemini-live-2.5-flash-preview',
		};
		const saConfig: LLMTransportConfig = {
			auth: { type: 'service_account', projectId: 'my-project', location: 'us-central1' },
			model: 'gemini-live-2.5-flash-preview',
			instructions: 'Be helpful',
			providerOptions: { googleSearch: true },
		};
		expect(apiKeyConfig.auth.type).toBe('api_key');
		expect(saConfig.auth.type).toBe('service_account');
	});

	it('SessionUpdate has optional fields', () => {
		const update: SessionUpdate = { instructions: 'New instructions' };
		expect(update.tools).toBeUndefined();
	});

	it('SessionUpdate accepts responseModality', () => {
		const update: SessionUpdate = { responseModality: 'text' };
		expect(update.responseModality).toBe('text');
	});

	it('LLMTransportConfig accepts responseModality', () => {
		const config: LLMTransportConfig = {
			auth: { type: 'api_key', apiKey: 'test' },
			model: 'test-model',
			responseModality: 'text',
		};
		expect(config.responseModality).toBe('text');
	});

	it('TransportCapabilities accepts optional textResponseModality', () => {
		const caps: TransportCapabilities = {
			messageTruncation: false,
			turnDetection: true,
			userTranscription: true,
			inPlaceSessionUpdate: false,
			sessionResumption: true,
			contextCompression: true,
			groundingMetadata: true,
			textResponseModality: true,
		};
		expect(caps.textResponseModality).toBe(true);
	});

	it('LLMTransport stub supports text-mode callbacks', () => {
		const stub: LLMTransport = {
			capabilities: {
				messageTruncation: false,
				turnDetection: true,
				userTranscription: true,
				inPlaceSessionUpdate: false,
				sessionResumption: false,
				contextCompression: false,
				groundingMetadata: false,
				textResponseModality: true,
			},
			audioFormat: {
				inputSampleRate: 16000,
				outputSampleRate: 24000,
				channels: 1,
				bitDepth: 16,
				encoding: 'pcm',
			},
			isConnected: false,
			connect: vi.fn(),
			disconnect: vi.fn(),
			reconnect: vi.fn(),
			sendAudio: vi.fn(),
			commitAudio: vi.fn(),
			clearAudio: vi.fn(),
			updateSession: vi.fn(),
			transferSession: vi.fn(),
			sendContent: vi.fn(),
			sendFile: vi.fn(),
			sendToolResult: vi.fn(),
			triggerGeneration: vi.fn(),
			onTextOutput: vi.fn(),
			onTextDone: vi.fn(),
			onSpeechStarted: vi.fn(),
		};

		expect(stub.capabilities.textResponseModality).toBe(true);
		stub.onTextOutput?.('hello');
		expect(stub.onTextOutput).toHaveBeenCalledWith('hello');
	});
});

describe('TTSProvider type definitions', () => {
	it('TTSAudioConfig satisfies expected shape', () => {
		const config: TTSAudioConfig = {
			sampleRate: 24000,
			bitDepth: 16,
			channels: 1,
			encoding: 'pcm',
		};
		expect(config.sampleRate).toBe(24000);
		expect(config.encoding).toBe('pcm');
	});

	it('TTSProvider stub satisfies interface', () => {
		const provider: TTSProvider = {
			configure: vi
				.fn()
				.mockReturnValue({ sampleRate: 24000, bitDepth: 16, channels: 1, encoding: 'pcm' }),
			start: vi.fn(),
			stop: vi.fn(),
			synthesize: vi.fn(),
			cancel: vi.fn(),
		};

		const result = provider.configure({
			sampleRate: 24000,
			bitDepth: 16,
			channels: 1,
			encoding: 'pcm',
		});
		expect(result.sampleRate).toBe(24000);
		provider.synthesize('hello', 1);
		expect(provider.synthesize).toHaveBeenCalledWith('hello', 1);
	});

	it('TTSProvider callbacks are optional', () => {
		const provider: TTSProvider = {
			configure: vi
				.fn()
				.mockReturnValue({ sampleRate: 24000, bitDepth: 16, channels: 1, encoding: 'pcm' }),
			start: vi.fn(),
			stop: vi.fn(),
			synthesize: vi.fn(),
			cancel: vi.fn(),
		};

		expect(provider.onAudio).toBeUndefined();
		expect(provider.onDone).toBeUndefined();
		expect(provider.onWordBoundary).toBeUndefined();
		expect(provider.onError).toBeUndefined();
	});

	it('TTSProvider is re-exported from types barrel', async () => {
		const types = await import('../../src/types/index.js');
		// Type-level check — if TTSProvider is not exported, this test file won't compile
		expect(types).toBeDefined();
	});
});
