import type { z } from 'zod';

/** Schema output format: Gemini uses UPPERCASE type names, standard JSON Schema uses lowercase. */
export type SchemaFormat = 'gemini' | 'standard';

const TYPE_MAP = {
	gemini: {
		object: 'OBJECT',
		string: 'STRING',
		number: 'NUMBER',
		integer: 'INTEGER',
		boolean: 'BOOLEAN',
		array: 'ARRAY',
		null: 'NULL',
	},
	standard: {
		object: 'object',
		string: 'string',
		number: 'number',
		integer: 'integer',
		boolean: 'boolean',
		array: 'array',
		null: 'null',
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
			if (format === 'standard' && def.unknownKeys === 'strict') {
				result.additionalProperties = false;
			}
			return result;
		}

		case 'ZodString':
			return { type: t.string };

		case 'ZodNumber': {
			const integer = def.checks?.some((check: { kind?: string }) => check.kind === 'int');
			return { type: integer ? t.integer : t.number };
		}

		case 'ZodBoolean':
			return { type: t.boolean };

		case 'ZodArray':
			return {
				type: t.array,
				items: convertDef(def.type._def, format),
			};

		case 'ZodLiteral':
			if (def.value === null) return { type: t.null };
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

		case 'ZodNullable': {
			const inner = convertDef(def.innerType._def, format);
			return format === 'gemini'
				? { ...inner, nullable: true }
				: { anyOf: [inner, { type: t.null }] };
		}

		case 'ZodNull':
			return { type: t.null };

		case 'ZodUnion':
			return {
				anyOf: (def.options as Array<{ _def: unknown }>).map((option) =>
					convertDef(option._def, format),
				),
			};

		case 'ZodDiscriminatedUnion':
			return {
				anyOf: [...def.options.values()].map((option) => convertDef(option._def, format)),
			};

		case 'ZodRecord': {
			const result: Record<string, unknown> = { type: t.object };
			if (format === 'standard') {
				result.additionalProperties = convertDef(def.valueType._def, format);
			}
			return result;
		}

		case 'ZodUnknown':
		case 'ZodAny':
			return {};

		case 'ZodEffects':
			return convertDef(def.schema._def, format);

		case 'ZodDefault':
		case 'ZodCatch':
		case 'ZodReadonly':
			return convertDef(def.innerType._def, format);

		case 'ZodBranded':
			return convertDef(def.type._def, format);

		case 'ZodLazy':
			return convertDef(def.getter()._def, format);

		default:
			// Unknown validator constructs must not be falsely advertised as a
			// string. An empty schema is permissive in standard JSON Schema and is
			// safer than a contract that disagrees with runtime validation.
			return {};
	}
}
