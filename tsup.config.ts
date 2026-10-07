import { defineConfig } from 'tsup';

/** Entries published through `exports`; only these get declaration files. */
const publicEntries = {
	index: 'src/index.ts',
	// Optional observability subpaths — kept out of the core entry so importing
	// nothing pulls nothing.
	'observability/index': 'src/observability/index.ts',
	'observability/opentelemetry': 'src/observability/opentelemetry.ts',
};

export default defineConfig({
	entry: {
		...publicEntries,
		// The werift + @evan/opus RTC engine. Internal: reached only through the
		// package's private `#direct-rtc` import, never referenced statically by the
		// root entry (it is loaded on first use), so `bodhi-realtime-agent` bundles
		// without native dependencies.
		'direct-rtc/index': 'src/direct-rtc/index.ts',
	},
	format: ['esm', 'cjs'],
	dts: { entry: publicEntries },
	sourcemap: true,
	clean: true,
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
	/** Heavy / platform-specific — consumers install when using `rtcAudio: 'werift_opus'`.
	 *  `@opentelemetry/*` is an optional peer dep of the OTel subpath. */
	external: ['werift', '@evan/opus', /^@opentelemetry\//],
	/** Workspace-only wire contract (clients/client-protocol) — not published, so bundle it.
	 *  tsconfig.build.json maps it to source so the types are inlined as well. */
	noExternal: ['@bodhi/client-protocol'],
});
