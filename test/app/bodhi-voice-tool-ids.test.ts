// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { BODHI_TOOL_LIBRARY } from '../../app/agents/agent-tool-library.js';
import { BODHI_VOICE_TOOL_IDS } from '../../app/agents/bodhi-voice-tool-ids.js';

describe('bodhi-voice-tool-ids', () => {
	it('lists the same ids as BODHI_TOOL_LIBRARY keys (keep registry in sync)', () => {
		const fromLibrary = Object.keys(BODHI_TOOL_LIBRARY).sort();
		const fromRegistry = [...BODHI_VOICE_TOOL_IDS].sort();
		expect(fromRegistry).toEqual(fromLibrary);
	});
});
