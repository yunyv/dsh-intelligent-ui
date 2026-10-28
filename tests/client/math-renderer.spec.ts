// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MathRenderResult } from '../../src/client/dil/math/protocol.ts'
import type { MathService, MathServiceOptions, MathWorker } from '../../src/client/dil/math/service.ts'
import type { DilNode } from '../../src/client/dil/types.ts'

const mocked = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('../../src/client/dil/math/service.ts', () => ({ renderMathIsolated: mocked.render }))
import { mount } from '../../src/client/dil/renderer/index.ts'
import { installDilStyles } from '../../src/client/dil/theme.ts'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 1000 1000"><path d="M0 0L1 1"/></svg>'
interface Pending {
	tex: string
	display: boolean
	signal: AbortSignal
	resolve(result: MathRenderResult): void
	reject(error: Error): void
}
let pending: Pending[]
const views: ReturnType<typeof mount>[] = []
const services: MathService[] = []

class FakeWorker implements MathWorker {
	onmessage: MathWorker['onmessage'] = null
	onerror: MathWorker['onerror'] = null
	onmessageerror: MathWorker['onmessageerror'] = null
	messages: { id: number; tex: string; display: boolean }[] = []
	terminated = false
	postMessage(value: unknown): void { this.messages.push(value as typeof this.messages[number]) }
	terminate(): void { this.terminated = true }
	reply(result: MathRenderResult = { ok: true, svg: SVG }): void {
		this.onmessage?.({ data: { id: this.messages.at(-1)!.id, result } })
	}
}

function root(): HTMLElement {
	const node = document.createElement('div')
	document.body.append(node)
	return node
}
function math(tex: unknown, display = false, extra = {}): DilNode {
	return { t: 'math', p: { tex, display, ...extra } }
}
function view(node: HTMLElement, tree: DilNode) {
	const mounted = mount(node, tree)
	views.push(mounted)
	return mounted
}
async function flush(): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
}
async function actualService(options: MathServiceOptions): Promise<MathService> {
	// Keep the real host component and scheduler; only the Worker transport is fake.
	const actual = await vi.importActual<typeof import('../../src/client/dil/math/service.ts')>('../../src/client/dil/math/service.ts')
	const made = actual.createMathService({ idleMs: 60_000, ...options })
	services.push(made)
	mocked.render.mockImplementation((tex: string, display: boolean, signal: AbortSignal) => made.render(tex, display, signal))
	return made
}

beforeEach(() => {
	document.body.innerHTML = ''
	pending = []
	mocked.render.mockReset()
	mocked.render.mockImplementation((tex: string, display: boolean, signal: AbortSignal) => new Promise<MathRenderResult>((resolve, reject) => {
		pending.push({ tex, display, signal, resolve, reject })
	}))
})
afterEach(() => {
	for (const mounted of views.splice(0)) mounted.destroy()
	for (const created of services.splice(0)) created.dispose()
	vi.useRealTimers()
})

