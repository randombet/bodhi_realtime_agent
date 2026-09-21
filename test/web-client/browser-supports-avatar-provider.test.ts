import { describe, expect, it } from 'vitest';
import {
	browserSupportsAvatarProvider,
	providerNeedsWsDriving,
} from '../../app/web-client/src/spatial-web-avatar/use-spatial-web-avatar-host.js';

describe('browserSupportsAvatarProvider', () => {
	it('includes spatialreal, heygen, and anam', () => {
		expect(browserSupportsAvatarProvider('spatialreal')).toBe(true);
		expect(browserSupportsAvatarProvider('heygen')).toBe(true);
		expect(browserSupportsAvatarProvider('anam')).toBe(true);
		expect(browserSupportsAvatarProvider('unknown')).toBe(false);
	});
});

describe('providerNeedsWsDriving', () => {
	it('is only true for spatialreal', () => {
		expect(providerNeedsWsDriving('spatialreal')).toBe(true);
		expect(providerNeedsWsDriving('heygen')).toBe(false);
		expect(providerNeedsWsDriving('anam')).toBe(false);
	});
});
