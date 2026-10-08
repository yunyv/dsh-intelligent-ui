// @vitest-environment node
/**
 * The streamed message model, and the SSE turn that feeds it.
 *
 * The patch algebra is what makes a half-written artifact renderable, so it is pinned
 * case by case; the turn wrapper is pinned against a fake `EventSource`, because the
 * routing rules (a `delta` is a patch *or* the completion, `[DONE]` closes, a dropped
 * connection is a failure rather than a reconnect) are the contract with the host half.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyPatch, compiledOf, emptyMessage, openTurn, patchCarriesCode } from '../../src/client/dil/stream.ts'
import type { TurnHandlers } from '../../src/client/dil/stream.ts'

/** A stand-in for the browser's `EventSource`, driven by the test. */
class FakeEventSource {
	static CLOSED = 2
	static instances: FakeEventSource[] = []
	readonly listeners = new Map<string, ((event: { data: string }) => void)[]>()
	onmessage: ((event: { data: string }) => void) | null = null
	onerror: (() => void) | null = null
	readyState = 1
	closed = false

	constructor(readonly url: string) {
		FakeEventSource.instances.push(this)
	}

	addEventListener(type: string, listener: (event: { data: string }) => void): void {
		const list = this.listeners.get(type) ?? []
		list.push(listener)
		this.listeners.set(type, list)
	}

	close(): void {
		this.closed = true
		this.readyState = FakeEventSource.CLOSED
	}

	/** Deliver one named event carrying JSON. */
	emit(type: string, payload: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(payload) })
	}

	/** Deliver one unnamed message, which is where `[DONE]` arrives. */
	raw(data: string): void {
		this.onmessage?.({ data })
	}

	/** Drop the connection, as a dead socket would. */
	drop(): void {
		this.onerror?.()
	}
}

afterEach(() => {
	FakeEventSource.instances = []
	vi.unstubAllGlobals()
})

describe('the message model', () => {
	it('starts empty but already carrying the compiled revision slot', () => {
		const message = emptyMessage('msg_1')
		expect(message).toMatchObject({
			id: 'msg_1',
			status: 'in_progress',
			content: { content_type: 'text', parts: [''] },
			metadata: { model_dil_v2: { code: '', constants: {}, appData: {} }, genui_components: [] }
		})
	})

	it('replaces, adds and creates intermediate containers', () => {
		const message = emptyMessage()
		applyPatch(message, { p: '/message/status', v: 'finished_successfully' })
		applyPatch(message, { p: '/message/metadata/model_dil_v2/code', o: 'add', v: 'DIL.render()' })
		applyPatch(message, { p: '/message/metadata/model_dil_v2/stateKeys/0', v: 'tab' })
		applyPatch(message, { p: '/message/metadata/genui_components/0/id', v: 'cmp-1' })
		expect(message.status).toBe('finished_successfully')
		expect(message.metadata.model_dil_v2.code).toBe('DIL.render()')
		expect(message.metadata.model_dil_v2.stateKeys).toEqual(['tab'])
		expect(message.metadata.genui_components).toEqual([{ id: 'cmp-1' }])
	})

	it('append accumulates a string and a list', () => {
		const message = emptyMessage()
		applyPatch(message, { p: '/message/content/parts/0', o: 'append', v: 'hel' })
		applyPatch(message, { p: '/message/content/parts/0', o: 'append', v: 'lo' })
		applyPatch(message, { p: '/message/metadata/genui_components', o: 'append', v: [{ id: 'a' }] })
		applyPatch(message, { p: '/message/metadata/genui_components', o: 'append', v: [{ id: 'b' }] })
		expect(message.content.parts[0]).toBe('hello')
		// An array append rebinds the property to a new array, so a holder must re-read it.
		expect(message.metadata.genui_components).toEqual([{ id: 'a' }, { id: 'b' }])
	})

	it('remove drops an array element or an object key', () => {
		const message = emptyMessage()
		applyPatch(message, { p: '/message/metadata/model_dil_v2/diagnostics', v: [{ code: 'a' }, { code: 'b' }] })
		applyPatch(message, { p: '/message/metadata/model_dil_v2/diagnostics/0', o: 'remove' })
		applyPatch(message, { p: '/message/metadata/model_dil_v2/stats', v: { ms: 1 } })
		applyPatch(message, { p: '/message/metadata/model_dil_v2/stats', o: 'remove' })
		expect(message.metadata.model_dil_v2.diagnostics).toEqual([{ code: 'b' }])
		expect(message.metadata.model_dil_v2.stats).toBeUndefined()
	})

	it('accepts a path without the document root, and ignores an empty one', () => {
		const message = emptyMessage()
		applyPatch(message, { p: '/status', v: 'done' })
		expect(message.status).toBe('done')
		expect(applyPatch(message, { p: '', v: 1 })).toBe(message)
		expect(applyPatch(message, { p: '/message', v: 1 })).toBe(message)
	})

	it('names the patch that carries the program', () => {
		expect(patchCarriesCode({ p: '/message/metadata/model_dil_v2/code' })).toBe(true)
		expect(patchCarriesCode({ p: '/message/metadata/model_dil_v2/constants' })).toBe(false)
		expect(patchCarriesCode({ p: '' })).toBe(false)
	})

	it('hands the compiled revision over once there is a program, and not before', () => {
		const message = emptyMessage()
		expect(compiledOf(message)).toBeNull()
		applyPatch(message, { p: '/message/metadata/model_dil_v2/code', v: 'DIL.render();' })
		applyPatch(message, { p: '/message/metadata/model_dil_v2/constants', v: { '0': 'x' } })
		expect(compiledOf(message)).toMatchObject({ code: 'DIL.render();', constants: { '0': 'x' } })
	})

	it('replays a streamed turn into the same message the server built', () => {
		const message = emptyMessage()
		const patches = [
			{ p: '/message/metadata/model_dil_v2/code', o: 'append', v: 'DIL.render(' },
			{ p: '/message/metadata/model_dil_v2/code', o: 'append', v: '__dil.jsx("box"))' },
			{ p: '/message/content/parts/0', o: 'append', v: 'prose ' },
			{ p: '/message/content/parts/0', o: 'append', v: 'first' }
		]
		for (const patch of patches) applyPatch(message, patch)
		expect(message.metadata.model_dil_v2.code).toBe('DIL.render(__dil.jsx("box"))')
		expect(message.content.parts[0]).toBe('prose first')
		expect(message.status).toBe('in_progress')
	})
})

