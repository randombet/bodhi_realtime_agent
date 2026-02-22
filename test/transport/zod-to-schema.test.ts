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
