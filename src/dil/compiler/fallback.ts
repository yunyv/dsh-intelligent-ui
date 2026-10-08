/**
 * The degraded rendering: a static markdown projection of the source, for clients
 * without a sandbox (and for search snippets). Nothing is executed, so dynamic
 * interpolations are dropped and the first branch of every `{#if}` stands in for it.
 *
 * Ported from `vendor/dil-replica/replica/server/compiler/fallback.js` (MIT,
 * Disdjj/intelligent-ui-demo @938ab09) — behaviour unchanged.
 * @module dsh-genui/dil/compiler/fallback
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
		if (node.type !== 'element') continue // expr / stmt carry no static text
		out.push(elementFallback(node, ctx))
	}
	return out.join('').replace(/\n{3,}/g, '\n\n')
}

function elementFallback(node: DilElementNode, ctx: FallbackContext): string {
	const inner = (): string => toFallback(node.children, ctx).trim()
	switch (node.name) {
		case 'title': return `\n\n## ${inner()}\n\n`
		case 'caption': return `\n${inner()}\n`
		case 'badge': return ` ${inner()} `
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
	return md
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => {
			if (!l) return false
			if (/^#{1,6}\s*$/.test(l)) return false
			if (/^#{1,6}\s/.test(l) && !hasWord(l.replace(/^#+\s*/, ''))) return false
			if (l.startsWith('|')) {
				const cells = l.replace(/^\|/, '').replace(/\|$/, '').split('|')
				if (!cells.some(hasWord)) return false
			}
			return hasWord(l) || /^[-*]\s/.test(l) || l === '---'
		})
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
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
