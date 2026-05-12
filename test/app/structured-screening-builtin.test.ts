// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	STRUCTURED_SCREENING_MAIN_INSTRUCTIONS,
	STRUCTURED_SCREENING_RECRUITING_STUDIO_MACRO_APPENDIX,
} from '../../app/agents/builtin/structured-screening/instructions.js';
import {
	RECRUITING_STUDIO_SCREENING_TEMPLATE_SYSTEM_PROMPT,
	STRUCTURED_SCREENING_VOICE_TOOL_IDS,
} from '../../app/agents/builtin/structured-screening/manifest.js';
import { structuredScreeningBuiltinCompileModel } from '../../app/agents/definitions/builtin/structured-screening.js';

describe('builtin structured_screening (manifest + compile model)', () => {
	it('voice tool ids match builtin structured_screening compile model', () => {
		const main = structuredScreeningBuiltinCompileModel.mainAgents[0];
		expect(main?.name).toBe('main');
		expect(main?.toolIds).toEqual([...STRUCTURED_SCREENING_VOICE_TOOL_IDS]);
	});

	it('recruiting studio template system prompt matches base + macro appendix', () => {
		expect(RECRUITING_STUDIO_SCREENING_TEMPLATE_SYSTEM_PROMPT).toBe(
			STRUCTURED_SCREENING_MAIN_INSTRUCTIONS +
				STRUCTURED_SCREENING_RECRUITING_STUDIO_MACRO_APPENDIX,
		);
	});
});
