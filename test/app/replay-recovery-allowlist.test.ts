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

	// Profile-agnosticism is structural: the predicate has NO profile/surface
	// inputs (agentProfile, sessionSurface, profileSessionInputKeys were removed)
	// — all Gemini Live profiles get recovery, including structured
	// screening/interview, which pin the most stall-prone config (3.1 + 200ms
	// endpointing) and produced the first natural hosted stall.

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
