import { describe, expect, it, vi } from 'vitest';

describe('internal direct-rtc engine entry', () => {
	it('exports createWeriftOpusRtcEngine as its only runtime value', async () => {
		const mod = await import('../../src/direct-rtc/index.js');
		expect(Object.keys(mod).sort()).toEqual(['createWeriftOpusRtcEngine']);
		expect(typeof mod.createWeriftOpusRtcEngine).toBe('function');
	});

	it('createWeriftOpusRtcEngine returns an engine that starts without media and disposes cleanly', async () => {
		const { createWeriftOpusRtcEngine } = await import('../../src/direct-rtc/index.js');
		const engine = createWeriftOpusRtcEngine({
			iceServers: undefined,
			inputPcmSampleRate: 16000,
			outputPcmSampleRate: 24000,
			onInboundPcm: vi.fn(),
			emitServerJson: vi.fn(),
		});
		expect(engine.mediaReady).toBe(false);
		// Before any offer, assistant PCM is dropped by the engine (no peer yet).
		engine.sendAssistantPcm(Buffer.alloc(960 * 2));
		await expect(engine.dispose()).resolves.toBeUndefined();
	});
});
