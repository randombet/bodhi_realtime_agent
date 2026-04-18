// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	type ChatAttachment,
	type ChatSendOptions,
	type GatewayChatEventRaw,
	extractContentBlocks,
	mergeText,
	normalizeEvent,
} from '../../app/lib/integrations/openclaw/openclaw-client.js';

describe('normalizeEvent', () => {
	const baseRaw: GatewayChatEventRaw = {
		runId: 'run-1',
		sessionKey: 'bodhi:sess-1',
		seq: 0,
		state: 'delta',
		message: { role: 'assistant', content: 'Working on it...' },
	};

	it('normalizes delta event — extracts text from message.content', () => {
		const event = normalizeEvent(baseRaw);

		expect(event).toEqual({
			source: 'chat',
			runId: 'run-1',
			state: 'delta',
			text: 'Working on it...',
			error: undefined,
			stopReason: undefined,
		});
	});

	it('normalizes final event with stopReason=stop → finalDisposition=completed', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			seq: 2,
			state: 'final',
			message: { role: 'assistant', content: 'Done! Here is the code.' },
			stopReason: 'stop',
		};

		const event = normalizeEvent(raw);

		expect(event.state).toBe('final');
		expect(event.finalDisposition).toBe('completed');
		expect(event.text).toBe('Done! Here is the code.');
	});

	it('normalizes final event with stopReason=max_tokens → finalDisposition=completed', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			state: 'final',
			stopReason: 'max_tokens',
		};

		const event = normalizeEvent(raw);
		expect(event.finalDisposition).toBe('completed');
	});

	it('normalizes final event with stopReason=needs_input → finalDisposition=needs_input', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			state: 'final',
			message: { role: 'assistant', content: 'Which file should I edit?' },
			stopReason: 'needs_input',
		};

		const event = normalizeEvent(raw);

		expect(event.finalDisposition).toBe('needs_input');
		expect(event.text).toBe('Which file should I edit?');
	});

	it('normalizes final event with missing stopReason → finalDisposition=completed', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			state: 'final',
			// No stopReason — treated as completed (gateway may omit stopReason)
		};

		const event = normalizeEvent(raw);
		expect(event.finalDisposition).toBe('completed');
	});

	it('normalizes final event with unrecognized stopReason → finalDisposition=completed', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			state: 'final',
			stopReason: 'end_turn',
		};

		const event = normalizeEvent(raw);
		expect(event.finalDisposition).toBe('completed');
	});

	it('normalizes error event — extracts errorMessage', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			state: 'error',
			message: undefined,
			errorMessage: 'Rate limit exceeded',
		};

		const event = normalizeEvent(raw);

		expect(event.state).toBe('error');
		expect(event.error).toBe('Rate limit exceeded');
		expect(event.text).toBeUndefined();
		expect(event.finalDisposition).toBeUndefined();
	});

	it('normalizes aborted event', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			state: 'aborted',
			message: undefined,
		};

		const event = normalizeEvent(raw);

		expect(event.state).toBe('aborted');
		expect(event.finalDisposition).toBeUndefined();
	});

	it('delta event has no finalDisposition', () => {
		const event = normalizeEvent(baseRaw);
		expect(event.finalDisposition).toBeUndefined();
	});

	it('preserves stopReason on final events', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			state: 'final',
			stopReason: 'stop',
		};

		const event = normalizeEvent(raw);
		expect(event.stopReason).toBe('stop');
	});

	it('extracts text from structured object content', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			message: {
				role: 'assistant',
				content: { text: 'Structured text output' } as unknown as string,
			},
		};

		const event = normalizeEvent(raw);
		expect(event.text).toBe('Structured text output');
	});

	it('extracts text from nested content array', () => {
		const raw: GatewayChatEventRaw = {
			...baseRaw,
			message: {
				role: 'assistant',
				content: {
					content: [{ type: 'text', text: 'Nested text output' }],
				} as unknown as string,
			},
		};

		const event = normalizeEvent(raw);
		expect(event.text).toBe('Nested text output');
	});
});

describe('extractContentBlocks', () => {
	it('string content → single text block', () => {
		const blocks = extractContentBlocks('Hello world');
		expect(blocks).toEqual([{ type: 'text', text: 'Hello world' }]);
	});

	it('empty string → no blocks', () => {
		expect(extractContentBlocks('')).toEqual([]);
	});

	it('array with text + image blocks', () => {
		const content = [
			{ type: 'text', text: "Here's the chart:" },
			{
				type: 'image',
				source: { type: 'base64', data: 'iVBOR...', media_type: 'image/png' },
			},
		];
		const blocks = extractContentBlocks(content);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toEqual({ type: 'text', text: "Here's the chart:" });
		expect(blocks[1]).toEqual({
			type: 'image',
			base64: 'iVBOR...',
			mimeType: 'image/png',
		});
	});

	it('document block extraction', () => {
		const content = [
			{
				type: 'document',
				name: 'report.pdf',
				source: {
					type: 'base64',
					data: 'JVBERi0...',
					media_type: 'application/pdf',
				},
			},
		];
		const blocks = extractContentBlocks(content);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toEqual({
			type: 'document',
			base64: 'JVBERi0...',
			mimeType: 'application/pdf',
			fileName: 'report.pdf',
		});
	});

	it('unknown block types are skipped', () => {
		const content = [
			{ type: 'text', text: 'hello' },
			{ type: 'tool_use', id: '123', input: {} },
			{ type: 'thinking', thinking: 'reasoning...' },
		];
		const blocks = extractContentBlocks(content);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe('text');
	});

	it('non-array object falls back to extractText', () => {
		const content = { text: 'Structured text output' };
		const blocks = extractContentBlocks(content);
		expect(blocks).toEqual([{ type: 'text', text: 'Structured text output' }]);
	});
});

