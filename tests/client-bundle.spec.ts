// @vitest-environment jsdom
/**
 * Loads the BUILT browser bundle (lib/client.js) the way the harness does —
 * through `window.__ModuleLoader__.load({ id, factory })` — and drives it with a
 * stand-in for the client context. This is the only place the shipped artifact
 * is exercised without a running GUI, so a registration or render failure here
 * is a real defect rather than a test-harness artefact.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as reactDom from 'react-dom'
import * as reactDomClient from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it } from 'vitest'

/** One ModuleLoader entry as the bundle registers it. */
interface LoaderEntry {
	id: string
	factory: (require: (specifier: string) => unknown) => {
		apply: (ctx: unknown) => void
		inject: string[]
		name: string
	}
}

/** One recorded seat registration. */
interface Registration {
	options: { name?: string; key?: string; id?: string }
	component: unknown
}

let client: LoaderEntry['factory'] extends (r: never) => infer M ? M : never
const registrations: Registration[] = []
const injected: string[] = []
/** The dependency lists `ctx.inject` was asked to wait on. */
const injectedDeps: string[][] = []
const opened: string[] = []
const definitions: { kind?: string }[] = []

/** The plugin context the browser half is applied to. */
const ctx = {
	get(name: string): unknown {
		if (name === 'sidebarRightTabs') {
			return {
				register: (definition: { id: string; kind: string }) => {
					opened.push(`type:${definition.kind}`)
					return () => undefined
				}
			}
		}
		if (name === 'sidebarRight') {
			return { openTab: (kind: string) => { opened.push(`open:${kind}`) } }
		}
		if (name === 'uiConversation') {
			return {
				events: {
					register: (definition: { kind?: string }) => {
						definitions.push(definition)
						return () => undefined
					}
				}
			}
		}
		// Neither settings face is present, so the folding observable reports false.
		return undefined
	},
	// Mirrors the shipped `ctx.inject`: the framework mounts the callback once the
	// named services exist. Here they already do, so it runs at once. The test below
	// drives the other case — services that arrive only after apply.
	inject(deps: string[], callback: (scope: unknown) => void): void {
		injectedDeps.push(deps)
		callback(ctx)
	},
	// Mirrors the shipped SlotRegistry: both methods read `this.ctx.effect`, so a
	// caller that detaches a method loses the receiver here exactly as it would in
	// the browser.
	slots: {
		ctx: {
			effect(run: () => unknown): unknown {
				return run()
			}
		},
		inject(this: { ctx: { effect(run: () => unknown): unknown } }, key: string, callback: () => unknown): () => void {
			this.ctx.effect(callback)
			injected.push(key)
			return () => undefined
		},
		register(this: { ctx: { effect(run: () => unknown): unknown } }, options: Registration['options'], component: unknown): () => void {
			this.ctx.effect(() => {
				registrations.push({ options, component })
			})
			return () => undefined
		}
	}
}

beforeAll(() => {
	// jsdom omits matchMedia; the theme resolver reads it only when the host
	// declares no scheme of its own.
	;(window as unknown as { matchMedia: unknown }).matchMedia = () => ({
		matches: false,
		addEventListener: () => undefined,
		removeEventListener: () => undefined
	})
	const entries: LoaderEntry[] = []
	;(window as unknown as { __ModuleLoader__: unknown }).__ModuleLoader__ = {
		load(entry: LoaderEntry) { entries.push(entry) }
	}
	// eslint-disable-next-line no-eval
	;(0, eval)(readFileSync(join(process.cwd(), 'lib', 'client.js'), 'utf8'))
	expect(entries, 'the bundle must register exactly one loader entry').toHaveLength(1)
	const entry = entries[0]!
	expect(entry.id).toBe('dsh-genui')
	client = entry.factory((specifier: string) => {
		if (specifier === 'react') return React
		if (specifier === 'react/jsx-runtime') return jsxRuntime
	if (specifier === 'react-dom') return reactDom
	if (specifier === 'react-dom/client') return reactDomClient
		throw new Error(`client bundle requires a package outside the platform seeds: ${specifier}`)
	})
	client.apply(ctx)
})

/** One settled tool result carrying an artifact revision. */
function resultBlock(overrides: Record<string, unknown>) {
	return {
		kind: 'tool-result',
		meta: {
			kind: 'artifact',
			action: 'create',
			id: 'art-demo',
			title: '示例产物',
			html: '<p id="demo">hi</p><script>window.__dshArtifactData = { a: 1 }</script>',
			version: 1,
			mode: 'inline',
			render: 'reload',
			sizeBytes: 64,
			session: 's1',
			...overrides
		},
		content: [{ type: 'text', text: 'Created artifact' }],
		isError: false
	}
}

/** The component registered under one seat key. */
function componentFor(name: string, key: string): (props: never) => React.ReactNode {
	// Keyed seats register a `key`; list seats register an `id`.
	const found = registrations.find(row => row.options.name === name && (row.options.key === key || row.options.id === key))
	expect(found, `no registration for ${name}#${key}`).toBeDefined()
	return found!.component as (props: never) => React.ReactNode
}

