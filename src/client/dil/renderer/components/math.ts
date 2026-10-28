/** Host-native DIL math: the model supplies TeX data, never DOM or executable code. */
import { MAX_MATH_INPUT_LENGTH } from '../../math/protocol.ts'
import { renderMathIsolated } from '../../math/service.ts'
import { fitMathCanvasWhenVisible } from '../../math/canvas.ts'
import type { DilHandle, DilProps } from '../../types.ts'
import { applyCommon, cls, el } from '../dom.ts'

function math(props: DilProps): DilHandle {
	const node = el('span')
	node.setAttribute('role', 'math')
	const retry = el('button')
	retry.type = 'button'
	retry.className = 'dil-button dil-variant-ghost dil-size-xs'
	retry.textContent = 'Retry'
	retry.setAttribute('data-d-math-retry', '')
	retry.setAttribute('aria-label', 'Retry formula')
	let generation = 0
	let controller: AbortController | undefined
	let previousTex: unknown
	let previousDisplay: boolean | undefined
	let destroyed = false
	let stopCanvas: (() => void) | undefined
	function cancelCanvas(): void { stopCanvas?.(); stopCanvas = undefined; node.removeAttribute('data-d-math-ink') }

	function showError(tex: unknown, message: string): void {
		cancelCanvas()
		node.textContent = typeof tex === 'string' ? tex.slice(0, 500) + (tex.length > 500 ? '…' : '') : '[math]'
		node.classList.remove('dil-math-pending')
		node.classList.add('dil-math-error')
		node.setAttribute('data-d-math-status', 'error')
		node.setAttribute('title', message.slice(0, 240))
		node.removeAttribute('aria-busy')
		retry.disabled = !(typeof tex === 'string' && tex.trim().length > 0 && tex.length <= MAX_MATH_INPUT_LENGTH)
		if (!retry.disabled) node.append(retry)
	}

	function start(tex: unknown, display: boolean): void {
		const current = ++generation
		cancelCanvas(); controller?.abort()
		controller = undefined
		retry.disabled = true
		node.setAttribute('aria-label', typeof tex === 'string' ? tex.slice(0, MAX_MATH_INPUT_LENGTH) : 'math')
		node.removeAttribute('title')
		node.classList.remove('dil-math-error')
		if (typeof tex !== 'string' || tex.length > MAX_MATH_INPUT_LENGTH) {
			showError(tex, typeof tex !== 'string' ? 'math.tex must be a string' : 'Formula exceeds the input limit')
			return
		}
		if (!tex.trim()) {
			node.textContent = ''
			node.classList.remove('dil-math-pending')
			node.setAttribute('data-d-math-status', 'ready')
			node.removeAttribute('aria-busy')
			return
		}
		const abort = new AbortController()
		controller = abort
		node.textContent = tex.slice(0, 500)
		node.classList.add('dil-math-pending')
		node.setAttribute('data-d-math-status', 'pending')
		node.setAttribute('aria-busy', 'true')
		void renderMathIsolated(tex, display, abort.signal).then((result) => {
			if (destroyed || current !== generation || abort.signal.aborted) return
			if (!result.ok) {
				showError(tex, result.error)
				return
			}
			// The service accepts only a bounded, inert SVG dialect from our fixed
			// offline engine. Neither arbitrary model HTML nor a renderer URL enters.
			node.classList.remove('dil-math-pending', 'dil-math-error')
			node.innerHTML = result.svg
			const svg = node.firstElementChild as SVGSVGElement | null
			let canvasError: string | undefined
			const stop = svg ? fitMathCanvasWhenVisible(svg, message => {
				canvasError = message
				if (!destroyed && current === generation && !abort.signal.aborted) showError(tex, message)
			}) : undefined
			if (canvasError) { stop?.(); return }
			stopCanvas = stop
			node.setAttribute('data-d-math-status', 'ready')
			node.removeAttribute('aria-busy')
		}).catch(() => {
			if (!destroyed && current === generation && !abort.signal.aborted) showError(tex, 'Formula rendering failed')
		})
	}

	function onRetry(event: Event): void {
		event.preventDefault()
		event.stopPropagation()
		if (destroyed || retry.disabled || node.getAttribute('data-d-math-status') !== 'error') return
		start(previousTex, previousDisplay === true)
	}

	function update(p: DilProps): void {
		if (destroyed) return
		const display = p.display === true
		applyCommon(node, p)
		const status = node.getAttribute('data-d-math-status')
		node.className = cls('dil-math', [display, 'dil-math-display'], [p.size, `dil-size-${p.size}`], [p.color, `dil-color-${p.color}`], [status === 'pending', 'dil-math-pending'], [status === 'error', 'dil-math-error'])
		if (p.tex === previousTex && display === previousDisplay) return
		previousTex = p.tex
		previousDisplay = display
		start(p.tex, display)
	}

	retry.addEventListener('click', onRetry)
	update(props)
	return {
		node,
		update,
		acceptsChildren: false,
		destroy(): void {
			if (destroyed) return
			destroyed = true
			generation++
			cancelCanvas(); controller?.abort()
			controller = undefined
			retry.disabled = true
			retry.removeEventListener('click', onRetry)
		}
	}
}

export default { math }
