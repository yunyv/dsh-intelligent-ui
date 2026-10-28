/**
 * One bounded, cancellable queue for the host's dedicated offline math Worker.
 * MathJax never runs on the page or in the model's DIL execution Worker.
 */
import { MATH_WORKER_SOURCE } from './generated/worker-source.ts'
import { MAX_MATH_INPUT_LENGTH, validateMathSvg, type MathRenderResult } from './protocol.ts'

export const MATH_TIMEOUT_MS = 2000
export const MAX_PENDING_MATH = 32

/** The small part of Worker used here, also implemented by the deterministic tests. */
export interface MathWorker {
	onmessage: ((event: { data: unknown }) => void) | null
	onerror: ((event: { preventDefault?(): void }) => void) | null
	onmessageerror: ((event: unknown) => void) | null
	postMessage(message: unknown): void
	terminate(): void
}

export interface MathServiceOptions {
	makeWorker?: () => MathWorker
	timeoutMs?: number
	maxPending?: number
	idleMs?: number
}

export interface MathService {
	render(tex: string, display?: boolean, signal?: AbortSignal): Promise<MathRenderResult>
	dispose(): void
}

interface Job {
	id: number
	tex: string
	display: boolean
	signal?: AbortSignal
	onAbort?: () => void
	resolve(result: MathRenderResult): void
	done: boolean
}

const failure = (message: string): MathRenderResult => ({ ok: false, error: message.slice(0, 240) })

function browserWorker(): MathWorker {
	if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL.createObjectURL !== 'function') {
		throw new Error('Formula rendering requires Web Workers')
	}
	const url = URL.createObjectURL(new Blob([MATH_WORKER_SOURCE], { type: 'text/javascript' }))
	try {
		// A classic IIFE, with its engine and all NewCM SVG data already inside.
		return new Worker(url, { name: 'dsh-dil-math-newcm' }) as unknown as MathWorker
	} finally {
		URL.revokeObjectURL(url)
	}
}

