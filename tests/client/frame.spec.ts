/**
 * The runner document.
 *
 * Three things must hold or the sandbox is either silent or open: the shipped text is
 * byte-identical to the vendored replica, the CSP hash covers exactly the inline
 * bootstrap, and the bootstrap really does announce itself to its parent. The last one
 * is checked by running it in a `node:vm` context with a fake window, which is the only
 * way to execute it without a browser.
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
	buildRunnerHtml,
	DIL_FRAME_CSP,
	escapeHtmlText,
	FRAME_SCRIPT,
	FRAME_SCRIPT_SHA256,
	WORKER_SOURCE,
	WORKER_SOURCES
} from '../../src/client/dil/frame.ts'

const require = createRequire(import.meta.url)
const vendored = require('../../vendor/dil-replica/replica/server/sandbox/frame.js') as {
	FRAME_SCRIPT: string
	WORKER_SOURCE: string
}

/** Everything the bootstrapped frame needs from its surroundings. */
interface FrameHarness {
	posted: Record<string, unknown>[]
	/** The object the script compares `event.source` against. */
	parent: Record<string, unknown>
	dispatch(event: Record<string, unknown>, source?: unknown): void
}

/**
 * Execute a bootstrap against a fake window.
 * @param script - the bootstrap to run; defaults to the shipped one.
 * @returns the messages it posted and a way to deliver messages to it.
 */
function bootFrame(script = FRAME_SCRIPT, withWorkerTemplate = false): FrameHarness {
	const posted: Record<string, unknown>[] = []
	const listeners: Record<string, ((event: Record<string, unknown>) => void)[]> = {}
	const parent = { postMessage: (message: Record<string, unknown>) => void posted.push(message) }
	const window: Record<string, any> = {
		parent,
		addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
			;(listeners[type] ??= []).push(listener)
		},
		removeEventListener: () => undefined
	}
	window.window = window
	window.self = window
	const document = {
		getElementById: (id: string) => (withWorkerTemplate && id === 'dil-worker-source'
			? { content: { textContent: 'self.onmessage = function () {};' } }
			: null),
		readyState: 'complete'
	}
	const context = vm.createContext({
		window,
		self: window,
		document,
		console,
		Promise,
		Map,
		Set,
		WeakMap,
		Object,
		Array,
		String,
		Number,
		Boolean,
		JSON,
		Math,
		Date,
		Error,
		TypeError,
		RegExp,
		Symbol,
		isNaN,
		isFinite,
		parseInt,
		parseFloat,
		setTimeout,
		clearTimeout,
		queueMicrotask
	})
	vm.runInContext(script, context, { filename: 'client/dil/frame-script.js' })
	return {
		posted,
		parent,
		dispatch(event, source = parent) {
			for (const listener of listeners.message ?? []) listener({ source, data: event })
		}
	}
}

/** Pull the one inline `<script>` body out while leaving `<template>` content alone. */
function inlineScript(html: string): string {
	const open = html.indexOf('<script>')
	const close = html.indexOf('</' + 'script>', open)
	return html.slice(open + '<script>'.length, close)
}

/** Pull the inert worker template's content. */
function templateContent(html: string): string {
	const open = html.indexOf('<template id="dil-worker-source">')
	const close = html.indexOf('</template>', open)
	return html.slice(open + '<template id="dil-worker-source">'.length, close)
}

