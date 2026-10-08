/**
 * What the compiler does to each `{@body …}` statement before hoisting it into the
 * render function — matching the captured artifact:
 *
 *   const [tab,setTab] = DIL.useState("overview")
 *     → const [tab,setTab] = DIL.useState("overview",{key:"tab"})
 *   const n = period==="7"?7:12
 *     → const n = __dilSafe(()=>(period==="7"?7:12),undefined)
 *
 * The state variable's name becomes its *semantic key*: the address under which the
 * value is reported to `/dil/view_state` and fed back to the model next turn. Plain
 * declarations get the same per-expression guard as the tree, so one bad derived
 * value degrades to `undefined` instead of killing the render.
 *
 * Ported from `vendor/dil-replica/replica/server/compiler/statements.js` (MIT,
 * Disdjj/intelligent-ui-demo @938ab09) — behaviour unchanged.
 * @module dsh-genui/dil/compiler/statements
 */

import { readBalanced, topLevelIndex } from './scanner.ts'

const USE_STATE_DECL = /^(const|let|var)\s+\[\s*([A-Za-z_$][\w$]*)\s*(?:,\s*[A-Za-z_$][\w$]*\s*)?\]\s*=\s*DIL\.useState\s*\(/
const PLAIN_DECL = /^(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/

/** One `{@body}` may hold several statements; split at top-level `;`. */
export function splitStatements(code: string): string[] {
	const out: string[] = []
	let start = 0
	for (let i = topLevelIndex(code, ';'); i >= 0; i = topLevelIndex(code, ';', start)) {
		out.push(code.slice(start, i))
		start = i + 1
	}
	out.push(code.slice(start))
	return out.map((s) => s.trim()).filter(Boolean)
}

export function rewriteStatement(code: string): string {
	const src = code.trim().replace(/;\s*$/, '')

	const us = USE_STATE_DECL.exec(src)
	if (us) {
		const open = us[0].length - 1
		const args = readBalanced(src, open, '(', ')')
		if (!args.ok || topLevelIndex(args.inner, ',') >= 0) return src // incomplete, or explicit options
		const init = args.inner.trim() || 'undefined'
		return `${src.slice(0, open)}(${init},{key:${JSON.stringify(us[2]!)}})${src.slice(args.end)}`
	}

	const pd = PLAIN_DECL.exec(src)
	if (pd) {
		const rhs = src.slice(pd[0].length).trim()
		if (!rhs || /^DIL\./.test(rhs)) return src // hooks must run unguarded, in order
		if (topLevelIndex(rhs, ',') >= 0 || topLevelIndex(rhs, ';') >= 0) return src // multi-declarator
		return `${pd[1]} ${pd[2]} = __dilSafe(()=>(${rhs}),undefined)`
	}
	// Declarations must stay at function scope; a bare expression statement
	// (`items.sort(...)`, a stray identifier) can throw, so it gets its own guard.
	if (/^(const|let|var|function|async\s+function|class|if|for|while|switch|try|return)\b/.test(src)) return src
	return `try{${src}}catch{}`
}

/** The `useState` keys a list of statements declares, in order. */
export function stateKeysOf(statements: string[]): string[] {
	return statements.map((s) => USE_STATE_DECL.exec(s)).filter(Boolean).map((m) => m![2]!)
}
