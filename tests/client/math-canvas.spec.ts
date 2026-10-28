// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { fitMathCanvas, fitMathCanvasWhenVisible } from '../../src/client/dil/math/canvas.ts'
import { validateMathSvg } from '../../src/client/dil/math/protocol.ts'

type Ink = { x: number; y: number; width: number; height: number }
const ROOT = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 -1000 1000 1000" style="vertical-align: -0.2em;"><g stroke="currentColor" stroke-width="0"><path d="M0 0L1 1"/></g></svg>'
function sample(ink: Ink): SVGSVGElement {
	const host = document.createElement('div')
	document.body.append(host)
	host.innerHTML = ROOT
	const svg = host.firstElementChild as SVGSVGElement
	Object.defineProperty(svg, 'getBBox', { configurable: true, value: () => ink })
	return svg
}
const number = (svg: SVGSVGElement, name: string) => Number.parseFloat(svg.getAttribute(name)!)
afterEach(() => { document.body.innerHTML = '' })

describe('bounded native math canvas fitting', () => {
	it('leaves an already contained canvas byte-for-byte unchanged', () => {
		const svg = sample({ x: 30, y: -900, width: 800, height: 800 })
		const before = svg.outerHTML
		expect(fitMathCanvas(svg)).toBeNull()
		expect(svg.outerHTML).toBe(before)
	})
	it('expands above the baseline without moving it', () => {
		const svg = sample({ x: 30, y: -1500, width: 800, height: 900 })
		expect(fitMathCanvas(svg)).toBeNull()
		expect(svg.getAttribute('viewBox')).toBe('0 -1500 1000 1500')
		expect(number(svg, 'height')).toBeCloseTo(1.5)
		expect(Number.parseFloat(svg.style.verticalAlign)).toBeCloseTo(-0.2)
		expect(validateMathSvg(svg.outerHTML)).toBeNull()
	})
	it('compensates bottom expansion in signed baseline units', () => {
		const svg = sample({ x: 30, y: -900, width: 800, height: 1400 })
		expect(fitMathCanvas(svg)).toBeNull()
		expect(svg.getAttribute('viewBox')).toBe('0 -1000 1000 1500')
		expect(number(svg, 'height')).toBeCloseTo(1.5)
		expect(Number.parseFloat(svg.style.verticalAlign)).toBeCloseTo(-0.7)
	})
	it('preserves the effective zero baseline of a block SVG', () => {
		const style = document.createElement('style')
		style.textContent = 'svg { display: block; }'
		document.body.append(style)
		const svg = sample({ x: 30, y: -900, width: 800, height: 1400 })
		expect(fitMathCanvas(svg)).toBeNull()
		expect(Number.parseFloat(svg.style.verticalAlign)).toBeCloseTo(-0.5)
	})

	it('fits both horizontal overhangs without rewriting glyphs', () => {
		const svg = sample({ x: -300, y: -900, width: 1800, height: 800 })
		const glyph = svg.querySelector('path')!
		expect(fitMathCanvas(svg)).toBeNull()
		expect(svg.getAttribute('viewBox')).toBe('-300 -1000 1800 1000')
		expect(number(svg, 'width')).toBeCloseTo(1.8)
		expect(svg.querySelector('path')).toBe(glyph)
		expect(glyph.getAttribute('d')).toBe('M0 0L1 1')
	})
	it('reserves one CSS pixel for fallback text after fractional viewport rounding', () => {
		const style = document.createElement('style')
		style.textContent = 'svg { font-size: 16px; }'
		document.body.append(style)
		const svg = sample({ x: 0, y: -1000, width: 1000, height: 1000 })
		svg.innerHTML = '<g stroke-width="0"><text font-size="884px">中</text></g>'
		expect(fitMathCanvas(svg)).toBeNull()
		expect(svg.getAttribute('viewBox')).toBe('-62.5 -1062.5 1125 1125')
		expect(number(svg, 'width')).toBeCloseTo(1.125)
		expect(number(svg, 'height')).toBeCloseTo(1.125)
		expect(validateMathSvg(svg.outerHTML)).toBeNull()
	})

	it('includes computed table stroke and its local scale', () => {
		const style = document.createElement('style')
		style.textContent = 'line { stroke: black; stroke-width: 70px; }'
		document.body.append(style)
		const svg = sample({ x: 0, y: -1000, width: 1000, height: 1000 })
		svg.innerHTML = '<g data-mml-node="mtable" transform="scale(2)" stroke-width="0"><line data-line="h" x1="0" y1="0" x2="500" y2="0"/></g>'
		Object.defineProperty(svg, 'getScreenCTM', { value: () => ({ a: 1, b: 0, c: 0, d: 1 }) })
		Object.defineProperty(svg.querySelector('line')!, 'getScreenCTM', { value: () => ({ a: 2, b: 0, c: 0, d: 2 }) })
		expect(fitMathCanvas(svg)).toBeNull()
		expect(svg.getAttribute('viewBox')).toBe('-280 -1280 1560 1560')
		expect(number(svg, 'width')).toBeCloseTo(1.56)
		expect(Number.parseFloat(svg.style.verticalAlign)).toBeCloseTo(-0.48)
		expect(validateMathSvg(svg.outerHTML)).toBeNull()
	})
	it.each([
		{ x: 0, y: 0, width: 2_000_000, height: 1000 },
		{ x: Number.NaN, y: 0, width: 1000, height: 1000 },
		{ x: 0, y: 0, width: -1, height: 1000 },
	])('does not mutate the live SVG when measurements are invalid or over budget: %j', ink => {
		const svg = sample(ink)
		const before = svg.outerHTML
		expect(fitMathCanvas(svg)).not.toBeNull()
		expect(svg.outerHTML).toBe(before)
	})
	it('turns native measurement exceptions into a controlled error', () => {
		const svg = sample({ x: 0, y: 0, width: 100, height: 100 })
		Object.defineProperty(svg, 'getBBox', { value: () => { throw new Error('not measurable') } })
		const before = svg.outerHTML
		expect(fitMathCanvas(svg)).toMatch(/measured/)
		expect(svg.outerHTML).toBe(before)
	})
	it.each([false, true])('defers hidden measurement once and respects disposal=%s', cancelled => {
		const svg = sample({ x: -300, y: -900, width: 1800, height: 800 })
		let visible = false
		let notify = () => {}
		let disconnects = 0
		let measurements = 0
		Object.defineProperty(svg, 'checkVisibility', { value: () => visible })
		Object.defineProperty(svg, 'getBBox', { configurable: true, value: () => { measurements++; return { x: -300, y: -900, width: 1800, height: 800 } } })
		const original = Object.getOwnPropertyDescriptor(window, 'ResizeObserver')
		Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: class {
			constructor(callback: () => void) { notify = callback }
			observe(target: Element) { expect(target).toBe(svg) }
			disconnect() { disconnects++ }
		} })
		try {
			const errors: string[] = []
			const before = svg.outerHTML
			const stop = fitMathCanvasWhenVisible(svg, message => errors.push(message))
			notify()
			expect(measurements).toBe(0)
			expect(svg.outerHTML).toBe(before)
			if (cancelled) stop()
			visible = true
			notify()
			notify() // A queued duplicate cannot fit again after completion/disposal.
			expect(measurements).toBe(cancelled ? 0 : 1)
			expect(number(svg, 'width')).toBeCloseTo(cancelled ? 1 : 1.8)
			expect(errors).toEqual([])
			expect(disconnects).toBeGreaterThanOrEqual(1)
			stop()
		} finally {
			if (original) Object.defineProperty(window, 'ResizeObserver', original)
			else Reflect.deleteProperty(window, 'ResizeObserver')
		}
	})

	it('keeps non-native DOM adapters on their already validated box', () => {
		const svg = sample({ x: 0, y: 0, width: 0, height: 0 })
		Reflect.deleteProperty(svg, 'getBBox')
		const before = svg.outerHTML
		expect(fitMathCanvas(svg)).toBeNull()
		expect(svg.outerHTML).toBe(before)
	})
})
