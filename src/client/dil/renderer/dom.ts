/**
 * Shared helpers for component factories.
 *
 * A factory is `(props, ctx) => handle`, where a handle is
 *
 *   { node, update(props), childHost?, events?, readValue? }
 *
 *   node       the DOM node inserted into the tree
 *   update     called on every patch with the latest props (keep DOM state in sync)
 *   childHost  where children are patched (defaults to `node`)
 *   events     { domEvent: 'propName' } — overrides the default event for a prop
 *   readValue  (event) => value passed to the sandbox handler
 *
 * Two host changes from upstream, both forced by living in a shadow root:
 *
 * 1. Nodes come from the *view's* document, not the module global. A `ShadowRoot`
 *    can belong to a document other than the top one, and `createElement` on the
 *    wrong document produces nodes the tree's own `ownerDocument` disagrees with.
 * 2. `activeElement()` descends through shadow roots. `document.activeElement` is
 *    the shadow *host* when the focus is inside a shadow tree, so upstream's
 *    "do not fight the user while they type" check never matched and every
 *    re-render would rewrite the caret away in a controlled input.
 * @module dsh-intelligent-ui/client/dil/renderer/dom
 */

import type { DilElement, DilProps } from '../types.ts'

let activeDocument: Document | undefined

/** Point every factory at the document that owns the view being rendered. */
export function useDocument(next: Document): void {
	activeDocument = next
}

/** The document new nodes are created in. */
export function currentDocument(): Document {
	return activeDocument ?? globalThis.document
}

/**
 * The window that owns the view.
 *
 * Constructors are per-realm: a `ResizeObserver` or `matchMedia` taken from the top
 * window and handed a node in another document throws or silently never fires.
 */
export function currentWindow(): Window & typeof globalThis {
	return (activeDocument?.defaultView ?? globalThis) as Window & typeof globalThis
}

/** Create one element in the view's document. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K]
export function el(tag: string, className?: string): HTMLElement
export function el(tag: string, className?: string): HTMLElement {
	const node = currentDocument().createElement(tag)
	if (className) node.className = className
	return node
}

/** Escape the five characters that would otherwise become markup. */
export function esc(value: unknown): string {
	return String(value == null ? '' : value).replace(/[&<>"]/gu, (char) => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>
	)[char] ?? char)
}

/** Numeric scale (`gap={2}`) and size tokens (`gap="lg"`) both resolve to px. */
const SPACING: Record<string, number> = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 }
const SPACING_TOKENS: Record<string, number> = { none: 0, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, '2xl': 32 }

/** Resolve one spacing prop to a CSS length. */
export function space(value: unknown): string {
	if (value == null || value === false) return ''
	if (typeof value === 'number') return (SPACING[value] ?? value * 4) + 'px'
	if (typeof value === 'string') {
		if (/^\d+$/u.test(value)) return (SPACING[value] ?? Number(value) * 4) + 'px'
		if (value in SPACING_TOKENS) return SPACING_TOKENS[value]! + 'px'
		return value
	}
	return String(value)
}

/** Resolve one sizing prop (`height`, `width`) to a CSS length. */
export function length(value: unknown): string {
	if (value == null || value === '') return ''
	return typeof value === 'number' ? value + 'px' : String(value)
}

/** `justify="space-between"` (CSS spelling) → the `between` token. */
export function justifyToken(value: unknown): string {
	return String(value).replace(/^space-/u, '').replace(/^flex-/u, '')
}

/** Build a className from a base and `[condition, class]` pairs. */
export function cls(base: string, ...pairs: readonly (readonly [unknown, string])[]): string {
	let out = base
	for (const [on, name] of pairs) if (on) out += ' ' + name
	return out
}

/** Applied to every component: the stable marker plus universal sizing props. */
export function applyCommon(node: HTMLElement, props: DilProps): void {
	node.setAttribute('data-d-component', String(props.__tag))
	node.style.width = length(props.width)
	node.style.display = props.hidden ? 'none' : ''
}

/**
 * The element the user is actually typing in.
 *
 * `document.activeElement` stops at the outermost shadow host, so walk down: each
 * host that has a focused node inside it is not the answer, its `shadowRoot.activeElement` is.
 * @returns the deepest focused element, or null.
 */
export function activeElement(): Element | null {
	try {
		let node: Element | null = currentDocument().activeElement
		while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement
		return node
	} catch {
		return null
	}
}

/** One normalized option of `options=[…]`. */
export interface DilOption {
	label: string
	value: unknown
}

/** Options as models write them: `[{label,value}]`, or bare strings. */
export function normalizeOptions(options: unknown): DilOption[] {
	if (!Array.isArray(options)) return []
	return options.map((option) =>
		option != null && typeof option === 'object'
			? {
				label: String((option as { label?: unknown; value?: unknown }).label ?? (option as { value?: unknown }).value ?? ''),
				value: (option as { value?: unknown }).value ?? (option as { label?: unknown }).label
			}
			: { label: String(option), value: option }
	)
}

/** The renderer's own bookkeeping slot on a DOM node. */
export type { DilElement }
