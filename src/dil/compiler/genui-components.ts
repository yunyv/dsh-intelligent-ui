/**
 * `genui_components` — source spans of widget-channel components, exactly as the
 * captured stream labels them:
 *
 *   {"type":"charts_widget_v2","tree_range":[58,59],"start_index":8021,"end_index":8039}
 *
 * Offsets are Unicode code points, not UTF-16 units (the capture's 8021 is 8024 as a
 * JS string index because of three astral emoji earlier in the document). While a tag
 * is still being written its end is the end of the source so far, so `end_index`
 * grows from patch to patch and `streaming` marks it unfinished.
 *
 * `tree_range` is the element's [pre-order index, +1) among all elements.
 *
 * Ported from `vendor/dil-replica/replica/server/compiler/genui-components.js` (MIT,
 * Disdjj/intelligent-ui-demo @938ab09) — behaviour unchanged.
 * @module dsh-intelligent-ui/dil/compiler/genui-components
 */

import { codePointIndexer } from './scanner.ts'
import { kindOf, widgetType } from './components.ts'
import type { DilNode } from './parser.ts'
import type { DilGenuiComponent } from '../types.ts'

export function genuiComponents(nodes: DilNode[], source: string, resolutionIds: string[]): DilGenuiComponent[] {
	const cp = codePointIndexer(source)
	const out: DilGenuiComponent[] = []
	let index = 0
	let hostSeq = 0

	const visit = (list: DilNode[]): void => {
		for (const n of list) {
			if (n.type === 'if') { n.branches.forEach((b) => visit(b.body)); continue }
			if (n.type === 'each') { visit(n.body); continue }
			if (n.type !== 'element') continue
			const at = index++
			const kind = kindOf(n.name)
			if (kind !== 'intrinsic') {
				const c: DilGenuiComponent = { type: widgetType(n.name), tree_range: [at, at + 1], start_index: cp(n.pos), end_index: cp(n.end) }
				if (kind === 'host') c.component_resolution_id = resolutionIds[hostSeq++]
				if (!n.closed) c.streaming = true
				out.push(c)
			}
			visit(n.children)
		}
	}
	visit(nodes)
	return out
}

/** One JSON-patch-style op over `/message/metadata/genui_components`. */
export interface GenuiPatch {
	/** JSON pointer the op applies to. */
	p: string
	/** `add` | `append` | `replace` | `remove`. */
	o: string
	/** Value carried by the op. */
	v: unknown
}

/**
 * Diff two lists into the patch ops the capture shows: `add` for the first list,
 * `append` for new widgets, `replace …/N/end_index` while a tag is still growing.
 * Widgets never move or disappear mid-stream because the source only ever grows.
 */
export function genuiComponentPatches(prev: DilGenuiComponent[], next: DilGenuiComponent[]): GenuiPatch[] {
	const base = '/message/metadata/genui_components'
	if (!next.length) return []
	if (!prev.length) return [{ p: base, o: 'add', v: next }]
	const out: GenuiPatch[] = []
	for (let i = 0; i < Math.min(prev.length, next.length); i++) {
		const before = prev[i]!
		const after = next[i]!
		if (before.end_index !== after.end_index) {
			out.push({ p: `${base}/${i}/end_index`, o: 'replace', v: after.end_index })
		}
		if (!!before.streaming !== !!after.streaming) {
			out.push({ p: `${base}/${i}/streaming`, o: after.streaming ? 'replace' : 'remove', v: after.streaming })
		}
	}
	if (next.length > prev.length) out.push({ p: base, o: 'append', v: next.slice(prev.length) })
	return out
}
