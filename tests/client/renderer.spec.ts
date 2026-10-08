// @vitest-environment jsdom
/**
 * The tree → DOM renderer.
 *
 * What matters here is not that markup appears, but that a *second* revision patches
 * the first one instead of replacing it: node identity is what keeps an `<input>`'s
 * caret, a checkbox's focus and a chart's measured width across a stream of revisions.
 * The rest of the file pins the vocabulary (tags, classes, host components), the event
 * round trip, and the two shadow-root behaviours the port had to change.
 */
import { describe, expect, it } from 'vitest'
import { activeElement, el as makeElement } from '../../src/client/dil/renderer/dom.ts'
import { mount } from '../../src/client/dil/renderer/index.ts'
import { fmtNumber, niceTicks } from '../../src/client/dil/renderer/components/charts.ts'
import type { DilNode } from '../../src/client/dil/types.ts'

/** A fresh `.dil-root` container, as the stylesheet expects. */
function container(): HTMLElement {
	document.body.innerHTML = ''
	const node = document.createElement('div')
	node.className = 'dil-root'
	document.body.appendChild(node)
	return node
}

/** The text of the first match, for compact assertions. */
function textOf(root: ParentNode, selector: string): string | null {
	return root.querySelector(selector)?.textContent ?? null
}

const CARD: DilNode = {
	t: '#frag',
	c: [
		{
			t: 'card',
			p: {},
			c: [
				{ t: 'title', p: { size: 'lg' }, c: [{ t: '#text', v: 'Hello' }] },
				{
					t: 'row',
					p: { gap: 2, justify: 'space-between' },
					c: [
						{ t: 'text', p: {}, c: [{ t: '#text', v: 'left' }] },
						{ t: 'badge', p: { color: 'success' }, c: [{ t: '#text', v: 'ok' }] }
					]
				},
				{ t: 'button', p: { onClick: { __dilFn: 'fn1' }, variant: 'outline' }, c: [{ t: '#text', v: 'Go' }] }
			]
		}
	]
}

describe('mounting a tree', () => {
	it('renders the vocabulary with its markers and classes', () => {
		const root = container()
		mount(root, CARD)
		expect(root.getAttribute('data-dil-ready')).toBe('true')
		expect(root.querySelector('[data-d-component="card"]')).not.toBeNull()
		expect(textOf(root, '.dil-title-lg')).toBe('Hello')
		expect(root.querySelector('.dil-row')?.getAttribute('style')).toContain('gap: 8px')
		expect(textOf(root, '.dil-badge-success')).toBe('ok')
		expect(root.querySelector('button')?.className).toContain('dil-variant-outline')
		// The fragment wrapper is flattened away: the card is the only child.
		expect(root.children).toHaveLength(1)
	})

	it('renders nothing for a null tree and keeps the marker', () => {
		const root = container()
		const view = mount(root, null)
		expect(root.children).toHaveLength(0)
		view.update(null)
		expect(root.children).toHaveLength(0)
	})

	it('turns data components into their real widgets', () => {
		const root = container()
		const tree: DilNode = {
			t: 'box',
			p: { gap: 2 },
			c: [
				{ t: 'progress', p: { value: 50, max: 100, showValue: true, label: 'half' }, c: [] },
				{ t: 'icon', p: { name: 'layers-3', size: 'lg' }, c: [] },
				{ t: 'spinner', p: {}, c: [] },
				{ t: 'list', p: { marker: 'number' }, c: [{ t: 'list-item', p: {}, c: [{ t: '#text', v: 'one' }] }] },
				{
					t: 'table',
					p: {},
					c: [
						{ t: 'table-row', p: { header: true }, c: [{ t: 'table-cell', p: {}, c: [{ t: '#text', v: 'h' }] }] }
					]
				}
			]
		}
		mount(root, tree)
		expect(root.querySelector('.dil-progress-bar')?.getAttribute('style')).toContain('width: 50%')
		expect(textOf(root, '.dil-progress-pct')).toBe('50%')
		expect(root.querySelector('.dil-icon svg')).not.toBeNull()
		expect(root.querySelector('.dil-spinner svg')).not.toBeNull()
		expect(root.querySelector('ol.dil-list-number')).not.toBeNull()
		expect(root.querySelector('.dil-table-header')).not.toBeNull()
	})

	it('renders charts as inline SVG, with no library and no asset request', () => {
		const root = container()
		mount(root, {
			t: 'box',
			p: {},
			c: [
				{ t: 'chart', p: { type: 'bar', height: 200, data: [{ label: 'a', value: 3 }, { label: 'b', value: 9 }] }, c: [] },
				{ t: 'pie-chart', p: { data: [{ label: 'a', value: 1 }, { label: 'b', value: 3 }] }, c: [] }
			]
		})
		const chart = root.querySelector('[data-d-component="chart"]')
		expect(chart?.innerHTML).toContain('<svg')
		expect(chart?.querySelectorAll('.dil-chart-bar')).toHaveLength(2)
		expect(chart?.querySelector('.dil-chart-axis')).not.toBeNull()
		expect(root.querySelectorAll('.dil-chart-slice')).toHaveLength(2)
		expect(root.innerHTML).not.toContain('<img')
	})

	it('formats axis ticks and numbers the way the upstream dialect was read', () => {
		expect(niceTicks(0, 10)).toEqual([0, 2.5, 5, 7.5, 10])
		expect(niceTicks(4, 4)).toEqual([4, 4.25, 4.5, 4.75, 5])
		expect(fmtNumber(12345)).toBe('1.2万')
		expect(fmtNumber(2.5)).toBe('2.5')
	})
})

