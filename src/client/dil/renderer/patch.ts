/**
 * Patch engine: serialized tree → DOM, updated in place.
 *
 * Tree nodes from the sandbox:
 *   { t:'#text', v }   text
 *   { t:'#frag', c }   fragment (flattened away here)
 *   { t, p, c }        element: tag, props, children
 *
 * Children are matched by index and replaced only when the node kind or tag changes,
 * so element identity survives updates — an <input> keeps focus while the model is
 * still streaming a new revision of its own UI.
 *
 * Handlers never cross the boundary as functions: an `on*` prop is a
 * `{__dilFn:"fnN"}` reference, and firing it sends the id (plus the value read from
 * the DOM) back to the sandbox.
 * @module dsh-intelligent-ui/client/dil/renderer/patch
 */

import type { DilContext, DilElementNode, DilHandle, DilNode, DilProps, DilTextNode } from '../types.ts'
import { createHostComponent } from './components/host.ts'
import { currentDocument } from './dom.ts'

/** A component factory: the host's fixed vocabulary, keyed by tag. */
export type DilFactory = (props: DilProps, ctx: DilContext) => DilHandle

/** prop → default DOM event. `onChange` listens to `input` so typing updates live. */
const EVENTS: Record<string, string> = {
	onClick: 'click',
	onChange: 'input',
	onInput: 'input',
	onBlur: 'blur',
	onFocus: 'focus',
	onKeyDown: 'keydown',
	onKeyUp: 'keyup',
	onSubmit: 'submit'
}

/** A node that survives flattening: text or an element. */
export type DilFlatNode = DilTextNode | DilElementNode

const isText = (node: DilFlatNode | undefined): node is DilTextNode => !!node && node.t === '#text'
const isFragment = (node: DilNode): node is Extract<DilNode, { t: '#frag' }> => node.t === '#frag'

/** Flatten `#frag` wrappers out of one child list, dropping empty nodes. */
export function flatten(nodes: readonly DilNode[] | undefined, out: DilFlatNode[] = []): DilFlatNode[] {
	for (const node of nodes ?? []) {
		if (!node) continue
		if (isFragment(node)) flatten(node.c, out)
		else out.push(node)
	}
	return out
}

/** One live child: either text, or an element with its handle and its own children. */
export type DilRecord =
	| { text: true; node: Text; children: DilRecord[] }
	| { text: false; node: HTMLElement; handle: DilHandle; tag: string; children: DilRecord[] }

/** One bound listener, keyed by the prop that installed it. */
interface BoundEvent {
	fnId: string
	type: string
	listener: EventListener
}

/**
 * Build a patcher over one factory table.
 * @param factories - tag → factory; unknown tags fall through to host components.
 * @param ctx - the context handed to every factory.
 */
export function createPatcher(factories: Record<string, DilFactory>, ctx: DilContext) {
	const bound = new WeakMap<DilHandle, Record<string, BoundEvent>>()

	function createHandle(tag: string, props: DilProps): DilHandle {
		const withTag = { ...props, __tag: tag }
		const factory = factories[tag] as DilFactory | undefined
		const handle = factory ? factory(withTag, ctx) : createHostComponent(tag, withTag, ctx)
		handle.node.setAttribute('data-d-component', tag)
		return handle
	}

	/** Wire `on*` props to DOM listeners, reusing listeners whose fnId is unchanged. */
	function bindEvents(handle: DilHandle, props: DilProps): void {
		let boundProps = bound.get(handle)
		if (!boundProps) {
			boundProps = {}
			bound.set(handle, boundProps)
		}
		const override: Record<string, string> = {}
		for (const [domType, prop] of Object.entries(handle.events ?? {})) override[prop] = domType

		for (const prop of Object.keys(EVENTS)) {
			const fnId = props[prop] && (props[prop] as { __dilFn?: unknown }).__dilFn
			const type = override[prop] ?? EVENTS[prop]!
			const prev = boundProps[prop]
			if (prev && prev.fnId === fnId) continue
			if (prev) handle.node.removeEventListener(prev.type, prev.listener)
			delete boundProps[prop]
			if (!fnId) continue

			const listener: EventListener = (event) => {
				// the handler lives in the sandbox, so the *value* travels with the event:
				// `setChannel` must be called as `setChannel(newValue)`
				const value = handle.readValue
					? handle.readValue(event)
					: event.target && 'value' in event.target ? (event.target as { value: unknown }).value : undefined
				if (handle.readValue && value === undefined && type === 'click' && prop === 'onChange') return // click between segments
				ctx.onEvent(String(fnId), [value], { type: event.type, value })
			}
			handle.node.addEventListener(type, listener)
			boundProps[prop] = { fnId: String(fnId), type, listener }
		}
	}

	function create(entry: DilFlatNode): DilRecord {
		if (isText(entry)) return { text: true, node: currentDocument().createTextNode(entry.v), children: [] }
		const handle = createHandle(entry.t, entry.p ?? {})
		return { text: false, handle, node: handle.node, tag: entry.t, children: [] }
	}

	function update(record: DilRecord, entry: DilFlatNode): void {
		if (isText(entry)) {
			if (!record.text) return
			if (record.node.nodeValue !== entry.v) record.node.nodeValue = entry.v
			return
		}
		if (record.text) return
		const props = entry.p ?? {}
		record.handle.update({ ...props, __tag: record.tag })
		bindEvents(record.handle, props)
		patchChildren(record.handle.childHost ?? record.node, record.children, flatten(entry.c))
	}

	function sameShape(record: DilRecord, entry: DilFlatNode): boolean {
		return isText(entry) ? record.text : !record.text && record.tag === entry.t
	}

	function patchChildren(container: Node, records: DilRecord[], entries: readonly DilFlatNode[]): void {
		const next: DilRecord[] = []
		entries.forEach((entry, index) => {
			const old = records[index]
			if (old && sameShape(old, entry)) {
				update(old, entry)
				next.push(old)
				return
			}
			const made = create(entry)
			if (old) container.replaceChild(made.node, old.node)
			else container.appendChild(made.node)
			update(made, entry)
			next.push(made)
		})
		for (let index = entries.length; index < records.length; index += 1) container.removeChild(records[index]!.node)
		records.length = 0
		records.push(...next)
	}

	return { patchChildren }
}
