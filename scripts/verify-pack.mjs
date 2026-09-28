#!/usr/bin/env node
// Packed-consumer gate: installs the tarball `npm pack` builds from this checkout into a
// clean directory and checks it the way a registry consumer would use it. Run after
// `pnpm build`; `prepublishOnly` and .github/workflows/release.yml run it in full.
//
//   (a) pack     the tarball carries dist/ (the root and observability entries and the
//                internal direct-rtc engine entry), LICENSE and README.md, and nothing under
//                src/, clients/, test/ or examples/
//   (b) install  `npm install --ignore-scripts --no-audit --no-fund <tgz>` into a fresh
//                `"type": "module"` consumer created with mkdtemp
//   (c) runtime  ESM import and CJS require of the root and the observability subpath, and a
//                werift_opus DirectRtcClientChannel built from the installed root entry loads
//                its RTC engine through the package's private #direct-rtc import
//   (d) types    test/fixtures/packed-consumer/api-probe.ts compiles against the installed
//                declarations with --module NodeNext (index.d.ts) and, inside a
//                "type": "commonjs" package, with --module Node16 (index.d.cts)
//   (e) bundle   esbuild bundles the root as a downstream Node app does (ESM output for
//                Node with the usual CommonJS interop banner); the output names no native or
//                telephony dependency and runs from a fresh directory with no ancestor
//                node_modules and no NODE_PATH
//   (f) one summary line per step
//
//   node scripts/verify-pack.mjs                      # full gate
//   node scripts/verify-pack.mjs --skip-declarations  # omit (d) and the (c) checks for
//                                                     # ClientTransport, CLOSE_CODE_CLIENT_BUSY
//                                                     # and VoiceSession.RECONNECT_DEADLINE_MS
//                                                     # until the probe's API names all exist
//   node scripts/verify-pack.mjs --keep               # leave the temp directories for inspection
//
// Exits non-zero on the first failure.

import { execFileSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE = 'bodhi-realtime-agent';
const FIXTURE = join(ROOT, 'test', 'fixtures', 'packed-consumer', 'api-probe.ts');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const REQUIRED_FILES = [
	'package.json',
	'LICENSE',
	'README.md',
	'dist/index.js',
	'dist/index.cjs',
	'dist/index.d.ts',
	'dist/index.d.cts',
	'dist/observability/index.js',
	'dist/direct-rtc/index.js',
	'dist/direct-rtc/index.cjs',
];
const FORBIDDEN_PREFIXES = ['src/', 'clients/', 'test/', 'examples/'];
/** Substrings the root bundle must never contain: the werift/Opus engine and Twilio stay off the root import chain. */
const BUNDLE_MUST_NOT_CONTAIN = ['"werift"', '"@evan/opus"', '"twilio"', '.node"'];
/**
 * The interop banner a downstream esbuild bundle prepends: it defines `require`,
 * `__filename` and `__dirname` so CommonJS code bundled into ESM output still runs.
 */
const BANNER =
	"import{createRequire as __cr}from'module';import{fileURLToPath as __fu}from'url';import{dirname as __dn}from'path';const require=__cr(import.meta.url);const __filename=__fu(import.meta.url);const __dirname=__dn(__filename);";

const KNOWN_FLAGS = new Set(['--keep', '--skip-declarations']);
const flags = process.argv.slice(2);
const unknownFlags = flags.filter((flag) => !KNOWN_FLAGS.has(flag));
if (unknownFlags.length > 0) {
	console.error(
		`verify-pack: unknown argument ${unknownFlags.join(' ')}\nusage: node scripts/verify-pack.mjs [--keep] [--skip-declarations]`,
	);
	process.exit(2);
}
const keep = flags.includes('--keep');
const skipDeclarations = flags.includes('--skip-declarations');

class StepFailure extends Error {
	constructor(step, message) {
		super(message);
		this.name = 'StepFailure';
		this.step = step;
	}
}

function fail(step, message) {
	throw new StepFailure(step, message);
}

function report(step, message) {
	console.log(`verify-pack (${step}) ${message}`);
}

/** Runs a command and returns its stdout; a non-zero exit becomes a StepFailure carrying both streams. */
function run(step, file, args, options = {}) {
	try {
		return execFileSync(file, args, {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			maxBuffer: 64 * 1024 * 1024,
			timeout: 600_000,
			...options,
		});
	} catch (error) {
		const detail = [error.stdout, error.stderr]
			.filter(Boolean)
			.map((stream) => String(stream).trim())
			.filter(Boolean)
			.join('\n');
		return fail(
			step,
			`${[file, ...args].join(' ')} exited with ${error.status ?? error.code ?? 'an unknown status'}${detail ? `\n${detail}` : ''}`,
		);
	}
}

function writeManifest(dir, manifest) {
	writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

// Step 0: esbuild is a devDependency; fail fast with a clear message when it is missing.
let esbuild;
try {
	esbuild = await import('esbuild');
} catch (error) {
	console.error(
		`verify-pack (0) FAILED: cannot import esbuild (${error?.message ?? error}). It is a devDependency (esbuild@^0.28.2); run \`pnpm install\` in ${ROOT}.`,
	);
	process.exit(1);
}
report('0', `esbuild ${esbuild.version} from ${ROOT}`);

const tempDirs = [];

// (a) npm pack: the tarball ships dist/, LICENSE and README.md and no sources.
function stepPack(packDir) {
	const stdout = run('a', NPM, ['pack', '--json', '--pack-destination', packDir], { cwd: ROOT });
	let packed;
	try {
		[packed] = JSON.parse(stdout);
	} catch {
		fail('a', `npm pack --json printed no JSON:\n${stdout}`);
	}
	const files = packed.files.map((file) => file.path);
	const missing = REQUIRED_FILES.filter((path) => !files.includes(path));
	if (missing.length > 0) fail('a', `tarball lacks ${missing.join(', ')} (did pnpm build run?)`);
	const forbidden = files.filter((path) =>
		FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)),
	);
	if (forbidden.length > 0) fail('a', `tarball must not ship ${forbidden.join(', ')}`);
	const tgz = join(packDir, packed.filename);
	if (!existsSync(tgz)) fail('a', `npm pack reported ${packed.filename} but ${tgz} does not exist`);
	report(
		'a',
		`pack: ${packed.filename}, ${files.length} files, ${packed.unpackedSize} bytes unpacked, no src/, clients/, test/ or examples/`,
	);
	return { tgz, version: packed.version };
}

