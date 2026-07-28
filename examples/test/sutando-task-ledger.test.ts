import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SutandoTaskLedger } from '../lib/sutando-task-ledger.js';

let dirs: string[] = [];

function makeLedger(overrides: { ttlMs?: number; now?: () => number } = {}): {
	ledger: SutandoTaskLedger;
	dir: string;
} {
	const dir = mkdtempSync(join(tmpdir(), 'sutando-ledger-'));
	dirs.push(dir);
	return { ledger: new SutandoTaskLedger({ dir, ...overrides }), dir };
}

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

describe('SutandoTaskLedger', () => {
	it('entries and states survive into a fresh instance (kill -9 equivalence: every append is fsync-durable)', () => {
		const { ledger, dir } = makeLedger();
		ledger.append({ id: 't-1', nonce: 'aaaa', state: 'submitted', desc: 'find invoices' });
		ledger.append({ id: 't-1', nonce: 'aaaa', state: 'acked' });
		ledger.append({ id: 't-2', nonce: 'aaaa', state: 'submitted', desc: 'send email' });

		// A brand-new instance over the same dir = post-crash reload.
		const reloaded = new SutandoTaskLedger({ dir });
		const views = reloaded.loadTaskViews();
		expect(views.get('t-1')).toMatchObject({
			acked: true,
			completed: false,
			desc: 'find invoices',
		});
		expect(views.get('t-2')).toMatchObject({ acked: false, desc: 'send email' });
	});

	it('tolerates a torn tail line from a crash mid-write', () => {
		const { ledger, dir } = makeLedger();
		ledger.append({ id: 't-1', nonce: 'aaaa', state: 'submitted', desc: 'x' });
		appendFileSync(join(dir, 'aaaa.jsonl'), '{"id":"t-2","non'); // torn write
		const views = new SutandoTaskLedger({ dir }).loadTaskViews();
		expect(views.size).toBe(1);
		expect(views.has('t-1')).toBe(true);
	});

	it('retention: descs are one-lined and capped; result content never stored', () => {
		const { ledger, dir } = makeLedger();
		ledger.append({
			id: 't-1',
			nonce: 'aaaa',
			state: 'submitted',
			desc: `line1\nline2 ${'x'.repeat(300)}`,
		});
		const raw = readFileSync(join(dir, 'aaaa.jsonl'), 'utf-8');
		const entry = JSON.parse(raw.trim());
		expect(entry.desc).not.toContain('\n');
		expect(entry.desc.length).toBeLessThanOrEqual(120);
	});

	describe('reap — intent-split classification', () => {
		it('submitted-but-never-acked → dropped_before_delivery (invites a re-ask)', () => {
			const { ledger } = makeLedger();
			ledger.append({ id: 't-1', nonce: 'aaaa', state: 'submitted', desc: 'send the report' });
			const { notices } = ledger.reap(new Set());
			expect(notices).toHaveLength(1);
			expect(notices[0]).toMatchObject({ id: 't-1', kind: 'dropped_before_delivery' });
			expect(notices[0].text).toContain('redo');
		});

		it('acked-but-unclaimed → unclaimed_after_restart (never suggests a redo)', () => {
			const { ledger } = makeLedger();
			ledger.append({ id: 't-1', nonce: 'aaaa', state: 'submitted', desc: 'send the report' });
			ledger.append({ id: 't-1', nonce: 'aaaa', state: 'acked' });
			const { notices } = ledger.reap(new Set());
			expect(notices).toHaveLength(1);
			expect(notices[0].kind).toBe('unclaimed_after_restart');
			expect(notices[0].text).toContain('may have already completed');
			expect(notices[0].text).toContain('Do not redo it without asking');
		});

		it('post-goodbye (or cancel/watchdog) work is NEVER notice-eligible', () => {
			const { ledger } = makeLedger();
			for (const [id, intent] of [
				['t-1', 'session_closed'],
				['t-2', 'cancelled'],
				['t-3', 'watchdog_expired'],
			] as const) {
				ledger.append({ id, nonce: 'aaaa', state: 'submitted', desc: 'walked away' });
				ledger.append({ id, nonce: 'aaaa', state: 'acked' });
				ledger.append({ id, nonce: 'aaaa', state: intent });
			}
			expect(ledger.reap(new Set()).notices).toHaveLength(0);
		});

		it('completed and live tasks produce no notices', () => {
			const { ledger } = makeLedger();
			ledger.append({ id: 't-1', nonce: 'aaaa', state: 'submitted', desc: 'done one' });
			ledger.append({ id: 't-1', nonce: 'aaaa', state: 'acked' });
			ledger.append({ id: 't-1', nonce: 'aaaa', state: 'completed' });
			ledger.append({ id: 't-2', nonce: 'aaaa', state: 'submitted', desc: 'live one' });
			expect(ledger.reap(new Set(['t-2'])).notices).toHaveLength(0);
		});

		it('a consumed notice never fires again (reconciled ≠ consumed)', () => {
			const { ledger } = makeLedger();
			ledger.append({ id: 't-1', nonce: 'aaaa', state: 'submitted', desc: 'x' });
			ledger.append({ id: 't-1', nonce: 'aaaa', state: 'acked' });
			expect(ledger.reap(new Set()).notices).toHaveLength(1); // still due — not consumed yet
			ledger.markNoticeConsumed('t-1', 'aaaa');
			expect(ledger.reap(new Set()).notices).toHaveLength(0);
		});
	});

	it('prunes a session file only when every task is terminal AND past TTL', () => {
		let clock = 1_000_000;
		const { ledger, dir } = makeLedger({ ttlMs: 100, now: () => clock });
		ledger.append({ id: 't-1', nonce: 'aaaa', state: 'submitted', desc: 'x' });
		ledger.append({ id: 't-1', nonce: 'aaaa', state: 'acked' });
		ledger.append({ id: 't-1', nonce: 'aaaa', state: 'completed' });

		// Terminal but young → kept.
		expect(ledger.reap(new Set()).prunedFiles).toBe(0);
		expect(readdirSync(dir)).toHaveLength(1);

		clock += 200; // past TTL → pruned.
		expect(ledger.reap(new Set()).prunedFiles).toBe(1);
		expect(readdirSync(dir)).toHaveLength(0);
	});
});
