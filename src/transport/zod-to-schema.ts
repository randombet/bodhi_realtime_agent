// SPDX-License-Identifier: MIT

import type { z } from 'zod';

/** Schema output format: Gemini uses UPPERCASE type names, standard JSON Schema uses lowercase. */
export type SchemaFormat = 'gemini' | 'standard';

const TYPE_MAP = {
	gemini: {
		object: 'OBJECT',
		string: 'STRING',
		number: 'NUMBER',
		boolean: 'BOOLEAN',
		array: 'ARRAY',
	},
	standard: {
		object: 'object',
		string: 'string',
		number: 'number',
		boolean: 'boolean',
		array: 'array',
	},
} as const;

/**
 * Converts a Zod schema to a simplified JSON Schema.
 * Handles the common subset: objects with string/number/boolean/array/enum properties.
 *
 * @param format - `'gemini'` (default) outputs UPPERCASE types for Gemini function declarations.
 *                 `'standard'` outputs lowercase types for OpenAI and standard JSON Schema consumers.
 */
export function zodToJsonSchema(
	schema: z.ZodSchema,
	format: SchemaFormat = 'gemini',
): Record<string, unknown> {
	// biome-ignore lint/suspicious/noExplicitAny: Zod internal API varies across versions
	const def = (schema as any)._def;
	if (!def) {
		return { type: TYPE_MAP[format].object, properties: {} };
	}

	return convertDef(def, format);
}

// biome-ignore lint/suspicious/noExplicitAny: Zod internal types
function convertDef(def: any, format: SchemaFormat): Record<string, unknown> {
	const typeName = def.typeName;
	const t = TYPE_MAP[format];

	switch (typeName) {
		case 'ZodObject': {
			const shape = def.shape?.();
			if (!shape) return { type: t.object, properties: {} };

			const properties: Record<string, unknown> = {};
			const required: string[] = [];

			for (const [key, value] of Object.entries(shape)) {
				// biome-ignore lint/suspicious/noExplicitAny: Zod internal types
				const fieldDef = (value as any)._def;
				if (fieldDef.typeName === 'ZodOptional') {
					properties[key] = convertDef(fieldDef.innerType._def, format);
				} else {
					properties[key] = convertDef(fieldDef, format);
					required.push(key);
				}
			}

			const result: Record<string, unknown> = { type: t.object, properties };
			if (required.length > 0) result.required = required;
			return result;
		}

		case 'ZodString':
			return { type: t.string };

		case 'ZodNumber':
			return { type: t.number };

		case 'ZodBoolean':
			return { type: t.boolean };

		case 'ZodArray':
			return {
				type: t.array,
				items: convertDef(def.type._def, format),
			};

		case 'ZodLiteral':
			return {
				type:
					typeof def.value === 'number'
						? t.number
						: typeof def.value === 'boolean'
							? t.boolean
							: t.string,
				enum: [def.value],
			};

		case 'ZodEnum':
			return {
				type: t.string,
				enum: def.values,
			};

		case 'ZodOptional':
			return convertDef(def.innerType._def, format);

		default:
			return { type: t.string };
	}
}