// (b) clean consumer install with --ignore-scripts: the supported no-script install path.
function stepInstall(consumer, tgz, version) {
	writeManifest(consumer, { name: 'bodhi-packed-consumer', private: true, type: 'module' });
	run('b', NPM, ['install', '--ignore-scripts', '--no-audit', '--no-fund', tgz], {
		cwd: consumer,
	});
	const installedManifest = join(consumer, 'node_modules', PACKAGE, 'package.json');
	if (!existsSync(installedManifest)) fail('b', `${installedManifest} is missing after install`);
	const installed = JSON.parse(readFileSync(installedManifest, 'utf8'));
	if (installed.version !== version) {
		fail('b', `installed ${PACKAGE}@${installed.version} but packed ${version}`);
	}
	report('b', `install: ${PACKAGE}@${installed.version} with --ignore-scripts into ${consumer}`);
}

// (c) runtime resolution of the root and the observability subpath from ESM and CJS, and the
// RTC engine load. The engine entry is not exported: a consumer reaches it only through a
// werift_opus DirectRtcClientChannel, whose first rtc.offer loads the engine through the
// package's private #direct-rtc import. The probe's offer is deliberately malformed (it has no
// media section): a loaded engine answers it or rejects it with its own rtc.error, and only a
// failed load produces the engine-unavailable rtc.error.
const ENGINE_UNAVAILABLE = 'RTC audio engine unavailable';
const ENGINE_REPLY_TIMEOUT_MS = 30_000;

function runtimeProbeSource(kind) {
	const load =
		kind === 'esm'
			? (specifier) => `await import('${specifier}')`
			: (specifier) => `require('${specifier}')`;
	return `async function main() {
	const root = ${load(PACKAGE)};
	const observability = ${load(`${PACKAGE}/observability`)};

	let settle;
	const reply = new Promise((resolve) => {
		settle = resolve;
	});
	const channel = root.createClientChannel({
		profile: { kind: 'direct_rtc', rtcAudio: 'werift_opus' },
		clientSender: {
			sendAudio: () => {},
			sendJson: (message) => {
				if (message.type === 'rtc.answer' || message.type === 'rtc.error') settle(message);
			},
		},
		directRtcMedia: { inputPcmSampleRate: 16000, outputPcmSampleRate: 24000, onInboundPcm: () => {} },
		callbacks: {},
	});
	// The lazy engine reports a failed load on console.error; keep those lines for the summary.
	const log = [];
	const consoleError = console.error;
	console.error = (...args) => log.push(args.map(String).join(' '));
	let frame;
	try {
		const timer = setTimeout(() => settle({ type: 'none' }), ${ENGINE_REPLY_TIMEOUT_MS});
		channel.feedSignaling({ type: 'rtc.offer', sdp: 'v=0\\r\\n' });
		frame = await reply;
		clearTimeout(timer);
		await channel.stop();
	} finally {
		console.error = consoleError;
	}

	console.log(JSON.stringify({
		VoiceSession: typeof root.VoiceSession,
		observabilityExports: Object.keys(observability).length,
		directRtcChannel: channel instanceof root.DirectRtcClientChannel,
		rtcReply: frame.type,
		rtcReplyMessage: frame.message ?? null,
		log,
		ClientTransport: typeof root.ClientTransport,
		CLOSE_CODE_CLIENT_BUSY: root.CLOSE_CODE_CLIENT_BUSY ?? null,
		RECONNECT_DEADLINE_MS: root.VoiceSession?.RECONNECT_DEADLINE_MS ?? null,
	}));
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
`;
}

