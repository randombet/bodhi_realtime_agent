import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		// Run tests through tsx so TypeScript `.js` import specifiers resolve to sources.
		pool: 'forks',
		poolOptions: {
			forks: {
				execArgv: ['--import', 'tsx/esm'],
			},
		},
		include: ['*.test.ts'],
	},
});
