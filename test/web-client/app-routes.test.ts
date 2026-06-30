import { describe, expect, it } from 'vitest';
import {
	type TabId,
	defaultTabForHostSurface,
	hostSurfaceFromHostname,
	mainOriginFromLocation,
	pathnameForTab,
	tabAllowedOnHostSurface,
	tabFromPathname,
	tabFromPathnameForHostSurface,
} from '../../app/web-client/src/app-routes.js';

describe('app-routes', () => {
	it('maps tab ids to pathnames', () => {
		expect(pathnameForTab('talk')).toBe('/talk');
		expect(pathnameForTab('agent_studio')).toBe('/agent-studio');
		expect(pathnameForTab('screening_demo')).toBe('/screening-demo');
		expect(pathnameForTab('recruiting_voice_studio')).toBe('/voice-recruiting-studio');
		expect(pathnameForTab('hardware_guide')).toBe('/hardware-guide');
		expect(pathnameForTab('terms')).toBe('/terms');
		expect(pathnameForTab('privacy')).toBe('/privacy');
	});

	it('resolves pathnames to tabs', () => {
		expect(tabFromPathname('/')).toBe('talk');
		expect(tabFromPathname('/talk')).toBe('talk');
		expect(tabFromPathname('/agent-studio')).toBe('agent_studio');
		expect(tabFromPathname('/screening-demo')).toBe('screening_demo');
		expect(tabFromPathname('/voice-recruiting-studio')).toBe('recruiting_voice_studio');
		expect(tabFromPathname('/terms')).toBe('terms');
		expect(tabFromPathname('/privacy')).toBe('privacy');
		expect(tabFromPathname('/unknown-route')).toBeNull();
	});

	it('round-trips all main tabs', () => {
		const tabs: TabId[] = [
			'talk',
			'agent_studio',
			'screening_demo',
			'recruiting_voice_studio',
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

	it('detects dedicated product subdomains', () => {
		expect(hostSurfaceFromHostname('avatar.bodhi.example')).toBe('avatar');
		expect(hostSurfaceFromHostname('Avatar.Bodhi.Example.')).toBe('avatar');
		expect(hostSurfaceFromHostname('recruiting.bodhi.example')).toBe('recruiting');
		expect(hostSurfaceFromHostname('interview.bodhi.example')).toBe('recruiting');
		expect(hostSurfaceFromHostname('interview.localhost')).toBe('recruiting');
		expect(hostSurfaceFromHostname('app.bodhi.example')).toBe('main');
		expect(hostSurfaceFromHostname('localhost')).toBe('main');
	});

	it('uses product studio defaults on dedicated host surfaces', () => {
		expect(defaultTabForHostSurface('avatar')).toBe('talk_avatar');
		expect(defaultTabForHostSurface('recruiting')).toBe('recruiting_voice_studio');
		expect(tabFromPathnameForHostSurface('/', 'avatar')).toBe('talk_avatar');
		expect(tabFromPathnameForHostSurface('/talk', 'avatar')).toBe('talk_avatar');
		expect(tabFromPathnameForHostSurface('/talk-avatar', 'avatar')).toBe('talk_avatar');
		expect(tabFromPathnameForHostSurface('/', 'recruiting')).toBe('recruiting_voice_studio');
		expect(tabFromPathnameForHostSurface('/screening-demo', 'recruiting')).toBe('screening_demo');
		expect(tabFromPathnameForHostSurface('/agent-studio', 'recruiting')).toBe(
			'recruiting_voice_studio',
		);
	});

	it('restricts tabs on product subdomains', () => {
		expect(tabAllowedOnHostSurface('avatar_studio', 'avatar')).toBe(true);
		expect(tabAllowedOnHostSurface('talk_avatar', 'avatar')).toBe(true);
		expect(tabAllowedOnHostSurface('agent_studio', 'avatar')).toBe(false);
		expect(tabAllowedOnHostSurface('recruiting_voice_studio', 'recruiting')).toBe(true);
		expect(tabAllowedOnHostSurface('screening_demo', 'recruiting')).toBe(true);
		expect(tabAllowedOnHostSurface('talk_avatar', 'recruiting')).toBe(false);
	});

	it('builds a main-domain origin from product subdomains', () => {
		expect(
			mainOriginFromLocation({
				hostname: 'avatar.bodhi.example',
				origin: 'https://avatar.bodhi.example',
				port: '',
				protocol: 'https:',
			}),
		).toBe('https://bodhi.example');
		expect(
			mainOriginFromLocation({
				hostname: 'recruiting.bodhi.example',
				origin: 'https://recruiting.bodhi.example',
				port: '',
				protocol: 'https:',
			}),
		).toBe('https://bodhi.example');
		expect(
			mainOriginFromLocation({
				hostname: 'interview.bodhi.example',
				origin: 'https://interview.bodhi.example',
				port: '',
				protocol: 'https:',
			}),
		).toBe('https://bodhi.example');
		expect(
			mainOriginFromLocation({
				hostname: 'avatar.localhost',
				origin: 'http://avatar.localhost:5173',
				port: '5173',
				protocol: 'http:',
			}),
		).toBe('http://localhost:5173');
	});
});