/** Create a service without starting a Worker until a nonempty formula is requested. */
export function createMathService(options: MathServiceOptions = {}): MathService {
	const makeWorker = options.makeWorker ?? browserWorker
	const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0 ? Math.min(options.timeoutMs!, 60_000) : MATH_TIMEOUT_MS
	const maxPending = Number.isFinite(options.maxPending) && options.maxPending! >= 1 ? Math.min(Math.floor(options.maxPending!), MAX_PENDING_MATH) : MAX_PENDING_MATH
	const idleMs = Number.isFinite(options.idleMs) && options.idleMs! >= 0 ? Math.min(options.idleMs!, 60_000) : 1000
	const queue: Job[] = []
	let worker: MathWorker | undefined
	let active: Job | undefined
	let deadline: ReturnType<typeof setTimeout> | undefined
	let idle: ReturnType<typeof setTimeout> | undefined
	let sequence = 0
	let disposed = false

	function clearIdle(): void {
		if (idle !== undefined) clearTimeout(idle)
		idle = undefined
	}

	function stopWorker(): void {
		clearIdle()
		if (!worker) return
		const previous = worker
		worker = undefined
		previous.onmessage = previous.onerror = previous.onmessageerror = null
		try { previous.terminate() } catch { /* teardown must not strand queued requests */ }
	}

	function settle(job: Job, result: MathRenderResult): void {
		if (job.done) return
		job.done = true
		if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort)
		job.resolve(result)
	}

	function finish(result: MathRenderResult, reset = false): void {
		const job = active
		if (!job) return
		active = undefined
		if (deadline !== undefined) clearTimeout(deadline)
		deadline = undefined
		if (reset) stopWorker()
		settle(job, result)
		pump()
	}

	function getWorker(): MathWorker {
		if (worker) return worker
		const made = makeWorker()
		worker = made
		made.onmessage = (event): void => {
			if (worker !== made || !active) return
			const data = event.data as { id?: unknown; result?: unknown } | null
			if (!data || typeof data !== 'object' || data.id !== active.id) return
			// Cancellation settles the consumer, not the Worker's actual execution.
			// Only its matching completion (or the original deadline/error) frees this slot.
			if (active.done) {
				finish(failure('Formula rendering was cancelled'))
				return
			}
			const result = data.result as Partial<{ ok: unknown; svg: unknown; error: unknown }> | null
			if (!result || typeof result !== 'object') {
				finish(failure('Invalid formula Worker response'), true)
			} else if (result.ok === true && typeof result.svg === 'string') {
				const invalid = validateMathSvg(result.svg)
				finish(invalid ? failure(invalid) : { ok: true, svg: result.svg }, !!invalid)
			} else if (result.ok === false && typeof result.error === 'string') {
				finish(failure(result.error))
			} else {
				finish(failure('Invalid formula Worker response'), true)
			}
		}
		made.onerror = (event): void => {
			if (worker !== made) return
			event.preventDefault?.()
			if (active) finish(failure('Formula Worker failed'), true)
			else stopWorker()
		}
		made.onmessageerror = (): void => {
			if (worker !== made) return
			if (active) finish(failure('Invalid formula Worker message'), true)
			else stopWorker()
		}
		return made
	}

	function pump(): void {
		if (disposed || active) return
		clearIdle()
		let next = queue.shift()
		while (next?.done) next = queue.shift()
		if (!next) {
			if (worker) idle = setTimeout(stopWorker, idleMs)
			return
		}
		active = next
		deadline = setTimeout(() => finish(failure('Formula rendering timed out'), true), timeoutMs)
		try {
			getWorker().postMessage({ id: next.id, tex: next.tex, display: next.display })
		} catch {
			finish(failure('Formula Worker is unavailable'), true)
		}
	}

	return {
		render(tex, display = false, signal): Promise<MathRenderResult> {
			if (disposed) return Promise.resolve(failure('Formula service has been disposed'))
			if (signal?.aborted) return Promise.resolve(failure('Formula rendering was cancelled'))
			if (typeof tex !== 'string') return Promise.resolve(failure('math.tex must be a string'))
			if (tex.length > MAX_MATH_INPUT_LENGTH) return Promise.resolve(failure('Formula exceeds the input limit'))
			if (!tex.trim()) return Promise.resolve({ ok: true, svg: '' })
			if (queue.length + (active ? 1 : 0) >= maxPending) return Promise.resolve(failure('Too many pending formulas'))
			return new Promise((resolve) => {
				const job: Job = { id: ++sequence, tex, display: display === true, signal, resolve, done: false }
				job.onAbort = (): void => {
					if (job.done) return
					if (active === job) {
						// Retain the running job and its original deadline: do not enqueue
						// more work in the Worker or rebuild it for a consumer cancellation.
						settle(job, failure('Formula rendering was cancelled'))
					} else {
						const index = queue.indexOf(job)
						if (index >= 0) queue.splice(index, 1)
						settle(job, failure('Formula rendering was cancelled'))
					}
				}
				signal?.addEventListener('abort', job.onAbort, { once: true })
				queue.push(job)
				if (signal?.aborted) job.onAbort()
				pump()
			})
		},
		dispose(): void {
			if (disposed) return
			disposed = true
			if (deadline !== undefined) clearTimeout(deadline)
			deadline = undefined
			stopWorker()
			const previous = active
			active = undefined
			if (previous) settle(previous, failure('Formula service has been disposed'))
			for (const job of queue.splice(0)) settle(job, failure('Formula service has been disposed'))
		}
	}
}

let sharedService: MathService | undefined

/** Shared across views, but never across the DIL sandbox boundary. */
export function renderMathIsolated(tex: string, display = false, signal?: AbortSignal): Promise<MathRenderResult> {
	sharedService ??= createMathService()
	return sharedService.render(tex, display, signal)
}
