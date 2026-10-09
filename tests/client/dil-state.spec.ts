/**
 * The channel that keeps an artifact's two mounts in step.
 *
 * The panel used to refuse to render a DIL revision at all, on the grounds that a
 * second copy would put two live instances of one state on screen. This is the
 * channel that removes the objection: the copies share the state, so they are views
 * of one interface. The loop guard is the part worth testing on its own, because
 * getting it wrong hangs the tab rather than failing a render.
 */
import { describe, expect, it, vi } from 'vitest'
import { dilStateOf, publishDilState, subscribeDilState } from '../../src/client/dil-state.ts'

describe('shared interface state', () => {
	it('opens a later mount where the first one left off', () => {
		expect(dilStateOf('art-open')).toEqual({})
		publishDilState('art-open', { n: 8 })
		expect(dilStateOf('art-open')).toEqual({ n: 8 })
	})

	it('hands a change to the other mount and not to the one that made it', () => {
		const publisher = vi.fn()
		const other = vi.fn()
		const stopA = subscribeDilState('art-pair', publisher)
		const stopB = subscribeDilState('art-pair', other)

		publishDilState('art-pair', { n: 30 }, publisher)

		expect(publisher, 'a mount is never told its own news').not.toHaveBeenCalled()
		expect(other).toHaveBeenCalledWith({ n: 30 })
		stopA()
		stopB()
	})

	it('drops a payload it already holds, so two mounts cannot echo forever', () => {
		const seen = vi.fn()
		const stop = subscribeDilState('art-echo', seen)

		publishDilState('art-echo', { n: 12 })
		expect(seen).toHaveBeenCalledTimes(1)

		// A mount adopting the state it was just handed reports the same values back.
		// Without this guard the pair would trade them for as long as the tab is open.
		publishDilState('art-echo', { n: 12 })
		publishDilState('art-echo', { n: 12 })
		expect(seen).toHaveBeenCalledTimes(1)

		// A real change still travels.
		publishDilState('art-echo', { n: 13 })
		expect(seen).toHaveBeenCalledTimes(2)
		stop()
	})

	it('keeps artifacts apart and stops listening once told to', () => {
		const seen = vi.fn()
		const stop = subscribeDilState('art-one', seen)

		publishDilState('art-two', { n: 1 })
		expect(seen, 'another artifact must not move this one').not.toHaveBeenCalled()

		publishDilState('art-one', { n: 2 })
		expect(seen).toHaveBeenCalledTimes(1)

		stop()
		publishDilState('art-one', { n: 3 })
		expect(seen).toHaveBeenCalledTimes(1)
	})

	it('survives a mount that throws when it is handed the news', () => {
		const healthy = vi.fn()
		const stopBad = subscribeDilState('art-bad', () => { throw new Error('this mount is gone') })
		const stopGood = subscribeDilState('art-bad', healthy)

		expect(() => publishDilState('art-bad', { n: 4 })).not.toThrow()
		expect(healthy, 'a dead mount must not cost the live one').toHaveBeenCalledWith({ n: 4 })

		stopBad()
		stopGood()
	})
})
