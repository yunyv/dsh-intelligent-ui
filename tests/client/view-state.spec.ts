// @vitest-environment node
/**
 * The keyed-state reporter.
 *
 * Its whole job is to turn a burst of keystrokes into one update carrying the latest
 * full state, and to be explicit about the three ways that can end: sent, held because
 * the destination is not addressable yet, or dropped because the sink threw. The sink is
 * a callback here rather than a POST, which is the one change from upstream — the
 * destination belongs to the host half.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_SESSION_ID, createStateReporter, STATE_REPORT_DELAY_MS, uuid } from '../../src/client/dil/view-state.ts'
import type { DilStateReport } from '../../src/client/dil/view-state.ts'

afterEach(() => {
	vi.useRealTimers()
})

/** One reporter over a recording sink. */
function reporter(options: { ready?: () => boolean; throwOnSend?: boolean } = {}) {
	const reports: DilStateReport[] = []
	const errors: unknown[] = []
	const instance = createStateReporter({
		send: (report) => {
			if (options.throwOnSend) throw new Error('the sink is gone')
			reports.push(report)
		},
		...(options.ready ? { ready: options.ready } : {}),
		onError: (error) => errors.push(error)
	})
	return { instance, reports, errors }
}

describe('coalescing', () => {
	it('sends one update for a burst, carrying the last state', () => {
		vi.useFakeTimers()
		const test = reporter()
		test.instance.queue({ typed: 'a' })
		test.instance.queue({ typed: 'ab' })
		test.instance.queue({ typed: 'abc' })
		expect(test.instance.hasPending).toBe(true)
		expect(test.reports).toHaveLength(0)
		vi.advanceTimersByTime(STATE_REPORT_DELAY_MS)
		expect(test.reports).toHaveLength(1)
		expect(test.reports[0]!.updates).toEqual([
			{ scope: 'root', state: { typed: 'abc' }, client_update_id: expect.any(String) }
		])
		expect(test.instance.hasPending).toBe(false)
	})

	it('opens a fresh window after each report', () => {
		vi.useFakeTimers()
		const test = reporter()
		test.instance.queue({ n: 1 })
		vi.advanceTimersByTime(STATE_REPORT_DELAY_MS)
		test.instance.queue({ n: 2 })
		vi.advanceTimersByTime(STATE_REPORT_DELAY_MS)
		expect(test.reports.map((report) => report.updates[0]!.state)).toEqual([{ n: 1 }, { n: 2 }])
	})

	it('carries the scope a report belongs to', () => {
		vi.useFakeTimers()
		const test = reporter()
		test.instance.queue({ tab: 'x' }, 'panel:1')
		vi.advanceTimersByTime(STATE_REPORT_DELAY_MS)
		expect(test.reports[0]!.updates[0]!.scope).toBe('panel:1')
	})

	it('flushes on demand, without waiting for the window', () => {
		vi.useFakeTimers()
		const test = reporter()
		test.instance.queue({ n: 1 })
		expect(test.instance.flush()).toBe(true)
		expect(test.reports).toHaveLength(1)
		expect(test.instance.flush()).toBe(false)
	})

	it('drops a pending change on cancel', () => {
		vi.useFakeTimers()
		const test = reporter()
		test.instance.queue({ n: 1 })
		test.instance.cancel()
		const pending = test.instance.hasPending
		vi.advanceTimersByTime(STATE_REPORT_DELAY_MS * 4)
		expect(pending).toBe(false)
		expect(test.reports).toHaveLength(0)
	})
})

describe('the destination', () => {
	it('holds the state until the destination says it is addressable', () => {
		vi.useFakeTimers()
		let addressable = false
		const test = reporter({ ready: () => addressable })
		test.instance.queue({ n: 1 })
		vi.advanceTimersByTime(STATE_REPORT_DELAY_MS)
		expect(test.reports).toHaveLength(0)
		// The pending change survived, so the caller can retry it once the ids are known.
		expect(test.instance.hasPending).toBe(true)
		addressable = true
		expect(test.instance.flush()).toBe(true)
		expect(test.reports).toHaveLength(1)
	})

	it('reports a sink that throws instead of losing the turn silently', () => {
		vi.useFakeTimers()
		const test = reporter({ throwOnSend: true })
		test.instance.queue({ n: 1 })
		expect(test.instance.flush()).toBe(false)
		expect(test.errors).toHaveLength(1)
		expect(String((test.errors[0] as Error).message)).toContain('sink is gone')
	})
})

describe('identity', () => {
	it('reports the client session and one fresh id per update', () => {
		vi.useFakeTimers()
		const test = reporter()
		test.instance.queue({ n: 1 })
		vi.advanceTimersByTime(STATE_REPORT_DELAY_MS)
		test.instance.queue({ n: 2 })
		vi.advanceTimersByTime(STATE_REPORT_DELAY_MS)
		const [first, second] = test.reports
		expect(first!.client_session_id).toBe(CLIENT_SESSION_ID)
		expect(second!.client_session_id).toBe(CLIENT_SESSION_ID)
		expect(first!.updates[0]!.client_update_id).not.toBe(second!.updates[0]!.client_update_id)
	})

	it('generates v4 uuids', () => {
		expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
	})
})
