// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
	AgentError,
	FrameworkError,
	MemoryError,
	SessionError,
	ToolExecutionError,
	TransportError,
	ValidationError,
} from '../../src/core/errors.js';

describe('FrameworkError', () => {
	it('sets message, component, and default severity', () => {
		const err = new FrameworkError('boom', { component: 'test' });
		expect(err.message).toBe('boom');
		expect(err.component).toBe('test');
		expect(err.severity).toBe('error');
		expect(err.name).toBe('FrameworkError');
	});

	it('accepts custom severity', () => {
		const err = new FrameworkError('warn', { component: 'test', severity: 'fatal' });
		expect(err.severity).toBe('fatal');
	});

	it('chains cause', () => {
		const cause = new Error('root');
		const err = new FrameworkError('wrapper', { component: 'test', cause });
		expect(err.cause).toBe(cause);
	});

	it('is an instance of Error', () => {
		const err = new FrameworkError('x', { component: 'test' });
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(FrameworkError);
	});
});

describe('TransportError', () => {
	it('sets component to transport', () => {
		const err = new TransportError('ws closed');
		expect(err.component).toBe('transport');
		expect(err.name).toBe('TransportError');
		expect(err).toBeInstanceOf(FrameworkError);
	});

	it('chains cause', () => {
		const cause = new Error('socket reset');
		const err = new TransportError('ws closed', { cause });
		expect(err.cause).toBe(cause);
	});
});

describe('SessionError', () => {
	it('sets component to session', () => {
		const err = new SessionError('invalid transition');
		expect(err.component).toBe('session');
		expect(err.name).toBe('SessionError');
		expect(err).toBeInstanceOf(FrameworkError);
	});
});

describe('ToolExecutionError', () => {
	it('sets component to tool', () => {
		const err = new ToolExecutionError('timeout');
		expect(err.component).toBe('tool');
		expect(err.name).toBe('ToolExecutionError');
		expect(err).toBeInstanceOf(FrameworkError);
	});

	it('accepts severity override', () => {
		const err = new ToolExecutionError('warn', { severity: 'warn' });
		expect(err.severity).toBe('warn');
	});
});

describe('AgentError', () => {
	it('sets component to agent', () => {
		const err = new AgentError('unknown agent');
		expect(err.component).toBe('agent');
		expect(err.name).toBe('AgentError');
		expect(err).toBeInstanceOf(FrameworkError);
	});
});

describe('MemoryError', () => {
	it('sets component to memory', () => {
		const err = new MemoryError('read failed');
		expect(err.component).toBe('memory');
		expect(err.name).toBe('MemoryError');
		expect(err).toBeInstanceOf(FrameworkError);
	});
});

describe('ValidationError', () => {
	it('sets component to validation', () => {
		const err = new ValidationError('bad input');
		expect(err.component).toBe('validation');
		expect(err.name).toBe('ValidationError');
		expect(err).toBeInstanceOf(FrameworkError);
	});
});

describe('instanceof chains', () => {
	it('all subclasses are instanceof FrameworkError and Error', () => {
		const errors = [
			new TransportError('a'),
			new SessionError('b'),
			new ToolExecutionError('c'),
			new AgentError('d'),
			new MemoryError('e'),
			new ValidationError('f'),
		];
		for (const err of errors) {
			expect(err).toBeInstanceOf(Error);
			expect(err).toBeInstanceOf(FrameworkError);
		}
	});
});
