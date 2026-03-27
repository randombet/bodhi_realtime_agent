// SPDX-License-Identifier: MIT

/**
 * TwilioBridge — manages the lifecycle of a Twilio outbound call and bridges
 * bidirectional audio between the framework's PCM pipeline and Twilio Media Streams.
 *
 * Audio format:
 *   Framework side: PCM L16, 16kHz, mono
 *   Twilio side:    mulaw, 8kHz, mono (Media Streams default, not configurable)
 *
 * Conversion is handled transparently via audio-codec.ts.
 */

import { randomBytes } from 'node:crypto';
import twilio from 'twilio';
import { frameworkToTwilio, twilioToFramework } from './audio-codec.js';
import { TwilioWebhookServer } from './twilio-webhook-server.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TwilioBridgeConfig {
	/** Twilio Account SID. */
	accountSid: string;
	/** Twilio Auth Token. */
	authToken: string;
	/** Twilio phone number to call FROM (your Twilio number, E.164). */
	fromNumber: string;
	/** Public base URL where Twilio sends webhooks (must be HTTPS in production). */
	webhookBaseUrl: string;
	/** Port for the webhook HTTP + Media Streams WS server. */
	webhookPort: number;
	/** Maximum call duration in seconds (Twilio `timeLimit`, default: 1800). */
	maxCallDuration?: number;
	/** Ring timeout in seconds before no-answer (Twilio `timeout`, default: 30). */
	ringTimeout?: number;
	/** Enable answering machine detection (default: false). */
	machineDetection?: boolean;
}

export interface TwilioBridgeCallbacks {
	/** Called when Twilio connects and audio bridge is ready. */
	onCallConnected: (callSid: string) => void;
	/** Called when the human hangs up or call ends. */
	onCallEnded: (callSid: string, reason: string) => void;
	/** Called with PCM L16 16kHz audio FROM the human (ready for client). */
	onAudioFromHuman: (pcm16kBuffer: Buffer) => void;
	/** Called on error (call failed, network issue). */
	onError: (error: Error) => void;
}

type BridgeState = 'idle' | 'dialing' | 'ringing' | 'connected' | 'ended' | 'disposed';

// ---------------------------------------------------------------------------
// TwilioBridge
// ---------------------------------------------------------------------------

export class TwilioBridge {
	private client: ReturnType<typeof twilio>;
	private webhookServer: TwilioWebhookServer;
	private state: BridgeState = 'idle';
	private callSid: string | undefined;
	private wsAuthToken: string;
	private streamSid: string | undefined;

	constructor(
		private readonly config: TwilioBridgeConfig,
		private readonly callbacks: TwilioBridgeCallbacks,
	) {
		this.client = twilio(config.accountSid, config.authToken);
		this.wsAuthToken = randomBytes(16).toString('hex');

		this.webhookServer = new TwilioWebhookServer({
			port: config.webhookPort,
			authToken: config.authToken,
			wsAuthToken: this.wsAuthToken,
			onMediaReceived: (base64Audio) => {
				if (this.state !== 'connected') return;
				try {
					const pcm16k = twilioToFramework(base64Audio);
					this.callbacks.onAudioFromHuman(pcm16k);
				} catch (err) {
					this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
				}
			},
			onStreamStarted: (streamSid, callSid) => {
				this.streamSid = streamSid;
				if (this.callSid && callSid !== this.callSid) {
					this.callbacks.onError(
						new Error(`CallSid mismatch: expected ${this.callSid}, got ${callSid}`),
					);
					return;
				}
				this.state = 'connected';
				this.callbacks.onCallConnected(this.callSid ?? callSid);
			},
			onStreamStopped: () => {
				if (this.state === 'connected' || this.state === 'dialing' || this.state === 'ringing') {
					this.state = 'ended';
					this.callbacks.onCallEnded(this.callSid ?? '', 'stream_stopped');
				}
			},
		});
	}

	/** Start the webhook server. Must be called before dial(). */
	async start(): Promise<void> {
		await this.webhookServer.start();
	}

	/**
	 * Initiate an outbound call to the given phone number.
	 * @returns The Twilio CallSid.
	 */
	async dial(toNumber: string): Promise<string> {
		if (this.state !== 'idle') {
			throw new Error(`Cannot dial in state "${this.state}"`);
		}
		this.state = 'dialing';

		const twimlUrl = `${this.config.webhookBaseUrl}/twilio/voice?auth=${this.wsAuthToken}`;
		const statusCallbackUrl = `${this.config.webhookBaseUrl}/twilio/status`;

		const callOptions = {
			to: toNumber,
			from: this.config.fromNumber,
			url: twimlUrl,
			statusCallback: statusCallbackUrl,
			statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
			timeLimit: this.config.maxCallDuration ?? 1800,
			timeout: this.config.ringTimeout ?? 30,
			...(this.config.machineDetection && { machineDetection: 'Enable' as const }),
		};

		try {
			const call = await this.client.calls.create(callOptions);
			this.callSid = call.sid;
			return call.sid;
		} catch (err) {
			this.state = 'ended';
			throw err;
		}
	}

	/**
	 * Send PCM L16 16kHz audio TO the human via Twilio Media Streams.
	 * Converts to mulaw 8kHz before sending.
	 */
	sendAudioToHuman(pcm16kInput: Buffer | string): void {
		if (this.state !== 'connected') return;

		const mulawBase64 = frameworkToTwilio(pcm16kInput);
		this.webhookServer.sendMedia(mulawBase64, this.streamSid);
	}

	/** Hang up the active call. */
	async hangup(): Promise<void> {
		if (!this.callSid || this.state === 'ended' || this.state === 'disposed') return;

		try {
			await this.client.calls(this.callSid).update({ status: 'completed' });
		} catch {
			// Call may already be ended — ignore
		}
		this.state = 'ended';
	}

	/** Clean up all resources (webhook server, call). */
	async dispose(): Promise<void> {
		if (this.state === 'disposed') return;

		await this.hangup();
		await this.webhookServer.stop();
		this.state = 'disposed';
	}

	/** Handle a Twilio status callback. */
	handleStatusCallback(callSid: string, callStatus: string, answeredBy?: string): void {
		if (callSid !== this.callSid) return;

		switch (callStatus) {
			case 'ringing':
				this.state = 'ringing';
				break;
			case 'completed':
			case 'busy':
			case 'no-answer':
			case 'failed':
			case 'canceled':
				if (this.state !== 'ended' && this.state !== 'disposed') {
					this.state = 'ended';
					const reason = answeredBy?.startsWith('machine') ? `voicemail:${answeredBy}` : callStatus;
					this.callbacks.onCallEnded(callSid, reason);
				}
				break;
		}
	}

	/** Current bridge state (for testing/inspection). */
	get currentState(): BridgeState {
		return this.state;
	}
}
