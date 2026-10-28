/** Host-only ink fitting. The fixed engine's logical box may intentionally omit smash/lap ink. */
import { validateMathSvg } from './protocol.ts'

type Linear = { a: number; b: number; c: number; d: number }

function relativeMagnification(root: Linear, leaf: Linear): number {
	const determinant = root.a * root.d - root.b * root.c
	if (!Number.isFinite(determinant) || determinant === 0) return Number.NaN
	const a = (root.d * leaf.a - root.c * leaf.b) / determinant
	const b = (-root.b * leaf.a + root.a * leaf.b) / determinant
	const c = (root.d * leaf.c - root.c * leaf.d) / determinant
	const d = (-root.b * leaf.c + root.a * leaf.d) / determinant
	return Math.max(Math.abs(a) + Math.abs(c), Math.abs(b) + Math.abs(d))
}

/** Native getBBox excludes stroke; include the inherited, transformed paint and miter bound. */
function strokePadding(svg: SVGSVGElement): number {
	const window = svg.ownerDocument.defaultView
	if (!window) return 0
	let padding = 0
	let root: DOMMatrix | null | undefined
	for (const leaf of svg.querySelectorAll<SVGGraphicsElement>('path,rect,line,polyline,polygon,text')) {
		const style = window.getComputedStyle(leaf)
		const width = Number.parseFloat(style.strokeWidth)
		if (style.stroke === 'none' || style.stroke === 'transparent' || style.stroke === 'rgba(0, 0, 0, 0)' || Number.parseFloat(style.strokeOpacity) === 0 || !Number.isFinite(width) || width === 0) continue
		if (width < 0 || typeof leaf.getScreenCTM !== 'function' || typeof svg.getScreenCTM !== 'function') return Number.NaN
		root ??= svg.getScreenCTM()
		const matrix = leaf.getScreenCTM()
		if (!root || !matrix) return Number.NaN
		const magnification = relativeMagnification(root, matrix)
		const limit = Number.parseFloat(style.strokeMiterlimit)
		const radius = width * Math.max(4, Number.isFinite(limit) ? limit : 4) / 2
		padding = Math.max(padding, radius * magnification)
	}
	return padding
}

/**
 * Expand only when native ink exceeds the logical viewport. Keep clipping and glyph scale;
 * validate the complete cloned SVG before changing the live root. No Worker/model CSS is added.
 * A DOM without native SVG measurement (e.g. Node test adapters) keeps the validated engine box.
 */
export function fitMathCanvas(svg: SVGSVGElement): string | null {
	if (typeof svg.getBBox !== 'function') return null
	try {
		const box = (svg.getAttribute('viewBox') ?? '').trim().split(/[ \t\r\n,]+/).map(Number)
		const width = Number.parseFloat(svg.getAttribute('width') ?? '')
		const height = Number.parseFloat(svg.getAttribute('height') ?? '')
		const block = svg.ownerDocument.defaultView?.getComputedStyle(svg).display === 'block'
		const baseline = block ? 0 : Number.parseFloat(svg.style.verticalAlign || '0')
		if (box.length !== 4 || ![...box, width, height, baseline].every(Number.isFinite) || box[2]! <= 0 || box[3]! <= 0) return 'Formula canvas geometry is invalid'
		const ratios = [width / box[2]!, height / box[3]!].filter(value => value > 0)
		if (!ratios.length) return null // An intentionally empty zero-size logical box has no viewport.
		let scale = Math.min(...ratios)
		// Preserve the browser's original used scale, including fractional CSS-pixel rounding.
		// getCTM excludes ancestor CSS transforms; screen CTMs are used only as a relative pair above.
		const matrix = typeof svg.getCTM === 'function' ? svg.getCTM() : null
		const fontSize = Number.parseFloat(svg.ownerDocument.defaultView?.getComputedStyle(svg).fontSize ?? '')
		if (matrix && Math.abs(matrix.b) < 1e-10 && Math.abs(matrix.c) < 1e-10 && matrix.a > 0 && matrix.d > 0 && fontSize > 0 && Number.isFinite(fontSize)) {
			scale = Math.min(matrix.a, matrix.d) / fontSize
		}
		if (!Number.isFinite(scale) || scale <= 0) return 'Formula canvas scale is invalid'
		const ink = svg.getBBox()
		// Fallback font metrics can shift slightly after fractional viewport rounding.
		// A bounded one-CSS-pixel halo covers that paint edge without rescaling glyphs.
		const textHalo = svg.querySelector('text') && fontSize > 0 && Number.isFinite(fontSize) ? 1 / (scale * fontSize) : 0
		const padding = strokePadding(svg) + textHalo
		if (![ink.x, ink.y, ink.width, ink.height, padding].every(Number.isFinite) || ink.width < 0 || ink.height < 0 || padding < 0) return 'Formula visible ink could not be measured'
		if (ink.width === 0 && ink.height === 0 && padding === 0) return null
		// Include original letterboxing so fitting never shrinks the logical layout dimensions.
		const oldWidth = Math.max(box[2]!, width / scale)
		const oldHeight = Math.max(box[3]!, height / scale)
		const oldLeft = box[0]! - (oldWidth - box[2]!) / 2
		const oldTop = box[1]! - (oldHeight - box[3]!) / 2
		const oldRight = oldLeft + oldWidth
		const oldBottom = oldTop + oldHeight
		const left = Math.min(oldLeft, ink.x - padding)
		const top = Math.min(oldTop, ink.y - padding)
		const right = Math.max(oldRight, ink.x + ink.width + padding)
		const bottom = Math.max(oldBottom, ink.y + ink.height + padding)
		if (left === oldLeft && top === oldTop && right === oldRight && bottom === oldBottom) return null
		const candidate = svg.cloneNode(true) as SVGSVGElement
		candidate.setAttribute('viewBox', `${left} ${top} ${right - left} ${bottom - top}`)
		candidate.setAttribute('width', `${(right - left) * scale}em`)
		candidate.setAttribute('height', `${(bottom - top) * scale}em`)
		candidate.style.verticalAlign = `${baseline + (oldBottom - bottom) * scale}em`
		const invalid = validateMathSvg(candidate.outerHTML)
		if (invalid) return `Formula visible ink exceeds the canvas budget: ${invalid}`
		for (const name of ['viewBox', 'width', 'height', 'style']) svg.setAttribute(name, candidate.getAttribute(name)!)
		if (svg.parentElement?.classList.contains('dil-math')) svg.parentElement.setAttribute('data-d-math-ink', '')
		return null
	} catch {
		return 'Formula visible ink could not be measured'
	}
}

/** Defer hidden DOM measurement, then fit once; the owner releases this on update/destroy. */
export function fitMathCanvasWhenVisible(svg: SVGSVGElement, onError: (message: string) => void): () => void {
	let stopped = false
	let observer: ResizeObserver | undefined
	const visible = () => typeof svg.checkVisibility !== 'function' || svg.checkVisibility()
	const fit = () => {
		if (stopped || !visible()) return
		stopped = true
		observer?.disconnect()
		const error = fitMathCanvas(svg)
		if (error) onError(error)
	}
	if (visible()) fit()
	else {
		const Observer = svg.ownerDocument.defaultView?.ResizeObserver
		if (!Observer) onError('Formula canvas cannot be measured until visible')
		else {
			observer = new Observer(fit)
			observer.observe(svg)
		}
	}
	return () => { stopped = true; observer?.disconnect() }
}
