import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	type SutandoService,
	startSutandoService,
	sweepRawDir,
} from '../../app/server/sutando/sutando-service.js';

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), 'sutando-service-'));
}

/** A fully valid env; tests knock out one field at a time. */
function validEnv(root: string): NodeJS.ProcessEnv {
	return {
		SUTANDO_RELAY_TOKEN: 'test-token',
		SUTANDO_OWNER_EMAIL: 'owner@example.com',
		SUTANDO_ALLOWED_ORIGINS: 'https://demo.example.com',
		SUPABASE_URL: 'https://project.supabase.co',
		SUPABASE_ANON_KEY: 'anon-key',
		SUTANDO_RAW_DIR: join(root, 'raw'),
		SUTANDO_LEDGER_DIR: join(root, 'ledger'),
	};
}

describe('startSutandoService', () => {
	const roots: string[] = [];
	const services: SutandoService[] = [];

	afterEach(async () => {
		for (const s of services.splice(0)) await s.stop();
		for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
	});

	async function start(env: NodeJS.ProcessEnv): Promise<SutandoService> {
		const service = await startSutandoService({ env, relayPortOverride: 0 });
		services.push(service);
		return service;
	}

	function root(): string {
		const r = tempDir();
		roots.push(r);
		return r;
	}

	it('boots disabled(not_declared) with no Sutando env at all', async () => {
		const service = await start({});
		expect(service.state).toBe('disabled');
		expect(service.state === 'disabled' && service.reason).toBe('not_declared');
	});

	it('reaches ready with a fully valid config', async () => {
		const service = await start(validEnv(root()));
		expect(service.state).toBe('ready');
		if (service.state === 'ready') {
			expect(service.config.ownerEmail).toBe('owner@example.com');
			expect(service.config.allowedOrigins).toEqual(['https://demo.example.com']);
			expect(service.config.googleSearch).toBe(true);
			expect(service.relay.port).toBeGreaterThan(0);
		}
	});

	it('lowercases and trims the owner email', async () => {
		const env = validEnv(root());
		env.SUTANDO_OWNER_EMAIL = '  Owner@Example.COM ';
		const service = await start(env);
		expect(service.state === 'ready' && service.config.ownerEmail).toBe('owner@example.com');
	});

	it('SUTANDO_GOOGLE_SEARCH=0 flips googleSearch off', async () => {
		const env = validEnv(root());
		env.SUTANDO_GOOGLE_SEARCH = '0';
		const service = await start(env);
		expect(service.state === 'ready' && service.config.googleSearch).toBe(false);
	});

	const disabledCases: Array<{
		name: string;
		mutate: (env: NodeJS.ProcessEnv) => void;
		reason: string;
	}> = [
		{
			name: 'missing owner email',
			mutate: (e) => {
				e.SUTANDO_OWNER_EMAIL = undefined;
			},
			reason: 'owner_email_missing',
		},
		{
			name: 'multiple owner emails',
			mutate: (e) => {
				e.SUTANDO_OWNER_EMAIL = 'a@example.com,b@example.com';
			},
			reason: 'owner_email_not_single',
		},
		{
			name: 'syntactically invalid owner email',
			mutate: (e) => {
				e.SUTANDO_OWNER_EMAIL = 'not-an-email';
			},
			reason: 'owner_email_invalid',
		},
		{
			name: 'missing origins',
			mutate: (e) => {
				e.SUTANDO_ALLOWED_ORIGINS = undefined;
			},
			reason: 'origins_missing',
		},
		{
			name: 'wildcard origin',
			mutate: (e) => {
				e.SUTANDO_ALLOWED_ORIGINS = 'https://*.example.com';
			},
			reason: 'origin_invalid',
		},
		{
			name: 'http origin',
			mutate: (e) => {
				e.SUTANDO_ALLOWED_ORIGINS = 'http://demo.example.com';
			},
			reason: 'origin_invalid',
		},
		{
			name: 'unnormalized origin (trailing path)',
			mutate: (e) => {
				e.SUTANDO_ALLOWED_ORIGINS = 'https://demo.example.com/app';
			},
			reason: 'origin_invalid',
		},
		{
			name: 'missing Supabase URL',
			mutate: (e) => {
				e.SUPABASE_URL = undefined;
			},
			reason: 'supabase_not_configured',
		},
		{
			name: 'missing Supabase anon key',
			mutate: (e) => {
				e.SUPABASE_ANON_KEY = undefined;
			},
			reason: 'supabase_not_configured',
		},
		{
			name: 'missing raw dir',
			mutate: (e) => {
				e.SUTANDO_RAW_DIR = undefined;
			},
			reason: 'raw_dir_missing',
		},
		{
			name: 'relative raw dir',
			mutate: (e) => {
				e.SUTANDO_RAW_DIR = './sutando-raw';
			},
			reason: 'raw_dir_not_absolute',
		},
		{
			name: 'missing ledger dir',
			mutate: (e) => {
				e.SUTANDO_LEDGER_DIR = undefined;
			},
			reason: 'ledger_dir_missing',
		},
		{
			name: 'relative ledger dir',
			mutate: (e) => {
				e.SUTANDO_LEDGER_DIR = './sutando-ledger';
			},
			reason: 'ledger_dir_not_absolute',
		},
	];

	for (const { name, mutate, reason } of disabledCases) {
		it(`disabled on ${name} (${reason})`, async () => {
			const env = validEnv(root());
			mutate(env);
			const service = await start(env);
			expect(service.state).toBe('disabled');
			expect(service.state === 'disabled' && service.reason).toBe(reason);
		});
	}

	it('disabled(dirs_overlap) when the ledger dir nests inside the raw dir', async () => {
		const r = root();
		const env = validEnv(r);
		env.SUTANDO_LEDGER_DIR = join(r, 'raw', 'ledger');
		const service = await start(env);
		expect(service.state === 'disabled' && service.reason).toBe('dirs_overlap');
	});

	it('disabled(dirs_overlap) when raw and ledger dirs are equal', async () => {
		const r = root();
		const env = validEnv(r);
		env.SUTANDO_LEDGER_DIR = env.SUTANDO_RAW_DIR as string;
		const service = await start(env);
		expect(service.state === 'disabled' && service.reason).toBe('dirs_overlap');
	});

	it('tightens a pre-existing permissive raw dir to 0700', async () => {
		const r = root();
		const env = validEnv(r);
		mkdirSync(env.SUTANDO_RAW_DIR as string, { recursive: true, mode: 0o755 });
		const service = await start(env);
		expect(service.state).toBe('ready');
		const mode = lstatSync(env.SUTANDO_RAW_DIR as string).mode & 0o777;
		expect(mode).toBe(0o700);
	});

	it('disabled(ledger_dir_unusable) on a symlinked ledger dir', async () => {
		const r = root();
		const real = join(r, 'real-ledger');
		mkdirSync(real);
		const link = join(r, 'ledger-link');
		symlinkSync(real, link);
		const env = validEnv(r);
		env.SUTANDO_LEDGER_DIR = link;
		const service = await start(env);
		expect(service.state === 'disabled' && service.reason).toBe('ledger_dir_unusable');
	});

	it('disabled(sweep_schedule_failed) when the sweep scheduler throws', async () => {
		const env = validEnv(root());
		const service = await startSutandoService({
			env,
			relayPortOverride: 0,
			scheduleSweep: () => {
				throw new Error('scheduler down');
			},
		});
		services.push(service);
		expect(service.state === 'disabled' && service.reason).toBe('sweep_schedule_failed');
	});

	it('disabled(relay_port_invalid) on an out-of-range port', async () => {
		const env = validEnv(root());
		env.SUTANDO_RELAY_PORT = '99999';
		const service = await startSutandoService({ env });
		services.push(service);
		expect(service.state === 'disabled' && service.reason).toBe('relay_port_invalid');
	});

	it('disabled(raw_dir_unusable) on a symlinked raw dir', async () => {
		const r = root();
		const real = join(r, 'real');
		mkdirSync(real);
		const link = join(r, 'link');
		symlinkSync(real, link);
		const env = validEnv(r);
		env.SUTANDO_RAW_DIR = link;
		const service = await start(env);
		expect(service.state === 'disabled' && service.reason).toBe('raw_dir_unusable');
	});

	it('disabled(relay_start_failed) when the relay port is already taken', async () => {
		const r = root();
		const first = await start(validEnv(r));
		expect(first.state).toBe('ready');
		if (first.state !== 'ready') return;
		const r2 = root();
		const env = validEnv(r2);
		const service = await startSutandoService({ env, relayPortOverride: first.relay.port });
		services.push(service);
		expect(service.state === 'disabled' && service.reason).toBe('relay_start_failed');
	});
});

