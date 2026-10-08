/**
 * tsdown preset for dsh-artifacts-live: an ESM node half with declarations plus
 * a browser half wrapped for the harness client-module loader.
 *
 * The browser half may only `require()` the loader's frozen platform seeds, so
 * every `@deepseek-ai/*` import in `src/client` is type-only (erased) and React
 * is the single runtime require. Keeping that property is what makes the bundle
 * loadable without any cross-plugin value import.
 */
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-artifacts-live'

/** Module specifiers the 0.2.0-rc.2 web shell shares into its frozen module table. */
const PLATFORM_MODULES = [
	'react',
	'react/jsx-runtime',
	'react-dom',
	'react-dom/client',
	'@deepseek-ai/cordis',
	'@deepseek-ai/dsh-client-store',
	'@deepseek-ai/dsh-client-ui-slots',
	'@deepseek-ai/dsh-client-ui-primitives',
	'@deepseek-ai/dsh-client-ui-dockkit'
] as const

export default [
	{
		entry: { index: 'src/index.ts' },
		outDir: 'lib',
		format: ['esm'],
		platform: 'node',
		target: 'es2024',
		fixedExtension: false,
		dts: true,
		clean: true,
		deps: {
			// The Loader validates Config with its own schemastery instance, and the
			// tool registry must be the profile's single instance.
			neverBundle: ['@deepseek-ai/schemastery', '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools']
		}
	},
	{
		// Browser bundle: lib/client.js, served by the harness at /plugins/<id>/client.js.
		entry: { client: 'src/client/index.tsx' },
		outDir: 'lib',
		format: 'cjs',
		platform: 'browser',
		dts: false,
		clean: false,
		deps: { neverBundle: [...PLATFORM_MODULES] },
		define: {
			'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production')
		},
		plugins: [{
			// Bundle purity gate: a value import of any package outside the frozen
			// seeds would emit a require() the loader cannot resolve, so fail the
			// build instead of shipping a browser half that never activates.
			name: 'dsh-client-bundle-purity',
			resolveId(source: string): null {
				if (!source.startsWith('@deepseek-ai/')) return null
				if ((PLATFORM_MODULES as readonly string[]).includes(source)) return null
				throw new Error(
					`client bundle purity: "${source}" is not a platform seed. `
					+ 'Use a type-only import, or reach the capability through a cordis service.'
				)
			}
		}],
		outputOptions: {
			entryFileNames: 'client.js',
			banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
			footer: 'return module.exports; } });',
			intro: 'var module = { exports: {} }; var exports = module.exports;'
		}
	}
] satisfies UserConfig[]
