/**
 * tsdown preset for dsh-intelligent-ui: an ESM node half with declarations plus
 * a browser half wrapped for the harness client-module loader.
 *
 * The browser half may only `require()` the loader's frozen platform seeds, so
 * every `@deepseek-ai/*` import in `src/client` is type-only (erased) and React
 * is the single runtime require. Keeping that property is what makes the bundle
 * loadable without any cross-plugin value import.
 */
import type { UserConfig } from 'tsdown'
import { readFileSync } from 'node:fs'

/** The one place the id is written down: the client bundle id and the package name must agree. */
const PLUGIN_ID = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name

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

/**
 * Node builtins that must never reach the browser bundle. Bundlers resolve them
 * happily, so without this list a server-only import fails at runtime in the app
 * rather than at build time.
 */
const NODE_BUILTINS = new Set([
	'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
	'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
	'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
	'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers',
	'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'
])

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
			// Bundle purity gate: the browser half may only bundle relative modules
			// and the frozen platform seeds. Anything else — an unlisted npm package
			// or a Node builtin — would either emit a require() the loader cannot
			// resolve or drag a server-only dependency into the browser, so fail the
			// build instead of shipping a browser half that activates and then breaks.
			//
			// Node builtins are the sharp edge here: they resolve fine at build time
			// and only explode in the browser, so they need an explicit check. The
			// compiler is the live example — validate.ts syntax-checks generated code
			// with node:vm, which is why the client may reference its types but must
			// never value-import it.
			name: 'dsh-client-bundle-purity',
			resolveId(source: string, importer?: string): null {
				// No importer means this is an entry, not an import: entries are
				// project-relative paths that rolldown hands over without a `./`.
				if (importer === undefined) return null
				const bare = !source.startsWith('.') && !source.startsWith('/') && !source.startsWith('\0')
				if (!bare) return null
				if ((PLATFORM_MODULES as readonly string[]).includes(source)) return null
				const nodeBuiltin = source.startsWith('node:')
					|| NODE_BUILTINS.has(source)
					|| NODE_BUILTINS.has(source.split('/')[0] ?? '')
				throw new Error(
					nodeBuiltin
						? `client bundle purity: "${source}" is a Node builtin and cannot run in the browser. `
							+ 'Keep the import type-only, or move the capability behind a cordis service.'
						: `client bundle purity: "${source}" is not a platform seed. `
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