describe('the streamed turn', () => {
	/** Install the fake transport and open one turn. */
	function turn(handlers: TurnHandlers = {}): { source: FakeEventSource; close: () => void } {
		vi.stubGlobal('EventSource', FakeEventSource)
		const close = openTurn('/api/chat?q=hi', handlers)
		const source = FakeEventSource.instances.at(-1)!
		return { source, close }
	}

	it('passes the URL through untouched', () => {
		const { source } = turn()
		expect(source.url).toBe('/api/chat?q=hi')
	})

	it('routes each named event to its handler', () => {
		const seen: string[] = []
		const { source } = turn({
			meta: (meta) => seen.push('meta:' + String(meta.message_id)),
			thinking: (text) => seen.push('thinking:' + text),
			note: (note) => seen.push('note:' + note.label)
		})
		source.emit('meta', { message_id: 'm1' })
		source.emit('thinking', 'hmm')
		source.emit('note', { label: 'compile', at: 1 })
		expect(seen).toEqual(['meta:m1', 'thinking:hmm', 'note:compile'])
	})

	it('treats a plain delta as a patch and a typed one as the completion', () => {
		const patches: unknown[] = []
		const completes: unknown[] = []
		const { source } = turn({ patch: (patch) => patches.push(patch), complete: (stats) => completes.push(stats) })
		source.emit('delta', { p: '/message/status', v: 'done' })
		source.emit('delta', { type: 'message_stream_complete', stats: { ms: 12 } })
		expect(patches).toEqual([{ p: '/message/status', v: 'done' }])
		expect(completes).toEqual([{ ms: 12 }])
	})

	it('closes on [DONE] and reports the turn as done', () => {
		const done = vi.fn()
		const { source } = turn({ done })
		source.raw('[DONE]')
		expect(source.closed).toBe(true)
		expect(done).toHaveBeenCalledTimes(1)
		// Anything else on the default channel is not ours to interpret.
		const other = turn({ done })
		other.source.raw('keepalive')
		expect(other.source.closed).toBe(false)
	})

	it('surfaces a named error payload', () => {
		const errors: { message: string }[] = []
		const { source } = turn({ error: (error) => errors.push(error) })
		source.emit('error', { message: 'compile failed' })
		expect(errors).toEqual([{ message: 'compile failed' }])
	})

	it('treats a dropped connection as a failed turn, not a reconnect', () => {
		const errors: { message: string }[] = []
		const done = vi.fn()
		const { source } = turn({ error: (error) => errors.push(error), done })
		source.drop()
		expect(source.closed).toBe(true)
		expect(errors).toEqual([{ message: '连接中断' }])
		expect(done).toHaveBeenCalledTimes(1)
	})

	it('stays quiet when the drop follows a close the caller asked for', () => {
		const errors: unknown[] = []
		const { source, close } = turn({ error: (error) => errors.push(error) })
		close()
		source.drop()
		expect(errors).toHaveLength(0)
	})
})
