import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		/** Align test runner with tsx so app TypeScript import specifiers ending in .js resolve to sources. */
		pool: 'forks',
		poolOptions: {
			forks: {
				execArgv: ['--import', 'tsx/esm'],
			},
		},
		// `examples/test/**` are hermetic (no live keys/network) demo-lib tests;
		// including them here makes the examples regression net part of the single
		// `pnpm test` invocation (modularization plan migration step M3).
		include: [
			'test/**/*.test.ts',
			'examples/test/**/*.test.ts',
			'composer/test/**/*.test.ts',
			// Composer touches the shared user-agent store (putIfAbsent); its colocated
			// contract tests run here too. Scoped to this dir so the broken wider `app/`
			// tree is not pulled into the suite.
			'app/server/stores/**/*.test.ts',
		],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts', 'src/__tests__/**'],
		},
	},
});
