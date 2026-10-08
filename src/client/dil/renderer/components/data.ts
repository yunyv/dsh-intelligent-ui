/** Data display: table / list / progress / stat. */
import type { DilHandle, DilProps } from '../../types.ts'
import { applyCommon, cls, el, length } from '../dom.ts'

export default {
	table(props: DilProps): DilHandle {
		const node = el('div', 'dil-table')
		node.setAttribute('role', 'table')
		return { node, update: (p: DilProps) => applyCommon(node, p) }
	},

	'table-row'(props: DilProps): DilHandle {
		const node = el('div')
		node.setAttribute('role', 'row')
		function update(p: DilProps): void {
			applyCommon(node, p)
			node.className = cls('dil-table-row', [p.header, 'dil-table-header'], [p.onClick, 'dil-clickable'], [p.selected, 'dil-selected'])
		}
		update(props)
		return { node, update }
	},

	'table-cell'(props: DilProps): DilHandle {
		const node = el('div', 'dil-table-cell')
		node.setAttribute('role', 'cell')
		function update(p: DilProps): void {
			applyCommon(node, p)
			node.style.textAlign = p.align === 'end' || p.align === 'right' ? 'right' : p.align === 'center' ? 'center' : ''
			node.style.alignItems = p.align === 'end' || p.align === 'right' ? 'flex-end' : p.align === 'center' ? 'center' : ''
			node.style.flex = p.width ? `0 0 ${length(p.width)}` : ''
		}
		update(props)
		return { node, update }
	},

	list(props: DilProps): DilHandle {
		// the tag (ul/ol) is chosen once; switching marker re-creates the node upstream
		const node = el(props.marker === 'number' ? 'ol' : 'ul')
		function update(p: DilProps): void {
			applyCommon(node, p)
			node.className = cls('dil-list', [p.marker === 'number', 'dil-list-number'], [p.marker === 'none', 'dil-list-none'])
		}
		update(props)
		return { node, update }
	},

	'list-item'(props: DilProps): DilHandle {
		const node = el('li', 'dil-list-item')
		return { node, update: (p: DilProps) => applyCommon(node, p) }
	},

	progress(props: DilProps): DilHandle {
		const wrap = el('div', 'dil-progress')
		const head = el('div', 'dil-progress-head')
		const label = el('span')
		const pct = el('span', 'dil-progress-pct')
		head.append(label, pct)
		const track = el('div', 'dil-progress-track')
		const bar = el('div', 'dil-progress-bar')
		track.append(bar)
		wrap.append(head, track)
		function update(p: DilProps): void {
			applyCommon(wrap, p)
			const max = Number(p.max ?? 100) || 100
			const value = Number(p.value ?? 0)
			const ratio = Math.max(0, Math.min(1, value / max))
			bar.style.width = `${ratio * 100}%`
			const tone = p.color || (ratio > 0.9 ? 'danger' : ratio > 0.7 ? 'warning' : 'accent')
			bar.className = `dil-progress-bar dil-tone-${tone}`
			label.textContent = p.label != null ? String(p.label) : ''
			pct.textContent = p.showValue ? `${Math.round(ratio * 100)}%` : ''
			head.style.display = p.label != null || p.showValue ? '' : 'none'
		}
		update(props)
		return { node: wrap, update }
	}
}
