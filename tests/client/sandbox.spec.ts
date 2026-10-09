// @vitest-environment jsdom
/**
 * The iframe contract.
 *
 * The frame is the security boundary of the whole feature, so the shape of the element
 * and the shape of the traffic are both asserted here: no `allow-same-origin`, no
 * cross-source messages acted on, a version check, and a boot budget that ends in a
 * rejection instead of a view that never renders.
 *
 * jsdom cannot execute the frame document, so the peer is played by dispatching a real
 * `MessageEvent` whose `source` is the frame's own `contentWindow` — exactly the check
 * the sandbox filters on.
 */
import { describe, expect, it } from 'vitest'
import { DilSandbox, PROTOCOL_VERSION } from '../../src/client/dil/sandbox.ts'
import type { DilSandboxOptions } from '../../src/client/dil/sandbox.ts'
import type { DilProtocolEntry } from '../../src/client/dil/types.ts'

/** A sandbox wired to a shadow root, with the frame's postMessage captured. */
interface Harness {
	sandbox: DilSandbox
	root: ShadowRoot
	frame: HTMLIFrameElement
	/** Messages the host sent into the frame. */
	sent: Record<string, any>[]
	protocol: DilProtocolEntry[]
	snapshots: Record<string, any>[]
	states: { state: Record<string, unknown>; scope: string; reason?: string }[]
	failures: { message: string; stage: string }[]
	connected: Promise<DilSandbox>
	/** Deliver a frame → host message, as the frame would. */
	deliver(message: Record<string, unknown>, source?: unknown): void
	/** A window object that is not the frame's. */
	foreignWindow(): unknown
}

/**
 * Build one sandbox over a fresh shadow root.
 * @param options - overrides merged over the defaults.
 */
function harness(options: Partial<DilSandboxOptions> = {}): Harness {
	document.body.innerHTML = ''
	const host = document.createElement('div')
	document.body.appendChild(host)
	const root = host.attachShadow({ mode: 'open' })
	const sent: Record<string, any>[] = []
	const protocol: DilProtocolEntry[] = []
	const snapshots: Record<string, any>[] = []
	const states: Harness['states'] = []
	const failures: Harness['failures'] = []

	const sandbox = new DilSandbox({
		container: root,
		document,
		bootTimeoutMs: 200,
		onProtocol: (entry) => protocol.push(entry),
		onSnapshot: (message) => snapshots.push(message as unknown as Record<string, any>),
		onStateChange: (state, scope, reason) => states.push({ state, scope, reason }),
		onFailure: (error, stage) => failures.push({ message: error.message, stage }),
		...options
	})
	const connected = sandbox.connect()
	// A test that never waits for the boot must not turn the eventual timeout into an
	// unhandled rejection: whether it lands inside the test or after it depends on how
	// long the whole suite runs, so a file that is green alone would fail in the full
	// run. Observing it here keeps the promise awaitable and quiet.
	void connected.catch(() => undefined)
	const frame = sandbox.frame!
	const frameWindow = frame.contentWindow as unknown as { postMessage: (message: unknown) => void }
	frameWindow.postMessage = (message: unknown) => void sent.push(message as Record<string, any>)

	return {
		sandbox,
		root,
		frame,
		sent,
		protocol,
		snapshots,
		states,
		failures,
		connected,
		deliver(message, source = frameWindow) {
			window.dispatchEvent(new MessageEvent('message', { data: message, source: source as Window }))
		},
		foreignWindow: () => ({ postMessage: () => undefined })
	}
}

const READY = { __dilFrame: true, protocolVersion: PROTOCOL_VERSION, kind: 'ready' }