function stepRuntime(consumer) {
	const summaries = [];
	for (const kind of ['esm', 'cjs']) {
		const label = kind === 'esm' ? 'ESM import' : 'CJS require';
		const probe = join(consumer, `runtime-probe.${kind === 'esm' ? 'mjs' : 'cjs'}`);
		writeFileSync(probe, runtimeProbeSource(kind));
		const stdout = run('c', process.execPath, [probe], { cwd: consumer });
		let result;
		try {
			result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
		} catch {
			fail('c', `${label}: probe printed no JSON summary:\n${stdout}`);
		}
		if (result.VoiceSession !== 'function') {
			fail('c', `${label}: typeof VoiceSession is ${result.VoiceSession}, expected function`);
		}
		if (!result.directRtcChannel) {
			fail(
				'c',
				`${label}: createClientChannel with a werift_opus direct_rtc profile did not build a DirectRtcClientChannel`,
			);
		}
		const reply = `${result.rtcReply}${result.rtcReplyMessage ? ` "${result.rtcReplyMessage}"` : ''}`;
		const engineLoaded =
			result.rtcReply === 'rtc.answer' ||
			(result.rtcReply === 'rtc.error' &&
				!String(result.rtcReplyMessage).startsWith(ENGINE_UNAVAILABLE));
		if (!engineLoaded) {
			fail(
				'c',
				`${label}: the werift_opus channel did not load its RTC engine through the private #direct-rtc import; its reply to rtc.offer was ${result.rtcReply === 'none' ? `nothing within ${ENGINE_REPLY_TIMEOUT_MS} ms` : reply}${result.log.length > 0 ? `\n${result.log.join('\n')}` : ''}`,
			);
		}
		if (!skipDeclarations) {
			if (result.ClientTransport !== 'function') {
				fail(
					'c',
					`${label}: typeof ClientTransport is ${result.ClientTransport}, expected function (not root-exported yet; pass --skip-declarations until ClientTransport is exported)`,
				);
			}
			if (result.CLOSE_CODE_CLIENT_BUSY !== 4409) {
				fail(
					'c',
					`${label}: CLOSE_CODE_CLIENT_BUSY is ${result.CLOSE_CODE_CLIENT_BUSY}, expected 4409 (pass --skip-declarations until CLOSE_CODE_CLIENT_BUSY is root-exported)`,
				);
			}
			if (result.RECONNECT_DEADLINE_MS !== 30_000) {
				fail(
					'c',
					`${label}: VoiceSession.RECONNECT_DEADLINE_MS is ${result.RECONNECT_DEADLINE_MS}, expected 30000 (pass --skip-declarations until VoiceSession.RECONNECT_DEADLINE_MS exists)`,
				);
			}
		}
		summaries.push(
			`${label}: VoiceSession function, observability ${result.observabilityExports} exports, werift_opus DirectRtcClientChannel loaded its engine through #direct-rtc (${reply} to the malformed offer)`,
		);
	}
	const exportChecks = skipDeclarations
		? 'ClientTransport, CLOSE_CODE_CLIENT_BUSY and RECONNECT_DEADLINE_MS checks skipped'
		: 'ClientTransport function, CLOSE_CODE_CLIENT_BUSY 4409, RECONNECT_DEADLINE_MS 30000';
	report('c', `runtime: ${summaries.join('; ')}; ${exportChecks}`);
}