describe('browser half', () => {
	it('exports the cordis plugin face', () => {
		expect(client.name).toBe('dsh-genui')
		expect(client.inject).toContain('slots')
	})

	it('claims the artifact tool row and both sidebar seats', () => {
		expect(registrations.some(row => row.options.name === 'tool.call.toolview' && row.options.key === 'artifact')).toBe(true)
		expect(injected).toContain('tool.call.toolview')
		expect(registrations.some(row => row.options.name === 'sidebar.right.pane.tab')).toBe(true)
		expect(registrations.some(row => row.options.name === 'sidebar.right.pane.tab.title')).toBe(true)
		expect(opened).toContain('type:dsh-genui')
	})

	it('waits for the right column instead of giving up when it is not there yet', () => {
		// A cold start can run this half before the column's services exist. The first
		// version probed once and returned, so the panel appeared or not depending on
		// startup order. The registration is now handed to `ctx.inject`, which mounts a
		// child plugin that stays pending until both services are present.
		const callbacks: ((scope: unknown) => void)[] = []
		const depsSeen: string[][] = []
		const lateCtx = {
			inject(deps: string[], callback: (scope: unknown) => void): void {
				depsSeen.push(deps)
				callbacks.push(callback)
			},
			slots: ctx.slots
		}

		const before = registrations.length
		client.apply(lateCtx as never)
		const added = (): Registration[] => registrations.slice(before)

		// The card is wired at once. It must never wait on an optional column.
		expect(added().some(row => row.options.key === 'artifact'), 'the card must not wait for the column').toBe(true)
		// The column is not registered, but the request for it is outstanding.
		expect(depsSeen).toEqual([['sidebarRightTabs', 'sidebarRight']])
		expect(callbacks).toHaveLength(1)
		expect(added().some(row => row.options.name === 'sidebar.right.pane.tab')).toBe(false)

		// The framework mounts the child once both services arrive.
		const lateServices = {
			sidebarRightTabs: { register: () => () => undefined },
			sidebarRight: { openTab: () => undefined }
		}
		callbacks[0]!({ get: (name: string) => lateServices[name as keyof typeof lateServices], slots: ctx.slots })

		expect(added().some(row => row.options.name === 'sidebar.right.pane.tab')).toBe(true)
		expect(added().some(row => row.options.name === 'sidebar.right.pane.tab.title')).toBe(true)
	})

	it('renders a settled revision as a compact row, never a second frame', () => {
		const View = componentFor('tool.call.toolview', 'artifact')
		const markup = renderToStaticMarkup(
			React.createElement(View as never, {
				callId: 'call-1',
				phase: 'result',
				block: resultBlock({})
			} as never)
		)
		expect(markup).toContain('示例产物')
		expect(markup).toContain('art-demo')
		expect(markup).toContain('在侧栏打开')
		expect(markup).toContain('在此预览')
		// The frame itself belongs to the marker in the answer (see fence.spec.ts).
		expect(markup).not.toContain('<iframe')
	})

	it('renders a streaming HTML revision while the call is still running', () => {
		const View = componentFor('tool.call.toolview', 'artifact')
		const markup = renderToStaticMarkup(
			React.createElement(View as never, {
				callId: 'call-2',
				phase: 'start',
				block: { phase: 'start', argsRaw: '{"action":"create","engine":"html","title":"流式中","html":"<b>partial</b>"}' }
			} as never)
		)
		expect(markup).toContain('sandbox="allow-scripts allow-modals"')
		expect(markup).toContain('生成中')
		// The frame document lives inside srcdoc, with the bridge the card talks to.
		expect(markup).toContain('default-src &#x27;none&#x27;')
		expect(markup).toContain('dsh-artifact-root')
		expect(markup).toContain('dsh-artifacts:height')
		expect(markup).toContain('dsh-artifacts:collect')
	})

	it('says so instead of framing a DIL revision that has not been compiled yet', () => {
		// A partial document carries its source but no program, so there is nothing
		// to mount. Framing it would render an empty box that reads as broken.
		const View = componentFor('tool.call.toolview', 'artifact')
		const markup = renderToStaticMarkup(
			React.createElement(View as never, {
				callId: 'call-3',
				phase: 'start',
				block: { phase: 'start', argsRaw: '{"action":"create","title":"计划器","source":"{@body const [n,setN] = DIL.useState(3)}"}' }
			} as never)
		)
		expect(markup).toContain('正在生成界面')
		expect(markup).not.toContain('<iframe')
	})

	it('renders a later patch as a row, so patching adds no frame', () => {
		const View = componentFor('tool.call.toolview', 'artifact')
		// The create card above already published art-demo into the page store.
		const markup = renderToStaticMarkup(
			React.createElement(View as never, {
				callId: 'call-3',
				phase: 'result',
				block: resultBlock({ action: 'patch', version: 2, render: 'reconcile' })
			} as never)
		)
		expect(markup).toContain('示例产物')
		expect(markup).toContain('v2')
		expect(markup).toContain('在侧栏打开')
		expect(markup).not.toContain('<iframe')
	})

	it('stays quiet on a failed call', () => {
		const View = componentFor('tool.call.toolview', 'artifact')
		const markup = renderToStaticMarkup(
			React.createElement(View as never, {
				callId: 'call-4',
				phase: 'result',
				block: {
					kind: 'tool-result',
					meta: null,
					content: [{ type: 'text', text: 'artifact patch art-x: unknown id' }],
					isError: true
				}
			} as never)
		)
		expect(markup).toContain('unknown id')
		expect(markup).not.toContain('<iframe')
	})
})
