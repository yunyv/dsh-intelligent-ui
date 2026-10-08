/**
 * Repairs for the two mistakes models make most often, applied before codegen.
 * Each one is recorded as a diagnostic so the developer panel shows what was fixed.
 *
 * 1. Undeclared controlled state.
 *      <segmented-control value={usage} onChange={setUsage} options={…}/>
 *    with no `{@body const [usage,setUsage] = DIL.useState(…)}` anywhere. Without a
 *    repair the control is dropped (its props throw). The pair `x` / `setX` is
 *    unambiguous, so declare it, seeding the initial value from the control itself:
 *    the first option, a slider's `min`, an unchecked checkbox, an empty input.
 *
 * 2. Markdown code fences around the whole document (```html … ```). The markup
 *    inside parses fine; the fence lines would render as literal backticks. They are
 *    dropped during markdown lowering (see markdown.js); here we only report them.
 *
 * Ported from `vendor/dil-replica/replica/server/compiler/repair.js` (MIT,
 * Disdjj/intelligent-ui-demo @938ab09) — behaviour unchanged, except that the two
 * seed fallbacks that used to return a raw boolean now stringify it: they are
 * interpolated into generated source, where `true` and `'true'` are the same text.
 * @module dsh-genui/dil/compiler/repair
 */

import { isExpression } from './validate.ts'
import type { DilAttr, DilElementNode, DilExprAttr, DilNode } from './parser.ts'
import type { PendingDiagnostic } from '../types.ts'

const IDENT = /^[A-Za-z_$][\w$]*$/

/** Every identifier a set of statements declares (`const a`, `[a,setA]`, `function f`). */
export function declaredNames(statements: string[]): Set<string> {
	const names = new Set<string>()
	for (const s of statements) {
		let m: RegExpExecArray | null
		const destructure = /^(?:const|let|var)\s+\[([^\]]*)\]/.exec(s)
		if (destructure) destructure[1]!.split(',').map((x) => x.trim()).filter(Boolean).forEach((n) => names.add(n))
		const re = /(?:^|[;\s])(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g
		while ((m = re.exec(s))) names.add(m[1]!)
	}
	return names
}

/** Initial value for a control whose state was never declared. */
function seedFor(node: DilElementNode): string {
	const attr = (name: string): DilAttr | undefined => node.attrs.find((a) => a.name === name)
	const options = attr('options')
	if (options && options.kind === 'expr') {
		try {
			const list: unknown = JSON.parse(options.value)
			if (Array.isArray(list) && list.length) {
				const first: unknown = list[0]
				return JSON.stringify(
					first && typeof first === 'object'
						? (first as Record<string, unknown>).value ?? (first as Record<string, unknown>).label
						: first
				)
			}
		} catch {
			// dynamic options: pick the first at runtime — and the list itself may be
			// undeclared too, so the seed must not throw
			const o = `(${options.value})`
			return `__dilSafe(()=>(${o}[0]?.value ?? ${o}[0]),"")`
		}
	}
	if (node.name === 'checkbox' || node.name === 'switch') return 'false'
	if (node.name === 'slider') {
		const min = attr('min')
		return min ? (min.kind === 'string' ? JSON.stringify(Number(min.value)) : String(min.value)) : '0'
	}
	if (node.name === 'radio-group') {
		const radio = node.children.find((c): c is DilElementNode => c.type === 'element' && c.name === 'radio')
		const v = radio && radio.attrs.find((a) => a.name === 'value')
		if (v) return v.kind === 'string' ? JSON.stringify(v.value) : String(v.value)
	}
	return '""'
}

interface ControlPair {
	name: string
	setter: string
	node: DilElementNode
}

function controlPairs(nodes: DilNode[], out: ControlPair[] = []): ControlPair[] {
	for (const n of nodes) {
		if (n.type === 'if') { n.branches.forEach((b) => controlPairs(b.body, out)); continue }
		if (n.type === 'each') { controlPairs(n.body, out); continue }
		if (n.type !== 'element') continue
		const value = n.attrs.find((a): a is DilExprAttr => (a.name === 'value' || a.name === 'checked') && a.kind === 'expr')
		const change = n.attrs.find((a): a is DilExprAttr => a.name === 'onChange' && a.kind === 'expr')
		if (value && change) {
			const v = value.value.trim()
			const setter = change.value.trim()
			if (IDENT.test(v) && setter === 'set' + v[0]!.toUpperCase() + v.slice(1)) out.push({ name: v, setter, node: n })
		}
		controlPairs(n.children, out)
	}
	return out
}

/** Statements to prepend, and diagnostics describing them. */
export interface RepairResult {
	statements: string[]
	repairs: PendingDiagnostic[]
}

export function repairUndeclaredState(nodes: DilNode[], statements: string[]): RepairResult {
	const declared = declaredNames(statements)
	const added: string[] = []
	const repairs: PendingDiagnostic[] = []
	for (const { name, setter, node } of controlPairs(nodes)) {
		if (declared.has(name) || declared.has(setter)) continue
		declared.add(name)
		declared.add(setter)
		// the control may still be streaming (`options={[{"la`): a seed that does not
		// parse yet starts empty and the next revision keeps the state anyway
		const seed = seedFor(node)
		added.push(`const [${name},${setter}] = DIL.useState(${isExpression(seed) ? seed : '""'})`)
		repairs.push({ code: 'implicit_state', action: 'declared', name, tag: node.name, pos: node.pos })
	}
	return { statements: added, repairs }
}

/** ` ```html ` style fence lines in top-level prose — reported, dropped in lowering. */
export function findFences(nodes: DilNode[]): PendingDiagnostic[] {
	const out: PendingDiagnostic[] = []
	for (const n of nodes) {
		if (n.type !== 'text') continue
		const re = /^[ \t]*```[\w-]*[ \t]*$/gm
		let m: RegExpExecArray | null
		while ((m = re.exec(n.value))) out.push({ code: 'stripped_code_fence', action: 'dropped', pos: n.pos + m.index })
	}
	return out
}
