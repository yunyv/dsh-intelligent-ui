// @vitest-environment node
/** Real MathJax/NewCM and the generated offline Worker, not a mocked renderer. */
import { readFileSync, readdirSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { DOMParser } from 'linkedom'
import { describe, expect, it, vi } from 'vitest'
import { mathjax } from '@mathjax/src/js/mathjax.js'
import { renderMath } from '../../src/client/dil/math/engine.ts'
import { createNewcmFont } from '../../src/client/dil/math/newcm.ts'
import { MATH_WORKER_SOURCE } from '../../src/client/dil/math/generated/worker-source.ts'
import { MAX_MATH_INPUT_LENGTH, MAX_MATH_SVG_LENGTH, validateMathSvg } from '../../src/client/dil/math/protocol.ts'
import type { MathRenderResult } from '../../src/client/dil/math/protocol.ts'

const corpus = [
	'x^2+1',
	String.raw`\frac{1}{\sqrt{2}}`,
	String.raw`\int_0^\infty e^{-x^2}\,dx`,
	String.raw`\sum_{n=1}^\infty \frac{1}{n^2}`,
	String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
	String.raw`\begin{array}{*{2}{c}}a&b\end{array}`,
	String.raw`\begin{aligned}a&=b+c\\d&=e\end{aligned}`,
	String.raw`\mathbb{R}+\mathfrak{g}+\mathcal{F}+\mathsf{\alpha}`,
	String.raw`\mathscr{A}+\mathtt{x}+\mathbf{\Gamma}`,
	String.raw`\widehat{ABC}+\overline{x}+\vec{v}`,
	String.raw`\left\langle\frac{x}{y}\right\rangle`,
	String.raw`\text{hello & <world>}`,
	String.raw`\text{中文}`,
	String.raw`\text{😀}`,
	String.raw`\text{مرحبا}`,
	String.raw`\mathbf{\text{中文}}`,
	String.raw`\mathit{\text{中文}}`,
	String.raw`\rule{10em}{1em}`,
	String.raw`\begin{array}{|c|c|}\hline a&b\\ \hline c&d\\ \hline\end{array}`,
	String.raw`\begin{array}{c:c}a&b\\c&d\end{array}`,
	String.raw`\begin{array}{p{1em}}a b c\end{array}`,
	String.raw`\begin{array}{|c|}a\\b\end{array}`,
	String.raw`\begin{array}{|c}a\\b\end{array}`,
	String.raw`\begin{array}{c|}a\\b\end{array}`,
]

const arrayVariants = [
	['double-frame', String.raw`\begin{array}{||c||}a\\b\end{array}`],
	['zero-padding', String.raw`\begin{array}{@{}c@{}}a\\b\end{array}`],
	['inserted-spacing', String.raw`\begin{array}{l@{+}r}a&b\\c&d\end{array}`],
	['left-dashed', String.raw`\begin{array}{:c}a\\b\end{array}`],
	['right-dashed', String.raw`\begin{array}{c:}a\\b\end{array}`],
	['both-dashed', String.raw`\begin{array}{:c:}a\\b\end{array}`],
	['inner-dashed', String.raw`\begin{array}{c:c}a&b\\c&d\end{array}`],
	['top-dashed', String.raw`\begin{array}{c}\hdashline a\\b\end{array}`],
	['middle-dashed', String.raw`\begin{array}{cc}a&b\\\hdashline c&d\end{array}`],
	['all-dashed', String.raw`\begin{array}{:c:}\hdashline a\\\hdashline b\\\hdashline\end{array}`],
	['solid-frame', String.raw`\begin{array}{|c|c|}\hline a&b\\\hline c&d\\\hline\end{array}`],
] as const

const layoutVariants = [
	['tag', String.raw`a=b\tag{1}`],
	['align-tag', String.raw`\begin{align}a&=b\tag{1}\end{align}`],
	['two-lines', String.raw`a\\b`],
	['three-lines', String.raw`a\\b\\c`],
	['line-space', String.raw`a\\[1em]b`],
	['gather-tags', String.raw`\begin{gather}a=b\tag{1}\\c=d\tag{2}\end{gather}`],
	['aligned', String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`],
	['equation', String.raw`\begin{equation}a=b\end{equation}`],
	['array', String.raw`\begin{array}{cc}a&b\\c&d\end{array}`],
	['long-first', String.raw`aaaa\\b`],
	['long-last', String.raw`a\\bbbb`],
	['fraction-lines', String.raw`\frac{1}{2}\\\frac{3}{4}`],
	['spaced-lines', String.raw`a\\[2em]b\\[.5em]c`],
	['word-tag', String.raw`\begin{align}a&=b\tag{LEFT}\end{align}`],
	['starred-tag', String.raw`a=b\tag*{note}`],
	['labelled-tag', String.raw`\begin{equation}a=b\tag{1}\label{eq:one}\end{equation}`],
	['negative-space', String.raw`a\\[-.1em]b`],
	['ex-space', String.raw`a\\[.5ex]b`],
	['nested-tag', String.raw`\begin{align}\begin{aligned}a&=b\\c&=d\end{aligned}\tag{2}\end{align}`],
	['fraction-tag', String.raw`\frac{1}{2}=\frac{2}{4}\tag{3}`],
	['multline', String.raw`\begin{multline}a+b+c\\d+e+f\end{multline}`],
	['multline-tag', String.raw`\begin{multline}a+b+c\tag{1}\\d+e+f\end{multline}`],
	['multline-starred', String.raw`\begin{multline*}a+b+c\\d+e+f\end{multline*}`],
] as const

const tallMatrices = [26, 27, 40, 60].map((rows) => ({ rows, tex: String.raw`\begin{pmatrix}` + Array(rows).fill('x').join(String.raw`\\`) + String.raw`\end{pmatrix}` }))

function good(result: MathRenderResult): string {
	expect(result.ok, !result.ok ? result.error : undefined).toBe(true)
	if (!result.ok) throw new Error(result.error)
	expect(validateMathSvg(result.svg)).toBeNull()
	expect(result.svg).toMatch(/^<svg\s/)
	expect(result.svg).toMatch(/<(?:path|text|rect|line|polyline|polygon)\b/)
	expect(result.svg).not.toMatch(/mjx-container|<use\b|<defs\b|(?:xlink:)?href\s*=|<merror\b|data-latex=/)
	expect(result.svg).toMatch(/width="[\d.]+em"/)
	expect(result.svg).toMatch(/height="[\d.]+em"/)
	expect(result.svg).toMatch(/style="vertical-align: (?:0|-?[\d.]+em);"/)
	expect(result.svg).not.toMatch(/(?:width|height)="[^"]*ex"/)
	return result.svg
}

function bad(result: MathRenderResult): string {
	expect(result.ok).toBe(false)
	if (result.ok) throw new Error('Expected a controlled math error')
	expect(result.error.length).toBeGreaterThan(0)
	expect(result.error.length).toBeLessThanOrEqual(512)
	return result.error
}

function svg(body = '', attributes = ''): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 -1000 1000 1000"${attributes}>${body}</svg>`
}

const invalidSvgs: [string, string][] = [
	['non-SVG', '<div>hello</div>'],
	['unconsumed table width marker', svg('<g data-mml-node="mtable" data-width-includes-label="true"/>')],
	['no namespace', '<svg width="1em" height="1em" viewBox="0 0 1 1"/>'],
	['no geometry', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
	['multiple roots', svg() + svg()],
	['nested root namespace', svg(svg())],
	['unbounded nested viewport', svg('<svg width="1000000" height="1000000" viewBox="0 0 0.00001 0.00001"><path d="M0 0L1 1"/></svg>')],
	['relative path accumulation', svg('<path d="M0 0l900000 0 900000 0"/>')],
	['mismatched tags', svg('<g></path>')],
	['unquoted attributes', svg('<path d=M0,0/>')],
	['duplicate attributes', svg('', ' width="2em"')],
	['XML processing instruction', '<?xml version="1.0"?>' + svg()],
	['DTD', '<!DOCTYPE svg [<!ENTITY x SYSTEM "https://example.invalid">]>' + svg()],
	['script', svg('<script>alert(1)</script>')],
	['foreignObject', svg('<foreignObject/>')],
	['image', svg('<image href="https://example.invalid/a.svg"/>')],
	['use', svg('<use href="#glyph"/>')],
	['animation', svg('<animate attributeName="x"/>')],
	['link', svg('<a href="javascript:alert(1)"><path d="M0 0"/></a>')],
	['style element', svg('<style>path{fill:red}</style>')],
	['root event', svg('', ' onload="alert(1)"')],
	['path event', svg('<path d="M0 0" onpointerenter="alert(1)"/>')],
	['class', svg('<g class="outside"/>')],
	['unrelated MathJax class', svg('<line class="mjx-outside"/>')],
	['multiple line classes', svg('<line class="mjx-solid outside"/>')],
	['encoded extra line class', svg('<line class="mjx-solid&#32;outside"/>')],
	['line class on a group', svg('<g class="mjx-solid"/>')],
	['line direction outside its enum', svg('<line data-line="horizontal"/>')],
	['line metadata on text', svg('<text data-line="h">x</text>')],
	['false frame marker', svg('<rect data-frame="false" width="1" height="1"/>')],
	['background marker on a group', svg('<g data-bgcolor="true"/>')],
	['false background marker', svg('<rect data-bgcolor="false" width="1" height="1"/>')],
	['nonzero enclosure padding', svg('<g data-padding="1"/>')],
	['encoded nonzero enclosure padding', svg('<g data-padding="&#49;"/>')],
	['enclosure padding on a path', svg('<path data-padding="0" d="M0 0L1 1"/>')],
	['event on zero enclosure padding', svg('<g data-padding="0" onload="alert(1)"/>')],
	['unknown fallback variant', svg('<text data-variant="normal outside">x</text>')],
	['variant on a group', svg('<g data-variant="normal"/>')],
	['invalid paragraph alignment', svg('<g data-align="left right"/>')],
	['paragraph alignment on a path', svg('<path d="M0 0" data-align="left"/>')],
	['multiple paragraph vertical alignments', svg('<g data-vertical-align="top bottom"/>')],
	['unknown paragraph vertical alignment', svg('<g data-vertical-align="outside"/>')],
	['paragraph vertical alignment on a path', svg('<path d="M0 0" data-vertical-align="top"/>')],
	['invalid paragraph overflow', svg('<g data-overflow="url(https://example.invalid)"/>')],
	['CSS on an allowed line class', svg('<line data-line="h" class="mjx-solid" style="stroke:url(https://example.invalid)"/>')],
	['event on an allowed line class', svg('<line data-line="h" class="mjx-solid" onload="alert(1)"/>')],
	['ID', svg('<g id="outside"/>')],
	['root CSS', svg('', ' style="background:url(https://example.invalid)"')],
	['path CSS', svg('<path d="M0 0" style="fill:red"/>')],
	['external paint', svg('<path d="M0 0" fill="url(https://example.invalid)"/>')],
	['encoded paint URL', svg('<path d="M0 0" fill="&#x75;rl(https://example.invalid)"/>')],
	['unknown entity', svg('<text>&outside;</text>')],
	['unescaped entity', svg('<text>a&b</text>')],
	['invalid numeric entity', svg('<text>&#xD800;</text>')],
	['control character', svg('<text>\u0000</text>')],
	['non-finite path', svg('<path d="M0 0L1e999 2"/>')],
	['malformed path exponent', svg('<path d="M0 0L1e 2"/>')],
	['non-finite viewBox', svg().replace('0 -1000 1000 1000', '0 0 1e999 1')],
	['negative viewBox extent', svg().replace('0 -1000 1000 1000', '0 0 -1 1')],
	['zero viewBox extent', svg().replace('0 -1000 1000 1000', '0 0 0 1')],
	['root viewBox scale amplification', svg().replace('0 -1000 1000 1000', '0 0 1e-308 1e-308')],
	['root viewBox one-axis amplification', svg().replace('0 -1000 1000 1000', '0 0 1e-308 1000')],
	['underflowed viewBox extent', svg().replace('0 -1000 1000 1000', '0 0 1e-999 1')],
	['extreme root length', svg().replace('width="1em"', 'width="1e100em"')],
	['negative root length', svg().replace('width="1em"', 'width="-1em"')],
	['extreme local geometry', svg('<rect x="1000001" width="1" height="1"/>')],
	['malformed scale exponent', svg('<g transform="scale(1e)"><path d="M0 0"/></g>')],
	['malformed translation exponent', svg('<g transform="translate(1e,2)"><path d="M0 0"/></g>')],
	['extreme matrix', svg('<g transform="matrix(1000000 0 0 1000000 0 0)"><path d="M0 0L1 1"/></g>')],
	['singular skew', svg('<g transform="skewX(90)"><path d="M0 0L1 1"/></g>')],
	['cumulative transform amplification', svg('<g transform="scale(100)">'.repeat(10) + '<path d="M0 0L1 1"/>' + '</g>'.repeat(10))],
	['element overflow', svg('<path d="M0 0"/>'.repeat(4096))],
	['depth overflow', svg('<g>'.repeat(64) + '</g>'.repeat(64))],
	['path data overflow', svg(`<path d="M0 0${'L1 1'.repeat(16384)}"/>`)],
	['metadata overflow', svg(`<g data-latex="${'a'.repeat(MAX_MATH_INPUT_LENGTH * 2 + 1)}"/>`)],
	['output overflow', svg(' '.repeat(MAX_MATH_SVG_LENGTH))],
]

describe('shared inert math SVG boundary', () => {
	it('accepts escaped text, inert metadata and bounded transforms', () => {
		expect(validateMathSvg(svg('<g data-frame-styles="" transform="translate(20,-10) scale(0.707)"><path d="M0 0L2e2 -1.5Z" fill="currentColor"/><text font-family="serif">&lt;math&amp;&#x3B1;</text></g>', ' style="vertical-align: -0.2em;"'))).toBeNull()
	})
	it.each([
		['solid horizontal line', '<line data-line="h" class="mjx-solid" x1="0" y1="0" x2="100" y2="0"/>'],
		['dashed vertical line', '<line data-line="v" class="mjx-dashed" x1="0" y1="0" x2="0" y2="100"/>'],
		['dotted line', '<line data-line="h" class="mjx-dotted"/>'],
		['encoded fixed line values', '<line data-line="&#104;" class="mjx-sol&#105;d"/>'],
		['table frame', '<rect data-frame="true" class="mjx-solid" width="100" height="100"/>'],
		['dashed frame', '<rect data-frame="true" class="mjx-dashed" width="100" height="100"/>'],
		['rule background', '<rect data-bgcolor="true" fill="black" width="100" height="100"/>'],
		['zero enclosure padding', '<g data-mml-node="menclose" data-padding="0"/>'],
		['encoded zero enclosure padding', '<g data-mml-node="menclose" data-padding="&#48;"/>'],
		['left paragraph', '<g data-align="left" data-overflow="auto"/>'],
		['center paragraph', '<g data-align="center" data-overflow="linebreak"/>'],
		['right paragraph', '<g data-align="right"/>'],
		['top paragraph', '<g data-vertical-align="top"/>'],
		['bottom paragraph', '<g data-vertical-align="bottom"/>'],
		['centered paragraph', '<g data-vertical-align="center"/>'],
		['middle paragraph', '<g data-vertical-align="middle"/>'],
	])('accepts the fixed MathJax attribute dialect: %s', (_name, body) => {
		expect(validateMathSvg(svg(body!))).toBeNull()
	})
	it('accepts the locked NewCM fallback variants only on text nodes', () => {
		const variants = Reflect.get(createNewcmFont(), 'variant') as Record<string, unknown>
		for (const variant of [...Object.keys(variants), '-explicitFont']) {
			expect(validateMathSvg(svg(`<text data-variant="${variant}" font-family="serif">中</text>`)), variant).toBeNull()
		}
	})
	it.each(invalidSvgs)('rejects %s without repairing it', (_name, value) => {
		expect(validateMathSvg(value)).not.toBeNull()
	})
})

describe('real synchronous MathJax 4.1.3 + NewCM 4.1.3', () => {
	it.each(layoutVariants.flatMap(([id, tex]) => [false, true].map((display) => ({ id, tex, display }))))('renders finite intrinsic $id layout (display=$display)', ({ id, tex, display }) => {
		const value = good(renderMath(tex, display))
		expect(value).not.toMatch(/(?:width|height|x|y)="[^"]*%|preserveAspectRatio=|data-table=|data-(?:labels|mjx-viewBox|mjx-linestack|mjx-linebox|mjx-lineno|lineleading|width-includes-label)=|min-width:/)
		expect(Number(/width="([\d.]+)em"/.exec(value)![1])).toBeLessThan(16)
		if (id === 'multline-tag') expect(value).toContain('data-c="31"')
	})
	it('preserves explicit tag glyphs instead of silently dropping them', () => {
		for (const tex of [String.raw`a=b\tag{1}`, String.raw`\begin{equation}a=b\tag{1}\label{eq:one}\end{equation}`]) expect(good(renderMath(tex, true))).toContain('data-c="31"')
		const two = good(renderMath(String.raw`\begin{gather}a=b\tag{1}\\c=d\tag{2}\end{gather}`, true))
		expect(two).toContain('data-c="31"')
		expect(two).toContain('data-c="32"')
		const word = good(renderMath(String.raw`\begin{align}a&=b\tag{LEFT}\end{align}`, true))
		for (const code of ['4C', '45', '46', '54']) expect(word).toContain(`data-c="${code}"`)
	})
	it('preserves explicit positive, negative and ex line leading without forcing display style', () => {
		const height = (tex: string, display: boolean) => Number(/viewBox="[^"]* ([\d.]+)"/.exec(good(renderMath(tex, display)))![1])
		for (const display of [false, true]) {
			const ordinary = height(String.raw`a\\b`, display)
			expect(height(String.raw`a\\[1em]b`, display)).toBeGreaterThan(ordinary + 700)
			expect(height(String.raw`a\\[-.1em]b`, display)).toBeLessThan(ordinary)
			expect(height(String.raw`a\\[.5ex]b`, display)).toBeGreaterThan(ordinary)
		}
		expect(height(String.raw`\frac{1}{2}\\\frac{3}{4}`, false)).toBeLessThan(height(String.raw`\frac{1}{2}\\\frac{3}{4}`, true))
	})
	it.each([false, true])('moves actual glyph baselines by explicit leading (display=%s)', (display) => {
		const baselines = (tex: string, codes = ['1D44E', '1D44F']): number[] => {
			const document = new DOMParser().parseFromString(good(renderMath(tex, display)), 'image/svg+xml')
			return codes.map((code) => {
				let element = document.querySelector(`[data-c="${code}"]`)
				expect(element, `missing glyph ${code}`).not.toBeNull()
				let y = 0
				while (element) {
					for (const match of (element.getAttribute('transform') ?? '').matchAll(/translate\(([^)]*)\)/g)) {
						const values = match[1]!.trim().split(/[ ,]+/).map(Number)
						y += values[1] ?? 0
					}
					element = element.parentElement
				}
				return y
			})
		}
		const gap = (tex: string) => { const values = baselines(tex); return values[0]! - values[1]! }
		const normal = gap(String.raw`a\\b`)
		expect(normal).toBeCloseTo(1200, 3)
		expect(gap(String.raw`a\\[1em]b`) - normal).toBeCloseTo(800, 3)
		expect(gap(String.raw`a\\[-.1em]b`) - normal).toBeCloseTo(-300, 3)
		expect(gap(String.raw`a\\[.5ex]b`)).toBeGreaterThan(normal)
		const three = baselines(String.raw`a\\[1em]b\\[.5em]c`, ['1D44E', '1D44F', '1D450'])
		expect(three.map((y) => y - three[0]!)).toEqual([0, -2000, -3500])
	})
	it('keeps finite-layout adaptation request-local and recovers after a failed layout input', () => {
		const ordinary = good(renderMath('x^2+1', false))
		good(renderMath(String.raw`a=b\tag{1}`, true))
		good(renderMath(String.raw`a\\b`, false))
		bad(renderMath(String.raw`a\\[1000000em]b`, false))
		expect(good(renderMath('x^2+1', false))).toBe(ordinary)
	})
	it.each(arrayVariants.flatMap(([id, tex]) => [false, true].map((display) => ({ id, tex, display }))))('normalizes $id array output without widening group CSS (display=$display)', ({ id, tex, display }) => {
		const value = good(renderMath(tex, display))
		expect(value).not.toMatch(/data-array-padding=|<g\b[^>]*\bstyle=|stroke=""/)
		if (['left-dashed', 'right-dashed', 'both-dashed'].includes(id)) expect(value).toContain('stroke-dasharray="70 210"')
		if (id === 'top-dashed') expect(value).toContain('stroke-dasharray="70 209.9"')
	})
	it.each(tallMatrices.flatMap(({ rows, tex }) => [false, true].map((display) => ({ rows, tex, display }))))('renders $rows-row NewCM delimiters within cumulative budgets (display=$display)', ({ tex, display }) => {
		good(renderMath(tex, display))
	})
	it.each(corpus.flatMap((tex) => [false, true].map((display) => ({ tex, display }))))('renders $tex (display=$display) as one self-contained vector SVG', ({ tex, display }) => {
		good(renderMath(tex, display))
	})
	it('statically imports exactly the 40 installed SVG shards, including uppercase PUA', () => {
		const source = readFileSync(new URL('../../src/client/dil/math/newcm.ts', import.meta.url), 'utf8')
		const imported = [...source.matchAll(/import '@mathjax\/mathjax-newcm-font\/js\/svg\/dynamic\/([^']+)'/g)].map((match) => match[1]!).sort()
		const installed = readdirSync(new URL('../../node_modules/@mathjax/mathjax-newcm-font/mjs/svg/dynamic/', import.meta.url)).filter((name) => name.endsWith('.js')).sort()
		expect(imported).toHaveLength(40)
		expect(imported).toEqual(installed)
		expect(imported).toContain('PUA.js')
	})
	it('uses actual NewCM x_height when reversing the MathJax root ex conversion', () => {
		const value = good(renderMath('x', false))
		const viewBox = /viewBox="([^\"]+)"/.exec(value)![1]!.split(' ').map(Number)
		const widthEm = Number(/width="([\d.]+)em"/.exec(value)![1])
		const heightEm = Number(/height="([\d.]+)em"/.exec(value)![1])
		// NewCM x_height=0.442; MathJax rounds its ex lengths to 0.001ex.
		expect(widthEm).toBeCloseTo(viewBox[2]! / 1000, 3)
		expect(heightEm).toBeCloseTo(viewBox[3]! / 1000, 3)
	})
	it('does not leak def or newcommand macros into the next request', () => {
		good(renderMath(String.raw`\def\saved{a}\newcommand{\mine}{b}\saved+\mine`, false))
		expect(bad(renderMath(String.raw`\saved`, false))).toMatch(/Undefined control sequence/)
		expect(bad(renderMath(String.raw`\mine`, false))).toMatch(/Undefined control sequence/)
	})
	it('does not attempt dynamic loads, including extended fonts and forbidden packages', () => {
		const load = vi.spyOn(mathjax, 'asyncLoad').mockImplementation((file) => { throw new Error(`Unexpected dynamic load ${file}`) })
		try {
			for (const tex of corpus) good(renderMath(tex, false))
			bad(renderMath(String.raw`\require{physics}`, false))
			bad(renderMath(String.raw`\href{https://example.invalid}{x}`, false))
			expect(load).not.toHaveBeenCalled()
		} finally { load.mockRestore() }
	})
	it('accepts exactly the input limit without accepting the next character', () => {
		good(renderMath('x' + ' '.repeat(MAX_MATH_INPUT_LENGTH - 1), false))
		bad(renderMath('x'.repeat(MAX_MATH_INPUT_LENGTH + 1), false))
	})
	it.each(['', '   ', 'x\u0000', String.raw`\unknownOfflineMacro`, String.raw`\require{html}`, String.raw`\style{background:url(https://example.invalid)}{x}`, String.raw`\htmlClass{outside}{x}`])('returns controlled errors for %j', (tex) => {
		bad(renderMath(tex, false))
	})
	it('rejects malformed input types without coercion', () => {
		bad(renderMath(null as unknown as string, false))
		bad(renderMath('x', 'display' as unknown as boolean))
	})
	it.each([
		String.raw`\begin{array}{*{999999999}{c}}x\end{array}`,
		String.raw`\begin{array}{*{-1}{c}}x\end{array}`,
		String.raw`\begin{array}{*{256}{ccccccccccccccccccccccccccccccccc}}x\end{array}`,
		String.raw`\newcolumntype{C}{*{999999999}{c}}\begin{array}{C}x\end{array}`,
	])('bounds column-template repetition before allocation: %s', (tex) => {
		expect(bad(renderMath(tex, false))).toMatch(/column repetition exceeds/)
	})
	it('bounds recursive macro substitution and recovers on the next request', () => {
		expect(bad(renderMath(String.raw`\def\loop{\loop}\loop`, false))).toMatch(/macro|substitution/i)
		good(renderMath('y', false))
	})
	it('bounds recursive column template macros', () => {
		expect(bad(renderMath(String.raw`\newcolumntype{C}{C}\begin{array}{C}x\end{array}`, false))).toMatch(/column specifiers|template|substitution/i)
	})
})

/** Execute precisely the source the browser receives, with no DOM or module loader. */
const workerScript = new Script(MATH_WORKER_SOURCE, { filename: 'offline-math-worker.js' })
function bootWorker() {
	const posted: { id: number | string; result: MathRenderResult }[] = []
	let networkCalls = 0
	const network = () => { networkCalls++; throw new Error('Unexpected network call') }
	const context = createContext({
		postMessage: (message: typeof posted[number]) => posted.push(structuredClone(message)),
		fetch: network, XMLHttpRequest: network, WebSocket: network, EventSource: network,
		WebTransport: network, RTCPeerConnection: network, importScripts: network,
		Worker: network, SharedWorker: network, navigator: { sendBeacon: network },
	}, { codeGeneration: { strings: false, wasm: false } })
	workerScript.runInContext(context, { timeout: 10000 })
	return {
		context,
		posted,
		get networkCalls() { return networkCalls },
		request(data: unknown) {
			context.__request = structuredClone(data)
			new Script('onmessage({data: __request})').runInContext(context, { timeout: 3000 })
			return posted.shift()
		},
	}
}

describe('generated single offline IIFE, executed', () => {
	it('renders finite tag and multiline layouts with exact source parity and no network', () => {
		const worker = bootWorker()
		for (const display of [false, true]) for (const [id, tex] of layoutVariants) {
			const reply = worker.request({ id: `layout-${id}-${display}`, tex, display })!
			expect(reply.id).toBe(`layout-${id}-${display}`)
			expect(good(reply.result)).toBe(good(renderMath(tex, display)))
		}
		expect(worker.networkCalls).toBe(0)
	})
	it('normalizes array variants in the distributed Worker with exact source parity and no network', () => {
		const worker = bootWorker()
		for (const display of [false, true]) for (const [id, tex] of arrayVariants) {
			const reply = worker.request({ id: `array-${id}-${display}`, tex, display })!
			expect(reply.id).toBe(`array-${id}-${display}`)
			expect(good(reply.result)).toBe(good(renderMath(tex, display)))
		}
		expect(worker.networkCalls).toBe(0)
	})
	it('renders tall NewCM delimiters with the same retained cumulative limits and no network', () => {
		const worker = bootWorker()
		for (const display of [false, true]) for (const { rows, tex } of tallMatrices) {
			const reply = worker.request({ id: `tall-${rows}-${display}`, tex, display })!
			expect(reply.id).toBe(`tall-${rows}-${display}`)
			expect(good(reply.result)).toBe(good(renderMath(tex, display)))
		}
		expect(worker.networkCalls).toBe(0)
	})
	it('boots with no DOM, no module loader, and JavaScript/Wasm dynamic code generation disabled', () => {
		const worker = bootWorker()
		expect(worker.context.document).toBeUndefined()
		expect(worker.context.require).toBeUndefined()
		expect(worker.networkCalls).toBe(0)
		expect(worker.posted).toEqual([])
		good(worker.request({ id: 'first', tex: 'x^2+1', display: false })!.result)
	})
	it('renders the real inline and display corpus with zero network calls', () => {
		const worker = bootWorker()
		for (const display of [false, true]) {
			for (const [id, tex] of corpus.entries()) {
				const reply = worker.request({ id, tex, display })!
				expect(reply.id).toBe(id)
				expect(good(reply.result)).toBe(good(renderMath(tex, display)))
			}
		}
		expect(worker.networkCalls).toBe(0)
	})
	it('preserves request-local macros and recovers after bounded parser errors', () => {
		const worker = bootWorker()
		good(worker.request({ id: 1, tex: String.raw`\newcommand{\mine}{a}\mine`, display: false })!.result)
		expect(bad(worker.request({ id: 2, tex: String.raw`\mine`, display: false })!.result)).toMatch(/Undefined control sequence/)
		expect(bad(worker.request({ id: 3, tex: String.raw`\begin{array}{*{999999999}{c}}x\end{array}`, display: true })!.result)).toMatch(/column repetition exceeds/)
		good(worker.request({ id: 4, tex: 'z', display: false })!.result)
		expect(worker.networkCalls).toBe(0)
	})
	it('rejects malformed request fields and ignores missing/unsafe request IDs', () => {
		const worker = bootWorker()
		for (const data of [null, {}, { id: {} }, { id: Infinity }, { id: 'a'.repeat(129) }]) expect(worker.request(data)).toBeUndefined()
		for (const data of [{ id: 1 }, { id: 'two', tex: 'x', display: 'yes' }, { id: 3, tex: {}, display: false }]) {
			expect(worker.request(data)).toMatchObject({ id: data.id, result: { ok: false, error: 'Invalid math Worker request' } })
		}
		good(worker.request({ id: 'valid', tex: 'x', display: true })!.result)
	})
	it('seals browser networking and nested-worker APIs even when the host provides them', () => {
		const worker = bootWorker()
		for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'RTCPeerConnection', 'importScripts', 'Worker', 'SharedWorker']) {
			const descriptor = Object.getOwnPropertyDescriptor(worker.context, name)!
			expect(descriptor.writable).toBe(false)
			expect(descriptor.configurable).toBe(false)
			expect(() => new Script(`globalThis[${JSON.stringify(name)}]("https://example.invalid")`).runInContext(worker.context)).toThrow('Math Worker network access is disabled')
		}
		expect(() => new Script('navigator.sendBeacon("https://example.invalid")').runInContext(worker.context)).toThrow('Math Worker network access is disabled')
		expect(worker.context.caches).toBeUndefined()
		expect(worker.networkCalls).toBe(0)
	})
})
