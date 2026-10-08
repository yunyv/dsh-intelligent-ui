// @vitest-environment jsdom
/**
 * `mountDilView`, end to end inside one shadow root.
 *
 * The frame document cannot execute under jsdom, so the peer is played by the test:
 * the iframe's `postMessage` is captured (host → frame) and a real `MessageEvent` whose
 * `source` is that iframe's window is dispatched (frame → host). Everything in between —
 * the stylesheet, the wrapper, the runner handshake, incremental patching, the state
 * debounce, the trigger round trip, teardown — is the shipped code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FRAME_HOST_ATTRIBUTE, mountDilView, mountDilViewInternal, VIEW_ATTRIBUTE, VIEW_CLASS } from '../../src/client/dil/mount.ts'
import { PROTOCOL_VERSION } from '../../src/client/dil/protocol.ts'
import { STYLE_ATTRIBUTE, THEME_ATTRIBUTE } from '../../src/client/dil/theme.ts'
import type { DilCompiled, DilMountOptions, DilProtocolEntry } from '../../src/client/dil/types.ts'

interface MountHarness {
	shadow: ShadowRoot
	internals: ReturnType<typeof mountDilViewInternal>
	/** Messages the host sent into the frame. */
	sent: Record<string, any>[]
	states: { state: Record<string, unknown>; scope?: string }[]
	events: { fnId: string; args: unknown }[]
	/** Deliver a frame → host message, as the frame would. */
	deliver(message: Record<string, unknown>): void
	/** Announce the frame and let the connection settle. */
	ready(): Promise<void>
	/** Deliver one tree snapshot. */
	snapshot(tree: unknown, version?: number): void
}

/**
 * Mount a view over a fresh shadow root, with the frame's traffic captured.
 * @param options - overrides merged over the recording sinks.
 */
function mountHarness(options: Partial<DilMountOptions> = {}): MountHarness {
	document.body.innerHTML = ''
	const host = document.createElement('div')
	document.body.appendChild(host)
	const shadow = host.attachShadow({ mode: 'open' })
	const states: MountHarness['states'] = []
	const events: MountHarness['events'] = []
	const internals = mountDilViewInternal(shadow, {
		onStateChange: (state, scope) => states.push({ state, scope }),
		onEvent: (fnId, args) => events.push({ fnId, args }),
		...options
	})
	const frame = internals.sandbox.frame!
	const sent: Record<string, any>[] = []
	const frameWindow = frame.contentWindow as unknown as { postMessage: (message: unknown) => void }
	frameWindow.postMessage = (message: unknown) => void sent.push(message as Record<string, any>)
	const deliver = (message: Record<string, unknown>): void => {
		window.dispatchEvent(new MessageEvent('message', { data: { __dilFrame: true, protocolVersion: PROTOCOL_VERSION, ...message }, source: frameWindow as unknown as Window }))
	}
	return {
		shadow,
		internals,
		sent,
		states,
		events,
		deliver,
		async ready() {
			deliver({ kind: 'ready' })
			await internals.sandbox.connect()
		},
		snapshot(tree, version = 1) {
			deliver({ kind: 'snapshot', tree, version, reason: 'initial' })
		}
	}
}

/** One minimal compiled revision, as the compiler returns it. */
function compiled(text: string, extra: Partial<DilCompiled> = {}): DilCompiled {
	return {
		code: `DIL.render(__dil.jsx("box", null, __dil.jsx("text", null, ${JSON.stringify(text)})));`,
		constants: {},
		...extra
	}
}

/** The one-child subtree a snapshot renders. */
function tree(text: string): unknown {
	return { t: 'box', p: {}, c: [{ t: 'text', p: {}, c: [{ t: '#text', v: text }] }] }
}

afterEach(() => {
	vi.useRealTimers()
})

