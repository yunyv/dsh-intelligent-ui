import { describe, expect, it } from 'vitest'
import { compile } from '../../src/dil/index.ts'
import { bootSandbox, collectHandlers, type SandboxTree } from './vendor.ts'

function formulas(node: SandboxTree | null | undefined): SandboxTree[] {
	if (!node) return []
	return [...(node.t === 'math' ? [node] : []), ...(node.c ?? []).flatMap(formulas)]
}

describe('math in the existing DIL compilation and state protocol', () => {
	it('passes literal attribute backslashes unchanged, with no host resolution', async () => {
		const source = String.raw`<box>
<math tex="\frac{1}{2}"/>
<math tex="\begin{pmatrix}a&b\\c&d\end{pmatrix}" display/>
<math tex="\theta + \nu + \text{safe}"/>
</box>`
		const compiled = compile(source)
		expect(compiled.diagnostics).toEqual([])
		expect(compiled.requiredComponents).toEqual([])
		// The compiled/frame wire version is 1; 14 names the captured upstream snapshot.
		expect(compiled.protocolVersion).toBe(1)
		const sandbox = bootSandbox()
		try {
			sandbox.createRunner({ compiledDil: compiled.code, constants: compiled.constants, appData: compiled.appData })
			await sandbox.flush()
			expect(sandbox.failures).toEqual([])
			const nodes = formulas(sandbox.latest?.tree)
			expect(nodes.map((node) => node.p?.tex)).toEqual([
				String.raw`\frac{1}{2}`,
				String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
				String.raw`\theta + \nu + \text{safe}`
			])
			expect(nodes[1]!.p?.display).toBe(true)
		} finally { sandbox.close() }
	})

	it('updates dynamic TeX through keyed state, and keeps it on a compiled revision', async () => {
		const source = [
			'{@body const [n, setN] = DIL.useState(2)}',
			'{@body const formula = String.raw`\\frac{1}{${n}}`}',
			'<box><math tex={formula} display/><button onClick={() => setN(n + 1)}>next</button></box>'
		].join('\n')
		const compiled = compile(source)
		expect(compiled.diagnostics).toEqual([])
		expect(compiled.stateKeys).toEqual(['n'])
		const sandbox = bootSandbox()
		try {
			sandbox.createRunner({ compiledDil: compiled.code, constants: compiled.constants, appData: compiled.appData })
			await sandbox.flush()
			expect(sandbox.failures).toEqual([])
			expect(formulas(sandbox.latest?.tree)[0]?.p?.tex).toBe(String.raw`\frac{1}{2}`)
			sandbox.trigger(collectHandlers(sandbox.latest?.tree)[0]!)
			await sandbox.flush()
			expect(formulas(sandbox.latest?.tree)[0]?.p?.tex).toBe(String.raw`\frac{1}{3}`)
			expect(await sandbox.requestState()).toMatchObject({ n: 3 })
			const revised = compile(source.replace('<box>', '<box gap={3}>'))
			sandbox.setCompiledDil({ compiledDil: revised.code, constants: revised.constants, appData: revised.appData })
			await sandbox.flush()
			expect(sandbox.failures).toEqual([])
			expect(formulas(sandbox.latest?.tree)[0]?.p?.tex).toBe(String.raw`\frac{1}{3}`)
		} finally { sandbox.close() }
	})

	it('projects literal TeX and dynamic expression source instead of dropping math', () => {
		const literal = compile(String.raw`Before <math tex="\frac{a}{b}"/> after.`)
		expect(literal.fallbackMarkdown).toContain(String.raw`\frac{a}{b}`)
		expect(literal.fallbackMarkdown).toContain('Before')
		const dynamic = compile('<math tex={formula}/>')
		expect(dynamic.fallbackMarkdown).toContain('{formula}')
		expect(compile('<math/>').fallbackMarkdown).toContain('[math]')
		expect(compile('<math tex="x`y"/>').fallbackMarkdown).toContain('`` x`y ``')
		for (const tex of ['+', '=', '→', '()']) {
			const fallback = compile(`<math tex="${tex}"/>`).fallbackMarkdown
			expect(fallback).toContain('[math]')
			expect(fallback).toContain(tex)
		}
	})

	it('retains streaming recovery for every prefix of a formula element', () => {
		const source = String.raw`<box><math tex="\frac{\alpha_{i}}{1 + x^2}" display/></box>`
		for (let length = 0; length <= source.length; length++) {
			expect(() => compile(source.slice(0, length)), `prefix ${length}`).not.toThrow()
		}
		expect(compile(source).diagnostics).toEqual([])
	})

	it('does not introduce dollar-delimited prose parsing', () => {
		const source = 'Price $10 and $x^2$ remain ordinary prose.'
		const compiled = compile(source)
		expect(compiled.code).not.toContain('__dil.jsx("math"')
		expect(compiled.fallbackMarkdown).toContain('$x^2$')
	})

	it.each([
		'a\n+', 'a\n∫', 'a\n\n\n+', '  a\n   +  ',
		String.raw`\frac{a}{b}` + '\n=\\alpha',
		'a`b\n```\n+', 'a\n<script>unsafe()</script>\n+',
	])('keeps multiline formula source in a complete literal block: %j', (tex) => {
		const compiled = compile(`<math tex="${tex}"/>`)
		expect(compiled.diagnostics).toEqual([])
		const md = compiled.fallbackMarkdown
		const longest = Math.max(2, ...(tex.match(/`+/g) ?? []).map((run) => run.length))
		const fence = '`'.repeat(longest + 1)
		expect(md).toContain(`[math]\n${fence}tex\n${tex}\n${fence}`)
	})

	it.each([
		['<text>Before ', ' after</text>'],
		['<button>', '</button>'],
		['<title>', '</title>'],
		['<table><table-row><table-cell>', '</table-cell><table-cell>other</table-cell></table-row></table>'],
	])('keeps math block boundaries inside surrounding projection %j', (before, after) => {
		const md = compile(`${before}<math tex="a\n+"/>${after}`).fallbackMarkdown
		expect(md).toContain('[math]\n```tex\na\n+\n```')
		expect(md.split('\n').filter((line) => line === '```')).toHaveLength(1)
	})

	it('retains separate multiline formulas without swallowing surrounding text', () => {
		const md = compile('<box>before <math tex="a\n+"/> between <math tex="b\n∫"/> after</box>').fallbackMarkdown
		expect(md).toContain('before')
		expect(md).toContain('between')
		expect(md).toContain('after')
		expect(md).toContain('a\n+')
		expect(md).toContain('b\n∫')
		expect(md.match(/^```tex$/gm)).toHaveLength(2)
		expect(md.match(/^```$/gm)).toHaveLength(2)
	})

	it('marks an oversized source preview instead of silently dropping the remainder', () => {
		const md = compile(`<math tex="${'x'.repeat(8193)}"/>`).fallbackMarkdown
		expect(md).toContain('x'.repeat(8192))
		expect(md).not.toContain('x'.repeat(8193))
		expect(md).toContain('source preview truncated')
		expect(md).toContain('8192')
	})

	it('does not split a surrogate pair at the preview boundary', () => {
		const md = compile(`<math tex="${'x'.repeat(8191)}😀tail"/>`).fallbackMarkdown
		expect(md).toContain('source preview truncated')
		expect(md).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u)
	})
})
