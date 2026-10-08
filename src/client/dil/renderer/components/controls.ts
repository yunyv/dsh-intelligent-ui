/**
 * Controls. All are *controlled*: the value shown is always the prop the sandbox
 * sent, and user input travels to the sandbox as a handler call. Nothing is kept
 * locally except what prevents the caret from jumping while the user types.
 * @module dsh-genui/client/dil/renderer/components/controls
 */

import type { DilElement, DilHandle, DilProps } from '../../types.ts'
import { activeElement, applyCommon, cls, el, normalizeOptions, type DilOption } from '../dom.ts'
import { iconSvg } from '../icons.ts'

interface RadioItem {
	node: DilElement
	input: HTMLInputElement
	body: HTMLSpanElement
}

function radioItem(name: string, value: unknown): RadioItem {
	const node = el('label', 'dil-radio') as DilElement
	const input = el('input')
	input.type = 'radio'
	input.name = name
	const dot = el('span', 'dil-radio-dot')
	const body = el('span', 'dil-radio-body')
	node.append(input, dot, body)
	node.dilValue = value
	return { node, input, body }
}

function syncRadio(item: Element, group: DilElement): void {
	const on = String((item as DilElement).dilValue) === group.dataset.value
	const input = item.querySelector('input')
	if (input && input.checked !== on) input.checked = on
	item.classList.toggle('dil-checked', on)
}

/** Set a value without fighting the user: skip while this element has focus. */
function syncValue(input: HTMLInputElement | HTMLTextAreaElement, next: string): void {
	if (activeElement() === input) return
	if (input.value !== next) input.value = next
}

