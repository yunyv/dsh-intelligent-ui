import { defineConfig } from 'vitest/config'

/**
 * `vendor/` holds upstream code kept verbatim and never edited here; its suite
 * uses `node:test` and runs through `pnpm run test:vendor`, so vitest must not
 * try to collect it.
 */
export default defineConfig({
	test: {
		exclude: ['**/node_modules/**', '**/lib/**', '**/vendor/**'],
	},
})
