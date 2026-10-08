/**
 * AST → JavaScript, in the shape of the captured artifact:
 *
 *   - every text run goes to a constant pool, referenced as `__dilConstants["n"]`
 *   - every expression is wrapped in `__dilSafe(() => expr, fallback)`, so one bad
 *     expression degrades locally instead of blanking the whole interface
 *   - elements become `__dil.jsx(tag, props, ...children)`
 *
 * Host components are emitted as a *string* tag plus a `__resolutionId` prop. The real
 * compiler emits a bare identifier and injects the resolved function into the sandbox;
 * the replica lets the host renderer resolve the name instead. Same fallback
 * behaviour, far less machinery.
 *
 * Ported from `vendor/dil-replica/replica/server/compiler/codegen.js` (MIT,
 * Disdjj/intelligent-ui-demo @938ab09) — behaviour unchanged.
 * @module dsh-genui/dil/compiler/codegen
 */

import { SHIMS, kindOf, resolutionId, type ComponentKind } from './components.ts'
import type { DilAttr, DilElementNode, DilIfNode, DilNode } from './parser.ts'
import { isExpression } from './validate.ts'
import type { DilComponentResolution, PendingDiagnostic } from '../types.ts'

/** What one `generate()` pass produced. */
export interface GeneratedProgram {
	/** The render function's `return …` expression. */
	tree: string
	/** Text constant pool, referenced as `__dilConstants["n"]`. */
	constants: Record<string, unknown>
	/** PascalCase host tags, in occurrence order. */
	components: string[]
	/** Sources of the shims the tree calls, in first-use order. */
	shimSources: string[]
	/** `appData.opGenui.componentResults`, keyed by `__resolutionId`. */
	resolutions: Record<string, DilComponentResolution>
	/** Fragments replaced because they do not parse. */
	invalid: PendingDiagnostic[]
}

/** A JSON-parseable object/array literal can go to the constant pool (no eval). */
function hoistable(expr: string): boolean {
	const t = expr.trim()
	if (t.length < 24 || !(t.startsWith('[') || t.startsWith('{'))) return false
	try {
		const v: unknown = JSON.parse(t)
		return v != null && typeof v === 'object'
	} catch {
		return false
	}
}

export function createGenerator(): { generate(nodes: DilNode[]): GeneratedProgram } {
	const invalid: PendingDiagnostic[] = []
	/** The expression itself, or `fallback` if it is not valid JavaScript. */
	const expr = (code: string, pos: number | undefined, fallback = 'undefined'): string => {
		if (isExpression(code)) return code
		invalid.push({ code: 'invalid_expression', action: 'replaced', pos: pos ?? 0, snippet: code.slice(0, 80) })
		return fallback
	}
	const constants: Record<string, unknown> = {}
	let constSeq = 0
	const components = new Set<string>()
	const shims = new Set<string>()
	const resolutions: Record<string, DilComponentResolution> = {}
	let hostSeq = 0

	const constant = (value: unknown): string => {
		const key = String(constSeq++)
		constants[key] = value
		return `__dilConstants[${JSON.stringify(key)}]`
	}

	const gen = (node: DilNode): string => {
		switch (node.type) {
			case 'text':
				return constant(node.value)
			case 'expr':
				return `__dilSafe(()=>(${expr(node.code, node.pos, 'null')}),null)`
			case 'if':
				return genIf(node)
			case 'each': {
				// the list is guarded too: a missing array must not take the tree down
				const body = genBranch(node.body)
				const list = expr(node.list, node.pos, '[]')
				const item = /^[A-Za-z_$][\w$]*$|^[[{][\s\S]*[\]}]$/.test(node.item.trim()) ? node.item : 'item'
				return `__dilSafe(()=>((${list}).map((${item})=>__dilSafe(()=>(${body}),null))),null)`
			}
			case 'element':
				return genElement(node)
			default:
				return '' // `stmt` is hoisted, not part of the tree
		}
	}

	const genIf = (node: DilIfNode): string => {
		let out = 'null'
		for (let i = node.branches.length - 1; i >= 0; i--) {
			const b = node.branches[i]!
			const body = genBranch(b.body)
			out = b.cond == null ? body : `(__dilSafe(()=>(${expr(b.cond, node.pos, 'false')}),false))?${body}:${out}`
		}
		return out
	}

	const genBranch = (nodes: DilNode[]): string => {
		const kids = nodes.map(gen).filter(Boolean)
		if (!kids.length) return 'null'
		if (kids.length === 1) return kids[0]!
		return `__dil.jsx(__dil.Fragment,null,${kids.join(',')})`
	}

	/** Can evaluating this attribute throw? JSON literals (`{3}`, `{true}`, `{[…]}`) cannot. */
	const isDynamic = (attr: DilAttr): boolean => {
		if (attr.kind !== 'expr' && attr.kind !== 'raw') return false
		try {
			JSON.parse(attr.value.trim())
			return false
		} catch {
			return true
		}
	}

	const genProp = (attr: DilAttr, kind: ComponentKind): string => {
		const key = JSON.stringify(attr.name)
		switch (attr.kind) {
			case 'boolean':
				return `${key}:true`
			case 'string':
				return `${key}:${JSON.stringify(attr.value)}`
			case 'raw':
				return `${key}:${expr(attr.value, attr.pos)}`
			default: {
				const value = expr(attr.value.trim() || 'undefined', attr.pos)
				// shim props are evaluated eagerly inside the shim, so guard them like the artifact
				if (kind === 'shim') return `${key}:__dilSafe(()=>(${value}),void 0)`
				return `${key}:${hoistable(value) ? constant(JSON.parse(value)) : value}`
			}
		}
	}

	const genElement = (node: DilElementNode): string => {
		const kind = kindOf(node.name)
		const props: string[] = []
		if (kind === 'shim') shims.add(node.name)
		if (kind === 'host') {
			components.add(node.name)
			const id = resolutionId(node.name, hostSeq++)
			resolutions[id] = { status: 'resolved', state: {}, componentName: node.name }
			props.push(`"__resolutionId":${constant(id)}`)
		}
		for (const a of node.attrs) props.push(genProp(a, kind))

		const tag = kind === 'shim' ? SHIMS[node.name]!.fn : JSON.stringify(node.name)
		// The element is the unit of degradation (as in the artifact): it is guarded when
		// anything it evaluates *itself* can throw — a dynamic prop, or an expression
		// child — and those direct expression children are then inlined bare. A failure
		// removes this one element; siblings and ancestors still render.
		const guarded = kind !== 'intrinsic' || node.attrs.some(isDynamic) || node.children.some((c) => c.type === 'expr')
		const kids = node.children
			.map((c) => (guarded && c.type === 'expr' ? `(${expr(c.code, c.pos, 'null')})` : gen(c)))
			.filter(Boolean)
		const call = `__dil.jsx(${[tag, props.length ? `{${props.join(',')}}` : 'null', ...kids].join(',')})`
		return guarded ? `__dilSafe(()=>(${call}),null)` : call
	}

	return {
		generate(nodes: DilNode[]): GeneratedProgram {
			return {
				tree: genBranch(nodes),
				constants,
				components: [...components],
				shimSources: [...shims].map((name) => SHIMS[name]!.source),
				resolutions,
				invalid
			}
		}
	}
}