const controls = {
	button(props: DilProps): DilHandle {
		const node = el('button')
		node.type = 'button'
		function update(p: DilProps): void {
			applyCommon(node, p)
			node.className = cls(
				'dil-button',
				[true, `dil-variant-${p.variant || 'solid'}`],
				[p.color, `dil-tone-${p.color}`],
				[p.size, `dil-size-${p.size}`],
				[p.block, 'dil-block']
			)
			node.disabled = !!p.disabled
		}
		update(props)
		return { node, update }
	},

	input(props: DilProps): DilHandle {
		const node = el('input', 'dil-input')
		function update(p: DilProps): void {
			applyCommon(node, p)
			node.type = ['number', 'email', 'search', 'date', 'time'].includes(p.type) ? p.type : 'text'
			node.placeholder = p.placeholder || ''
			node.disabled = !!p.disabled
			syncValue(node, p.value == null ? '' : String(p.value))
		}
		update(props)
		return { node, update, readValue: () => (node.type === 'number' ? Number(node.value) : node.value) }
	},

	textarea(props: DilProps): DilHandle {
		const node = el('textarea', 'dil-input dil-textarea')
		function update(p: DilProps): void {
			applyCommon(node, p)
			node.placeholder = p.placeholder || ''
			node.rows = Number(p.rows) || 3
			node.disabled = !!p.disabled
			syncValue(node, p.value == null ? '' : String(p.value))
		}
		update(props)
		return { node, update }
	},

	checkbox(props: DilProps): DilHandle {
		const wrap = el('label', 'dil-checkbox')
		const input = el('input')
		input.type = 'checkbox'
		const box = el('span', 'dil-checkbox-box')
		box.innerHTML = iconSvg('check', 12)
		const body = el('span', 'dil-checkbox-body')
		const fallbackLabel = el('span')
		wrap.append(input, box, body)
		function update(p: DilProps): void {
			applyCommon(wrap, p)
			// `checked` is the dialect; `value` is a common model slip — accept both
			const on = !!(p.checked !== undefined ? p.checked : p.value)
			input.checked = on
			input.disabled = !!p.disabled
			wrap.className = cls('dil-checkbox', [on, 'dil-checked'], [p.disabled, 'dil-disabled'], [p.lineThrough && on, 'dil-done'])
			// children are the label; a `label` prop is accepted too
			if (p.label != null) {
				fallbackLabel.textContent = String(p.label)
				if (!fallbackLabel.parentNode) body.append(fallbackLabel)
			} else fallbackLabel.remove()
		}
		update(props)
		return { node: wrap, childHost: body, update, events: { change: 'onChange' }, readValue: () => input.checked }
	},

	switch(props: DilProps): DilHandle {
		const made = controls.checkbox(props)
		const update = made.update
		made.update = (p: DilProps): void => {
			update(p)
			made.node.classList.add('dil-switch')
		}
		made.update(props)
		return made
	},

	select(props: DilProps): DilHandle {
		const wrap = el('div', 'dil-select')
		const node = el('select')
		const chevron = el('span', 'dil-select-chevron')
		chevron.innerHTML = iconSvg('chevron-down', 14)
		wrap.append(node, chevron)
		let sig: string | null = null
		let options: DilOption[] = []
		function update(p: DilProps): void {
			applyCommon(wrap, p)
			options = normalizeOptions(p.options)
			const next = JSON.stringify(options)
			if (next !== sig) {
				sig = next
				node.textContent = ''
				for (const option of options) {
					const item = el('option')
					item.value = String(option.value)
					item.textContent = option.label
					node.append(item)
				}
			}
			node.disabled = !!p.disabled
			// select via the option: works everywhere, including DOM shims where
			// `HTMLSelectElement.value` is getter-only
			const value = String(p.value ?? '')
			for (const option of Array.from(node.options)) {
				if (option.selected !== (option.value === value)) option.selected = option.value === value
			}
		}
		update(props)
		// hand back the original (possibly non-string) option value
		const readValue = (): unknown => (options.find((option) => String(option.value) === node.value) ?? { value: node.value }).value
		return { node: wrap, update, events: { change: 'onChange' }, readValue }
	},

	'segmented-control'(props: DilProps): DilHandle {
		const node = el('div')
		let sig: string | null = null
		let options: DilOption[] = []
		function update(p: DilProps): void {
			applyCommon(node, p)
			node.className = cls('dil-segmented', [p.block, 'dil-block'], [p.size, `dil-size-${p.size}`])
			options = normalizeOptions(p.options)
			const next = JSON.stringify(options)
			if (next !== sig) {
				sig = next
				node.textContent = ''
				options.forEach((option, index) => {
					const button = el('button', 'dil-segmented-item')
					button.type = 'button'
					button.textContent = option.label
					button.dataset.index = String(index)
					node.append(button)
				})
			}
			const value = String(p.value ?? '')
			Array.from(node.querySelectorAll('.dil-segmented-item')).forEach((element, index) => {
				const button = element as HTMLButtonElement
				const active = options[index] && String(options[index]!.value) === value
				button.classList.toggle('dil-active', !!active)
				button.setAttribute('aria-pressed', active ? 'true' : 'false')
				button.disabled = !!p.disabled
			})
		}
		update(props)
		const readValue = (event: Event): unknown => {
			const target = event.target as Element | null
			const button = target && typeof target.closest === 'function' ? target.closest('.dil-segmented-item') : null
			if (!button) return undefined
			return options[Number((button as HTMLElement).dataset.index)]?.value
		}
		return { node, update, events: { click: 'onChange' }, readValue }
	},

	/**
	 * Two dialects:
	 *   options  `<radio-group options={[…]} value onChange/>`
	 *   children `<radio-group value onChange><radio value="a">…</radio></radio-group>`
	 *            (the captured artifact's form; each <radio> renders itself below)
	 * Both end up as `.dil-radio` items with a real radio input, so one `change`
	 * listener on the group reads the chosen item's original value.
	 */
	'radio-group'(props: DilProps): DilHandle {
		const node = el('div', 'dil-radio-group') as DilElement
		node.dataset.name = 'dil-radio-' + Math.random().toString(36).slice(2, 8)
		const items = el('div', 'dil-radio-items')
		const children = el('div', 'dil-radio-items')
		node.append(items, children)
		let sig: string | null = null
		function update(p: DilProps): void {
			applyCommon(node, p)
			node.classList.toggle('dil-row', p.direction === 'row')
			// children read this during their own update, which runs right after ours
			node.dataset.value = String(p.value ?? '')
			node.dilValue = p.value
			const options = normalizeOptions(p.options)
			const next = JSON.stringify(options)
			if (next !== sig) {
				sig = next
				items.textContent = ''
				for (const option of options) {
					const item = radioItem(node.dataset.name!, option.value)
					item.body.textContent = option.label
					items.append(item.node)
				}
			}
			for (const item of Array.from(items.children)) syncRadio(item, node)
		}
		update(props)
		const readValue = (event: Event): unknown => {
			const target = event.target as DilElement | null
			return target && typeof target.closest === 'function' ? (target.closest('.dil-radio') as DilElement | null)?.dilValue : undefined
		}
		return { node, childHost: children, update, events: { change: 'onChange' }, readValue }
	},

	radio(props: DilProps): DilHandle {
		const item = radioItem('', props.value)
		function update(p: DilProps): void {
			applyCommon(item.node, p)
			item.node.dilValue = p.value
			const group = (typeof item.node.closest === 'function' ? item.node.closest('.dil-radio-group') : null) as DilElement | null
			if (group) {
				item.input.name = group.dataset.name!
				syncRadio(item.node, group)
			} else {
				// standalone: `checked` like a checkbox
				item.input.checked = !!p.checked
				item.node.classList.toggle('dil-checked', !!p.checked)
			}
			item.input.disabled = !!p.disabled
		}
		update(props)
		return { node: item.node, childHost: item.body, update }
	},

	slider(props: DilProps): DilHandle {
		const wrap = el('div', 'dil-slider')
		const head = el('div', 'dil-slider-head')
		const label = el('span', 'dil-slider-label')
		const value = el('span', 'dil-slider-value')
		head.append(label, value)
		const input = el('input')
		input.type = 'range'
		wrap.append(head, input)
		function update(p: DilProps): void {
			applyCommon(wrap, p)
			const min = Number(p.min ?? 0)
			const max = Number(p.max ?? 100)
			const current = Number(p.value ?? min)
			input.min = String(min)
			input.max = String(max)
			input.step = String(p.step ?? 1)
			input.disabled = !!p.disabled
			if (activeElement() !== input && Number(input.value) !== current) input.value = String(current)
			// filled track: CSS reads the percentage
			wrap.style.setProperty('--fill', `${max > min ? ((current - min) / (max - min)) * 100 : 0}%`)
			label.textContent = p.label != null ? String(p.label) : ''
			value.textContent = p.showValue === false ? '' : String(current)
			head.style.display = p.label != null ? '' : 'none'
		}
		update(props)
		return { node: wrap, update, events: { input: 'onChange' }, readValue: () => Number(input.value) }
	}
}

export default controls