/** Undo the HTML escaping the template round trip applies. */
function unescapeHtmlText(text: string): string {
	return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

describe('the vendored replica is carried verbatim', () => {
	it('ships the same bootstrap as vendor/dil-replica', () => {
		expect(FRAME_SCRIPT).toBe(vendored.FRAME_SCRIPT)
	})

	it('ships the same worker as vendor/dil-replica', () => {
		expect(WORKER_SOURCE).toBe(vendored.WORKER_SOURCE)
		expect(WORKER_SOURCE.length).toBeGreaterThan(0)
	})

	it('pins the bootstrap with its own sha256', () => {
		const hash = createHash('sha256').update(FRAME_SCRIPT, 'utf8').digest('base64')
		expect(hash).toBe(FRAME_SCRIPT_SHA256)
		expect(DIL_FRAME_CSP).toContain(`script-src 'sha256-${hash}' 'unsafe-eval'`)
	})

	it('carries no text the HTML parser would terminate or swallow', () => {
		// A `</script` would end the raw text early, and `<!--` would move the parser
		// into its escaped state; both change the script text and break the hash pin.
		for (const text of [FRAME_SCRIPT, WORKER_SOURCE]) {
			expect(text).not.toContain('</scr' + 'ipt')
			expect(text).not.toContain('<!--')
		}
	})
})

describe('runner document', () => {
	it('opens with default-src none and allows exactly the worker transports', () => {
		const html = buildRunnerHtml()
		expect(html).toContain("default-src 'none'")
		expect(html).toContain(`worker-src ${WORKER_SOURCES}`)
		expect(html).toContain("base-uri 'none'")
		expect(html).toContain("form-action 'none'")
		expect(html).toContain("frame-src 'none'")
		expect(html).toContain("object-src 'none'")
		expect(html).toContain('sandbox')
	})

	it('denies every network destination, so compiled code has nowhere to send anything', () => {
		for (const directive of ['connect-src', 'img-src', 'font-src', 'media-src', 'style-src', 'child-src']) {
			expect(DIL_FRAME_CSP).not.toContain(directive)
		}
		expect(DIL_FRAME_CSP).not.toContain('https:')
		expect(DIL_FRAME_CSP).not.toContain("'unsafe-inline'")
	})

	it('embeds the bootstrap verbatim, so the hash still matches', () => {
		expect(inlineScript(buildRunnerHtml())).toBe(FRAME_SCRIPT)
	})

	it('carries the worker in an inert template, escaped and recoverable', () => {
		const content = templateContent(buildRunnerHtml())
		expect(content).not.toBe('')
		expect(unescapeHtmlText(content)).toBe(WORKER_SOURCE)
		expect(escapeHtmlText('<x>&')).toBe('&lt;x&gt;&amp;')
	})

	it('refuses a replacement bootstrap without a replacement policy', () => {
		expect(() => buildRunnerHtml({ frameScript: 'console.log(1)' })).toThrow(/matching csp/u)
		expect(buildRunnerHtml({ frameScript: 'console.log(1)', csp: "default-src 'none'" })).toContain('console.log(1)')
	})
})

describe('the bootstrap itself', () => {
	it('announces ready to its parent on boot', () => {
		const frame = bootFrame()
		expect(frame.posted.at(-1)).toMatchObject({ __dilFrame: true, kind: 'ready', protocolVersion: 1 })
	})

	it('answers a parent probe with a diagnostic instead of staying silent', () => {
		const frame = bootFrame()
		frame.dispatch({ __dilFrame: true, kind: 'probe' })
		expect(frame.posted.some((message) => message.kind === 'diagnostic' && message.stage === 'frame_probe')).toBe(true)
	})

	it('logs a foreign message but acts on none of it', () => {
		const frame = bootFrame()
		frame.dispatch({ __dilFrame: true, kind: 'probe' }, { notTheParent: true })
		// The arrival is recorded (that is what makes a broken channel diagnosable)...
		expect(frame.posted.some((message) => message.stage === 'frame_window_msg')).toBe(true)
		// ...and the command is not run.
		expect(frame.posted.some((message) => message.stage === 'frame_probe')).toBe(false)
	})

	it('ignores messages that carry no frame flag', () => {
		const frame = bootFrame()
		frame.dispatch({ kind: 'createRunner', protocolVersion: 1, compiledDil: 'x' })
		const arrival = frame.posted.find((message) => message.stage === 'frame_window_msg')
		expect(arrival?.detail).toMatchObject({ frameFlag: false, kind: 'createRunner' })
		expect(frame.posted.some((message) => message.kind === 'failure')).toBe(false)
	})

	it('reports a missing worker source as a failure rather than throwing', () => {
		const frame = bootFrame()
		frame.dispatch({ __dilFrame: true, kind: 'createRunner', protocolVersion: 1, compiledDil: 'DIL.render(null)' })
		expect(frame.posted.some((message) => message.kind === 'failure' && message.stage === 'worker_create')).toBe(true)
	})

	it('rejects a createRunner for another protocol version', () => {
		const frame = bootFrame(FRAME_SCRIPT, true)
		frame.dispatch({ __dilFrame: true, kind: 'createRunner', protocolVersion: 99, compiledDil: 'x' })
		expect(frame.posted.some((message) => message.kind === 'failure')).toBe(false)
		expect(frame.posted.some((message) => message.kind === 'diagnostic' && message.phase === 'rejected')).toBe(true)
	})
})
