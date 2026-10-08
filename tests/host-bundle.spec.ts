/**
 * The built host half may import only what the running Host actually carries.
 *
 * This is a packaging invariant, not a style rule, and it fails loudly at load
 * time when broken: the Loader imports the plugin's entry in-process, so one
 * unresolvable specifier takes the whole host half down. The symptom is not an
 * error in the transcript — the entry simply reports `fiberPhase: failed` and the
 * tool never appears — which is why it needs a test rather than a reviewer.
 *
 * It caught a real one: `@deepseek-ai/dsh-skill` was declared a peer dependency
 * to get its types, the bundler externalised it because of that declaration, and
 * the runtime does not ship it (nor its own peers). Every `inject`, config and
 * skill assertion was correct while the plugin could not load at all.
 *
 * @module dsh-genui/tests/host-bundle
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Packages the Host provides to plugin code in-process. A plugin may import
 * these and nothing else beyond its own relative modules and Node builtins.
 */
const RUNTIME_PROVIDED = [
	'@deepseek-ai/cordis',
	'@deepseek-ai/dsh-tools',
	'@deepseek-ai/schemastery'
]

const bundle = readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8')

/**
 * Every bare module specifier the built entry imports.
 * @param code - the built entry.
 * @returns sorted, deduplicated specifiers, excluding relative and absolute paths.
 */
function externalSpecifiers(code: string): string[] {
	const found = new Set<string>()
	for (const pattern of [/\bfrom\s*"([^"]+)"/gu, /\bimport\s*\(\s*"([^"]+)"/gu]) {
		for (const match of code.matchAll(pattern)) {
			const specifier = match[1]
			if (specifier === undefined || specifier.startsWith('.')) continue
			found.add(specifier)
		}
	}
	return [...found].sort()
}

describe('the built host half', () => {
	it('imports nothing the runtime does not carry', () => {
		const unexpected = externalSpecifiers(bundle)
			.filter(specifier => !specifier.startsWith('node:'))
			.filter(specifier => !RUNTIME_PROVIDED.includes(specifier))
		expect(unexpected, 'these would fail to resolve when the Host imports the entry').toEqual([])
	})

	it('does not reach for the skill package at runtime, which is not shipped', () => {
		// Its types are still imported, but a type erases. A value import here is
		// what took the plugin down once; the fix was to write the one constant out.
		// Asserted on the specifier rather than the substring, because the module
		// doc explains this history and keeps the name in a comment.
		expect(externalSpecifiers(bundle)).not.toContain('@deepseek-ai/dsh-skill')
	})

	it('still ships the dialect contract it registers', () => {
		// The provider reads this file at load; losing it would leave the model
		// without the component inventory the tool description points at.
		expect(bundle).toContain('genui-skill.md')
	})

	it('registers the tool and the skill provider from one apply', () => {
		expect(bundle).toContain('registerProvider')
		expect(bundle).toContain('tools.register')
	})
})