describe('sweepRawDir', () => {
	it('deletes old files, keeps fresh files and fresh temp files, never follows symlinks', () => {
		const r = mkdtempSync(join(tmpdir(), 'sutando-sweep-'));
		const outside = mkdtempSync(join(tmpdir(), 'sutando-sweep-outside-'));
		try {
			const now = Date.now();
			const old = now / 1000 - 30 * 24 * 3600; // 30 days ago, in seconds
			const sub = join(r, 'session-a');
			mkdirSync(sub);
			writeFileSync(join(sub, 'old.txt'), 'x');
			utimesSync(join(sub, 'old.txt'), old, old);
			writeFileSync(join(sub, 'fresh.txt'), 'x');
			writeFileSync(join(r, 'fresh.tmp'), 'x'); // in-flight write: skipped
			writeFileSync(join(outside, 'victim.txt'), 'x');
			utimesSync(join(outside, 'victim.txt'), old, old);
			symlinkSync(outside, join(r, 'escape')); // must not be followed

			sweepRawDir(r, 14 * 24 * 3600_000, now, () => {});

			expect(readdirSync(sub)).toEqual(['fresh.txt']);
			expect(readdirSync(r)).toContain('fresh.tmp');
			expect(readdirSync(outside)).toEqual(['victim.txt']); // symlink not traversed
		} finally {
			rmSync(r, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
