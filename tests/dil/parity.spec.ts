/**
 * Behaviour-equivalence test: our ported compiler vs the vendored upstream it was
 * ported from.
 *
 * The three ported upstream suites (compiler / robustness / artifact) pin the
 * behaviour they cover; this one covers the whole surface — every field of the
 * `DilCompiled` contract, on the captured artifact, the shipped fixtures, the demo
 * document and a set of hand-picked edge shapes, at full length and at streamed
 * prefixes. Any drift in a diagnostic, a constant, a guard or an offset shows up as
 * a named differing field rather than as a wrong rendering months later.
 *
 * Only `durationMs` and `compiledAt` are excluded: they are clocks, not behaviour.
 * @module tests/dil/parity.spec
 */

import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	compile,
	genuiComponentPatches,
	readBalanced,
	rewriteStatement,
	splitEachClause,
	tidyFallback,
	toFallback,
	type DilNode
} from '../../src/dil/index.ts'
import { ARTIFACTS_DIR, DEMO_SOURCE, FIXTURES_DIR, stable, vendorCompiler } from './vendor.ts'

const CAPTURED = fs.readFileSync(path.join(ARTIFACTS_DIR, 'genui-source.dil.md'), 'utf8')
const FIXTURES = fs
	.readdirSync(FIXTURES_DIR)
	.filter((f) => f.endsWith('.dil.md'))
	.sort()
	.map((f) => [f, fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8')] as const)

/** Shapes that exercised a recovery path or a repair at least once upstream. */
const SNIPPETS = [
	'',
	'就是这样。',
	'你好，世界',
	'## 这个示例体现了什么？\n\n它不只是 **图表**。\n\n1. **注入**：联动\n2. 第二项',
	'本月 {n} 次\n\n<box>count: {n}</box>',
	'- 一\n- 二\n\n---\n\n### 三级标题',
	'**粗体** 段落\n\n`code` 与 `**bold**` 混排',
	'<box><WeatherWidget city="sf"/><text>x</text></box>',
	'<box><Chart content={{"chartType":"bar","data":[{"name":"a","value":1}]}}/></box>',
	'<box><Chart content={{"chartType":"donut","data":[]}}/><text>after</text></box>',
	'<box><code>for i := 0; i &lt; n; i++ { wg.Add(1) }</code></box>',
	'<box><text>Usage &amp; Billing &lt;3</text></box>',
	'{@body const [a, setA] = DIL.useState(1);\nconst [b, setB] = DIL.useState("x");\nconst c = a * 2;}\n<box><text>{c}</text></box>',
	'{@body const T = {a:{b:1}}',
	'{@body co',
	'{@body const x = DIL.useState({',
	'{@body 0}',
	'{@body }',
	'{#if a}<text>x</text>{:else}<text>y</text>{/if}',
	'{#if a}<text>x</text>{:else if b}<text>y</text>{:else}<text>z</text>{/if}',
	'{#each xs as x}<text>{x}</text>{/each}',
	'{#each list as x}<text>a</text>{/if}',
	'{#while x}<text>a</text>{/while}',
	'{#each xs as x',
	'{:else}',
	'{/if}',
	'{a b c}',
	'{`${x({y: 1})}`}',
	'{a && b ? {c: "d"} : /x/.test(e)}',
	'<box border radius="lg">\n<row gap={2}',
	'<box><text>hi</text>',
	'</box>',
	'<box><segmented-control value={usage} onChange={setUsage} options={[{"label":"办公","value":"office"},{"label":"剪辑","value":"media"}]}/><slider value={budget} onChange={setBudget} min={6000} max={30000}/><checkbox checked={portable} onChange={setPortable}>便携</checkbox></box>',
	'<box><segmented-control value={usage} onChange={setUsage} options={PLANS}/></box>',
	'<box><radio-group value={picked} onChange={setPicked}><radio value="a">A</radio><radio value="b">B</radio></radio-group></box>',
	'说明文字。\n```html\n<box><text>hi</text></box>\n```\n收尾。',
	'<box><text>a</text></box><box><text>b</text></box>',
	'<text>{}</text>',
	'<text>{{}}</text>',
	'<box>{list.map(x=>({...x}))}</box>',
	'<box>{@body items.sort((a,b)=>a-b)}</box>',
	'<box><input value={q} onChange={setQ}/></box>',
	// the implicit-state seeds: a bare boolean attribute and a label-less option are the
	// only places the repair has to stringify a non-string seed
	'<box><slider value={v} onChange={setV} min/></box>',
	'<box><slider value={v} onChange={setV} min="6000" max={30}/></box>',
	'<box><radio-group value={p} onChange={setP}><radio value>A</radio><radio value={1}>B</radio></radio-group></box>',
	'<box><radio-group value={p} onChange={setP}></radio-group></box>',
	'<box><segmented-control value={u} onChange={setU} options={[{"value":"a"},{"label":"B","value":"b"}]}/></box>',
	'<box><select value={s} onChange={setS} options={OPTS}/></box>',
	'<box><checkbox checked={c} onChange={setC}/><input value={q} onChange={setQ}/><switch checked={k} onChange={setK}/></box>',
	'text with no markup at all',
	'\n\n\n',
	'<box>\n  <text>hi</text>\n</box>',
	'<div class="x"><span>y</span></div>',
	'<box><text>{"emoji 🚀🛰️🎯"}</text></box>'
]

/**
 * Every field, one assertion each, so a failure names the field that drifted.
 *
 * `fallbackMarkdown` is compared by direction rather than by bytes — see
 * {@link assertFallbackIsNotThinner} for what is left to check, and the second
 * divergence test below for the change itself.
 */
function assertSame(name: string, source: string): void {
	const mine = stable(compile(source))
	const theirs = stable(vendorCompiler.compile(source))
	expect(Object.keys(mine), `${name} · field order`).toEqual(Object.keys(theirs))
	for (const key of Object.keys(theirs)) {
		if (key === 'fallbackMarkdown') continue
		expect(JSON.stringify(mine[key]), `${name} · field ${key}`).toBe(JSON.stringify(theirs[key]))
	}
	assertFallbackIsNotThinner(name, String(mine.fallbackMarkdown), String(theirs.fallbackMarkdown))
}

/** Whether any node in the tree is an interpolation. */
function hasInterpolation(nodes: unknown): boolean {
	if (Array.isArray(nodes)) return nodes.some(hasInterpolation)
	if (nodes === null || typeof nodes !== 'object') return false
	const row = nodes as Record<string, unknown>
	if (row.type === 'expr') return true
	return Object.values(row).some(hasInterpolation)
}

/**
 * The degraded projection changed shape, not just text.
 *
 * Upstream drops interpolation nodes and we print their source, which is not a
 * cosmetic difference: a heading whose whole content was dynamic survives our tidy
 * step and vanishes from upstream's, and the spacing left inside an emptied
 * `badge` differs. Measured on the captured artifact the two projections are 41 and
 * 36 non-empty lines, so no line or byte relation is left to assert.
 *
 * What the large corpora can still assert is the direction that would be a
 * regression if it flipped: ours must never say less than upstream's.
 * @param name - the case name, for the failure message.
 * @param ours - our projection.
 * @param theirs - upstream's.
 */
function assertFallbackIsNotThinner(name: string, ours: string, theirs: string): void {
	const spoken = (markdown: string): number => markdown.split('\n').filter(line => line.trim().length > 0).length
	expect(spoken(ours), `${name} · degraded projection lost lines upstream kept`).toBeGreaterThanOrEqual(spoken(theirs))
	expect(ours.length, `${name} · degraded projection is shorter than upstream's`).toBeGreaterThanOrEqual(theirs.length)
}

test('the captured artifact compiles identically, whole and at every 97th prefix', () => {
	assertSame('captured:full', CAPTURED)
	for (let n = 1; n <= CAPTURED.length; n += 97) assertSame(`captured:${n}`, CAPTURED.slice(0, n))
}, 180_000)

test('the streaming boundaries of the captured artifact compile identically', () => {
	// the offsets artifact.test.js asserts on, plus one window either side of each
	for (const n of [8021, 8045, 8150, 8209, 8300, 8416, 8500, 8723, 9000, 14464, 14740, 23408, 23422, 25832]) {
		assertSame(`captured:${n}`, CAPTURED.slice(0, n))
	}
})

test('every fixture compiles identically, whole and at every 37th prefix', () => {
	for (const [name, source] of FIXTURES) {
		assertSame(`${name}:full`, source)
		for (let n = 1; n <= source.length; n += 37) assertSame(`${name}:${n}`, source.slice(0, n))
	}
}, 180_000)

test('the demo document compiles identically, whole and at every 53rd prefix', () => {
	assertSame('demo:full', DEMO_SOURCE)
	for (let n = 1; n <= DEMO_SOURCE.length; n += 53) assertSame(`demo:${n}`, DEMO_SOURCE.slice(0, n))
}, 180_000)

test('hand-picked edge shapes compile identically', () => {
	for (const source of SNIPPETS) assertSame(JSON.stringify(source), source)
})

test('the second intentional divergence: an interpolation keeps its place in the degraded projection', () => {
	// Upstream drops the interpolation node outright. Where it carried a badge label
	// that reads fine, but inside a sentence it leaves a hole: a terminal reader gets
	// `n =  时` and cannot tell that a value was ever meant to sit there. We print the
	// expression's own source, so the gap names what belongs in it.
	const source = '<box><text>n = {n} 时，差距约 {ratio} 倍。</text></box>'
	const ours = compile(source).fallbackMarkdown
	const upstream = vendorCompiler.compile(source).fallbackMarkdown

	expect(upstream, 'upstream leaves the hole').toContain('n =  时')
	expect(upstream).not.toContain('{n}')
	expect(ours, 'we name the gap').toContain('n = {n} 时，差距约 {ratio} 倍。')
	// And the difference is exactly the placeholders, nothing else.
	// The controlled source here has no nested braces, so removing the placeholders
	// is unambiguous: what is left must be exactly upstream's projection.
	expect(ours.replace(/\{[^{}]*\}/gu, '')).toBe(upstream)
})

test('the first intentional divergence: a closing tag inside a block no longer swallows the document', () => {
	// Upstream `readClosingTag` reported only `{ at, terminator }`, so a `</tag>` that
	// closed the *surrounding* element from inside a `{#if}` / `{#each}` body reached
	// `closeBlock` with `length === undefined`: `ctx.i += undefined` → NaN, the sibling
	// loop stopped, and everything after that point was dropped. For a streaming
	// document that means the live interface freezes on the rest of the stream.
	const src = '<WeatherWidget>{#if a}x</box>rest</WeatherWidget>'

	const upstream = vendorCompiler.compile(src)
	// upstream: swallows the remainder, never notices `</WeatherWidget>`, and reports the
	// widget as still streaming with no end_index at all
	expect(upstream.diagnosticSummary).toContain('unclosed_tag')
	expect(upstream.genuiComponents[0]!.streaming).toBe(true)
	expect(upstream.genuiComponents[0]!.end_index).toBeUndefined()
	expect(upstream.constants).not.toContain('rest')

	// ours: keeps parsing, closes the widget, and names the tag it found
	const ours = compile(src)
	expect(ours.diagnostics.map((d) => d.code)).toEqual(['mismatched_tag', 'mismatched_block_close'])
	expect(ours.diagnostics[1]!.found).toBe('box')
	expect(ours.genuiComponents[0]!.end_index).toBe(49)
	expect(ours.genuiComponents[0]!.streaming).toBeUndefined()
	expect(Object.values(ours.constants)).toContain('rest')
})

test('the exported helpers return the same values as upstream', () => {
	const statements = [
		'const [tab,setTab] = DIL.useState("overview")',
		'const [a,setA] = DIL.useState(1,{key:"a"})',
		'const n = period==="7"?7:period==="30"?10:12',
		'const d = DIL.useAppData(a=>a)',
		'function f(){return 1}',
		'items.sort((a,b)=>a-b)',
		'const a = {x:1;}; const b = "a;b"',
		'let v = 1, w = 2'
	]
	for (const s of statements) expect(rewriteStatement(s), s).toBe(vendorCompiler.rewriteStatement(s))

	for (const e of ['items as item', '[a, b] as x', '{ a: "as b" } as y', 'no as here']) {
		expect(splitEachClause(e), e).toEqual(vendorCompiler.splitEachClause(e))
	}

	for (const src of ['{a: `${b({c: 1})}`}', '{ a: 1', 'plain', '`${`${x}`}`']) {
		expect(readBalanced(src, 0), src).toEqual(vendorCompiler.readBalanced(src, 0))
	}

	for (const md of ['## %\n\nreal text\n|||\n\n---\n', '## 标题\n\n- 一\n- 二', '| a | b |\n| | |']) {
		expect(tidyFallback(md), md).toBe(vendorCompiler.tidyFallback(md))
	}

	// The fallback walkers are compared directly, on upstream's own AST.
	//
	// The split is exact rather than heuristic: a tree with no interpolation node is
	// untouched by the divergence, so the two walkers must agree byte for byte. A
	// tree that has one differs by design, and is compared by direction. (Deciding
	// it from the source text instead does not work — braces are literal inside a
	// `<code>` body, and expression code can nest them.)
	for (const src of SNIPPETS) {
		const nodes = vendorCompiler.parse(src).nodes as DilNode[]
		const ours = toFallback(nodes)
		const theirs = vendorCompiler.toFallback(nodes)
		if (hasInterpolation(nodes)) assertFallbackIsNotThinner(JSON.stringify(src), ours, theirs)
		else expect(ours, JSON.stringify(src)).toBe(theirs)
	}

	const steps = [8045, 8150, 8300, 8500, 9000].map((n) => compile(CAPTURED.slice(0, n)).genuiComponents)
	let prev: typeof steps[number] = []
	for (const next of steps) {
		expect(genuiComponentPatches(prev, next), JSON.stringify(next)).toEqual(vendorCompiler.genuiComponentPatches(prev, next))
		prev = next
	}
})
