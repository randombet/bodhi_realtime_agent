import { defineConfig } from 'tsup';

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		// Optional observability subpaths — kept out of the core entry so importing
		// nothing pulls nothing.
		'observability/index': 'src/observability/index.ts',
		'observability/opentelemetry': 'src/observability/opentelemetry.ts',
	},
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
	/** Heavy / platform-specific — consumers install when using `rtcAudio: 'werift_opus'`.
	 *  `@opentelemetry/*` is an optional peer dep of the OTel subpath. */
	external: ['werift', '@evan/opus', /^@opentelemetry\//],
});
