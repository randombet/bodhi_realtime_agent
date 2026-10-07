import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Manifest fields of the npm registry release.
 *
 * The tarball itself is checked by `scripts/verify-pack.mjs`; this suite guards the
 * manifest fields that script and every registry consumer rely on.
 */

interface ExportsEntry {
	readonly types: string;
	readonly default: string;
}

interface ExportsTarget {
	readonly import: ExportsEntry;
	readonly require: ExportsEntry;
}

interface ImportsTarget {
	readonly import: string;
	readonly require: string;
}

interface Manifest {
	readonly files: readonly string[];
	readonly scripts: Readonly<Record<string, string>>;
	readonly exports: Readonly<Record<string, ExportsTarget>>;
	readonly imports?: Readonly<Record<string, ImportsTarget>>;
}

const manifest = JSON.parse(
	readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as Manifest;

describe('package manifest', () => {
	it('guards prepare so a non-git install context cannot abort it', () => {
		const prepare = manifest.scripts.prepare;
		expect(prepare.startsWith('(git rev-parse --git-dir')).toBe(true);
		expect(prepare).toContain('|| true');
	});

	it('publishes only dist', () => {
		expect(manifest.files).toEqual(['dist']);
	});

	it('exports the root and each subpath with import/require types and defaults under dist', () => {
		const subpaths = ['.', './observability', './observability/opentelemetry'];
		for (const subpath of subpaths) {
			const target = manifest.exports[subpath];
			expect(target, subpath).toBeDefined();
			expect(target.import.types, `${subpath} import.types`).toMatch(/^\.\/dist\/.+\.d\.ts$/);
			expect(target.import.default, `${subpath} import.default`).toMatch(/^\.\/dist\/.+\.js$/);
			expect(target.require.types, `${subpath} require.types`).toMatch(/^\.\/dist\/.+\.d\.cts$/);
			expect(target.require.default, `${subpath} require.default`).toMatch(/^\.\/dist\/.+\.cjs$/);
		}
	});

	it('maps the RTC engine entry through the private #direct-rtc import, not a public subpath', () => {
		const target = manifest.imports?.['#direct-rtc'];
		expect(target, '#direct-rtc').toBeDefined();
		expect(target?.import, '#direct-rtc import').toMatch(/^\.\/dist\/direct-rtc\/.+\.js$/);
		expect(target?.require, '#direct-rtc require').toMatch(/^\.\/dist\/direct-rtc\/.+\.cjs$/);
		expect(Object.keys(manifest.exports)).not.toContain('./direct-rtc');
	});

	it('runs the packed-consumer gate from prepublishOnly', () => {
		expect(manifest.scripts['verify:pack']).toBe('node scripts/verify-pack.mjs');
		expect(manifest.scripts.prepublishOnly).toContain('verify:pack');
	});
});
