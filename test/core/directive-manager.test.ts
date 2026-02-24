// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { DirectiveManager } from '../../src/core/directive-manager.js';

describe('DirectiveManager', () => {
	it('starts with no directives', () => {
		const mgr = new DirectiveManager();
		expect(mgr.getSessionSuffix()).toBe('');
		expect(mgr.getReinforcementText()).toBe('');
	});

	it('sets and retrieves session directives via getSessionSuffix', () => {
		const mgr = new DirectiveManager();
		mgr.set('pacing', 'Speak slowly', 'session');
		const suffix = mgr.getSessionSuffix();
		expect(suffix).toContain('SESSION DIRECTIVES');
		expect(suffix).toContain('Speak slowly');
	});

	it('sets agent directives (not included in session suffix)', () => {
		const mgr = new DirectiveManager();
		mgr.set('tone', 'Be formal', 'agent');
		expect(mgr.getSessionSuffix()).toBe('');
		expect(mgr.getReinforcementText()).toContain('Be formal');
	});

	it('defaults scope to agent when undefined', () => {
		const mgr = new DirectiveManager();
		mgr.set('tone', 'Be casual');
		expect(mgr.getSessionSuffix()).toBe('');
		expect(mgr.getReinforcementText()).toContain('Be casual');
	});

	it('merges both scopes in reinforcement text with agent overriding session', () => {
		const mgr = new DirectiveManager();
		mgr.set('pacing', 'Speak slowly', 'session');
		mgr.set('pacing', 'Speak fast', 'agent');
		const text = mgr.getReinforcementText();
		expect(text).toContain('Speak fast');
		expect(text).not.toContain('Speak slowly');
	});

	it('deletes a directive when value is null', () => {
		const mgr = new DirectiveManager();
		mgr.set('pacing', 'Speak slowly', 'session');
		expect(mgr.getSessionSuffix()).toContain('Speak slowly');

		mgr.set('pacing', null, 'session');
		expect(mgr.getSessionSuffix()).toBe('');
	});

	it('clearAgent removes agent directives but keeps session directives', () => {
		const mgr = new DirectiveManager();
		mgr.set('pacing', 'Speak slowly', 'session');
		mgr.set('tone', 'Be formal', 'agent');

		mgr.clearAgent();

		expect(mgr.getSessionSuffix()).toContain('Speak slowly');
		const text = mgr.getReinforcementText();
		expect(text).toContain('Speak slowly');
		expect(text).not.toContain('Be formal');
	});

	it('joins multiple directives with double newlines', () => {
		const mgr = new DirectiveManager();
		mgr.set('a', 'First directive', 'session');
		mgr.set('b', 'Second directive', 'session');
		const suffix = mgr.getSessionSuffix();
		expect(suffix).toContain('First directive\n\nSecond directive');
	});
});
