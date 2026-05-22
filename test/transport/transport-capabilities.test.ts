// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { DEFAULT_TRANSPORT_CAPABILITIES } from '../../src/types/transport.js';

describe('TransportCapabilities defaults', () => {
	it('playbackGatedTurnComplete defaults to false', () => {
		expect(DEFAULT_TRANSPORT_CAPABILITIES.playbackGatedTurnComplete).toBe(false);
	});
});
