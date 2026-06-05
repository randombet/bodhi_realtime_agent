import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		/** Align test runner with tsx so app TypeScript import specifiers ending in .js resolve to sources. */
		pool: "forks",
		poolOptions: {
			forks: {
				execArgv: ["--import", "tsx/esm"],
			},
		},
		// `examples/test/**` are hermetic (no live keys/network) demo-lib tests;
		// including them here makes the examples regression net part of the single
		// `pnpm test` invocation (modularization plan migration step M3).
		include: ["test/**/*.test.ts", "examples/test/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/__tests__/**"],
		},
	},
});
