/**
 * Markdown lowering — prose text runs → DIL elements, as the real compiler does:
 *
 *   ## 标题                 → <title size="lg">
 *   段落 **粗体** 文字       → <text>段落 <bold>粗体</bold> 文字</text>
 *   1. 第一项 / - 一项      → <list marker="number"> <list-item><text>…</text></list-item>
 *   `code`                 → <code>
 *
 * (Captured evidence: `## 这个示例体现了什么？` compiles to `__dil.jsx("title",
 * {"size":"lg"},…)` and `**收入渠道结构**` to `__dil.jsx("text",null,__dil.jsx("bold",…))`.)
 *
 * Only text that sits *between* blocks is lowered; text inside a component is left
 * as-is except for inline `**bold**`. Lowering happens on the AST, after parsing, so
 * the parser and its diagnostics are untouched.
 *
 * Ported from `vendor/dil-replica/replica/server/compiler/markdown.js` (MIT,
 * Disdjj/intelligent-ui-demo @938ab09) — behaviour unchanged.
 * @module dsh-intelligent-ui/dil/compiler/markdown
 */

import type { DilAttr, DilElementNode, DilNode, DilTextNode } from './parser.ts'

const HEADING = /^(#{1,6})\s+(.*)$/
const ORDERED = /^\d+[.)]\s+(.*)$/
const BULLET = /^[-*+]\s+(.*)$/
const RULE = /^(-{3,}|\*{3,}|_{3,})$/
const FENCE = /^```[\w-]*$/

/** Inline markdown → array of text nodes and `bold` / `code` elements. */
export function inline(text: string, pos: number): DilNode[] {
	const out: DilNode[] = []
	const re = /\*\*([^*]+)\*\*|`([^`]+)`/g
	let last = 0
	let m: RegExpExecArray | null
	while ((m = re.exec(text))) {
		if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index), pos })
		const name = m[1] != null ? 'bold' : 'code'
		out.push(el(name, [{ type: 'text', value: m[1] != null ? m[1] : m[2]!, pos }], pos))
		last = re.lastIndex
	}
	if (last < text.length) out.push({ type: 'text', value: text.slice(last), pos })
	return out
}

function el(name: string, children: DilNode[], pos: number, attrs: DilAttr[] = []): DilElementNode {
	return { type: 'element', name, attrs, children, pos, end: pos, closed: true, synthetic: true }
}

const attr = (name: string, value: string): DilAttr => ({ name, kind: 'string', value })

/**
 * Lower one prose text run into block elements. Consecutive non-blank lines form a
 * paragraph; list items group into one list; headings and rules stand alone.
 */
function lowerBlock(text: string, pos: number): DilNode[] {
	const out: DilNode[] = []
	let para: string[] = []
	let list: { marker: string; node: DilElementNode } | null = null

	const flushPara = (): void => {
		if (para.length) out.push(el('text', inline(para.join(' '), pos), pos))
		para = []
	}
	const flushList = (): void => {
		if (list) out.push(list.node)
		list = null
	}

	for (const raw of text.split('\n')) {
		const line = raw.trim()
		if (!line) { flushPara(); flushList(); continue }
		if (FENCE.test(line)) { flushPara(); flushList(); continue } // ```html around the markup

		const heading = HEADING.exec(line)
		const ordered = heading ? null : ORDERED.exec(line)
		const bullet = heading || ordered ? null : BULLET.exec(line)
		if (heading) {
			flushPara(); flushList()
			const size = heading[1]!.length <= 2 ? 'lg' : 'md'
			out.push(el('title', inline(heading[2]!, pos), pos, [attr('size', size)]))
		} else if (RULE.test(line)) {
			flushPara(); flushList()
			out.push(el('divider', [], pos))
		} else if (ordered || bullet) {
			flushPara()
			const marker = ordered ? 'number' : 'bullet'
			if (!list || list.marker !== marker) {
				flushList()
				list = { marker, node: el('list', [], pos, marker === 'number' ? [attr('marker', 'number')] : []) }
			}
			list.node.children.push(el('list-item', [el('text', inline((ordered ?? bullet)![1]!, pos), pos)], pos))
		} else {
			flushList()
			para.push(line)
		}
	}
	flushPara()
	flushList()
	return out
}

/**
 * Walk the AST.
 *
 *   document level  (root, and if/each bodies at root) — prose becomes blocks
 *   inside elements — only inline `**bold**` / `code` is lowered, and only when the
 *                     run has block syntax on its own lines is it split into blocks.
 *                     Wrapping every run would break `count: {n}`, whose text and
 *                     expression must stay one flow inside a flex container.
 */
export function lowerMarkdown(nodes: DilNode[], { document = true }: { document?: boolean } = {}): DilNode[] {
	if (document) return lowerDocument(nodes)
	const out: DilNode[] = []
	for (const n of nodes) {
		if (n.type === 'text') {
			if (n.raw || !/\S/.test(n.value)) out.push(n)
			else if (hasBlockSyntax(n.value)) out.push(...lowerBlock(n.value, n.pos))
			else out.push(...inline(n.value, n.pos))
		} else {
			out.push(lowerChildren(n, false))
		}
	}
	return out
}

/**
 * At document level, a paragraph can be several AST nodes: `本月 {n} 次` is text +
 * expr + text. Gather each run of inline nodes up to a blank line or a block node,
 * lower the text parts, and keep the expressions in place inside one `<text>`.
 */
function lowerDocument(nodes: DilNode[]): DilNode[] {
	const out: DilNode[] = []
	let run: DilNode[] = []

	const flushRun = (): void => {
		if (!run.length) return
		const hasExpr = run.some((n) => n.type === 'expr')
		if (!hasExpr) {
			// pure prose: full block lowering on the concatenated text
			out.push(...lowerBlock(run.map((n) => (n.type === 'text' ? n.value : '')).join(''), run[0]!.pos))
		} else {
			const parts: DilNode[] = []
			for (const n of run) parts.push(...(n.type === 'text' ? inline(n.value.replace(/\s*\n\s*/g, ' '), n.pos) : [n]))
			out.push(el('text', parts, run[0]!.pos))
		}
		run = []
	}

	for (const n of nodes) {
		if (n.type === 'expr') { run.push(n); continue }
		if (n.type === 'text') {
			// a blank line ends the paragraph; split the text there
			const pieces = n.value.split(/\n\s*\n/)
			pieces.forEach((piece, i) => {
				if (i > 0) flushRun()
				if (hasBlockSyntax(piece)) { flushRun(); out.push(...lowerBlock(piece, n.pos)); return }
				if (/\S/.test(piece)) run.push({ ...n, value: piece } as DilTextNode)
			})
			continue
		}
		flushRun()
		out.push(lowerChildren(n, true))
	}
	flushRun()
	return out
}

function lowerChildren(n: DilNode, document: boolean): DilNode {
	if (n.type === 'if') return { ...n, branches: n.branches.map((b) => ({ ...b, body: lowerMarkdown(b.body, { document }) })) }
	if (n.type === 'each') return { ...n, body: lowerMarkdown(n.body, { document }) }
	if (n.type === 'element' && !n.synthetic) return { ...n, children: lowerMarkdown(n.children, { document: false }) }
	return n
}

/** A line that is a heading, list item or rule on its own. */
function hasBlockSyntax(value: string): boolean {
	return value.split('\n').some((l) => {
		const t = l.trim()
		return HEADING.test(t) || ORDERED.test(t) || BULLET.test(t)
	})
}
