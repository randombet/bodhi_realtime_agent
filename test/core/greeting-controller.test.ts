import { describe, expect, it, vi } from 'vitest';
import {
	GreetingController,
	type GreetingControllerConfig,
	type GreetingControllerDeps,
} from '../../src/core/greeting-controller.js';
import type { MainAgent } from '../../src/types/agent.js';
import type { MemoryFact } from '../../src/types/memory.js';
import type { LLMTransport } from '../../src/types/transport.js';

/** Minimal transport stub — only the fields GreetingController touches:
 *  capabilities (grace finalization), sendContent (greeting), clearInputAudio
 *  (arming echo-discard), cancelResponse presence (grace-enable validation). */
function fakeTransport(overrides: Partial<LLMTransport> = {}): LLMTransport {
	return {
		capabilities: { frameworkOwnsInterrupt: true },
		sendContent: vi.fn(),
		clearInputAudio: vi.fn(),
		cancelResponse: vi.fn(),
		...overrides,
	} as unknown as LLMTransport;
}

function fakeAgent(greeting: string | undefined = 'Hello there!'): MainAgent {
	return { name: 'TestAgent', greeting } as unknown as MainAgent;
}

interface Harness {
	controller: GreetingController;
	transport: LLMTransport;
	log: ReturnType<typeof vi.fn>;
	resetNotificationAudio: ReturnType<typeof vi.fn>;
	sendContent: ReturnType<typeof vi.fn>;
	clearInputAudio: ReturnType<typeof vi.fn>;
	facts: MemoryFact[];
	suffix: { value: string };
}

function makeHarness(
	opts: {
		transport?: LLMTransport;
		agent?: MainAgent;
		facts?: MemoryFact[];
		override?: number | undefined;
	} = {},
): Harness {
	const transport = opts.transport ?? fakeTransport();
	const sendContent = transport.sendContent as unknown as ReturnType<typeof vi.fn>;
	const clearInputAudio = transport.clearInputAudio as unknown as ReturnType<typeof vi.fn>;
	const log = vi.fn();
	const resetNotificationAudio = vi.fn();
	const facts: MemoryFact[] = opts.facts ?? [];
	const suffix = { value: '' };
	const deps: GreetingControllerDeps = {
		transport,
		getActiveAgent: () => opts.agent ?? fakeAgent(),
		getMemoryFacts: () => facts,
		getSessionSuffix: () => suffix.value,
		resetNotificationAudio,
		log,
	};
	const config: GreetingControllerConfig = { overrideGraceMs: opts.override };
	return {
		controller: new GreetingController(deps, config),
		transport,
		log,
		resetNotificationAudio,
		sendContent,
		clearInputAudio,
		facts,
		suffix,
	};
}

const logHas = (log: ReturnType<typeof vi.fn>, substr: string): boolean =>
	log.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes(substr));

describe('GreetingController grace resolution (pass 2)', () => {
	it('resolves the caller override against an enabled transport (frameworkOwns + cancelResponse)', () => {
		const h = makeHarness({ override: 1000 });
		h.controller.finalizeGreetingInterruptGrace();
		expect(logHas(h.log, '[Latency] greetingInterruptGraceMs resolved to 1000ms')).toBe(true);
	});

	it('inherits the transport-capability default when no caller override is given', () => {
		const transport = fakeTransport({
			capabilities: { frameworkOwnsInterrupt: true, greetingInterruptGraceMs: 250 },
		} as Partial<LLMTransport>);
		const h = makeHarness({ transport, override: undefined });
		h.controller.finalizeGreetingInterruptGrace();
		expect(logHas(h.log, '[Latency] greetingInterruptGraceMs resolved to 250ms')).toBe(true);
	});

	it('disables grace when frameworkOwnsInterrupt is not true (provider auto-cancel wins)', () => {
		const transport = fakeTransport({
			capabilities: { frameworkOwnsInterrupt: false },
		} as Partial<LLMTransport>);
		const h = makeHarness({ transport, override: 1000 });
		h.controller.finalizeGreetingInterruptGrace();
		expect(logHas(h.log, '[WARN] greetingInterruptGraceMs=1000ms requested but ')).toBe(true);
		// Disabled → no grace window, requestInterrupt always proceeds.
		expect(h.controller.requestInterrupt('test')).toBe(true);
	});

	it('disables grace when the transport lacks cancelResponse', () => {
		const transport = fakeTransport({ cancelResponse: undefined });
		const h = makeHarness({ transport, override: 1000 });
		h.controller.finalizeGreetingInterruptGrace();
		expect(logHas(h.log, '[WARN] greetingInterruptGraceMs=1000ms requested but ')).toBe(true);
	});

	it('stays disabled (no log) when the resolved grace is 0', () => {
		const h = makeHarness({ override: 0 });
		h.controller.finalizeGreetingInterruptGrace();
		expect(logHas(h.log, '[Latency] greetingInterruptGraceMs resolved')).toBe(false);
		expect(logHas(h.log, '[WARN] greetingInterruptGraceMs')).toBe(false);
	});
});

