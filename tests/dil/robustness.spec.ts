/**
 * Robustness against real model output. Fixtures are DeepSeek generations that broke
 * earlier versions:
 *
 *   model-g2  Go code inside <code> (`for i := 0; … { wg.Add(1) }`) parsed as DIL
 *   model-n2  `{@body const T = {…}}` missing its final `}` — swallowed the document
 *   model-t1  state never declared, option arrays never declared, ```html fences
 *   model-t3  state never declared
 *
 * The property: for EVERY prefix of every document (that is what streaming sends),
 * the compiled program parses, and running it never fails the sandbox.
 *
 * Ported verbatim from `vendor/dil-replica/replica/test/robustness.test.js` (MIT,
 * Disdjj/intelligent-ui-demo @938ab09): every assertion below is the upstream one,
 * phrased in vitest.
 * @module tests/dil/robustness.spec
 */

import fs from 'node:fs'
import path from 'node:path'
import { Script } from 'node:vm'
import { expect, test } from 'vitest'
import { compile } from '../../src/dil/index.ts'
import { ARTIFACTS_DIR, FIXTURES_DIR, bootSandbox } from './vendor.ts'

const SOURCES: [string, string][] = [
	...fs
		.readdirSync(FIXTURES_DIR)
		.filter((f) => f.endsWith('.dil.md'))
		.map((f) => [f, fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8')] as [string, string]),
	['captured', fs.readFileSync(path.join(ARTIFACTS_DIR, 'genui-source.dil.md'), 'utf8')]
]

for (const [name, src] of SOURCES) {
	test(`${name}: every streamed prefix compiles to a parsable program`, () => {
		for (let n = 1; n <= src.length; n += 5) {
			const r = compile(src.slice(0, n))
			expect(() => new Script(`(function(){${r.code}\n})`), `prefix ${n}`).not.toThrow()
			expect(r.diagnostics.some((d) => d.code === 'invalid_program'), `prefix ${n} fell back to text`).toBe(false)
		}
	}, 120_000)

	test(`${name}: streaming it through one sandbox never fails`, async () => {
		const sb = bootSandbox()
		let started = false
		let trees = 0
		try {
			for (let n = 200; n <= src.length + 200; n += 211) {
				const r = compile(src.slice(0, n))
				const payload = { compiledDil: r.code, constants: r.constants, appData: r.appData }
				if (!started) { sb.createRunner(payload); started = true } else sb.setCompiledDil(payload)
				await sb.flush()
				if (sb.latest && sb.latest.tree) trees++
			}
			expect(sb.failures.map((f) => f.error && f.error.message)).toEqual([])
			expect(trees).toBeGreaterThan(0)
		} finally {
			sb.close()
		}
	}, 60_000)
}

test('the final render of each fixture has working controls', async () => {
	for (const [name, src] of SOURCES) {
		const r = compile(src)
		const sb = bootSandbox()
		sb.createRunner({ compiledDil: r.code, constants: r.constants, appData: r.appData })
		await sb.flush()
		const json = JSON.stringify(sb.latest!.tree)
		expect(/"__dilFn"/.test(json), `${name} rendered no interactive controls`).toBe(true)
		sb.close()
	}
}, 60_000)

test('<code> and <pre> are raw text: braces and := never reach the program', () => {
	const r = compile('<box><code>for i := 0; i &lt; n; i++ { wg.Add(1); go func(){ defer wg.Done() }() }</code></box>')
	expect(r.diagnosticSummary).toBe('clean')
	expect(Object.values(r.constants)).toContain('for i := 0; i < n; i++ { wg.Add(1); go func(){ defer wg.Done() }() }')
})

test('an invalid expression is replaced, the rest renders', () => {
	const r = compile('<box><text>{a b c}</text><text>ok</text></box>')
	expect(r.diagnostics.some((d) => d.code === 'invalid_expression')).toBe(true)
	expect(() => new Script(`(function(){${r.code}\n})`)).not.toThrow()
})
