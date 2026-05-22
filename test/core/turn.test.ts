// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { Turn } from '../../src/core/turn.js';

describe('Turn', () => {
	it('starts active with the given identity', () => {
		const t = new Turn('turn_1', 'main');
		expect(t.id).toBe('turn_1');
		expect(t.agentName).toBe('main');
		expect(t.isFinalized).toBe(false);
		expect(t.hasServerTurnId).toBe(false);
		expect(t.latestServerTurnId).toBeNull();
	});

	it('finalize() returns true once, then false', () => {
		const t = new Turn('turn_1', 'main');
		expect(t.finalize()).toBe(true);
		expect(t.isFinalized).toBe(true);
		expect(t.finalize()).toBe(false);
		expect(t.finalize()).toBe(false);
	});

	it('bindServerTurnId() accumulates; ownsServerTurn() reflects every bound id', () => {
		const t = new Turn('turn_1', 'main');
		t.bindServerTurnId(3);
		t.bindServerTurnId(5);
		expect(t.ownsServerTurn(3)).toBe(true);
		expect(t.ownsServerTurn(5)).toBe(true);
		expect(t.ownsServerTurn(4)).toBe(false);
		expect(t.hasServerTurnId).toBe(true);
	});

	it('binding the same id twice is idempotent', () => {
		const t = new Turn('turn_1', 'main');
		t.bindServerTurnId(7);
		t.bindServerTurnId(7);
		expect(t.ownsServerTurn(7)).toBe(true);
		expect(t.latestServerTurnId).toBe(7);
	});

	it('latestServerTurnId is the maximum bound id regardless of insertion order', () => {
		const t = new Turn('turn_1', 'main');
		t.bindServerTurnId(9);
		t.bindServerTurnId(2);
		t.bindServerTurnId(6);
		expect(t.latestServerTurnId).toBe(9);
	});

	it('can bind a server-turn id after finalize() — late-signal correlation', () => {
		const t = new Turn('turn_1', 'main');
		t.finalize();
		t.bindServerTurnId(4);
		expect(t.ownsServerTurn(4)).toBe(true);
	});
});
