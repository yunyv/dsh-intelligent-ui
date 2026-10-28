/**
 * The degraded rendering: a static markdown projection of the source, for clients
 * without a sandbox (and for search snippets). Nothing is executed, so a dynamic
 * interpolation is printed as the expression that produced it — `n = {n}` rather
 * than `n = ` — and the first branch of every `{#if}` stands in for it.
 *
 * Ported from `vendor/dil-replica/replica/server/compiler/fallback.js` (MIT,
 * Disdjj/intelligent-ui-demo @938ab09), with one deliberate change: upstream drops
 * interpolation nodes entirely, which is invisible when they carry a badge label
 * and unreadable when they sit inside a sentence. Printing the source costs
 * nothing and names what belongs in the gap. Recorded in
 * `tests/dil/parity.spec.ts`.
 * @module dsh-intelligent-ui/dil/compiler/fallback
 */

import type { DilElementNode, DilNode } from './parser.ts'

/** Nesting state for the list projection. */
export interface FallbackContext {
	listDepth: number
}

export function toFallback(nodes: DilNode[], ctx: FallbackContext = { listDepth: 0 }): string {
	const out: string[] = []
	for (const node of nodes) {
		if (node.type === 'text') { out.push(node.value); continue }
		if (node.type === 'if') {
			const first = node.branches[0]
			if (first) out.push(toFallback(first.body, ctx))
			continue
		}
		if (node.type === 'each') { out.push(toFallback(node.body, ctx)); continue }
		// An expression has no value here, but silence leaves a hole in the sentence
		// it sits in. The source is the honest stand-in: it says a value goes here
		// and, for a model re-reading its own projection, which one.
		if (node.type === 'expr') { out.push(`{${node.code}}`); continue }
		if (node.type !== 'element') continue // stmt carries no static text
		out.push(elementFallback(node, ctx))
	}
	// Do not collapse source whitespace here; tidyFallback handles non-code debris.
	return out.join('')
}

function elementFallback(node: DilElementNode, ctx: FallbackContext): string {
	const inner = (): string => toFallback(node.children, ctx).trim()
	switch (node.name) {
		case 'title': return `\n\n## ${inner()}\n\n`
		case 'caption': return `\n${inner()}\n`
		case 'badge': return ` ${inner()} `
		case 'math': {
			// Static previews retain expression source; they never execute it.
			const attr = node.attrs.find((a) => a.name === 'tex')
			if (!attr || attr.kind === 'boolean') return '[math]'
			const source = attr.kind === 'string' ? attr.value : `{${attr.value}}`
			const previewLimit = 8192
			let tex = source.slice(0, previewLimit)
			const last = tex.charCodeAt(tex.length - 1)
			if (tex.length < source.length && last >= 0xd800 && last <= 0xdbff) tex = tex.slice(0, -1)
			if (!tex) return ''
			let longest = 0
			for (const run of tex.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
			const truncated = tex.length < source.length ? `\n[math source preview truncated at ${previewLimit} UTF-16 characters]\n` : ''
			// Multiline code must be a block: inline spans cannot protect blank lines
			// or HTML-looking content across Markdown paragraph boundaries.
			if (/[\r\n]/.test(tex)) {
				const fence = '`'.repeat(Math.max(3, longest + 1))
				return `\n[math]\n${fence}tex\n${tex}\n${fence}\n${truncated}`
			}
			const fence = '`'.repeat(longest + 1)
			return ` [math] ${fence} ${tex} ${fence} ${truncated}`
		}
		case 'button': return ` [${inner()}]`
		case 'divider': return '\n\n---\n\n'
		case 'list': return `\n${toFallback(node.children, ctx)}\n`
		case 'list-item': return `\n${'  '.repeat(ctx.listDepth)}- ${inner()}`
		case 'table-row': return `| ${columnize(node)} |`
		case 'chart':
		case 'pie-chart':
		case 'Chart':
			return '\n[图表：当前环境不支持渲染]\n'
		case 'icon':
			return ''
		case 'select':
		case 'segmented-control': {
			const opts = readOptions(node)
			return opts ? `\n${opts.map((o) => `- ${o.label}`).join('\n')}\n当前所选项不可用。\n` : inner()
		}
		default:
			return inner()
	}
}

/**
 * Projection leaves debris (headings whose content was dynamic, rows of empty cells).
 * Drop lines with no letters or digits, keeping list bullets and rules.
 */
export function tidyFallback(md: string): string {
	const hasWord = (s: string): boolean => /[\p{L}\p{N}]/u.test(s)
	const keep = (line: string): boolean => {
		if (!line || /^#{1,6}\s*$/.test(line)) return false
		if (/^#{1,6}\s/.test(line) && !hasWord(line.replace(/^#+\s*/, ''))) return false
		if (line.startsWith('|')) {
			const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|')
			if (!cells.some(hasWord)) return false
		}
		return hasWord(line) || /^[-*]\s/.test(line) || line === '---'
	}
	const out: string[] = []
	let mathFence = 0
	let afterMathLabel = false
	for (const raw of md.split('\n')) {
		let ticks = 0
		while (raw[ticks] === '`') ticks++
		if (mathFence) {
			if (ticks === mathFence) {
				// The generated delimiter is longer than every run in the source.
				// Parent button/table projections may append their closing syntax.
				out.push('`'.repeat(mathFence))
				mathFence = 0
				const suffix = raw.slice(ticks).trim()
				if (suffix) out.push(suffix)
				afterMathLabel = suffix.includes('[math]')
			} else out.push(raw)
			continue
		}
		const line = raw.trim()
		if (afterMathLabel && ticks >= 3 && raw.slice(ticks) === 'tex') {
			mathFence = ticks
			out.push(raw)
			afterMathLabel = false
			continue
		}
		if (keep(line)) out.push(line)
		afterMathLabel = line.includes('[math]')
	}
	return out.join('\n').trim()
}

function columnize(row: DilElementNode): string {
	return row.children
		.filter((c): c is DilElementNode => c.type === 'element' && c.name === 'table-cell')
		.map((c) => toFallback(c.children, { listDepth: 0 }).trim())
		.join(' | ')
}

/** `options={[…]}` when it is a JSON literal; dynamic options cannot be projected. */
function readOptions(node: DilElementNode): { label: string; value: unknown }[] | null {
	const attr = node.attrs.find((a) => a.name === 'options')
	if (!attr || attr.kind !== 'expr') return null
	try {
		const v: unknown = JSON.parse(attr.value.trim())
		if (Array.isArray(v)) return v.map((o: Record<string, unknown>) => ({ label: String(o.label ?? o.value ?? ''), value: o.value }))
	} catch { /* not JSON */ }
	return null
}
