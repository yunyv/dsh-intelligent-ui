/**
 * Syntax validation of model-written JavaScript fragments.
 *
 * The program is evaluated as one unit (`new Function(program)`), so a single
 * unparsable fragment anywhere — `<code>a := b</code>` read as DIL, an unclosed
 * object literal — fails the *whole* interface on every recompile. Checking each
 * fragment here, and replacing the bad ones with a safe placeholder, turns that
 * into one missing value.
 *
 * Only *compiles* the fragment (vm.Script with a wrapper); nothing is executed.
 *
 * Ported from `vendor/dil-replica/replica/server/compiler/validate.js` (MIT,
 * Disdjj/intelligent-ui-demo @938ab09) — behaviour unchanged.
 * @module dsh-intelligent-ui/dil/compiler/validate
 */

import { Script } from 'node:vm'

const cache = new Map<string, boolean>()
const CACHE_LIMIT = 4000

function parses(wrapped: string): boolean {
	const cached = cache.get(wrapped)
	if (cached !== undefined) return cached
	let ok = true
	try {
		// wrap in a function so `return`, and top-level `await` errors, behave as in the sandbox
		new Script(`(function(){${wrapped}\n})`)
	} catch {
		ok = false
	}
	if (cache.size > CACHE_LIMIT) cache.clear()
	cache.set(wrapped, ok)
	return ok
}

/** An expression usable as `(${code})`. */
export function isExpression(code: string): boolean {
	return parses(`return (${code}\n);`)
}

/** A statement usable inside the render function body. */
export function isStatement(code: string): boolean {
	return parses(`${code}\n;`)
}

/** The finished program, as the sandbox will evaluate it. */
export function isProgram(code: string): boolean {
	return parses(code)
}