describe('patching a second revision', () => {
	it('keeps node identity when only the text changed', () => {
		const root = container()
		const view = mount(root, { t: 'card', p: {}, c: [{ t: 'text', p: {}, c: [{ t: '#text', v: 'one' }] }] })
		const card = root.firstElementChild
		view.update({ t: 'card', p: {}, c: [{ t: 'text', p: {}, c: [{ t: '#text', v: 'two' }] }] })
		expect(root.firstElementChild).toBe(card)
		expect(textOf(root, '.dil-text')).toBe('two')
	})

	it('keeps the caret of a focused input across a revision', () => {
		const root = container()
		const view = mount(root, { t: 'input', p: { value: 'typed' } })
		const input = root.querySelector('input')!
		input.focus()
		expect(activeElement()).toBe(input)
		view.update({ t: 'input', p: { value: 'model revision' } })
		expect(root.querySelector('input')).toBe(input)
		expect(input.value).toBe('typed')
		// Once it is no longer focused, the model's value wins again.
		input.blur()
		view.update({ t: 'input', p: { value: 'model revision' } })
		expect(input.value).toBe('model revision')
	})

	it('replaces the node only when the tag changes shape', () => {
		const root = container()
		const view = mount(root, { t: 'box', p: {}, c: [{ t: '#text', v: 'a' }] })
		const box = root.firstElementChild
		view.update({ t: 'box', p: {}, c: [{ t: '#text', v: 'b' }] })
		expect(root.firstElementChild).toBe(box)
		view.update({ t: 'row', p: {}, c: [{ t: '#text', v: 'b' }] })
		expect(root.firstElementChild).not.toBe(box)
		expect(root.firstElementChild?.className).toContain('dil-row')
	})

	it('removes the children a shorter tree no longer has', () => {
		const root = container()
		const view = mount(root, {
			t: 'box',
			p: {},
			c: [{ t: 'text', p: {}, c: [{ t: '#text', v: '1' }] }, { t: 'text', p: {}, c: [{ t: '#text', v: '2' }] }]
		})
		expect(root.querySelectorAll('.dil-text')).toHaveLength(2)
		view.update({ t: 'box', p: {}, c: [{ t: 'text', p: {}, c: [{ t: '#text', v: '1' }] }] })
		expect(root.querySelectorAll('.dil-text')).toHaveLength(1)
	})

	it('applies new props to a surviving node instead of remounting it', () => {
		const root = container()
		const view = mount(root, { t: 'button', p: { disabled: false, size: 'sm' }, c: [{ t: '#text', v: 'Go' }] })
		const button = root.querySelector('button')!
		view.update({ t: 'button', p: { disabled: true, size: 'lg' }, c: [{ t: '#text', v: 'Go' }] })
		expect(root.querySelector('button')).toBe(button)
		expect(button.disabled).toBe(true)
		expect(button.className).toContain('dil-size-lg')
	})
})