describe('mounting into a shadow root', () => {
	it('installs the stylesheet and the view element in the root, and nowhere else', () => {
		const test = mountHarness()
		const style = test.shadow.querySelector<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}]`)
		expect(style).not.toBeNull()
		expect(style?.textContent).toContain('--dsw-alias-bg-layer-1')
		// Document-level stylesheets do not cross the boundary, so nothing may be added there.
		expect(document.querySelector(`style[${STYLE_ATTRIBUTE}]`)).toBeNull()
		const element = test.shadow.querySelector<HTMLElement>(`[${VIEW_ATTRIBUTE}]`)
		expect(element?.className).toBe(VIEW_CLASS)
		expect(element?.getAttribute(THEME_ATTRIBUTE)).toBe('light')
		expect(test.shadow.querySelector(`[${FRAME_HOST_ATTRIBUTE}]`)?.querySelector('iframe')).toBe(test.internals.sandbox.frame)
		test.internals.handle.destroy()
	})

	it('shares one stylesheet between two views in the same root', () => {
		const first = mountHarness()
		const second = mountDilViewInternal(first.shadow, { onStateChange: () => undefined, onEvent: () => undefined })
		expect(first.shadow.querySelectorAll(`style[${STYLE_ATTRIBUTE}]`)).toHaveLength(1)
		expect(first.shadow.querySelectorAll(`[${VIEW_ATTRIBUTE}]`)).toHaveLength(2)
		second.handle.destroy()
		first.internals.handle.destroy()
	})

	it('renders nothing until the sandbox has something to say', () => {
		const test = mountHarness()
		expect(test.internals.element.children).toHaveLength(0)
		test.internals.handle.destroy()
	})

	it('returns a handle with exactly the contract surface', () => {
		const test = mountHarness()
		const handle = mountDilView(test.shadow, { onStateChange: () => undefined, onEvent: () => undefined })
		expect(Object.keys(handle).sort()).toEqual(['destroy', 'setState', 'update'])
		handle.destroy()
		test.internals.handle.destroy()
	})
})

describe('program delivery', () => {
	it('holds the first revision until the frame is ready, then spawns the runner', async () => {
		const test = mountHarness({ appData: { opGenui: { modelDataBindings: { b: 2 } } } })
		test.internals.handle.update(compiled('hi', { appData: { opGenui: { componentResults: { x: { status: 'resolved' } }, modelDataBindings: { a: 1 } } } }))
		expect(test.sent).toHaveLength(0)
		await test.ready()
		expect(test.sent).toHaveLength(1)
		expect(test.sent[0]).toMatchObject({ kind: 'createRunner', runnerId: expect.stringMatching(/^dil_/u) })
		expect(test.sent[0]!.compiledDil).toContain('DIL.render')
		// The embedder's appData wins over the compiled revision's, and `opGenui` merges
		// one level deep (upstream's `appData()`) — so a bindings map the host supplies
		// replaces the compiled one wholesale.
		expect(test.sent[0]!.appData).toEqual({
			opGenui: {
				componentResults: { x: { status: 'resolved' } },
				modelDataBindings: { b: 2 }
			}
		})
		test.internals.handle.destroy()
	})

	it('sends a later revision as a patch, never a second runner', async () => {
		const test = mountHarness()
		await test.ready()
		test.internals.handle.update(compiled('one'))
		test.internals.handle.update(compiled('two'))
		expect(test.sent.map((message) => message.kind)).toEqual(['createRunner', 'setCompiledDil'])
		expect(String(test.sent[1]!.compiledDil)).toContain('two')
		test.internals.handle.destroy()
	})

	it('keeps the newest revision when several arrive before the frame boots', async () => {
		const test = mountHarness()
		test.internals.handle.update(compiled('one'))
		test.internals.handle.update(compiled('two'))
		await test.ready()
		expect(test.sent).toHaveLength(1)
		expect(String(test.sent[0]!.compiledDil)).toContain('two')
		test.internals.handle.destroy()
	})

	it('honours frameUrl instead of generating the document', () => {
		const test = mountHarness({ frameUrl: '/plugins/dsh-genui/runner.html' })
		expect(test.internals.sandbox.frame?.getAttribute('src')).toBe('/plugins/dsh-genui/runner.html')
		test.internals.handle.destroy()
	})
})

describe('rendering what the sandbox posts back', () => {
	it('draws the tree into the view element', async () => {
		const test = mountHarness()
		await test.ready()
		test.snapshot(tree('hi'))
		const element = test.internals.element
		expect(element.getAttribute('data-dil-ready')).toBe('true')
		expect(element.querySelector('[data-d-component="box"]')).not.toBeNull()
		expect(element.querySelector('[data-d-component="text"]')?.textContent).toBe('hi')
		test.internals.handle.destroy()
	})

	it('patches a later snapshot in place instead of remounting the tree', async () => {
		const test = mountHarness()
		await test.ready()
		test.snapshot(tree('one'))
		const box = test.internals.element.firstElementChild
		const text = test.internals.element.querySelector('[data-d-component="text"]')
		test.snapshot(tree('two'), 2)
		expect(test.internals.element.firstElementChild).toBe(box)
		expect(test.internals.element.querySelector('[data-d-component="text"]')).toBe(text)
		expect(text?.textContent).toBe('two')
		test.internals.handle.destroy()
	})

	it('keeps the last good tree when a snapshot reports a render error', async () => {
		const test = mountHarness()
		await test.ready()
		test.snapshot(tree('good'))
		test.deliver({ kind: 'snapshot', tree: null, version: 2, error: { name: 'Error', message: 'render blew up' } })
		expect(test.internals.element.querySelector('[data-d-component="text"]')?.textContent).toBe('good')
		expect(test.internals.failures()).toEqual([{ error: { name: 'Error', message: 'render blew up' }, stage: 'render' }])
		test.internals.handle.destroy()
	})

	it('records what the sandbox reported as a failure', async () => {
		const test = mountHarness()
		await test.ready()
		test.deliver({ kind: 'failure', stage: 'evaluate', error: { name: 'Error', message: 'boom' } })
		test.deliver({ kind: 'timeout', stage: 'trigger' })
		expect(test.internals.failures().map((entry) => entry.stage)).toEqual(['evaluate', 'timeout'])
		test.internals.handle.destroy()
	})
})

describe('the event round trip', () => {
	/** A tree whose button calls `fn1`. */
	const CLICKABLE: unknown = {
		t: 'box',
		p: {},
		c: [{ t: 'button', p: { onClick: { __dilFn: 'fn1' } }, c: [{ t: '#text', v: 'Go' }] }]
	}

	it('sends the handler back to the sandbox and tells the host about it', async () => {
		const test = mountHarness()
		await test.ready()
		test.snapshot(CLICKABLE)
		test.internals.element.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		expect(test.sent.at(-1)).toMatchObject({ kind: 'trigger', fnId: 'fn1', args: [''] })
		expect(test.events).toEqual([{ fnId: 'fn1', args: [''] }])
		test.internals.handle.destroy()
	})

	it('renders the tree the handler produced', async () => {
		const test = mountHarness()
		await test.ready()
		test.snapshot(CLICKABLE)
		test.snapshot(tree('clicked'), 2)
		expect(test.internals.element.querySelector('[data-d-component="text"]')?.textContent).toBe('clicked')
		test.internals.handle.destroy()
	})

	it('stays silent once the view is destroyed', async () => {
		const test = mountHarness()
		await test.ready()
		test.snapshot(CLICKABLE)
		const button = test.internals.element.querySelector('button')!
		test.internals.handle.destroy()
		button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		expect(test.events).toHaveLength(0)
		expect(test.sent.some((message) => message.kind === 'trigger')).toBe(false)
	})
})

describe('keyed state', () => {
	it('coalesces a burst of changes into one report of the latest state', async () => {
		const test = mountHarness()
		await test.ready()
		vi.useFakeTimers()
		test.deliver({ kind: 'stateChanged', state: { tab: 'a' } })
		test.deliver({ kind: 'stateChanged', state: { tab: 'b' } })
		test.deliver({ kind: 'stateChanged', state: { tab: 'c' } })
		expect(test.states).toHaveLength(0)
		vi.advanceTimersByTime(600)
		expect(test.states).toEqual([{ state: { tab: 'c' }, scope: 'root' }])
		test.internals.handle.destroy()
	})

	it('sends a pending report rather than dropping it on destroy', async () => {
		const test = mountHarness()
		await test.ready()
		vi.useFakeTimers()
		test.deliver({ kind: 'stateChanged', state: { typed: 'half a word' } })
		test.internals.handle.destroy()
		expect(test.states).toEqual([{ state: { typed: 'half a word' }, scope: 'root' }])
	})

	it('restarts the runner with the seed, so a restored snapshot lands where it was', async () => {
		const test = mountHarness()
		await test.ready()
		test.internals.handle.update(compiled('hi'))
		test.snapshot(tree('hi'))
		test.internals.handle.setState({ tab: 'settings', n: 3 })
		expect(test.sent.map((message) => message.kind)).toEqual(['createRunner', 'createRunner'])
		expect(test.sent[1]!.initialState).toEqual({ tab: 'settings', n: 3 })
		expect(String(test.sent[1]!.compiledDil)).toContain('hi')
		test.internals.handle.destroy()
	})

	it('carries a seed given before any program arrived', async () => {
		const test = mountHarness()
		test.internals.handle.setState({ tab: 'settings' })
		await test.ready()
		test.internals.handle.update(compiled('hi'))
		expect(test.sent[0]!.initialState).toEqual({ tab: 'settings' })
		test.internals.handle.destroy()
	})
})

describe('theming', () => {
	it('mirrors the app scheme onto the view element, and follows a change', async () => {
		const test = mountHarness()
		expect(test.internals.element.getAttribute(THEME_ATTRIBUTE)).toBe('light')
		document.body.setAttribute('data-ds-dark-theme', '')
		await vi.waitFor(() => {
			expect(test.internals.element.getAttribute(THEME_ATTRIBUTE)).toBe('dark')
		})
		document.body.removeAttribute('data-ds-dark-theme')
		await vi.waitFor(() => {
			expect(test.internals.element.getAttribute(THEME_ATTRIBUTE)).toBe('light')
		})
		test.internals.handle.destroy()
	})

	it('stops watching once destroyed', async () => {
		const test = mountHarness()
		const observer = vi.spyOn(MutationObserver.prototype, 'disconnect')
		test.internals.handle.destroy()
		expect(observer).toHaveBeenCalled()
		observer.mockRestore()
	})
})

describe('teardown', () => {
	it('removes the tree and the frame, and keeps the shared stylesheet', async () => {
		const test = mountHarness()
		await test.ready()
		test.snapshot(tree('hi'))
		test.internals.handle.destroy()
		expect(test.shadow.querySelector(`[${VIEW_ATTRIBUTE}]`)).toBeNull()
		expect(test.shadow.querySelector(`[${FRAME_HOST_ATTRIBUTE}]`)).toBeNull()
		expect(test.shadow.querySelector(`style[${STYLE_ATTRIBUTE}]`)).not.toBeNull()
	})

	it('is idempotent, and makes a later update a no-op', async () => {
		const test = mountHarness()
		await test.ready()
		test.internals.handle.update(compiled('hi'))
		const beforeDestroy = test.sent.length
		test.internals.handle.destroy()
		expect(test.sent).toHaveLength(beforeDestroy + 1)
		expect(test.sent.at(-1)).toMatchObject({ kind: 'dispose' })
		expect(() => test.internals.handle.destroy()).not.toThrow()
		test.internals.handle.update(compiled('later'))
		expect(test.sent).toHaveLength(beforeDestroy + 1)
	})

	it('keeps a protocol log the host can inspect', async () => {
		const test = mountHarness()
		await test.ready()
		test.internals.handle.update(compiled('hi'))
		const kinds = test.internals.protocol.map((entry: DilProtocolEntry) => entry.kind)
		expect(kinds).toContain('ready')
		expect(kinds).toContain('createRunner')
		test.internals.handle.destroy()
	})
})

describe('the public entry point', () => {
	it('mounts, renders a snapshot, and tears down through the frozen signature', async () => {
		document.body.innerHTML = ''
		const host = document.createElement('div')
		document.body.appendChild(host)
		const shadow = host.attachShadow({ mode: 'open' })
		const seen: string[] = []
		const handle = mountDilView(shadow, {
			onStateChange: () => undefined,
			onEvent: (fnId) => seen.push(fnId)
		})
		const frame = shadow.querySelector('iframe')!
		const frameWindow = frame.contentWindow as unknown as { postMessage: () => void }
		frameWindow.postMessage = () => undefined
		window.dispatchEvent(new MessageEvent('message', {
			data: { __dilFrame: true, protocolVersion: PROTOCOL_VERSION, kind: 'ready' },
			source: frameWindow as unknown as Window
		}))
		handle.update(compiled('hello'))
		window.dispatchEvent(new MessageEvent('message', {
			data: { __dilFrame: true, protocolVersion: PROTOCOL_VERSION, kind: 'snapshot', tree: tree('hello'), version: 1 },
			source: frameWindow as unknown as Window
		}))
		expect(shadow.querySelector('[data-d-component="text"]')?.textContent).toBe('hello')
		handle.destroy()
		expect(shadow.querySelector('iframe')).toBeNull()
	})
})
