// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock twilio SDK
const mockCallCreate = vi.fn();
const mockCallUpdate = vi.fn();
vi.mock('twilio', () => ({
	default: vi.fn().mockImplementation(() => ({
		calls: Object.assign(mockCallCreate, {
			create: mockCallCreate,
		}),
	})),
}));

// Mock webhook server
vi.mock('../../src/telephony/twilio-webhook-server.js', () => ({
	TwilioWebhookServer: vi.fn().mockImplementation((config: Record<string, unknown>) => ({
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		sendMedia: vi.fn(),
		_config: config,
	})),
}));

const { TwilioBridge } = await import('../../src/telephony/twilio-bridge.js');

const BASE_CONFIG = {
	accountSid: 'AC_test',
	authToken: 'auth_test',
	fromNumber: '+15551234567',
	webhookBaseUrl: 'https://test.ngrok.io',
	webhookPort: 8766,
};

describe('TwilioBridge', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCallCreate.mockResolvedValue({ sid: 'CA_test_call_sid' });
		mockCallUpdate.mockResolvedValue({});
	});

	it('starts in idle state', () => {
		const bridge = new TwilioBridge(BASE_CONFIG, {
			onCallConnected: vi.fn(),
			onCallEnded: vi.fn(),
			onAudioFromHuman: vi.fn(),
			onError: vi.fn(),
		});
		expect(bridge.currentState).toBe('idle');
	});

	it('dial() creates Twilio call with correct parameters', async () => {
		const bridge = new TwilioBridge(BASE_CONFIG, {
			onCallConnected: vi.fn(),
			onCallEnded: vi.fn(),
			onAudioFromHuman: vi.fn(),
			onError: vi.fn(),
		});
		await bridge.start();

		const callSid = await bridge.dial('+15559876543');

		expect(callSid).toBe('CA_test_call_sid');
		expect(mockCallCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '+15559876543',
				from: '+15551234567',
				timeLimit: 1800,
				timeout: 30,
				statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
			}),
		);
	});

	it('dial() transitions to dialing state', async () => {
		const bridge = new TwilioBridge(BASE_CONFIG, {
			onCallConnected: vi.fn(),
			onCallEnded: vi.fn(),
			onAudioFromHuman: vi.fn(),
			onError: vi.fn(),
		});
		await bridge.start();
		await bridge.dial('+15559876543');
		expect(bridge.currentState).toBe('dialing');
	});

	it('dial() throws when not idle', async () => {
		const bridge = new TwilioBridge(BASE_CONFIG, {
			onCallConnected: vi.fn(),
			onCallEnded: vi.fn(),
			onAudioFromHuman: vi.fn(),
			onError: vi.fn(),
		});
		await bridge.start();
		await bridge.dial('+15559876543');

		await expect(bridge.dial('+15551111111')).rejects.toThrow('Cannot dial');
	});

	it('dial() with machineDetection passes the option', async () => {
		const bridge = new TwilioBridge(
			{ ...BASE_CONFIG, machineDetection: true },
			{
				onCallConnected: vi.fn(),
				onCallEnded: vi.fn(),
				onAudioFromHuman: vi.fn(),
				onError: vi.fn(),
			},
		);
		await bridge.start();
		await bridge.dial('+15559876543');

		expect(mockCallCreate).toHaveBeenCalledWith(
			expect.objectContaining({ machineDetection: 'Enable' }),
		);
	});

	it('dial() sets ended state on API failure', async () => {
		mockCallCreate.mockRejectedValueOnce(new Error('Twilio API error'));

		const bridge = new TwilioBridge(BASE_CONFIG, {
			onCallConnected: vi.fn(),
			onCallEnded: vi.fn(),
			onAudioFromHuman: vi.fn(),
			onError: vi.fn(),
		});
		await bridge.start();
		await expect(bridge.dial('+15559876543')).rejects.toThrow('Twilio API error');
		expect(bridge.currentState).toBe('ended');
	});

	it('handleStatusCallback transitions state correctly', async () => {
		const onCallEnded = vi.fn();
		const bridge = new TwilioBridge(BASE_CONFIG, {
			onCallConnected: vi.fn(),
			onCallEnded,
			onAudioFromHuman: vi.fn(),
			onError: vi.fn(),
		});
		await bridge.start();
		await bridge.dial('+15559876543');

		bridge.handleStatusCallback('CA_test_call_sid', 'ringing');
		expect(bridge.currentState).toBe('ringing');

		bridge.handleStatusCallback('CA_test_call_sid', 'completed');
		expect(bridge.currentState).toBe('ended');
		expect(onCallEnded).toHaveBeenCalledWith('CA_test_call_sid', 'completed');
	});

	it('handleStatusCallback detects voicemail', async () => {
		const onCallEnded = vi.fn();
		const bridge = new TwilioBridge(BASE_CONFIG, {
			onCallConnected: vi.fn(),
			onCallEnded,
			onAudioFromHuman: vi.fn(),
			onError: vi.fn(),
		});
		await bridge.start();
		await bridge.dial('+15559876543');

		bridge.handleStatusCallback('CA_test_call_sid', 'completed', 'machine_start');
		expect(onCallEnded).toHaveBeenCalledWith('CA_test_call_sid', 'voicemail:machine_start');
	});

	it('handleStatusCallback ignores mismatched callSid', async () => {
		const onCallEnded = vi.fn();
		const bridge = new TwilioBridge(BASE_CONFIG, {
			onCallConnected: vi.fn(),
			onCallEnded,
			onAudioFromHuman: vi.fn(),
			onError: vi.fn(),
		});
		await bridge.start();
		await bridge.dial('+15559876543');

		bridge.handleStatusCallback('CA_wrong_sid', 'completed');
		expect(onCallEnded).not.toHaveBeenCalled();
	});

	it('dispose() is idempotent', async () => {
		const bridge = new TwilioBridge(BASE_CONFIG, {
			onCallConnected: vi.fn(),
			onCallEnded: vi.fn(),
			onAudioFromHuman: vi.fn(),
			onError: vi.fn(),
		});
		await bridge.start();
		await bridge.dispose();
		await bridge.dispose(); // Should not throw
		expect(bridge.currentState).toBe('disposed');
	});

	it('sendAudioToHuman is no-op when not connected', () => {
		const bridge = new TwilioBridge(BASE_CONFIG, {
			onCallConnected: vi.fn(),
			onCallEnded: vi.fn(),
			onAudioFromHuman: vi.fn(),
			onError: vi.fn(),
		});
		// Should not throw when idle
		bridge.sendAudioToHuman(Buffer.alloc(32));
	});

	it('custom timeLimit and timeout are passed to Twilio', async () => {
		const bridge = new TwilioBridge(
			{ ...BASE_CONFIG, maxCallDuration: 600, ringTimeout: 15 },
			{
				onCallConnected: vi.fn(),
				onCallEnded: vi.fn(),
				onAudioFromHuman: vi.fn(),
				onError: vi.fn(),
			},
		);
		await bridge.start();
		await bridge.dial('+15559876543');

		expect(mockCallCreate).toHaveBeenCalledWith(
			expect.objectContaining({ timeLimit: 600, timeout: 15 }),
		);
	});
});