describe('creating the frame', () => {
	it('puts a scoped, script-only, opaque-origin frame in the container', () => {
		const test = harness()
		expect(test.root.querySelector('iframe')).toBe(test.frame)
		expect(test.frame.getAttribute('sandbox')).toBe('allow-scripts')
		expect(test.frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
		expect(test.frame.getAttribute('referrerpolicy')).toBe('no-referrer')
		expect(test.frame.getAttribute('aria-hidden')).toBe('true')
		expect(test.frame.getAttribute('data-dil-sandbox')).toBe('true')
		expect(test.frame.style.width).toBe('0px')
		expect(test.frame.style.visibility).toBe('hidden')
	})

	it('writes the runner document into srcdoc, policy and all, when no URL is given', () => {
		const test = harness()
		const srcdoc = test.frame.getAttribute('srcdoc') ?? ''
		expect(srcdoc).toContain("default-src 'none'")
		expect(srcdoc).toContain('dil-worker-source')
		expect(test.frame.getAttribute('src')).toBeNull()
	})

	it('serves a given frameUrl instead, and generates nothing', () => {
		const test = harness({ frameUrl: '/plugins/dsh-intelligent-ui/runner.html' })
		expect(test.frame.getAttribute('src')).toBe('/plugins/dsh-intelligent-ui/runner.html')
		expect(test.frame.getAttribute('srcdoc')).toBeNull()
	})

	it('connects only when the frame announces itself', async () => {
		const test = harness()
		let settled = false
		void test.connected.then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		test.deliver(READY)
		await test.connected
		expect(test.sandbox.connected).toBe(true)
		expect(test.protocol.some((entry) => entry.kind === 'ready')).toBe(true)
	})

	it('is a no-op when connect() is called twice', async () => {
		const test = harness()
		test.deliver(READY)
		await test.connected
		expect(await test.sandbox.connect()).toBe(test.sandbox)
	})

	it('rejects a frame that never boots, and takes it back out', async () => {
		const test = harness({ bootTimeoutMs: 5 })
		await expect(test.connected).rejects.toThrow(/did not become ready/u)
		expect(test.root.querySelector('iframe')).toBeNull()
	})
})

describe('the traffic it accepts', () => {
	it('ignores a message from anyone but its own frame', () => {
		const test = harness()
		test.deliver({ __dilFrame: true, protocolVersion: PROTOCOL_VERSION, kind: 'snapshot', tree: { t: 'box' } }, test.foreignWindow())
		expect(test.snapshots).toHaveLength(0)
	})

	it('ignores a bare object that is not a frame message', () => {
		const test = harness()
		test.deliver({ type: 'dsh-artifacts:height', height: 10 })
		expect(test.snapshots).toHaveLength(0)
		expect(test.protocol).toHaveLength(0)
	})

	it('ignores a frame speaking another protocol version', () => {
		const test = harness()
		test.deliver({ __dilFrame: true, protocolVersion: 99, kind: 'snapshot', tree: { t: 'box' } })
		expect(test.snapshots).toHaveLength(0)
		expect(test.protocol.at(-1)).toMatchObject({ kind: 'protocol_mismatch' })
	})

	it('forwards a tree snapshot', () => {
		const test = harness()
		test.deliver({
			__dilFrame: true,
			protocolVersion: PROTOCOL_VERSION,
			kind: 'snapshot',
			tree: { t: 'box', c: [] },
			version: 3,
			reason: 'source',
			stats: { version: 3 }
		})
		expect(test.snapshots).toEqual([{ tree: { t: 'box', c: [] }, version: 3, reason: 'source', error: null, stats: { version: 3 } }])
	})

	it('forwards keyed state with its scope, defaulting to root', () => {
		const test = harness()
		test.deliver({ __dilFrame: true, protocolVersion: PROTOCOL_VERSION, kind: 'stateChanged', state: { tab: 'b' }, reason: 'event' })
		test.deliver({ __dilFrame: true, protocolVersion: PROTOCOL_VERSION, kind: 'stateChanged', state: { tab: 'c' }, scope: 'panel' })
		expect(test.states).toEqual([
			{ state: { tab: 'b' }, scope: 'root', reason: 'event' },
			{ state: { tab: 'c' }, scope: 'panel', reason: undefined }
		])
	})

	it('turns a failure, a timeout and a quarantine into host errors', () => {
		const test = harness()
		test.deliver({ __dilFrame: true, protocolVersion: PROTOCOL_VERSION, kind: 'failure', stage: 'evaluate', error: { name: 'Error', message: 'boom' } })
		test.deliver({ __dilFrame: true, protocolVersion: PROTOCOL_VERSION, kind: 'timeout', stage: 'trigger' })
		test.deliver({ __dilFrame: true, protocolVersion: PROTOCOL_VERSION, kind: 'quarantined', reason: 'worker_unresponsive' })
		expect(test.failures).toEqual([
			{ message: 'boom', stage: 'evaluate' },
			{ message: 'sandbox exceeded its render budget (trigger)', stage: 'timeout' },
			{ message: 'worker_unresponsive', stage: 'quarantine' }
		])
	})
})

describe('the traffic it sends', () => {
	it('creates a runner with the program, the constants and the seed state', async () => {
		const test = harness()
		test.deliver(READY)
		await test.connected
		test.sandbox.createRunner('runner-1', {
			compiledDil: 'DIL.render(null)',
			constants: { a: 1 },
			appData: { b: 2 },
			initialState: { tab: 'a' }
		})
		expect(test.sent).toEqual([{
			__dilFrame: true,
			protocolVersion: PROTOCOL_VERSION,
			kind: 'createRunner',
			runnerId: 'runner-1',
			compiledDil: 'DIL.render(null)',
			constants: { a: 1 },
			appData: { b: 2 },
			initialState: { tab: 'a' }
		}])
	})

	it('sends a later revision as setCompiledDil, without a seed', async () => {
		const test = harness()
		test.deliver(READY)
		await test.connected
		test.sandbox.setCompiledDil({ compiledDil: 'next' })
		expect(test.sent).toEqual([{
			__dilFrame: true,
			protocolVersion: PROTOCOL_VERSION,
			kind: 'setCompiledDil',
			compiledDil: 'next',
			constants: {},
			appData: {}
		}])
	})

	it('carries a handler call and its arguments across', async () => {
		const test = harness()
		test.deliver(READY)
		await test.connected
		test.sandbox.trigger('fn7', ['typed'])
		test.sandbox.requestState()
		expect(test.sent[0]).toMatchObject({ kind: 'trigger', fnId: 'fn7', args: ['typed'] })
		expect(test.sent[1]).toMatchObject({ kind: 'stateSnapshotRequest' })
	})

	it('says so when there is no frame yet', () => {
		const sandbox = new DilSandbox({ document, bootTimeoutMs: 5 })
		expect(sandbox.send({ kind: 'probe' })).toBe(false)
		sandbox.dispose()
	})
})

describe('tearing the frame down', () => {
	it('removes the frame, the listener and the channel', async () => {
		const test = harness()
		test.deliver(READY)
		await test.connected
		test.sandbox.dispose()
		expect(test.root.querySelector('iframe')).toBeNull()
		expect(test.sandbox.frame).toBeNull()
		expect(test.sandbox.connected).toBe(false)
		expect(test.sandbox.send({ kind: 'probe' })).toBe(false)
		const before = test.snapshots.length
		test.deliver({ __dilFrame: true, protocolVersion: PROTOCOL_VERSION, kind: 'snapshot', tree: { t: 'box' } })
		expect(test.snapshots).toHaveLength(before)
		expect(test.sent.at(-1)).toMatchObject({ kind: 'dispose' })
	})
})
