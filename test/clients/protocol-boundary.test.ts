import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Boundary check for the browser-safe packages under clients/: they must not
// import the framework tree (src/) or any third-party runtime dependency.

const CLIENTS_ROOT = join(__dirname, '..', '..', 'clients');
const ALLOWED_PACKAGE_IMPORTS = new Set(['@bodhi/client-protocol']);

function* sourceFiles(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (name === 'dist' || name === 'node_modules') continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) yield* sourceFiles(full);
		else if (/\.(ts|tsx)$/.test(name)) yield full;
	}
}

describe('clients/* package boundary', () => {
	it('contains no imports from src/ and no third-party runtime deps', () => {
		const violations: string[] = [];
		for (const file of sourceFiles(CLIENTS_ROOT)) {
			const content = readFileSync(file, 'utf8');
			for (const m of content.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
				const spec = m[1];
				if (spec.startsWith('.')) {
					if (spec.includes('/src/') || spec.includes('../../src')) {
						violations.push(`${file}: relative import into src/ (${spec})`);
					}
					continue;
				}
				if (spec.startsWith('node:')) {
					violations.push(`${file}: Node built-in in browser package (${spec})`);
					continue;
				}
				if (!ALLOWED_PACKAGE_IMPORTS.has(spec)) {
					violations.push(`${file}: disallowed package import (${spec})`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
