// @vitest-environment jsdom
/**
 * The host half ⇄ client half contract.
 *
 * Two halves were built against one type in two workstreams, so this file is the seam:
 * a compile-time assertion that the host's `DilCompiled` really is accepted where the
 * client's `DilMountHandle.update` expects one, and a runtime pass that runs the whole
 * pipeline — `compileDil` → sandbox worker → tree → renderer → DOM → handler → tree
 * again — from the host half's own output, with no hand-written program anywhere.
 */
import { describe, expect, it } from 'vitest'
import { compileDil } from '../../src/dil/index.ts'
import type { DilCompiled as HostCompiled } from '../../src/dil/types.ts'
import { mountDilViewInternal } from '../../src/client/dil/mount.ts'
import { PROTOCOL_VERSION } from '../../src/client/dil/protocol.ts'
import type { DilCompiled as ClientCompiled, DilMountHandle, DilMountOptions } from '../../src/client/dil/types.ts'
import { bootSandbox } from './support/worker-harness.ts'

/** A compile-time assertion: `false` is not assignable to `true`. */
type Assert<T extends true> = T

/** The host's compiled revision is what the client's `update` takes. */
type HostRevisionIsAccepted = Assert<HostCompiled extends ClientCompiled ? true : false>

/**
 * And it is accepted at the real call site, which is what the host half actually writes.
 *
 * Declared, never called: this exists so `tsc` checks the signature the Lead's wiring
 * uses, not a hand-written approximation of it.
 */
declare const contractHandle: DilMountHandle
declare const contractRevision: HostCompiled
function hostHalfCallSite(): void {
	contractHandle.update(contractRevision)
	contractHandle.setState({ tab: 'b' })
	contractHandle.destroy()
}

/** The options the host half passes are the options the client half declares. */
type OptionsMatch = Assert<{
	onStateChange(state: Record<string, unknown>, scope?: string): void
	onEvent(fnId: string, args: unknown): void
	appData?: unknown
	frameUrl?: string
} extends DilMountOptions ? true : false>

/** Collapse the whitespace the worker's text nodes carry between them. */
function flat(text: string): string {
	return text.replace(/\s+/gu, ' ').trim()
}

/** A source in the dialect, exercising state, props, a control and prose. */
const SOURCE = [
	'选一个标签页。',
	'{@body const [tab,setTab] = DIL.useState("a")}',
	'<card gap={2}>',
	'  <text>tab is {tab}</text>',
	'  <segmented-control options={[{label:"A",value:"a"},{label:"B",value:"b"}]} value={tab} onChange={setTab}/>',
	'</card>'
].join('\n')

describe('the two halves agree on the contract', () => {
	it('compiles a source from the host half into something the client half accepts', () => {
		const revision: ClientCompiled = compileDil(SOURCE)
		expect(revision.code).toContain('DIL.render')
		expect(revision.stateKeys).toContain('tab')
		expect(revision.diagnosticSummary).toBe('clean')
	})

	it('runs that program in the sandbox and renders the tree it posts back', async () => {
		const revision = compileDil(SOURCE)
		const sandbox = bootSandbox()
		try {
			await sandbox.createRunner({ compiledDil: revision.code, constants: revision.constants, appData: revision.appData })
			const tree = sandbox.latestTree()
			expect(tree, `no tree for a clean compile (${revision.diagnosticSummary})`).not.toBeNull()
			expect(flat(sandbox.treeText())).toContain('tab is a')

			document.body.innerHTML = ''
			const host = document.createElement('div')
			document.body.appendChild(host)
			const shadow = host.attachShadow({ mode: 'open' })
			const internals = mountDilViewInternal(shadow, {
				onStateChange: () => undefined,
				onEvent: () => undefined,
				appData: revision.appData
			})
			const frame = internals.sandbox.frame!
			const frameWindow = frame.contentWindow as unknown as { postMessage: () => void }
			frameWindow.postMessage = () => undefined
			window.dispatchEvent(new MessageEvent('message', {
				data: { __dilFrame: true, protocolVersion: PROTOCOL_VERSION, kind: 'ready' },
				source: frameWindow as unknown as Window
			}))
			window.dispatchEvent(new MessageEvent('message', {
				data: { __dilFrame: true, protocolVersion: PROTOCOL_VERSION, kind: 'snapshot', tree, version: 1, reason: 'initial' },
				source: frameWindow as unknown as Window
			}))
			expect(internals.element.textContent).toContain('tab is a')
			const items = internals.element.querySelectorAll('.dil-segmented-item')
			expect(items).toHaveLength(2)
			internals.handle.destroy()
		} finally {
			sandbox.close()
		}
	})

	it('closes the loop: a control in the DOM changes the tree the sandbox posts', async () => {
		const revision = compileDil(SOURCE)
		const sandbox = bootSandbox()
		try {
			await sandbox.createRunner({ compiledDil: revision.code, constants: revision.constants, appData: revision.appData })
			document.body.innerHTML = ''
			const host = document.createElement('div')
			document.body.appendChild(host)
			const shadow = host.attachShadow({ mode: 'open' })
			const internals = mountDilViewInternal(shadow, { onStateChange: () => undefined, onEvent: () => undefined })
			const frame = internals.sandbox.frame!
			const sent: Record<string, any>[] = []
			const frameWindow = frame.contentWindow as unknown as { postMessage: (message: unknown) => void }
			frameWindow.postMessage = (message: unknown) => void sent.push(message as Record<string, any>)
			const deliver = (data: Record<string, unknown>): void => {
				window.dispatchEvent(new MessageEvent('message', {
					data: { __dilFrame: true, protocolVersion: PROTOCOL_VERSION, ...data },
					source: frameWindow as unknown as Window
				}))
			}
			deliver({ kind: 'ready' })
			await internals.sandbox.connect()
			internals.handle.update(revision)
			expect(sent[0]).toMatchObject({ kind: 'createRunner' })
			// The frame is a stub here, so the program is executed by the worker harness
			// instead; what this test proves is the direction of the traffic.
			deliver({ kind: 'snapshot', tree: sandbox.latestTree(), version: 1 })
			internals.element.querySelectorAll('.dil-segmented-item')[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
			const trigger = sent.find((message) => message.kind === 'trigger')
			expect(trigger).toMatchObject({ fnId: expect.stringMatching(/^fn\d+$/u) })
			expect(trigger?.args).toEqual(['b'])

			// Feed that same handler call to the worker: the tree must move to the new tab.
			await sandbox.trigger(trigger!.fnId, trigger!.args)
			expect(flat(sandbox.treeText())).toContain('tab is b')
			expect(sandbox.stateChanges.at(-1)?.state).toEqual({ tab: 'b' })
			internals.handle.destroy()
		} finally {
			sandbox.close()
		}
	})
})