describe('the event round trip', () => {
	it('sends the handler id and the value read off the DOM', () => {
		const root = container()
		const calls: { fnId: string; args: unknown[]; type?: string }[] = []
		mount(root, CARD, { onEvent: (fnId, args, meta) => calls.push({ fnId, args, type: meta?.type }) })
		root.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		// A `<button>` has a `value` property, so upstream's DOM read sends `''` here.
		// Faithful to the replica: the value is whatever the element reports.
		expect(calls).toEqual([{ fnId: 'fn1', args: [''], type: 'click' }])
	})

	it('reads a text input on input, and a number input as a number', () => {
		const root = container()
		const calls: unknown[][] = []
		mount(
			root,
			{
				t: 'box',
				p: {},
				c: [
					{ t: 'input', p: { onChange: { __dilFn: 'fnText' } }, c: [] },
					{ t: 'input', p: { type: 'number', onChange: { __dilFn: 'fnNum' }, value: 1 }, c: [] }
				]
			},
			{ onEvent: (fnId, args) => calls.push([fnId, ...args]) }
		)
		const [text, numeric] = Array.from(root.querySelectorAll('input'))
		text!.value = 'typed'
		text!.dispatchEvent(new Event('input', { bubbles: true }))
		expect(calls.at(-1)).toEqual(['fnText', 'typed'])
		numeric!.value = '42'
		numeric!.dispatchEvent(new Event('input', { bubbles: true }))
		expect(calls.at(-1)).toEqual(['fnNum', 42])
	})

	it('reads a checkbox as a boolean on change, not on input', () => {
		const root = container()
		const calls: unknown[][] = []
		mount(root, { t: 'checkbox', p: { onChange: { __dilFn: 'fnCheck' } }, c: [] }, {
			onEvent: (fnId, args) => calls.push([fnId, ...args])
		})
		const input = root.querySelector('input')!
		input.checked = true
		input.dispatchEvent(new Event('change', { bubbles: true }))
		expect(calls).toEqual([['fnCheck', true]])
	})

	it('hands back the original option value, not just its label', () => {
		const root = container()
		const calls: unknown[][] = []
		mount(
			root,
			{ t: 'select', p: { options: [{ label: 'One', value: 1 }, { label: 'Two', value: 2 }], value: 2, onChange: { __dilFn: 'fnSelect' } }, c: [] },
			{ onEvent: (fnId, args) => calls.push([fnId, ...args]) }
		)
		const select = root.querySelector('select')!
		expect(select.value).toBe('2')
		select.value = '1'
		select.dispatchEvent(new Event('change', { bubbles: true }))
		expect(calls).toEqual([['fnSelect', 1]])
	})

	it('maps a segmented-control click to the option behind the pressed item', () => {
		const root = container()
		const calls: unknown[][] = []
		mount(
			root,
			{ t: 'segmented-control', p: { options: ['a', 'b', 'c'], value: 'a', onChange: { __dilFn: 'fnSeg' } }, c: [] },
			{ onEvent: (fnId, args) => calls.push([fnId, ...args]) }
		)
		const items = root.querySelectorAll('.dil-segmented-item')
		expect(items).toHaveLength(3)
		items[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		expect(calls).toEqual([['fnSeg', 'c']])
	})

	it('binds one listener per handler id, however many revisions arrive', () => {
		const root = container()
		const calls: unknown[][] = []
		const view = mount(root, { t: 'button', p: { onClick: { __dilFn: 'fn1' } }, c: [] }, {
			onEvent: (fnId, args) => calls.push([fnId, ...args])
		})
		view.update({ t: 'button', p: { onClick: { __dilFn: 'fn1' }, disabled: true }, c: [] })
		view.update({ t: 'button', p: { onClick: { __dilFn: 'fn1' } }, c: [] })
		root.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		expect(calls).toHaveLength(1)
	})

	it('drops the listener when the handler goes away', () => {
		const root = container()
		const calls: unknown[][] = []
		const view = mount(root, { t: 'button', p: { onClick: { __dilFn: 'fn1' } }, c: [] }, {
			onEvent: (fnId, args) => calls.push([fnId, ...args])
		})
		view.update({ t: 'button', p: {}, c: [] })
		root.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		expect(calls).toHaveLength(0)
	})
})

describe('host components', () => {
	it('mounts a registered widget only when the compiler resolved it', () => {
		const root = container()
		mount(root, { t: 'MemoryCite', p: { __resolutionId: 'cmp-1' } }, {
			appData: { opGenui: { componentResults: { 'cmp-1': { status: 'resolved', componentName: 'MemoryCite' } } } }
		})
		const node = root.querySelector('.dil-memory-cite')
		expect(node).not.toBeNull()
		expect(node?.getAttribute('data-d-component')).toBe('MemoryCite')
		expect(node?.getAttribute('data-d-resolution')).toBe('cmp-1')
	})

	it('renders a quiet placeholder for anything else, and reports it', () => {
		const root = container()
		const missing: string[] = []
		mount(root, { t: 'SomethingElse', p: {} }, { onMissingComponent: (tag) => missing.push(tag) })
		expect(root.querySelector('.dil-widget-unresolved')).not.toBeNull()
		expect(textOf(root, '.dil-widget-body')).toContain('SomethingElse')
		expect(missing).toEqual(['SomethingElse'])
	})

	it('refuses a resolution that names a different component', () => {
		const root = container()
		mount(root, { t: 'MemoryCite', p: { __resolutionId: 'cmp-2' } }, {
			appData: { opGenui: { componentResults: { 'cmp-2': { status: 'resolved', componentName: 'OtherWidget' } } } }
		})
		expect(root.querySelector('.dil-memory-cite')).toBeNull()
		expect(root.querySelector('.dil-widget-unresolved')).not.toBeNull()
	})

	it('applies componentResults that arrive mid-stream to the next mount, not to a live node', () => {
		const root = container()
		const view = mount(root, { t: 'MemoryCite', p: { __resolutionId: 'cmp-3' } })
		expect(root.querySelector('.dil-widget-unresolved')).not.toBeNull()
		view.setAppData({ opGenui: { componentResults: { 'cmp-3': { status: 'resolved', componentName: 'MemoryCite' } } } })
		// A node that is already on screen keeps its handle (that is what keeps focus and
		// scroll), so the placeholder stays until the shape changes and it is remounted.
		view.update({ t: 'MemoryCite', p: { __resolutionId: 'cmp-3' } })
		expect(root.querySelector('.dil-widget-unresolved')).not.toBeNull()
		view.update({ t: 'box', p: {}, c: [] })
		view.update({ t: 'MemoryCite', p: { __resolutionId: 'cmp-3' } })
		expect(root.querySelector('.dil-memory-cite')).not.toBeNull()
	})
})

describe('lifecycle', () => {
	it('disconnects the chart observer it created', () => {
		const root = container()
		const observed: unknown[] = []
		const disconnected: unknown[] = []
		class FakeObserver {
			constructor(_callback: unknown) {}
			observe(node: unknown): void {
				observed.push(node)
			}
			disconnect(): void {
				disconnected.push(true)
			}
		}
		const win = window as unknown as { ResizeObserver?: unknown }
		const previous = win.ResizeObserver
		win.ResizeObserver = FakeObserver
		try {
			const view = mount(root, { t: 'chart', p: { data: [{ label: 'a', value: 1 }] }, c: [] })
			expect(observed).toHaveLength(1)
			view.destroy()
			expect(disconnected).toHaveLength(1)
		} finally {
			win.ResizeObserver = previous
		}
	})

	it('clears the container on destroy', () => {
		const root = container()
		const view = mount(root, CARD)
		view.destroy()
		expect(root.children).toHaveLength(0)
		expect(root.querySelector('[data-d-component="card"]')).toBeNull()
	})

	it('survives a teardown that throws, and still runs the ones behind it', () => {
		const root = container()
		const win = window as unknown as { ResizeObserver?: unknown }
		const previous = win.ResizeObserver
		class ThrowingObserver {
			constructor(_callback: unknown) {}
			observe(): void {}
			disconnect(): void {
				throw new Error('this observer is having a bad day')
			}
		}
		win.ResizeObserver = ThrowingObserver
		try {
			const view = mount(root, { t: 'chart', p: { data: [{ label: 'a', value: 1 }] }, c: [] })
			expect(() => view.destroy()).not.toThrow()
			expect(root.children).toHaveLength(0)
		} finally {
			win.ResizeObserver = previous
		}
	})
})

describe('living in a shadow root', () => {
	it('finds the focused element through the shadow boundary, which document.activeElement cannot', () => {
		document.body.innerHTML = ''
		const host = document.createElement('div')
		document.body.appendChild(host)
		const shadow = host.attachShadow({ mode: 'open' })
		const root = document.createElement('div')
		root.className = 'dil-root'
		shadow.appendChild(root)

		const view = mount(root, { t: 'input', p: { value: 'typed' } })
		const input = root.querySelector('input')!
		input.focus()
		// The whole reason `activeElement()` descends: the document sees only the host.
		expect(document.activeElement).toBe(host)
		expect(shadow.activeElement).toBe(input)
		expect(activeElement()).toBe(input)
		view.update({ t: 'input', p: { value: 'from the model' } })
		expect(input.value).toBe('typed')
	})

	it('creates nodes in the document it was given', () => {
		const root = container()
		mount(root, { t: 'text', p: {}, c: [{ t: '#text', v: 'x' }] })
		expect(root.querySelector('.dil-text')?.ownerDocument).toBe(document)
		// `el()` and the patcher agree on the document, so an adopted node is never
		// pulled across a document boundary mid-patch.
		expect(makeElement('span', 'probe').ownerDocument).toBe(document)
	})
})
