// @vitest-environment node
/** Compile and execute the author-facing math examples, including their exact escapes. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile } from '../../src/dil/index.ts'
import { renderMath } from '../../src/client/dil/math/engine.ts'
import { MATH_WORKER_SOURCE } from '../../src/client/dil/math/generated/worker-source.ts'
import { bootSandbox, collectHandlers, type SandboxTree } from '../dil/vendor.ts'

function formulas(node: SandboxTree | null | undefined): SandboxTree[] {
	return node ? [...(node.t === 'math' ? [node] : []), ...(node.c ?? []).flatMap(formulas)] : []
}

const documents = ['README.md', 'README.zh.md', 'assets/genui-skill.md']

for (const path of documents) {
	describe(`executable math documentation: ${path}`, () => {
		it('uses the real attribute/template syntax and updates the rendered fraction', async () => {
			const text = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
			const examples = [...text.matchAll(/```dil\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1]!).filter((example) => example.includes('<math'))
			expect(examples).toHaveLength(1)
			const compiled = compile(examples[0]!)
			expect(compiled.ok).toBe(true)
			expect(compiled.diagnostics).toEqual([])
			expect(compiled.requiredComponents).toEqual([])
			const sandbox = bootSandbox()
			try {
				sandbox.createRunner({ compiledDil: compiled.code, constants: compiled.constants, appData: compiled.appData })
				await sandbox.flush()
				expect(sandbox.failures).toEqual([])
				const before = formulas(sandbox.latest?.tree)
				expect(before).toHaveLength(3)
				expect(before[1]!.p?.tex).toBe(String.raw`\frac{1}{2}`)
				expect(before[2]!.p?.tex).toBe(String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`)
				for (const node of before) {
					const rendered = renderMath(node.p?.tex as string, node.p?.display === true)
					expect(rendered.ok, !rendered.ok ? rendered.error : undefined).toBe(true)
					if (rendered.ok) expect(rendered.svg).toContain('<path')
				}
				sandbox.trigger(collectHandlers(sandbox.latest?.tree)[0]!)
				await sandbox.flush()
				expect(sandbox.failures).toEqual([])
				const after = formulas(sandbox.latest?.tree)
				expect(after[1]!.p?.tex).toBe(String.raw`\frac{1}{3}`)
				expect(renderMath(after[1]!.p?.tex as string, true).ok).toBe(true)
				expect(await sandbox.requestState()).toMatchObject({ denominator: 3 })
			} finally { sandbox.close() }
		})
	})
}

describe('redistributed math notices', () => {
	it('retains the distinct copyright notices from the pinned core sources in the Worker banner', () => {
		const sources = [
			'input/tex/ams/AmsItems.ts',
			'core/FindMath.ts',
			'adaptors/lite/Document.ts',
			'output/common/Wrappers/mtext.ts',
			'ui/safe/safe.ts',
			'output/common/Direction.ts',
			'adaptors/NodeMixin.ts',
			'output/common/Wrappers/XmlNode.ts',
			'util/context.ts',
			'components/version.ts'
		]
		const copyrights = new Set(sources.map((source) => {
			const text = readFileSync(new URL(`../../node_modules/@mathjax/src/ts/${source}`, import.meta.url), 'utf8')
			const header = text.slice(0, text.indexOf('*/') + 2)
			expect(header).toContain('Licensed under the Apache License, Version 2.0')
			const copyright = header.match(/Copyright[^\r\n]+/)?.[0]?.trim()
			expect(copyright).toBeDefined()
			return copyright!
		}))
		expect(copyrights.size).toBe(10)
		const bannerEnd = MATH_WORKER_SOURCE.indexOf('*/')
		expect(bannerEnd).toBeGreaterThan(0)
		const banner = MATH_WORKER_SOURCE.slice(0, bannerEnd + 2)
		const notice = readFileSync(new URL('../../assets/math/THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8')
		for (const copyright of copyrights) {
			expect(banner).toContain(copyright)
			expect(notice).toContain(copyright)
		}
	})
	it('ships the Apache licence text identical to the installed MathJax licence', () => {
		const shipped = readFileSync(new URL('../../assets/math/APACHE-2.0.txt', import.meta.url), 'utf8')
		expect(shipped).toBe(readFileSync(new URL('../../node_modules/@mathjax/src/LICENSE', import.meta.url), 'utf8'))
	})
})
