// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	type TabId,
	pathnameForTab,
	tabFromPathname,
} from '../../app/web-client/src/app-routes.js';

describe('app-routes', () => {
	it('maps tab ids to pathnames', () => {
		expect(pathnameForTab('talk')).toBe('/talk');
		expect(pathnameForTab('agent_studio')).toBe('/agent-studio');
		expect(pathnameForTab('hardware_guide')).toBe('/hardware-guide');
		expect(pathnameForTab('terms')).toBe('/terms');
		expect(pathnameForTab('privacy')).toBe('/privacy');
	});

	it('resolves pathnames to tabs', () => {
		expect(tabFromPathname('/')).toBe('talk');
		expect(tabFromPathname('/talk')).toBe('talk');
		expect(tabFromPathname('/agent-studio')).toBe('agent_studio');
		expect(tabFromPathname('/terms')).toBe('terms');
		expect(tabFromPathname('/privacy')).toBe('privacy');
		expect(tabFromPathname('/unknown-route')).toBeNull();
	});

	it('round-trips all main tabs', () => {
		const tabs: TabId[] = [
			'talk',
			'agent_studio',
			'features',
			'opensource',
			'hardware_guide',
			'hardware_faq',
			'terms',
			'privacy',
		];
		for (const t of tabs) {
			expect(tabFromPathname(pathnameForTab(t))).toBe(t);
		}
	});
});
