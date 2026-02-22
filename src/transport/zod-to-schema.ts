// SPDX-License-Identifier: MIT

import type { z } from 'zod';

/**
 * Converts a Zod schema to a simplified JSON Schema suitable for Gemini function declarations.
 * Handles the common subset: objects with string/number/boolean/array/enum properties.
 */
export function zodToJsonSchema(schema: z.ZodSchema): Record<string, unknown> {
	// Use Zod's built-in JSON Schema output if available
	// biome-ignore lint/suspicious/noExplicitAny: Zod internal API varies across versions
	const def = (schema as any)._def;
	if (!def) {
		return { type: 'OBJECT', properties: {} };
	}

	return convertDef(def);
}

// biome-ignore lint/suspicious/noExplicitAny: Zod internal types
function convertDef(def: any): Record<string, unknown> {
	const typeName = def.typeName;

	switch (typeName) {
		case 'ZodObject': {
			const shape = def.shape?.();
			if (!shape) return { type: 'OBJECT', properties: {} };

			const properties: Record<string, unknown> = {};
			const required: string[] = [];

			for (const [key, value] of Object.entries(shape)) {
				// biome-ignore lint/suspicious/noExplicitAny: Zod internal types
				const fieldDef = (value as any)._def;
				if (fieldDef.typeName === 'ZodOptional') {
					properties[key] = convertDef(fieldDef.innerType._def);
				} else {
					properties[key] = convertDef(fieldDef);
					required.push(key);
				}
			}

			const result: Record<string, unknown> = { type: 'OBJECT', properties };
			if (required.length > 0) result.required = required;
			return result;
		}

		case 'ZodString':
			return { type: 'STRING' };

		case 'ZodNumber':
			return { type: 'NUMBER' };

		case 'ZodBoolean':
			return { type: 'BOOLEAN' };

		case 'ZodArray':
			return {
				type: 'ARRAY',
				items: convertDef(def.type._def),
			};

		case 'ZodLiteral':
			return {
				type:
					typeof def.value === 'number'
						? 'NUMBER'
						: typeof def.value === 'boolean'
							? 'BOOLEAN'
							: 'STRING',
				enum: [def.value],
			};

		case 'ZodEnum':
			return {
				type: 'STRING',
				enum: def.values,
			};

		case 'ZodOptional':
			return convertDef(def.innerType._def);

		default:
			return { type: 'STRING' };
	}
}
