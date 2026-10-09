/**
 * Theme plumbing for the DIL view: the stylesheet, the scheme, and the host element
 * that carries both.
 *
 * A `ShadowRoot` is a style boundary, and three consequences shape this module:
 *
 *   • A page stylesheet cannot reach inside, so the library ships as text and is
 *     injected as one `<style>` in the shadow root. Injection is idempotent: the
 *     first mount in a root installs it, every later one reuses the element.
 *   • Custom properties *do* cross the boundary, so `--dsw-alias-*` on `body` resolves
 *     for the tree without any copy step. Only the token's fallback needs a dark
 *     variant, which `theme.css` keys on `data-dil-theme`.
 *   • `prefers-color-scheme` inside a shadow root answers for the OS, not for the app.
 *     DSH paints dark by putting `data-ds-dark-theme` on the document, and no selector
 *     written inside a shadow root can see that attribute on an ancestor — so the
 *     scheme is resolved here and mirrored onto the view element, and it is kept in
 *     step with a MutationObserver plus the media query.
 * @module dsh-intelligent-ui/client/dil/theme
 */

import { THEME_CSS } from './generated/theme-css.ts'

export { THEME_CSS }

/** Attribute marking the injected stylesheet, so mounts share one. */
export const STYLE_ATTRIBUTE = 'data-dil-styles'

/** Attribute carrying the resolved scheme on the view element. */
export const THEME_ATTRIBUTE = 'data-dil-theme'

/** The two palettes the stylesheet knows. */
export type DilScheme = 'light' | 'dark'

/**
 * Inject the library stylesheet into a shadow root, once.
 * @param root - the shadow root the view renders in.
 * @returns the style element, existing or new.
 */
export function installDilStyles(root: ShadowRoot): HTMLStyleElement {
	const existing = root.querySelector<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}]`)
	if (existing) return existing
	const document = root.ownerDocument ?? globalThis.document
	const style = document.createElement('style')
	style.setAttribute(STYLE_ATTRIBUTE, '')
	style.textContent = THEME_CSS
	root.insertBefore(style, root.firstChild)
	return style
}

/**
 * The scheme the app is painting with.
 *
 * Read in the same order the artifact frame uses — the host's declared `color-scheme`
 * first, because it is the one the app itself computed and it covers a host that
 * follows neither the attribute nor the OS.
 * @param document - the document the view lives in.
 * @param view - its window, for `getComputedStyle` and `matchMedia`.
 * @returns the scheme the view should paint with.
 */
export function resolveScheme(document: Document, view?: Window & typeof globalThis | null): DilScheme {
	const body = document.body
	if (view && body) {
		const declared = view.getComputedStyle(body).colorScheme ?? ''
		const dark = declared.includes('dark') && !declared.includes('light')
		const light = declared.includes('light') && !declared.includes('dark')
		if (dark) return 'dark'
		if (light) return 'light'
	}
	if (body?.hasAttribute('data-ds-dark-theme') || document.documentElement.hasAttribute('data-ds-dark-theme')) return 'dark'
	if (view && typeof view.matchMedia === 'function') {
		try {
			if (view.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
		} catch {
			// an environment without a media query list simply has no opinion
		}
	}
	return 'light'
}

/**
 * Watch for a scheme change: an attribute flip on the document, or the OS preference.
 * @param document - the document to observe.
 * @param view - its window.
 * @param onChange - called only when the resolved scheme actually changes.
 * @returns stop watching.
 */
export function watchScheme(
	document: Document,
	view: Window & typeof globalThis | null,
	onChange: (scheme: DilScheme) => void
): () => void {
	let last = resolveScheme(document, view)
	const check = (): void => {
		const next = resolveScheme(document, view)
		if (next === last) return
		last = next
		onChange(next)
	}
	const Observer = view?.MutationObserver ?? globalThis.MutationObserver
	const observer = typeof Observer === 'function' ? new Observer(check) : null
	observer?.observe(document.documentElement, { attributes: true })
	if (document.body) observer?.observe(document.body, { attributes: true })

	let media: MediaQueryList | null = null
	if (view && typeof view.matchMedia === 'function') {
		try {
			media = view.matchMedia('(prefers-color-scheme: dark)')
			media.addEventListener('change', check)
		} catch {
			media = null
		}
	}
	return () => {
		observer?.disconnect()
		media?.removeEventListener('change', check)
	}
}
