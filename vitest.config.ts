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
		include: ["test/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/__tests__/**"],
		},
	},
});
