// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	type HostedReplayRecoveryWebSessionParams,
	isHostedReplayRecoveryAllowedForWebSession,
	isHostedReplayRecoveryEnvEnabled,
} from '../../app/server/replay-recovery-allowlist.js';

/** A fully-allowed first-party web Gemini session (case A). */
function allowedParams(): HostedReplayRecoveryWebSessionParams {
	return {
		envFlagEnabled: true,
		sessionRealtimeProvider: 'gemini',
		isMobileWs: false,
		hasBrowserEmbedIntent: false,
		wantAvatar: false,
		hasAvatarRuntimeSelection: false,
		hasSpatialProxy: false,
		hasExternalTts: false,
		requestedClientMediaKind: undefined,
		savedAgentPrefersDirectRtc: false,
		sessionSurface: null,
		agentProfile: 'standard',
		profileSessionInputKeys: [],
	};
}

describe('isHostedReplayRecoveryAllowedForWebSession (H3 case-A allowlist)', () => {
	it('allows a first-party web Gemini session when the env flag is on', () => {
		expect(isHostedReplayRecoveryAllowedForWebSession(allowedParams())).toBe(true);
	});

	it('denies when the env kill switch is off', () => {
		expect(
			isHostedReplayRecoveryAllowedForWebSession({ ...allowedParams(), envFlagEnabled: false }),
		).toBe(false);
	});

	it('denies non-gemini providers (replay is Gemini-only)', () => {
		expect(
			isHostedReplayRecoveryAllowedForWebSession({
				...allowedParams(),
				sessionRealtimeProvider: 'openai',
			}),
		).toBe(false);
	});

	it('denies the hosted mobile surface (unvalidated echo path)', () => {
		expect(
			isHostedReplayRecoveryAllowedForWebSession({ ...allowedParams(), isMobileWs: true }),
		).toBe(false);
	});

	it('denies published widget/embed sessions', () => {
		expect(
			isHostedReplayRecoveryAllowedForWebSession({
				...allowedParams(),
				hasBrowserEmbedIntent: true,
			}),
		).toBe(false);
	});

	it('denies avatar sessions on INTENT, not just proxy creation', () => {
		// Avatar intent (query params) is derived before the SpatialReal proxy
		// exists — each signal must deny independently.
		expect(
			isHostedReplayRecoveryAllowedForWebSession({ ...allowedParams(), wantAvatar: true }),
		).toBe(false);
		expect(
			isHostedReplayRecoveryAllowedForWebSession({
				...allowedParams(),
				hasAvatarRuntimeSelection: true,
			}),
		).toBe(false);
		expect(
			isHostedReplayRecoveryAllowedForWebSession({ ...allowedParams(), hasSpatialProxy: true }),
		).toBe(false);
	});

	it('denies external-TTS sessions', () => {
		expect(
			isHostedReplayRecoveryAllowedForWebSession({ ...allowedParams(), hasExternalTts: true }),
		).toBe(false);
	});

	it('denies direct-RTC sessions (case B blocked until its own enablement)', () => {
		expect(
			isHostedReplayRecoveryAllowedForWebSession({
				...allowedParams(),
				requestedClientMediaKind: 'direct_rtc',
			}),
		).toBe(false);
	});

	it('denies saved agents whose media prefs imply direct-RTC, even when not applied', () => {
		expect(
			isHostedReplayRecoveryAllowedForWebSession({
				...allowedParams(),
				savedAgentPrefersDirectRtc: true,
			}),
		).toBe(false);
	});

	it('denies the recruiting studio surface', () => {
		expect(
			isHostedReplayRecoveryAllowedForWebSession({
				...allowedParams(),
				sessionSurface: 'recruiting_studio',
			}),
		).toBe(false);
	});

	it('denies the catalog structured profiles', () => {
		for (const agentProfile of ['structured_screening', 'structured_interview']) {
			expect(isHostedReplayRecoveryAllowedForWebSession({ ...allowedParams(), agentProfile })).toBe(
				false,
			);
		}
	});

	it('denies saved ua_* sessions carrying ANY of the three structured/recruiting input keys', () => {
		// Screening drafts map to recruiting_draft while structured-interview
		// drafts map to structured_interview even for ua_* profiles — checking
		// only the recruiting key would let saved-agent interviews through.
		for (const key of ['recruiting_draft', 'structured_screening', 'structured_interview']) {
			expect(
				isHostedReplayRecoveryAllowedForWebSession({
					...allowedParams(),
					agentProfile: 'ua_abc123',
					profileSessionInputKeys: [key],
				}),
			).toBe(false);
		}
	});

	it('allows a clean saved ua_* session (no structured inputs, no media prefs)', () => {
		expect(
			isHostedReplayRecoveryAllowedForWebSession({
				...allowedParams(),
				agentProfile: 'ua_abc123',
			}),
		).toBe(true);
	});

	it('websocket client media kind is allowed', () => {
		expect(
			isHostedReplayRecoveryAllowedForWebSession({
				...allowedParams(),
				requestedClientMediaKind: 'websocket',
			}),
		).toBe(true);
	});
});

describe('isHostedReplayRecoveryEnvEnabled', () => {
	it('is ON by default; BODHI_WATCHDOG_REPLAY_RECOVERY=0 is the kill switch', () => {
		expect(isHostedReplayRecoveryEnvEnabled({})).toBe(true); // default on
		expect(isHostedReplayRecoveryEnvEnabled({ BODHI_WATCHDOG_REPLAY_RECOVERY: '1' })).toBe(true);
		expect(isHostedReplayRecoveryEnvEnabled({ BODHI_WATCHDOG_REPLAY_RECOVERY: '0' })).toBe(false);
		// Exact-match kill switch — no truthy/falsy-string surprises.
		expect(isHostedReplayRecoveryEnvEnabled({ BODHI_WATCHDOG_REPLAY_RECOVERY: 'false' })).toBe(
			true,
		);
	});
});
