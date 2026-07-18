#!/usr/bin/env node
// Client-protocol literal scanner (audit step A1 of the peer-server reuse plan).
//
// Sweeps every boundary-API population for wire message-type literals and
// prints one row per literal with where it was seen. The audit table
// (dev_docs/framework/client-protocol-audit.md) must classify EVERY candidate
// this script emits — rerun after protocol changes; an unclassified literal
// means the table (or the unions) are stale.
//
//   node scripts/scan-client-protocol.mjs            # human-readable
//   node scripts/scan-client-protocol.mjs --json     # machine-readable
//
// Populations (tag → what it captures):
//   emit      server→client send sites: sendJsonToClient / sendJson /
//             sendJsonAfterAudio / sendToClient / emitServerJson / broadcast /
//             ws.send(JSON.stringify(...)) — `type:` literal within 3 lines
//   builder   message-builder modules that construct frames away from the
//             send call (client-action-messages.ts, behavior-manager.ts):
//             every `type:` literal in the file
//   dispatch  inbound dispatch: `.type === 'x'` comparisons and `case 'x':`
//             arms in files that switch on a message/msg/event type
//   publish   EventBus-to-wire bridges: eventBus.publish('x', ...)
//   handler   web-client action-handler table method names
//
// Regex-based on purpose: zero deps, runs anywhere. It over-collects rather
// than under-collects; noise rows are classified `not-wire` in the table.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN_DIRS = ['src', 'app', 'examples'];
const SKIP = new Set(['node_modules', 'dist', '.next', '.worktrees', 'data', 'public']);
const EXT = /\.(ts|tsx|mts)$/;

const SEND_API =
	/\b(sendJsonToClient|sendJsonAfterAudio|sendJson|sendToClient|emitServerJson|broadcast)(?:\?\.)?\s*\(|\bws\.send\s*\(\s*JSON\.stringify|\bfeedJsonFromClient(?:\?\.)?\s*\(/;
const TYPE_LITERAL = /\btype:\s*['"]([A-Za-z0-9_.-]+)['"]/g;
const DISPATCH = /\.type\s*===\s*['"]([A-Za-z0-9_.-]+)['"]/g;
const CASE_ARM = /\bcase\s+['"]([A-Za-z0-9_.-]+)['"]\s*:/g;
const PUBLISH = /\beventBus\.publish\(\s*['"]([A-Za-z0-9_.-]+)['"]/g;
// Handler-table methods: `name(msg` or `'dotted.name'(msg` at member position.
const HANDLER_METHOD = /^\s*(?:['"]([A-Za-z0-9_.-]+)['"]|([A-Za-z0-9_]+))\s*\(\s*(?:msg|message|_msg)\b/;

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		if (SKIP.has(name) || name.startsWith('.')) continue;
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) yield* walk(full);
		else if (EXT.test(name) && !/\.test\.tsx?$/.test(name)) yield full;
	}
}

/** literal → { populations: Set, sites: Set<file:line> } */
const found = new Map();
function record(literal, population, file, line) {
	if (!found.has(literal)) found.set(literal, { populations: new Set(), sites: new Set() });
	const entry = found.get(literal);
	entry.populations.add(population);
	entry.sites.add(`${file}:${line}`);
}

for (const dir of SCAN_DIRS) {
	let files;
	try {
		files = [...walk(join(ROOT, dir))];
	} catch {
		continue;
	}
	for (const file of files) {
		const rel = relative(ROOT, file);
		const lines = readFileSync(file, 'utf8').split('\n');
		const isHandlerTable = /client-action-handlers\.ts$/.test(rel);
		// Builder modules construct frames far from the send call; take every
		// type literal in the file. Extend this list when a new builder module
		// appears (a frame the emit window misses but dispatch/handler sees is
		// the tell).
		const isBuilderModule = /client-action-messages\.ts$|behaviors\/behavior-manager\.ts$/.test(rel);
		const fileSwitchesOnType = lines.some((l) => /\b(msg|message|event|data|action)\.type\b/.test(l));

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			if (SEND_API.test(line)) {
				// `type:` literal within ±3 lines of the send call (the frame
				// object is often built immediately above or spread below).
				for (let j = Math.max(0, i - 3); j <= Math.min(i + 3, lines.length - 1); j++) {
					for (const m of lines[j].matchAll(TYPE_LITERAL)) record(m[1], 'emit', rel, j + 1);
				}
			}
			for (const m of line.matchAll(DISPATCH)) record(m[1], 'dispatch', rel, i + 1);
			if (fileSwitchesOnType) {
				for (const m of line.matchAll(CASE_ARM)) record(m[1], 'dispatch', rel, i + 1);
			}
			if (isBuilderModule) {
				for (const m of line.matchAll(TYPE_LITERAL)) record(m[1], 'builder', rel, i + 1);
			}
			for (const m of line.matchAll(PUBLISH)) record(m[1], 'publish', rel, i + 1);
			if (isHandlerTable) {
				const hm = line.match(HANDLER_METHOD);
				if (hm) record(hm[1] ?? hm[2], 'handler', rel, i + 1);
			}
		}
	}
}

const rows = [...found.entries()]
	.map(([literal, { populations, sites }]) => ({
		literal,
		populations: [...populations].sort(),
		sites: [...sites].sort(),
	}))
	.sort((a, b) => a.literal.localeCompare(b.literal));

if (process.argv.includes('--json')) {
	console.log(JSON.stringify(rows, null, 2));
} else {
	for (const r of rows) {
		console.log(`${r.literal}  [${r.populations.join(',')}]`);
		for (const s of r.sites.slice(0, 6)) console.log(`    ${s}`);
		if (r.sites.length > 6) console.log(`    … +${r.sites.length - 6} more`);
	}
	console.log(`\n${rows.length} candidate literals`);
}