describe('normalizeEvent with contentBlocks', () => {
	it('text-only response — no contentBlocks (regression)', () => {
		const raw: GatewayChatEventRaw = {
			runId: 'run-1',
			sessionKey: 'bodhi:sess-1',
			seq: 0,
			state: 'final',
			message: { role: 'assistant', content: 'Done!' },
			stopReason: 'stop',
		};
		const event = normalizeEvent(raw);
		expect(event.text).toBe('Done!');
		expect(event.contentBlocks).toBeUndefined();
		expect(event.finalDisposition).toBe('completed');
	});

	it('multimodal response — text + image block', () => {
		const raw: GatewayChatEventRaw = {
			runId: 'run-1',
			sessionKey: 'bodhi:sess-1',
			seq: 0,
			state: 'final',
			message: {
				role: 'assistant',
				content: [
					{ type: 'text', text: 'Here is the chart:' },
					{
						type: 'image',
						source: { type: 'base64', data: 'iVBOR...', media_type: 'image/png' },
					},
				] as unknown as string,
			},
			stopReason: 'stop',
		};
		const event = normalizeEvent(raw);
		expect(event.text).toBe('Here is the chart:');
		expect(event.contentBlocks).toHaveLength(1);
		expect(event.contentBlocks?.[0].type).toBe('image');
		expect(event.contentBlocks?.[0].base64).toBe('iVBOR...');
	});

	it('image-only response — text is undefined, contentBlocks populated', () => {
		const raw: GatewayChatEventRaw = {
			runId: 'run-1',
			sessionKey: 'bodhi:sess-1',
			seq: 0,
			state: 'final',
			message: {
				role: 'assistant',
				content: [
					{
						type: 'image',
						source: { type: 'base64', data: 'abc123', media_type: 'image/jpeg' },
					},
				] as unknown as string,
			},
			stopReason: 'stop',
		};
		const event = normalizeEvent(raw);
		expect(event.text).toBeUndefined();
		expect(event.contentBlocks).toHaveLength(1);
	});

	it('non-standard content structure falls back to extractText', () => {
		const raw: GatewayChatEventRaw = {
			runId: 'run-1',
			sessionKey: 'bodhi:sess-1',
			seq: 0,
			state: 'final',
			message: {
				role: 'assistant',
				content: [
					{ type: 'tool_result', content: 'Task completed successfully' },
				] as unknown as string,
			},
			stopReason: 'stop',
		};
		const event = normalizeEvent(raw);
		expect(event.text).toBe('Task completed successfully');
		expect(event.contentBlocks).toBeUndefined();
		expect(event.finalDisposition).toBe('completed');
	});

	it('mixed content keeps non-text blocks and still extracts wrapped text', () => {
		const raw: GatewayChatEventRaw = {
			runId: 'run-1',
			sessionKey: 'bodhi:sess-1',
			seq: 0,
			state: 'final',
			message: {
				role: 'assistant',
				content: [
					{ type: 'tool_result', content: 'Attached and sent.' },
					{
						type: 'image',
						source: { type: 'base64', data: 'abc123', media_type: 'image/png' },
					},
				] as unknown as string,
			},
			stopReason: 'stop',
		};
		const event = normalizeEvent(raw);
		expect(event.text).toBe('Attached and sent.');
		expect(event.contentBlocks).toHaveLength(1);
		expect(event.contentBlocks?.[0].type).toBe('image');
	});

	it('image-only structured payload does not stringify to text blob', () => {
		const raw: GatewayChatEventRaw = {
			runId: 'run-1',
			sessionKey: 'bodhi:sess-1',
			seq: 0,
			state: 'final',
			message: {
				role: 'assistant',
				content: [
					{
						type: 'image',
						source: { type: 'base64', data: 'abc123', media_type: 'image/png' },
					},
				] as unknown as string,
			},
			stopReason: 'stop',
		};
		const event = normalizeEvent(raw);
		expect(event.text).toBeUndefined();
		expect(event.contentBlocks).toHaveLength(1);
	});
});

describe('ChatAttachment types', () => {
	it('ChatAttachment has required fields', () => {
		const attachment: ChatAttachment = {
			type: 'image',
			mimeType: 'image/png',
			content: 'base64data',
		};
		expect(attachment.type).toBe('image');
		expect(attachment.mimeType).toBe('image/png');
		expect(attachment.content).toBe('base64data');
		expect(attachment.fileName).toBeUndefined();
	});

	it('ChatAttachment supports optional fileName', () => {
		const attachment: ChatAttachment = {
			type: 'image',
			mimeType: 'image/jpeg',
			content: 'base64data',
			fileName: 'photo.jpg',
		};
		expect(attachment.fileName).toBe('photo.jpg');
	});

	it('ChatSendOptions supports idempotencyKey and attachments', () => {
		const options: ChatSendOptions = {
			idempotencyKey: 'key-123',
			attachments: [{ type: 'image', mimeType: 'image/png', content: 'b64' }],
		};
		expect(options.idempotencyKey).toBe('key-123');
		expect(options.attachments).toHaveLength(1);
	});

	it('ChatSendOptions supports empty attachments', () => {
		const options: ChatSendOptions = {};
		expect(options.attachments).toBeUndefined();
		expect(options.idempotencyKey).toBeUndefined();
	});
});

describe('mergeText', () => {
	it('keeps previous text when incoming is undefined or blank', () => {
		expect(mergeText('hello', undefined)).toBe('hello');
		expect(mergeText('hello', '')).toBe('hello');
		expect(mergeText('hello', '   ')).toBe('hello');
	});

	it('uses incoming text when non-empty', () => {
		expect(mergeText('hello', 'world')).toBe('world');
	});
});
