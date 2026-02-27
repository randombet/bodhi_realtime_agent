// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from '../../src/transport/zod-to-schema.js';

describe('zodToJsonSchema', () => {
	it('converts simple object with string and number', () => {
		const schema = z.object({
			name: z.string(),
			age: z.number(),
		});
		const result = zodToJsonSchema(schema);
		expect(result).toEqual({
			type: 'OBJECT',
			properties: {
				name: { type: 'STRING' },
				age: { type: 'NUMBER' },
			},
			required: ['name', 'age'],
		});
	});

	it('handles optional fields', () => {
		const schema = z.object({
			query: z.string(),
			limit: z.number().optional(),
		});
		const result = zodToJsonSchema(schema);
		expect(result.required).toEqual(['query']);
		expect(result.properties).toEqual({
			query: { type: 'STRING' },
			limit: { type: 'NUMBER' },
		});
	});

	it('converts boolean type', () => {
		const schema = z.object({ active: z.boolean() });
		const result = zodToJsonSchema(schema);
		expect((result.properties as Record<string, unknown>).active).toEqual({ type: 'BOOLEAN' });
	});

	it('converts array type', () => {
		const schema = z.object({ tags: z.array(z.string()) });
		const result = zodToJsonSchema(schema);
		expect((result.properties as Record<string, unknown>).tags).toEqual({
			type: 'ARRAY',
			items: { type: 'STRING' },
		});
	});

	it('converts literal string type', () => {
		const schema = z.object({
			agent_name: z.literal('math_expert'),
		});
		const result = zodToJsonSchema(schema);
		expect((result.properties as Record<string, unknown>).agent_name).toEqual({
			type: 'STRING',
			enum: ['math_expert'],
		});
	});

	it('converts literal number type', () => {
		const schema = z.object({ version: z.literal(1) });
		const result = zodToJsonSchema(schema);
		expect((result.properties as Record<string, unknown>).version).toEqual({
			type: 'NUMBER',
			enum: [1],
		});
	});

	it('converts enum type', () => {
		const schema = z.object({
			priority: z.enum(['low', 'medium', 'high']),
		});
		const result = zodToJsonSchema(schema);
		expect((result.properties as Record<string, unknown>).priority).toEqual({
			type: 'STRING',
			enum: ['low', 'medium', 'high'],
		});
	});
});

describe('zodToJsonSchema — standard format', () => {
	it('converts object with lowercase type names', () => {
		const schema = z.object({
			name: z.string(),
			age: z.number(),
		});
		const result = zodToJsonSchema(schema, 'standard');
		expect(result).toEqual({
			type: 'object',
			properties: {
				name: { type: 'string' },
				age: { type: 'number' },
			},
			required: ['name', 'age'],
		});
	});

	it('handles optional fields with lowercase types', () => {
		const schema = z.object({
			query: z.string(),
			limit: z.number().optional(),
		});
		const result = zodToJsonSchema(schema, 'standard');
		expect(result.required).toEqual(['query']);
		expect(result.properties).toEqual({
			query: { type: 'string' },
			limit: { type: 'number' },
		});
	});

	it('converts boolean and array with lowercase types', () => {
		const schema = z.object({
			active: z.boolean(),
			tags: z.array(z.string()),
		});
		const result = zodToJsonSchema(schema, 'standard');
		const props = result.properties as Record<string, unknown>;
		expect(props.active).toEqual({ type: 'boolean' });
		expect(props.tags).toEqual({ type: 'array', items: { type: 'string' } });
	});

	it('converts enum and literal with lowercase types', () => {
		const schema = z.object({
			priority: z.enum(['low', 'high']),
			agent: z.literal('main'),
			version: z.literal(2),
		});
		const result = zodToJsonSchema(schema, 'standard');
		const props = result.properties as Record<string, unknown>;
		expect(props.priority).toEqual({ type: 'string', enum: ['low', 'high'] });
		expect(props.agent).toEqual({ type: 'string', enum: ['main'] });
		expect(props.version).toEqual({ type: 'number', enum: [2] });
	});

	it('default format is gemini (uppercase)', () => {
		const schema = z.object({ name: z.string() });
		const result = zodToJsonSchema(schema);
		expect(result.type).toBe('OBJECT');
	});
});