describe('DIL math host component', () => {
	it('renders asynchronously with its original TeX accessible as data', async () => {
		const node = root()
		view(node, math(String.raw`\frac{1}{2}`))
		const formula = node.querySelector<HTMLElement>('[data-d-component="math"]')!
		expect(formula.getAttribute('role')).toBe('math')
		expect(formula.getAttribute('aria-label')).toBe(String.raw`\frac{1}{2}`)
		expect(formula.getAttribute('aria-busy')).toBe('true')
		expect(pending).toHaveLength(1) // constructor + first patch do not double-submit
		expect(pending[0]!.display).toBe(false)
		pending[0]!.resolve({ ok: true, svg: SVG })
		await flush()
		expect(formula.querySelector('svg path')).not.toBeNull()
		expect(formula.dataset.dMathStatus).toBe('ready')
		expect(formula.hasAttribute('aria-busy')).toBe(false)
	})

	it('fits overhanging ink without changing glyph transforms or resubmitting', async () => {
		const old = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox')
		const bbox = vi.fn(() => ({ x: -500, y: -1000, width: 2000, height: 2000 }))
		Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: bbox })
		try {
			const node = root()
			const mounted = view(node, math(String.raw`\llap{x}y`))
			pending[0]!.resolve({ ok: true, svg: SVG })
			await flush()
			const svg = node.querySelector('svg')!
			expect(svg.getAttribute('viewBox')).toBe('-500 -1000 2000 2000')
			expect(Number.parseFloat(svg.getAttribute('width')!)).toBeCloseTo(2)
			expect(Number.parseFloat(svg.getAttribute('height')!)).toBeCloseTo(2)
			expect(svg.querySelector('path')!.getAttribute('d')).toBe('M0 0L1 1')
			expect(node.querySelector('.dil-math')!.getAttribute('data-d-math-status')).toBe('ready')
			mounted.update(math(String.raw`\llap{x}y`))
			expect(node.querySelector('svg')).toBe(svg)
			expect(pending).toHaveLength(1)
			expect(bbox).toHaveBeenCalledTimes(1)
			const formula = node.querySelector('.dil-math')!
			expect(formula.hasAttribute('data-d-math-ink')).toBe(true)
			mounted.update(math('new input'))
			expect(formula.hasAttribute('data-d-math-ink')).toBe(false)
			expect(pending).toHaveLength(2)
		} finally {
			if (old) Object.defineProperty(SVGElement.prototype, 'getBBox', old)
			else Reflect.deleteProperty(SVGElement.prototype, 'getBBox')
		}
	})

	it('keeps oversized visible ink inside the existing failure and Retry path', async () => {
		const old = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'getBBox')
		Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 2_000_000, height: 1000 }) })
		try {
			const node = root()
			view(node, math('oversized ink'))
			pending[0]!.resolve({ ok: true, svg: SVG })
			await flush()
			expect(node.querySelector('.dil-math')!.getAttribute('data-d-math-status')).toBe('error')
			expect(node.querySelector('svg')).toBeNull()
			expect(node.querySelector('button[data-d-math-retry]')).not.toBeNull()
		} finally {
			if (old) Object.defineProperty(SVGElement.prototype, 'getBBox', old)
			else Reflect.deleteProperty(SVGElement.prototype, 'getBBox')
		}
	})

	it('keeps node identity and does not recompute on styling-only revisions', async () => {
		const node = root()
		const mounted = view(node, math('x', false))
		const formula = node.firstElementChild
		pending[0]!.resolve({ ok: true, svg: SVG })
		await flush()
		mounted.update(math('x', false, { color: 'secondary', size: 'lg', width: 200, hidden: true }))
		expect(node.firstElementChild).toBe(formula)
		expect(pending).toHaveLength(1)
		expect(formula?.className).toContain('dil-color-secondary')
		expect(formula?.className).toContain('dil-size-lg')
		expect((formula as HTMLElement).style.display).toBe('none')
	})

	it('cancels a replaced request and ignores its late result', async () => {
		const node = root()
		const mounted = view(node, math('old'))
		const formula = node.firstElementChild
		mounted.update(math('new', true))
		expect(node.firstElementChild).toBe(formula)
		expect(pending[0]!.signal.aborted).toBe(true)
		expect(pending[1]!.display).toBe(true)
		expect(formula?.className).toContain('dil-math-display')
		pending[0]!.resolve({ ok: true, svg: SVG })
		await flush()
		expect(formula?.querySelector('svg')).toBeNull()
		expect(formula?.textContent).toBe('new')
		pending[1]!.resolve({ ok: true, svg: SVG })
		await flush()
		expect(formula?.querySelector('svg')).not.toBeNull()
	})

	it('keeps invalid TeX local and recovers on the next revision', async () => {
		const node = root()
		const mounted = view(node, { t: 'box', c: [math('<img src=x onerror=alert(1)>'), { t: 'text', c: [{ t: '#text', v: 'neighbour' }] }] })
		expect(node.querySelector('img')).toBeNull()
		pending[0]!.resolve({ ok: false, error: 'Unknown TeX command' })
		await flush()
		const formula = node.querySelector<HTMLElement>('.dil-math')!
		expect(formula.dataset.dMathStatus).toBe('error')
		expect(formula.title).toBe('Unknown TeX command')
		expect(formula.querySelector('img')).toBeNull()
		expect(node.textContent).toContain('neighbour')
		mounted.update({ t: 'box', c: [math('x^2'), { t: 'text', c: [{ t: '#text', v: 'neighbour' }] }] })
		pending[1]!.resolve({ ok: true, svg: SVG })
		await flush()
		expect(formula.dataset.dMathStatus).toBe('ready')
		expect(formula.hasAttribute('title')).toBe(false)
		expect(formula.querySelector('svg')).not.toBeNull()
	})

	it('rejects missing/oversized props and skips empty formulas without a Worker', () => {
		const node = root()
		const mounted = view(node, math(undefined))
		expect(node.querySelector('.dil-math-error')).not.toBeNull()
		mounted.update(math('x'.repeat(8193)))
		expect(node.querySelector('.dil-math-error')?.textContent?.length).toBeLessThanOrEqual(501)
		mounted.update(math('  '))
		expect(node.querySelector('.dil-math')?.textContent).toBe('')
		expect(node.querySelector('.dil-math')?.getAttribute('data-d-math-status')).toBe('ready')
		expect(mocked.render).not.toHaveBeenCalled()
	})

	it('ignores children instead of corrupting the leaf-owned SVG DOM', async () => {
		const node = root()
		const mounted = view(node, { t: 'math', p: { tex: 'x' }, c: [{ t: 'button', c: [{ t: '#text', v: 'not allowed' }] }] })
		expect(node.querySelector('button')).toBeNull()
		pending[0]!.resolve({ ok: true, svg: SVG })
		await flush()
		expect(() => mounted.update({ t: 'math', p: { tex: 'x' }, c: [] })).not.toThrow()
		expect(node.querySelector('svg')).not.toBeNull()
	})

	it('cancels work when a nested formula is removed or its parent replaced', async () => {
		const node = root()
		const mounted = view(node, { t: 'box', c: [math('one'), math('two')] })
		mounted.update({ t: 'box', c: [math('one')] })
		expect(pending[0]!.signal.aborted).toBe(false)
		expect(pending[1]!.signal.aborted).toBe(true)
		mounted.update({ t: 'text', c: [{ t: '#text', v: 'replaced' }] })
		expect(pending[0]!.signal.aborted).toBe(true)
		pending[0]!.resolve({ ok: true, svg: SVG })
		pending[1]!.resolve({ ok: true, svg: SVG })
		await flush()
		expect(node.textContent).toBe('replaced')
		expect(node.querySelector('svg')).toBeNull()
	})

	it('reconstructs a saved tree after teardown without adopting stale completions', async () => {
		const saved = math(String.raw`\sum_{k=1}^{n} k`, true)
		const node = root()
		const first = view(node, saved)
		first.destroy()
		expect(pending[0]!.signal.aborted).toBe(true)
		const second = view(node, JSON.parse(JSON.stringify(saved)))
		pending[0]!.resolve({ ok: true, svg: SVG })
		await flush()
		expect(node.querySelector('svg')).toBeNull()
		pending[1]!.resolve({ ok: true, svg: SVG })
		await flush()
		expect(node.querySelector('svg')).not.toBeNull()
		second.destroy()
		expect(pending[1]!.signal.aborted).toBe(true)
		expect(node.children).toHaveLength(0)
	})

	it('uses the ShadowRoot document and installs themed SVG rules there', async () => {
		const host = root()
		const shadow = host.attachShadow({ mode: 'open' })
		installDilStyles(shadow)
		const inside = document.createElement('div')
		shadow.append(inside)
		view(inside, math('x', true))
		pending[0]!.resolve({ ok: true, svg: SVG })
		await flush()
		expect(inside.querySelector('svg')?.ownerDocument).toBe(document)
		expect(document.querySelector('svg')).toBeNull()
	})

	function retryButton(node: ParentNode): HTMLButtonElement {
		const button = node.querySelector<HTMLButtonElement>('button[data-d-math-retry]')
		expect(button).not.toBeNull()
		return button!
	}

	it('handles unexpected service rejection and recovers only on explicit retry', async () => {
		const node = root()
		const mounted = view(node, math('x'))
		pending[0]!.reject(new Error('transport failure'))
		await flush()
		const formula = node.querySelector<HTMLElement>('.dil-math-error')!
		expect(formula.firstChild?.textContent).toBe('x')
		expect(formula.title).toBe('Formula rendering failed')
		mounted.update(math('x'))
		expect(pending).toHaveLength(1)
		retryButton(formula).click()
		expect(pending).toHaveLength(2)
		pending[1]!.resolve({ ok: true, svg: SVG })
		await flush()
		expect(formula.dataset.dMathStatus).toBe('ready')
		expect(formula.querySelector('[data-d-math-retry]')).toBeNull()
	})

	it.each([
		'Too many pending formulas',
		'Formula rendering timed out',
		'Formula Worker is unavailable'
	])('keeps %s stable through patches and retries only on a click', async (error) => {
		const node = root()
		const mounted = view(node, math('x'))
		const formula = node.querySelector<HTMLElement>('.dil-math')!
		pending[0]!.resolve({ ok: false, error })
		await flush()
		const retry = retryButton(formula)
		expect(retry.type).toBe('button')
		expect(retry.getAttribute('aria-label')).toBe('Retry formula')
		for (let i = 0; i < 5; i++) {
			mounted.update(math('x', false, { color: 'secondary' }))
			expect(formula.dataset.dMathStatus).toBe('error')
			expect(formula.title).toBe(error)
			expect(formula.classList.contains('dil-math-error')).toBe(true)
		}
		expect(node.firstElementChild).toBe(formula)
		expect(mocked.render).toHaveBeenCalledTimes(1)
		expect(retryButton(formula)).toBe(retry)
		retry.click()
		expect(pending).toHaveLength(2)
		expect(formula.dataset.dMathStatus).toBe('pending')
		expect(retry.disabled).toBe(true)
		expect(formula.getAttribute('aria-busy')).toBe('true')
		retry.click()
		retry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
		for (let i = 0; i < 5; i++) mounted.update(math('x'))
		expect(pending).toHaveLength(2)
		expect(pending[1]!.signal.aborted).toBe(false)
		pending[1]!.resolve({ ok: true, svg: SVG })
		await flush()
		const svg = formula.firstElementChild
		expect(formula.dataset.dMathStatus).toBe('ready')
		expect(formula.hasAttribute('aria-busy')).toBe(false)
		expect(formula.hasAttribute('title')).toBe(false)
		expect(formula.querySelector('[data-d-math-retry]')).toBeNull()
		for (let i = 0; i < 5; i++) mounted.update(math('x', false, { color: 'secondary' }))
		retry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
		expect(mocked.render).toHaveBeenCalledTimes(2)
		expect(formula.firstElementChild).toBe(svg)
	})

	it('does not bubble an explicit retry into parent controls', async () => {
		const node = root()
		const clicked = vi.fn()
		node.addEventListener('click', clicked)
		view(node, math('x'))
		pending[0]!.resolve({ ok: false, error: 'failed' })
		await flush()
		retryButton(node).click()
		expect(pending).toHaveLength(2)
		expect(clicked).not.toHaveBeenCalled()
	})

	it('deduplicates unchanged patches while the original request is pending', () => {
		const node = root()
		const mounted = view(node, math('x'))
		for (let i = 0; i < 10; i++) mounted.update(math('x'))
		expect(pending).toHaveLength(1)
		expect(pending[0]!.signal.aborted).toBe(false)
		expect(node.querySelector('.dil-math')?.getAttribute('data-d-math-status')).toBe('pending')
	})

	it('cancels explicit retry on removal and ignores clicks and replies after destruction', async () => {
		const node = root()
		const mounted = view(node, { t: 'box', c: [math('x')] })
		pending[0]!.resolve({ ok: false, error: 'Formula Worker is unavailable' })
		await flush()
		const retry = retryButton(node)
		retry.click()
		expect(pending).toHaveLength(2)
		mounted.update({ t: 'box', c: [] })
		expect(pending[1]!.signal.aborted).toBe(true)
		retry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
		expect(pending).toHaveLength(2)
		pending[1]!.resolve({ ok: true, svg: SVG })
		await flush()
		expect(node.querySelector('.dil-math')).toBeNull()
		expect(node.querySelector('svg')).toBeNull()
	})

	it('recovers through the real service after Worker availability changes, without automatic retries', async () => {
		const workers: FakeWorker[] = []
		let attempts = 0
		await actualService({ makeWorker: () => {
			if (++attempts === 1) throw new Error('unavailable')
			const worker = new FakeWorker()
			workers.push(worker)
			return worker
		} })
		vi.useFakeTimers()
		const node = root()
		const mounted = view(node, math('x'))
		await flush()
		expect(node.querySelector('.dil-math')?.getAttribute('title')).toBe('Formula Worker is unavailable')
		await vi.advanceTimersByTimeAsync(60_000)
		mounted.update(math('x'))
		expect(attempts).toBe(1)
		expect(mocked.render).toHaveBeenCalledTimes(1)
		retryButton(node).click()
		expect(attempts).toBe(2)
		expect(workers).toHaveLength(1)
		workers[0]!.reply()
		await flush()
		expect(node.querySelector('.dil-math')?.getAttribute('data-d-math-status')).toBe('ready')
	})

	it('recovers unchanged input through the real service after a timeout and an explicit retry', async () => {
		const workers: FakeWorker[] = []
		await actualService({ timeoutMs: 20, makeWorker: () => {
			const worker = new FakeWorker()
			workers.push(worker)
			return worker
		} })
		vi.useFakeTimers()
		const node = root()
		const mounted = view(node, math('x'))
		await vi.advanceTimersByTimeAsync(20)
		expect(workers[0]!.terminated).toBe(true)
		expect(node.querySelector('.dil-math')?.getAttribute('data-d-math-status')).toBe('error')
		mounted.update(math('x'))
		expect(workers).toHaveLength(1)
		retryButton(node).click()
		expect(workers).toHaveLength(2)
		mounted.update(math('x'))
		expect(mocked.render).toHaveBeenCalledTimes(2)
		workers[1]!.reply()
		await flush()
		expect(node.querySelector('.dil-math')?.getAttribute('data-d-math-status')).toBe('ready')
	})

	it('does not repost permanent TeX errors through the real service without a retry click', async () => {
		const workers: FakeWorker[] = []
		await actualService({ makeWorker: () => {
			const worker = new FakeWorker()
			workers.push(worker)
			return worker
		} })
		const node = root()
		const tex = String.raw`\unknownMacro`
		const mounted = view(node, math(tex))
		const error: MathRenderResult = { ok: false, error: 'Undefined control sequence' }
		workers[0]!.reply(error)
		await flush()
		for (let i = 0; i < 20; i++) {
			mounted.update(math(tex))
			await flush()
		}
		expect(workers[0]!.messages).toHaveLength(1)
		expect(mocked.render).toHaveBeenCalledTimes(1)
		retryButton(node).click()
		expect(workers[0]!.messages).toHaveLength(2)
		workers[0]!.reply(error)
		await flush()
		expect(retryButton(node).disabled).toBe(false)
		expect(workers).toHaveLength(1)
	})

	it('recovers all 40 formulas after the shared queue drains and failed formulas are explicitly retried', async () => {
		const workers: FakeWorker[] = []
		await actualService({ makeWorker: () => {
			const worker = new FakeWorker()
			workers.push(worker)
			return worker
		} })
		vi.useFakeTimers()
		const node = root()
		const tree: DilNode = { t: 'box', c: Array.from({ length: 40 }, (_, i) => math(`x_{${i}}`)) }
		const mounted = view(node, tree)
		await flush()
		expect(node.querySelectorAll('[data-d-math-status="pending"]')).toHaveLength(32)
		expect(node.querySelectorAll('[data-d-math-status="error"]')).toHaveLength(8)
		for (let i = 0; i < 32; i++) {
			expect(workers[0]!.messages).toHaveLength(i + 1)
			workers[0]!.reply()
			await flush()
		}
		expect(node.querySelectorAll('[data-d-math-status="ready"]')).toHaveLength(32)
		mounted.update(tree)
		expect(mocked.render).toHaveBeenCalledTimes(40)
		expect(node.querySelectorAll('[data-d-math-status="error"]')).toHaveLength(8)
		const retries = [...node.querySelectorAll<HTMLButtonElement>('button[data-d-math-retry]')]
		expect(retries).toHaveLength(8)
		for (const retry of retries) retry.click()
		expect(node.querySelectorAll('[data-d-math-status="pending"]')).toHaveLength(8)
		for (let i = 32; i < 40; i++) {
			expect(workers[0]!.messages).toHaveLength(i + 1)
			workers[0]!.reply()
			await flush()
		}
		expect(node.querySelectorAll('[data-d-math-status="ready"]')).toHaveLength(40)
		expect(node.querySelectorAll('[data-d-math-retry]')).toHaveLength(0)
		expect(mocked.render).toHaveBeenCalledTimes(48)
		mounted.update(tree)
		expect(mocked.render).toHaveBeenCalledTimes(48)
		expect(workers).toHaveLength(1)
	})
})
