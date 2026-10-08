/**
 * Host-side renderer: the sandbox produces a serializable element tree; this turns
 * it into DOM and keeps it patched.
 *
 *   const view = mount(container, tree, { onEvent, appData });
 *   view.update(nextTree);
 *
 * Every rendered element carries `data-d-component="<tag>"` — the marker the real
 * client uses, and the hook tests and tooling attach to. Nothing here is generated:
 * this is the host's fixed vocabulary, and the model can only *describe* a UI in it.
 *
 * DOM, not React, on purpose: the tree comes from the sandbox as data, the update
 * granularity is a patch, and a React tree would re-own every node the patcher needs
 * to keep identity on. The React shell around this view is the host half's business.
 * @module dsh-genui/client/dil/renderer
 */

import type { DilComponentResult, DilContext, DilHandle, DilNode, DilProps } from '../types.ts'
import charts from './components/charts.ts'
import data from './components/data.ts'
import { defineHost } from './components/host.ts'
import controls from './components/controls.ts'
import layout from './components/layout.ts'
import text from './components/text.ts'
import { useDocument } from './dom.ts'
import { ICON_NAMES, iconSvg } from './icons.ts'
import { createPatcher, flatten, type DilFactory, type DilRecord } from './patch.ts'

/** The host's fixed vocabulary: tag → factory. The model cannot add to it. */
export const FACTORIES: Record<string, DilFactory> = { ...layout, ...text, ...controls, ...data, ...charts }

function componentResults(appData: unknown): Record<string, DilComponentResult> {
	const genui = (appData as { opGenui?: { componentResults?: Record<string, DilComponentResult> } } | null | undefined)?.opGenui
	return genui?.componentResults ?? {}
}

/** What one mounted view offers its owner. */
export interface DilRenderer {
	/** Patch the container to show `tree`. */
	update(tree: DilNode | null): void
	/** New appData (componentResults arriving mid-stream) applies to future mounts. */
	setAppData(appData: unknown): void
	/** The tree currently on screen. */
	readonly tree: DilNode | null
	/** Clear the container and run every factory teardown. */
	destroy(): void
}

/** Options for {@link mount}. */
export interface DilRenderOptions {
	onEvent?: (fnId: string, args: unknown[], meta?: { type?: string; value?: unknown }) => void
	onMissingComponent?: (tag: string, result: unknown) => void
	appData?: unknown
	/** Document to create nodes in; defaults to the container's own. */
	document?: Document
}

/**
 * Mount a tree into one container and keep it patched.
 * @param container - where the tree renders; cleared by `destroy()`.
 * @param tree - the first tree, or null for an empty view.
 * @param options - event sink, appData, document.
 */
export function mount(container: HTMLElement, tree?: DilNode | null, options: DilRenderOptions = {}): DilRenderer {
	useDocument(options.document ?? container.ownerDocument ?? globalThis.document)
	const teardowns: (() => void)[] = []
	const ctx: DilContext = {
		onEvent: (fnId, args, meta) => (options.onEvent ?? (() => {}))(fnId, args, meta),
		onMissingComponent: (tag, result) => options.onMissingComponent?.(tag, result),
		componentResults: componentResults(options.appData),
		onTeardown: (dispose) => teardowns.push(dispose)
	}
	const { patchChildren } = createPatcher(FACTORIES, ctx)
	const records: DilRecord[] = []
	let current: DilNode | null = null

	const view: DilRenderer = {
		update(nextTree: DilNode | null): void {
			current = nextTree
			patchChildren(container, records, flatten(nextTree ? [nextTree] : []))
			container.setAttribute('data-dil-ready', 'true')
		},
		setAppData(appData: unknown): void {
			ctx.componentResults = componentResults(appData)
		},
		get tree(): DilNode | null {
			return current
		},
		destroy(): void {
			for (const dispose of teardowns.splice(0)) {
				try {
					dispose()
				} catch {
					// a teardown that throws must not strand the ones behind it
				}
			}
			container.textContent = ''
			records.length = 0
		}
	}
	if (tree) view.update(tree)
	return view
}

export { createPatcher, defineHost, flatten, iconSvg, ICON_NAMES }
export type { DilFactory }
export type { DilHandle, DilProps }
