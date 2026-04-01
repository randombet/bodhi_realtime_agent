// SPDX-License-Identifier: MIT

/**
 * Human agent factory — creates a MainAgent that bridges the user's voice
 * session to a real human via Twilio outbound call.
 *
 * When activated:
 * 1. Gemini LLM transport is disconnected (resumption handle saved)
 * 2. TwilioBridge dials the human's phone number
 * 3. Bidirectional audio flows: web client ↔ TwilioBridge ↔ Twilio ↔ phone
 * 4. When human hangs up, transfers back to the AI agent
 */

import type { AgentContext, MainAgent } from '../../src/types/agent.js';
import { TwilioBridge } from '../../src/telephony/twilio-bridge.js';
import type { TwilioBridgeConfig } from '../../src/telephony/twilio-bridge.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface HumanAgentConfig {
	/** Phone number to dial when transferring to human (E.164 format). */
	phoneNumber: string;
	/** Twilio Account SID. */
	twilioAccountSid: string;
	/** Twilio Auth Token. */
	twilioAuthToken: string;
	/** Your Twilio phone number (caller ID, E.164). */
	twilioFromNumber: string;
	/** Public base URL for Twilio webhooks (must be HTTPS in production). */
	twilioWebhookUrl: string;
	/** Port for the Twilio webhook + Media Streams server (default: 8766). */
	twilioWebhookPort?: number;
	/** Maximum call duration in seconds (default: 1800 = 30 min). */
	maxCallDuration?: number;
	/** Ring timeout in seconds (default: 30). */
	ringTimeout?: number;
	/** Agent to return to after human call ends (default: 'main'). */
	returnAgent?: string;
	/** Callback to route client audio to the bridge during human segment. */
	onAudioFromClient?: (handler: ((data: Buffer) => void) | null) => void;
}

function clientAudioFormat(outputSampleRate: number): {
	inputSampleRate: number;
	outputSampleRate: number;
	channels: number;
	bitDepth: number;
	encoding: 'pcm';
} {
	return {
		inputSampleRate: 16000,
		outputSampleRate,
		channels: 1,
		bitDepth: 16,
		encoding: 'pcm',
	};
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a MainAgent that bridges to a human phone agent via Twilio.
 * Uses `audioMode: 'external'` — Gemini is disconnected during the call.
 */
export function createHumanAgent(config: HumanAgentConfig): MainAgent {
	let bridge: TwilioBridge | null = null;
	let clientDisconnected = false;

	const safeRequestTransfer = (ctx: AgentContext) => {
		if (clientDisconnected) return;
		ctx.requestTransfer(config.returnAgent ?? 'main');
	};

	return {
		name: 'human_agent',
		audioMode: 'external',
		instructions: '',
		tools: [],

		async onEnter(ctx: AgentContext) {
			clientDisconnected = false;

			const bridgeConfig: TwilioBridgeConfig = {
				accountSid: config.twilioAccountSid,
				authToken: config.twilioAuthToken,
				fromNumber: config.twilioFromNumber,
				webhookBaseUrl: config.twilioWebhookUrl,
				webhookPort: config.twilioWebhookPort ?? 8766,
				maxCallDuration: config.maxCallDuration,
				ringTimeout: config.ringTimeout,
			};

			bridge = new TwilioBridge(bridgeConfig, {
				onCallConnected: (callSid) => {
					console.log(`[HumanAgent] Call connected: ${callSid}`);

					// Drain buffered audio from the dial gap to the human
					ctx.stopBufferingAndDrain((chunk) => {
						bridge?.sendAudioToHuman(chunk);
					});

					// Wire client mic → human phone audio.
					const toHuman = (data: Buffer) => {
						bridge?.sendAudioToHuman(data);
					};
					ctx.setExternalAudioHandler?.(toHuman);
					// Legacy fallback for older integrations that inject their own audio hook.
					config.onAudioFromClient?.(toHuman);

					// Notify client about audio format change and connection status
					ctx.sendJsonToClient({
						type: 'session.config',
						audioFormat: clientAudioFormat(16000),
					});
					ctx.sendJsonToClient({
						type: 'agent.human_transfer',
						status: 'connected',
						callSid,
					});
				},

				onAudioFromHuman: (pcm16kBuffer) => {
					// Send human's PCM audio to the web client as binary.
					ctx.sendAudioToClient?.(pcm16kBuffer);
				},

				onCallEnded: (callSid, reason) => {
					console.log(`[HumanAgent] Call ended: ${callSid} reason=${reason}`);
					if (!clientDisconnected) {
						ctx.sendJsonToClient({
							type: 'agent.human_transfer',
							status: 'ended',
							reason,
						});
					}
					safeRequestTransfer(ctx);
				},

				onError: (error) => {
					console.error(`[HumanAgent] Error: ${error.message}`);
					if (!clientDisconnected) {
						ctx.sendJsonToClient({
							type: 'agent.human_transfer',
							status: 'error',
							error: error.message,
						});
					}
					safeRequestTransfer(ctx);
				},
			});

			await bridge.start();

			ctx.sendJsonToClient({
				type: 'agent.human_transfer',
				status: 'dialing',
				phoneNumber: config.phoneNumber,
			});

			try {
				await bridge.dial(config.phoneNumber);
			} catch (err) {
				console.error(`[HumanAgent] Dial failed: ${err instanceof Error ? err.message : String(err)}`);
				ctx.sendJsonToClient({
					type: 'agent.human_transfer',
					status: 'error',
					error: `Failed to dial: ${err instanceof Error ? err.message : String(err)}`,
				});
				safeRequestTransfer(ctx);
			}
		},

		async onExit(_ctx: AgentContext) {
			// Unwire audio
			_ctx.setExternalAudioHandler?.(null);
			config.onAudioFromClient?.(null);

			if (bridge) {
				await bridge.hangup();
				await bridge.dispose();
				bridge = null;
			}

			// Restore Gemini audio format
			_ctx.sendJsonToClient({
				type: 'session.config',
				audioFormat: clientAudioFormat(24000),
			});
		},
	};
}