describe('GreetingController first-audio arming', () => {
	it('arms the grace window on the first audio chunk and discards input-buffer residue', () => {
		const h = makeHarness({ override: 1000 });
		h.controller.finalizeGreetingInterruptGrace();
		// Pre-arming: grace not yet active → interrupts pass.
		expect(h.controller.requestInterrupt('pre')).toBe(true);

		h.controller.maybeArmGraceOnFirstAudio();
		expect(logHas(h.log, '[Latency] Interrupt grace window armed (1000ms)')).toBe(true);
		expect(h.clearInputAudio).toHaveBeenCalledTimes(1);
		// Armed → suppresses interrupts.
		expect(h.controller.requestInterrupt('post')).toBe(false);
	});

	it('is idempotent — only the first chunk arms / logs / clears', () => {
		const h = makeHarness({ override: 1000 });
		h.controller.finalizeGreetingInterruptGrace();
		h.controller.maybeArmGraceOnFirstAudio();
		h.controller.maybeArmGraceOnFirstAudio();
		h.controller.maybeArmGraceOnFirstAudio();
		expect(h.clearInputAudio).toHaveBeenCalledTimes(1);
		expect(
			h.log.mock.calls.filter(
				(c) => typeof c[0] === 'string' && c[0].includes('Interrupt grace window armed'),
			).length,
		).toBe(1);
	});

	it('is a no-op when grace is disabled (grace=0)', () => {
		const h = makeHarness({ override: 0 });
		h.controller.finalizeGreetingInterruptGrace();
		h.controller.maybeArmGraceOnFirstAudio();
		expect(h.clearInputAudio).not.toHaveBeenCalled();
		expect(h.controller.requestInterrupt('x')).toBe(true);
	});
});

describe('GreetingController interrupt suppression', () => {
	it('requestInterrupt returns false (and logs) while the window is active, true after it expires', () => {
		vi.useFakeTimers();
		try {
			const h = makeHarness({ override: 1000 });
			h.controller.finalizeGreetingInterruptGrace();
			h.controller.maybeArmGraceOnFirstAudio();
			expect(h.controller.requestInterrupt('vad')).toBe(false);
			expect(logHas(h.log, 'interrupt suppressed (grace')).toBe(true);
			// Advance past the window — interrupts proceed again.
			vi.advanceTimersByTime(1001);
			expect(h.controller.requestInterrupt('vad')).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('GreetingController shouldDropOutbound + sendGreeting', () => {
	it('drops outbound mic while greeting is in flight (pre-first-audio), then hands off to the grace window', () => {
		const h = makeHarness({ override: 1000 });
		h.controller.finalizeGreetingInterruptGrace();
		// Before greeting send: nothing in flight, window unarmed.
		expect(h.controller.shouldDropOutbound()).toBe(false);

		h.controller.sendGreeting();
		// _greetingInFlight set → drop outbound even before first audio.
		expect(h.controller.shouldDropOutbound()).toBe(true);
		expect(h.sendContent).toHaveBeenCalledTimes(1);
		expect(h.resetNotificationAudio).toHaveBeenCalledTimes(1);

		// First audio arms the grace window and clears _greetingInFlight; the
		// active grace window keeps shouldDropOutbound true.
		h.controller.maybeArmGraceOnFirstAudio();
		expect(h.controller.shouldDropOutbound()).toBe(true);
	});

	it('sendGreeting prepends memory facts + session directives into one sendContent', () => {
		const facts: MemoryFact[] = [
			{ content: 'likes tea' } as MemoryFact,
			{ content: 'in Tokyo' } as MemoryFact,
		];
		const h = makeHarness({ override: 1000, facts });
		h.suffix.value = 'Speak slowly.';
		h.controller.finalizeGreetingInterruptGrace();
		h.controller.sendGreeting();
		const arg = h.sendContent.mock.calls[0][0] as Array<{ role: string; text: string }>;
		expect(arg[0].text).toContain('likes tea');
		expect(arg[0].text).toContain('in Tokyo');
		expect(arg[0].text).toContain('Speak slowly.');
		expect(arg[0].text).toContain('Hello there!');
		expect(h.sendContent.mock.calls[0][1]).toBe(true);
	});

	it('sendGreeting is a no-op (no sendContent) when the agent has no greeting', () => {
		const h = makeHarness({ override: 1000, agent: { name: 'NoGreet' } as unknown as MainAgent });
		h.controller.finalizeGreetingInterruptGrace();
		h.controller.sendGreeting();
		expect(h.sendContent).not.toHaveBeenCalled();
		expect(h.controller.shouldDropOutbound()).toBe(false);
	});
});

describe('GreetingController.resetForClientConnected', () => {
	it('clears the grace window, the arming-log gate, and the greeting-in-flight flag', () => {
		const h = makeHarness({ override: 1000 });
		h.controller.finalizeGreetingInterruptGrace();
		h.controller.sendGreeting(); // sets _greetingInFlight
		h.controller.maybeArmGraceOnFirstAudio(); // arms grace + logs
		expect(h.controller.shouldDropOutbound()).toBe(true);

		h.controller.resetForClientConnected();
		// _grace.reset() + _greetingInFlight=false → nothing drops outbound.
		expect(h.controller.shouldDropOutbound()).toBe(false);
		// Interrupt suppression released (grace window reset).
		expect(h.controller.requestInterrupt('x')).toBe(true);

		// _graceArmingLogged cleared → re-arming logs again on next first audio.
		const before = h.log.mock.calls.filter(
			(c) => typeof c[0] === 'string' && c[0].includes('Interrupt grace window armed'),
		).length;
		h.controller.maybeArmGraceOnFirstAudio();
		const after = h.log.mock.calls.filter(
			(c) => typeof c[0] === 'string' && c[0].includes('Interrupt grace window armed'),
		).length;
		expect(after).toBe(before + 1);
	});
});