// (d) the API probe fixture compiles against the installed declarations in both module modes.
function stepDeclarations(consumer) {
	if (!existsSync(FIXTURE)) fail('d', `${FIXTURE} is missing`);
	const modes = [
		{ name: 'esm', type: 'module', module: 'NodeNext', declaration: 'dist/index.d.ts' },
		{ name: 'cjs', type: 'commonjs', module: 'Node16', declaration: 'dist/index.d.cts' },
	];
	const summaries = [];
	for (const mode of modes) {
		const dir = join(consumer, `types-${mode.name}`);
		mkdirSync(dir);
		writeManifest(dir, {
			name: `bodhi-packed-consumer-${mode.name}`,
			private: true,
			type: mode.type,
		});
		copyFileSync(FIXTURE, join(dir, 'api-probe.ts'));
		const tscArgs = [
			TSC,
			'--noEmit',
			'--skipLibCheck',
			'--strict',
			'--module',
			mode.module,
			'--moduleResolution',
			mode.module,
			'--target',
			'ES2023',
		];
		let stdout;
		try {
			stdout = run('d', process.execPath, [...tscArgs, '--explainFiles', 'api-probe.ts'], {
				cwd: dir,
			});
		} catch (error) {
			if (!(error instanceof StepFailure)) throw error;
			// --explainFiles lists every loaded file, which buries the type errors; compile
			// again without it so the failure reports only the errors.
			run('d', process.execPath, [...tscArgs, 'api-probe.ts'], { cwd: dir });
			throw error;
		}
		const expected = `${PACKAGE}/${mode.declaration}`;
		if (!stdout.includes(expected)) {
			fail(
				'd',
				`--module ${mode.module} inside "type": "${mode.type}" did not load ${expected}:\n${stdout}`,
			);
		}
		summaries.push(
			`--module ${mode.module} ("type": "${mode.type}") compiled api-probe.ts against ${mode.declaration}`,
		);
	}
	report('d', `declarations: ${summaries.join('; ')}`);
}

// (e) bundle the root as a downstream app does: no native or telephony dependency, isolated run.
async function stepBundle(consumer) {
	const entry = join(consumer, 'entry.mts');
	writeFileSync(
		entry,
		`import * as bodhi from '${PACKAGE}';\nconsole.log('VoiceSession', typeof bodhi.VoiceSession);\n`,
	);
	const outfile = join(consumer, 'run', 'out.js');
	try {
		await esbuild.build({
			entryPoints: [entry],
			outfile,
			bundle: true,
			platform: 'node',
			format: 'esm',
			target: 'node22',
			banner: { js: BANNER },
			external: ['bufferutil', 'utf-8-validate'],
			logLevel: 'silent',
		});
	} catch (error) {
		const errors = (error.errors ?? []).map(
			(entry) =>
				`  ${entry.text}${entry.location ? ` (${entry.location.file}:${entry.location.line})` : ''}`,
		);
		fail(
			'e',
			`BUNDLE_FAILED\n${errors.length > 0 ? errors.join('\n') : `  ${error.message ?? error}`}`,
		);
	}
	const text = readFileSync(outfile, 'utf8');
	for (const needle of BUNDLE_MUST_NOT_CONTAIN) {
		if (text.includes(needle)) {
			fail(
				'e',
				`bundle contains ${needle}: the root entry reaches a native or telephony dependency`,
			);
		}
	}
	const isolated = mkdtempSync(join(tmpdir(), 'bodhi-verify-pack-run-'));
	tempDirs.push(isolated);
	for (let dir = isolated; ; dir = dirname(dir)) {
		if (existsSync(join(dir, 'node_modules'))) {
			fail('e', `${dir} contains node_modules, so a run in ${isolated} would not be isolated`);
		}
		if (dirname(dir) === dir) break;
	}
	copyFileSync(outfile, join(isolated, 'out.mjs'));
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => key !== 'NODE_PATH'),
	);
	const out = run('e', process.execPath, ['out.mjs'], { cwd: isolated, env });
	if (!out.includes('VoiceSession function')) fail('e', `RUN_FAILED ${out.trim()}`);
	report('e', `BUNDLE_OK VoiceSession function (${text.length} bytes, ran in ${isolated})`);
}

async function main() {
	const work = mkdtempSync(join(tmpdir(), 'bodhi-verify-pack-'));
	tempDirs.push(work);
	const packDir = join(work, 'pack');
	const consumer = join(work, 'consumer');
	mkdirSync(packDir);
	mkdirSync(consumer);
	const { tgz, version } = stepPack(packDir);
	stepInstall(consumer, tgz, version);
	stepRuntime(consumer);
	if (skipDeclarations) report('d', 'declarations: skipped (--skip-declarations)');
	else stepDeclarations(consumer);
	await stepBundle(consumer);
}

let exitCode = 0;
try {
	await main();
	report(
		'f',
		skipDeclarations
			? 'OK with --skip-declarations: step (d) and the (c) export checks were not run'
			: 'OK: pack, install, runtime, declarations and bundle all passed',
	);
} catch (error) {
	if (error instanceof StepFailure)
		console.error(`verify-pack (${error.step}) FAILED: ${error.message}`);
	else console.error('verify-pack FAILED:', error);
	exitCode = 1;
} finally {
	if (keep) console.log(`verify-pack kept ${tempDirs.join(' ')}`);
	else for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
