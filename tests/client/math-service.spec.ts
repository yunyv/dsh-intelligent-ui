import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMathService, type MathService, type MathWorker } from '../../src/client/dil/math/service.ts'
import type { MathRenderResult } from '../../src/client/dil/math/protocol.ts'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 1000 1000"><path d="M0 0L1 1"/></svg>'
const GOOD: MathRenderResult = { ok: true, svg: SVG }

class FakeWorker implements MathWorker {
	onmessage: MathWorker['onmessage'] = null
	onerror: MathWorker['onerror'] = null
	onmessageerror: MathWorker['onmessageerror'] = null
	messages: { id: number; tex: string; display: boolean }[] = []
	terminated = false
	postMessage(value: unknown): void { this.messages.push(value as typeof this.messages[number]) }
	terminate(): void { this.terminated = true }
	reply(result: unknown = GOOD, id = this.messages.at(-1)!.id): void { this.onmessage?.({ data: { id, result } }) }
}
let workers: FakeWorker[]
let services: MathService[]
function service(options: Parameters<typeof createMathService>[0] = {}): MathService {
	const made = createMathService({
		makeWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker },
		...options
	})
	services.push(made)
	return made
}

beforeEach(() => { vi.useFakeTimers(); workers = []; services = [] })
afterEach(() => {
	for (const created of services) created.dispose()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe('bounded offline formula Worker service', () => {
	it('is lazy and validates empty, invalid and oversized input without creating a Worker', async () => {
		const client = service()
		expect(workers).toHaveLength(0)
		expect(await client.render('  ')).toEqual({ ok: true, svg: '' })
		expect(await client.render(7 as unknown as string)).toMatchObject({ ok: false })
		expect(await client.render('x'.repeat(8193))).toMatchObject({ ok: false })
		expect(workers).toHaveLength(0)
	})

	it('serializes requests through one Worker and reuses it while work is queued', async () => {
		const client = service()
		const first = client.render('x')
		const second = client.render('y', true)
		expect(workers).toHaveLength(1)
		expect(workers[0]!.messages).toHaveLength(1)
		workers[0]!.reply()
		expect(await first).toEqual(GOOD)
		expect(workers[0]!.messages).toHaveLength(2)
		expect(workers[0]!.messages[1]).toMatchObject({ tex: 'y', display: true })
		workers[0]!.reply()
		expect(await second).toEqual(GOOD)
	})

	it('caps pending requests without starting additional Workers', async () => {
		const client = service({ maxPending: 2 })
		const first = client.render('x')
		const second = client.render('y')
		expect(await client.render('overflow')).toMatchObject({ ok: false, error: expect.stringContaining('pending') })
		expect(workers).toHaveLength(1)
		workers[0]!.reply()
		workers[0]!.reply()
		expect(await first).toEqual(GOOD)
		expect(await second).toEqual(GOOD)
	})

	it('does not enqueue a signal that has already been cancelled', async () => {
		const abort = new AbortController()
		abort.abort()
		expect(await service().render('x', false, abort.signal)).toMatchObject({ ok: false, error: expect.stringContaining('cancelled') })
		expect(workers).toHaveLength(0)
	})

	it('settles a cancelled consumer but retains the real in-flight slot until its reply', async () => {
		const client = service()
		const abort = new AbortController()
		const first = client.render('x', false, abort.signal)
		const second = client.render('y')
		const made = workers[0]!
		const firstId = made.messages[0]!.id
		let secondDone = false
		void second.then(() => { secondDone = true })
		abort.abort()
		expect(await first).toMatchObject({ ok: false, error: expect.stringContaining('cancelled') })
		expect(made.terminated).toBe(false)
		expect(workers).toHaveLength(1)
		expect(made.messages).toHaveLength(1)
		made.reply(GOOD, firstId + 1)
		await Promise.resolve()
		expect(secondDone).toBe(false)
		expect(made.messages).toHaveLength(1)
		made.reply(GOOD, firstId)
		expect(made.messages).toHaveLength(2)
		expect(made.messages[1]).toMatchObject({ tex: 'y' })
		made.reply({ ok: false, error: 'stale' }, firstId)
		await Promise.resolve()
		expect(secondDone).toBe(false)
		made.reply()
		expect(await second).toEqual(GOOD)
		expect(workers).toHaveLength(1)
	})

	it('does not build a cascade when all 32 pending consumers cancel', async () => {
		const client = service({ idleMs: 100 })
		const aborts = Array.from({ length: 32 }, () => new AbortController())
		const pending = aborts.map((abort, i) => client.render(`x_${i}`, false, abort.signal))
		const made = workers[0]!
		for (const abort of aborts) abort.abort()
		expect((await Promise.all(pending)).every(result => !result.ok && result.error.includes('cancelled'))).toBe(true)
		expect(workers).toHaveLength(1)
		expect(made.messages).toHaveLength(1)
		expect(made.terminated).toBe(false)
		made.reply()
		expect(made.messages).toHaveLength(1)
		vi.advanceTimersByTime(99)
		expect(made.terminated).toBe(false)
		vi.advanceTimersByTime(1)
		expect(made.terminated).toBe(true)
		expect(workers).toHaveLength(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('keeps high-frequency replacements in the host queue, not in the busy Worker', async () => {
		const client = service()
		let abort = new AbortController()
		const cancelled = [client.render('original', false, abort.signal)]
		const made = workers[0]!
		const firstId = made.messages[0]!.id
		let latest = cancelled[0]!
		for (let i = 0; i < 40; i++) {
			abort.abort()
			abort = new AbortController()
			latest = client.render(`replacement_${i}`, false, abort.signal)
			if (i < 39) cancelled.push(latest)
		}
		expect((await Promise.all(cancelled)).every(result => !result.ok && result.error.includes('cancelled'))).toBe(true)
		expect(workers).toHaveLength(1)
		expect(made.messages).toHaveLength(1)
		made.reply(GOOD, firstId)
		expect(made.messages).toHaveLength(2)
		expect(made.messages[1]).toMatchObject({ tex: 'replacement_39' })
		made.reply()
		expect(await latest).toEqual(GOOD)
		expect(workers).toHaveLength(1)
	})

	it('retains the original execution deadline after cancellation before dispatching queued work', async () => {
		const client = service({ timeoutMs: 40, idleMs: 60_000 })
		const abort = new AbortController()
		const first = client.render('slow', false, abort.signal)
		const old = workers[0]!
		const oldCallback = old.onmessage!
		vi.advanceTimersByTime(15)
		abort.abort()
		expect(await first).toMatchObject({ ok: false, error: expect.stringContaining('cancelled') })
		const second = client.render('next')
		vi.advanceTimersByTime(24)
		expect(workers).toHaveLength(1)
		expect(old.messages).toHaveLength(1)
		expect(old.terminated).toBe(false)
		vi.advanceTimersByTime(1)
		expect(old.terminated).toBe(true)
		expect(workers).toHaveLength(2)
		expect(workers[1]!.messages).toHaveLength(1)
		oldCallback({ data: { id: workers[1]!.messages[0]!.id, result: { ok: false, error: 'stale' } } })
		workers[1]!.reply()
		expect(await second).toEqual(GOOD)
	})

	it('still terminates a cancelled lone computation at its original deadline', async () => {
		const client = service({ timeoutMs: 40, idleMs: 60_000 })
		const abort = new AbortController()
		const first = client.render('stuck', false, abort.signal)
		const made = workers[0]!
		vi.advanceTimersByTime(15)
		abort.abort()
		expect(await first).toMatchObject({ ok: false, error: expect.stringContaining('cancelled') })
		expect(made.terminated).toBe(false)
		vi.advanceTimersByTime(24)
		expect(made.terminated).toBe(false)
		vi.advanceTimersByTime(1)
		expect(made.terminated).toBe(true)
		expect(workers).toHaveLength(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('counts an unsettled execution against capacity even after its consumer cancels', async () => {
		const client = service({ maxPending: 1 })
		const abort = new AbortController()
		const first = client.render('x', false, abort.signal)
		abort.abort()
		expect(await first).toMatchObject({ ok: false, error: expect.stringContaining('cancelled') })
		let admission: MathRenderResult | undefined
		void client.render('too soon').then(result => { admission = result })
		await Promise.resolve()
		expect(admission).toMatchObject({ ok: false, error: expect.stringContaining('pending') })
		expect(workers).toHaveLength(1)
		expect(workers[0]!.messages).toHaveLength(1)
		workers[0]!.reply()
		const next = client.render('after completion')
		workers[0]!.reply()
		expect(await next).toEqual(GOOD)
		expect(workers).toHaveLength(1)
	})

	it.each(['error', 'messageerror'] as const)('hard-resets a cancelled computation after Worker %s', async (kind) => {
		const client = service()
		const abort = new AbortController()
		const first = client.render('x', false, abort.signal)
		const second = client.render('y')
		abort.abort()
		expect(await first).toMatchObject({ ok: false, error: expect.stringContaining('cancelled') })
		expect(workers).toHaveLength(1)
		if (kind === 'error') workers[0]!.onerror?.({ preventDefault: vi.fn() })
		else workers[0]!.onmessageerror?.({})
		expect(workers[0]!.terminated).toBe(true)
		expect(workers).toHaveLength(2)
		workers[1]!.reply()
		expect(await second).toEqual(GOOD)
	})

	it('disposes an already-cancelled active task and queued consumers without leaked timers', async () => {
		const client = service({ timeoutMs: 40, idleMs: 60_000 })
		const abort = new AbortController()
		const first = client.render('x', false, abort.signal)
		const second = client.render('y')
		abort.abort()
		expect(await first).toMatchObject({ ok: false, error: expect.stringContaining('cancelled') })
		expect(workers).toHaveLength(1)
		client.dispose()
		client.dispose()
		expect(workers[0]!.terminated).toBe(true)
		expect(await second).toMatchObject({ ok: false, error: expect.stringContaining('disposed') })
		expect(vi.getTimerCount()).toBe(0)
	})

	it('removes a cancelled queued request without killing the active one', async () => {
		const client = service()
		const abort = new AbortController()
		const unlisten = vi.spyOn(abort.signal, 'removeEventListener')
		const first = client.render('x')
		const second = client.render('y', false, abort.signal)
		abort.abort()
		expect(await second).toMatchObject({ ok: false })
		expect(unlisten).toHaveBeenCalled()
		expect(workers[0]!.terminated).toBe(false)
		workers[0]!.reply()
		expect(await first).toEqual(GOOD)
		expect(workers[0]!.messages).toHaveLength(1)
	})

	it('terminates a timed-out Worker and recovers for a queued normal formula', async () => {
		const client = service({ timeoutMs: 20 })
		const first = client.render('slow')
		const second = client.render('normal')
		vi.advanceTimersByTime(20)
		expect(await first).toMatchObject({ ok: false, error: expect.stringContaining('timed out') })
		expect(workers[0]!.terminated).toBe(true)
		expect(workers).toHaveLength(2)
		workers[1]!.reply()
		expect(await second).toEqual(GOOD)
	})

	it.each(['error', 'messageerror', 'malformed'] as const)('rebuilds after a Worker %s', async (kind) => {
		const client = service()
		const first = client.render('bad')
		const second = client.render('good')
		if (kind === 'error') workers[0]!.onerror?.({ preventDefault: vi.fn() })
		else if (kind === 'messageerror') workers[0]!.onmessageerror?.({})
		else workers[0]!.reply({ ok: 'not a boolean' })
		expect(await first).toMatchObject({ ok: false })
		expect(workers[0]!.terminated).toBe(true)
		workers[1]!.reply()
		expect(await second).toEqual(GOOD)
	})

	it('validates SVG before returning it to the DOM and recovers after rejection', async () => {
		const client = service()
		const first = client.render('bad')
		const second = client.render('good')
		workers[0]!.reply({ ok: true, svg: '<svg onload="alert(1)"><script/></svg>' })
		expect(await first).toMatchObject({ ok: false })
		expect(workers[0]!.terminated).toBe(true)
		workers[1]!.reply()
		expect(await second).toEqual(GOOD)
	})

	it('ignores unrelated IDs instead of applying another request’s result', async () => {
		const client = service()
		const result = client.render('x')
		let resolved = false
		void result.then(() => { resolved = true })
		workers[0]!.reply(GOOD, 999)
		await Promise.resolve()
		expect(resolved).toBe(false)
		workers[0]!.reply()
		expect(await result).toEqual(GOOD)
	})

	it('handles unavailable workers without synchronous engine fallback', async () => {
		let tries = 0
		const client = service({ makeWorker: () => { tries++; throw new Error('CSP') } })
		expect(await client.render('x')).toMatchObject({ ok: false, error: expect.stringContaining('unavailable') })
		expect(await client.render('y')).toMatchObject({ ok: false })
		expect(tries).toBe(2)
	})

	it('settles all pending promises on dispose, even when called twice', async () => {
		const client = service()
		const first = client.render('x')
		const second = client.render('y')
		client.dispose()
		client.dispose()
		expect(workers[0]!.terminated).toBe(true)
		expect(await first).toMatchObject({ ok: false, error: expect.stringContaining('disposed') })
		expect(await second).toMatchObject({ ok: false })
		expect(await client.render('z')).toMatchObject({ ok: false })
		expect(vi.getTimerCount()).toBe(0)
	})

	it('releases an idle Worker and starts a fresh one on later replay', async () => {
		const client = service({ idleMs: 100 })
		const first = client.render('x')
		workers[0]!.reply()
		expect(await first).toEqual(GOOD)
		vi.advanceTimersByTime(100)
		expect(workers[0]!.terminated).toBe(true)
		const second = client.render('x')
		expect(workers).toHaveLength(2)
		workers[1]!.reply()
		expect(await second).toEqual(GOOD)
	})

	it('revokes the Blob URL after constructing the default classic Worker', async () => {
		const makeURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:offline-math')
		const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
		vi.stubGlobal('Worker', class extends FakeWorker {
			constructor(url: string, options: { name: string }) {
				super()
				expect(url).toBe('blob:offline-math')
				expect(options.name).toBe('dsh-dil-math-newcm')
				workers.push(this)
			}
		})
		const client = createMathService()
		services.push(client)
		const result = client.render('x')
		expect(makeURL).toHaveBeenCalledOnce()
		expect(revoke).toHaveBeenCalledWith('blob:offline-math')
		workers[0]!.reply()
		expect(await result).toEqual(GOOD)
	})
})
