// @vitest-environment jsdom
/**
 * The stylesheet, and the scheme it paints with.
 *
 * The theme is the whole reason this library is not upstream's: the component look has
 * to come from the host's tokens. Two invariants are asserted on the real bytes — the
 * text is identical to `theme.css`, and no paint property holds a raw colour of its own
 * — plus the shadow-root mechanics: one injected `<style>`, and a scheme mirrored onto
 * the view element because no selector inside a shadow root can read the document's.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDilStyles, resolveScheme, STYLE_ATTRIBUTE, THEME_ATTRIBUTE, THEME_CSS, watchScheme } from '../../src/client/dil/theme.ts'

/** The authored stylesheet, straight off disk. */
const AUTHORED = readFileSync(join(process.cwd(), 'src', 'client', 'dil', 'theme.css'), 'utf8')

/** Every DSH token the library has to resolve. */
const TOKENS = [
	'--dsw-alias-bg-base',
	'--dsw-alias-bg-layer-1',
	'--dsw-alias-bg-layer-2',
	'--dsw-alias-bg-layer-3',
	'--dsw-alias-bg-overlay',
	'--dsw-alias-interactive-bg-hover',
	'--dsw-alias-border-l2',
	'--dsw-alias-border-l3',
	'--dsw-alias-brand-primary',
	'--dsw-alias-label-primary',
	'--dsw-alias-label-secondary',
	'--dsw-alias-label-tertiary',
	'--dsw-alias-label-primary-inverted',
	'--dsw-alias-link',
	'--dsw-alias-state-error-primary',
	'--dsw-alias-state-idle-primary',
	'--dsw-alias-state-success-primary',
	'--dsw-alias-state-warn-primary',
	'--dsw-alias-switch-thumb',
	'--dsw-specific-sidebar-fill'
]

/** A window stand-in that answers only the two lookups the scheme resolver makes. */
function fakeView(options: { colorScheme?: string; dark?: boolean }): Window & typeof globalThis {
	return {
		getComputedStyle: () => ({ colorScheme: options.colorScheme ?? '' }),
		matchMedia: (query: string) => ({ matches: Boolean(options.dark) && query.includes('dark') })
	} as unknown as Window & typeof globalThis
}

afterEach(() => {
	document.body.innerHTML = ''
	document.documentElement.removeAttribute('data-ds-dark-theme')
})

describe('the stylesheet', () => {
	it('is the authored theme.css, byte for byte', () => {
		expect(THEME_CSS).toBe(AUTHORED)
	})

	it('resolves every colour through a DSH token, with a fallback', () => {
		for (const token of TOKENS) {
			expect(THEME_CSS).toContain(`var(${token},`)
		}
	})

	it('leaves no paint property with a colour of its own', () => {
		const painted = /(^|\s)(color|background|background-color|border|border-color|border-top|border-bottom|fill|stroke|outline)\s*:[^;{}]*#[0-9a-fA-F]{3,8}/giu
		expect(AUTHORED.match(painted)).toBeNull()
	})

	it('keeps upstream spacing, radii and type scale', () => {
		expect(AUTHORED).toContain('.dil-radius-lg { border-radius: 16px; }')
		expect(AUTHORED).toContain('.dil-title-md { font-size: 17px; }')
		expect(AUTHORED).toContain('font: 400 15px/1.65')
		expect(AUTHORED).toContain('font-family: var(--dil-font,')
		expect(AUTHORED).toContain('.dil-root > * + * { margin-top: 12px; }')
	})

	it('keys dark on the mirrored attribute, the host attribute, and the system', () => {
		expect(AUTHORED).toContain(`.dil-root[${THEME_ATTRIBUTE}='dark']`)
		expect(AUTHORED).toContain(':host([data-ds-dark-theme]) .dil-root')
		expect(AUTHORED).toContain('@media (prefers-color-scheme: dark)')
		expect(AUTHORED).toContain(`.dil-root:not([${THEME_ATTRIBUTE}])`)
	})

	it('never scopes anything to :root, which matches nothing inside a shadow tree', () => {
		expect(AUTHORED).not.toMatch(/(^|\})\s*:root/gu)
		// The host element is a block, not the inline box a custom element defaults to.
		expect(AUTHORED).toContain(':host { display: block;')
	})

	it('drops animation for a reader who asked for less motion', () => {
		expect(AUTHORED).toContain('@media (prefers-reduced-motion: reduce)')
	})
})

describe('installing the stylesheet', () => {
	it('injects one style element into the shadow root, ahead of everything else', () => {
		const host = document.createElement('div')
		document.body.appendChild(host)
		const shadow = host.attachShadow({ mode: 'open' })
		const filler = document.createElement('p')
		shadow.appendChild(filler)

		const style = installDilStyles(shadow)
		expect(style.parentNode).toBe(shadow)
		expect(shadow.firstChild).toBe(style)
		expect(style.textContent).toBe(THEME_CSS)
		expect(style.getAttribute(STYLE_ATTRIBUTE)).toBe('')
		// A page stylesheet would not reach in here, so nothing may be added out there.
		expect(document.querySelector(`style[${STYLE_ATTRIBUTE}]`)).toBeNull()
	})

	it('hands back the same element on every later mount', () => {
		const host = document.createElement('div')
		document.body.appendChild(host)
		const shadow = host.attachShadow({ mode: 'open' })
		const first = installDilStyles(shadow)
		const second = installDilStyles(shadow)
		expect(second).toBe(first)
		expect(shadow.querySelectorAll('style').length).toBe(1)
	})
})

describe('resolving the scheme', () => {
	it('reads the host attribute the app paints dark with', () => {
		document.body.setAttribute('data-ds-dark-theme', '')
		expect(resolveScheme(document, null)).toBe('dark')
		document.body.removeAttribute('data-ds-dark-theme')
		document.documentElement.setAttribute('data-ds-dark-theme', '')
		expect(resolveScheme(document, null)).toBe('dark')
	})

	it('prefers the scheme the host itself computed', () => {
		expect(resolveScheme(document, fakeView({ colorScheme: 'dark', dark: false }))).toBe('dark')
		expect(resolveScheme(document, fakeView({ colorScheme: 'light', dark: true }))).toBe('light')
		// `light dark` declares no choice of its own, so the next signal decides.
		expect(resolveScheme(document, fakeView({ colorScheme: 'light dark', dark: true }))).toBe('dark')
	})

	it('falls back to the system preference, and then to light', () => {
		expect(resolveScheme(document, fakeView({ dark: true }))).toBe('dark')
		expect(resolveScheme(document, fakeView({}))).toBe('light')
		expect(resolveScheme(document, null)).toBe('light')
	})

	it('watches for a change and reports only real ones', async () => {
		const host = document.createElement('div')
		document.body.appendChild(host)
		const shadow = host.attachShadow({ mode: 'open' })
		const seen: string[] = []
		const stop = watchScheme(document, window, (scheme) => seen.push(scheme))

		document.body.setAttribute('data-ds-dark-theme', '')
		await vi.waitFor(() => expect(seen).toEqual(['dark']))
		// Same scheme again: nothing to report, so the view is not repainted.
		document.body.setAttribute('data-ds-dark-theme', '')
		await Promise.resolve()
		expect(seen).toEqual(['dark'])

		document.body.removeAttribute('data-ds-dark-theme')
		await vi.waitFor(() => expect(seen).toEqual(['dark', 'light']))

		stop()
		document.body.setAttribute('data-ds-dark-theme', '')
		await Promise.resolve()
		expect(seen).toEqual(['dark', 'light'])
		expect(shadow.querySelectorAll('style').length).toBe(0)
	})
})
