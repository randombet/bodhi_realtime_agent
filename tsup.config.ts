import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm", "cjs"],
	dts: true,
	sourcemap: true,
	clean: true,
	outDir: "dist",
	tsconfig: "tsconfig.build.json",
	/** Heavy / platform-specific — consumers install when using `rtcAudio: 'werift_opus'`. */
	external: ["werift", "@evan/opus"],
});
