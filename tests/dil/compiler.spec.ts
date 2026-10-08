/**
 * Compiler tests. The headline property is negative: **compilation never throws**,
 * whatever prefix of the document it is handed. That is what makes streaming possible.
 *
 * Ported verbatim from `vendor/dil-replica/replica/test/compiler.test.js` (MIT,
 * Disdjj/intelligent-ui-demo @938ab09): every assertion below is the upstream one,
 * phrased in vitest. Nothing is added and nothing is relaxed.
 * @module tests/dil/compiler.spec
 */

import { expect, test } from 'vitest'
import { compile, parse, readBalanced, splitEachClause, splitStatements, tidyFallback } from '../../src/dil/index.ts'
import { DEMO_SOURCE, EXAMPLE, bootSandbox } from './vendor.ts'

test('compiles the demo document cleanly', () => {
	const r = compile(DEMO_SOURCE)
	expect(r.diagnosticSummary).toBe('clean')
	expect(r.diagnostics).toEqual([])
	expect(r.code).toContain('function __dilSafe(')
	expect(r.code).toContain('DIL.render(__dil.jsx(')
	expect(r.code).toContain('DIL.useConstants()')
	expect(r.code).toContain('DIL.useAppData(')
	expect(r.constantCount, 'string table should be populated').toBeGreaterThan(10)
	expect(r.code.length).toBeGreaterThan(r.sourceLength * 0.8)
})

test('hoists text into the constant pool instead of inlining it', () => {
	const r = compile('你好，世界')
	expect(r.constantCount).toBe(1)
	expect(r.constants['0']).toBe('你好，世界')
	expect(r.code).toContain('__dilConstants["0"]')
	expect(r.code, 'literal must not appear in the code').not.toContain('你好，世界')
})

test('hoists JSON-parseable attribute expressions', () => {
	const r = compile('<select options={[{"label":"a","value":"1"}]} value={1}/>')
	const hoisted = Object.values(r.constants).some((v) => Array.isArray(v))
	expect(hoisted, 'options array should be hoisted').toBe(true)
})

test('a plain text answer still compiles to a DIL program', () => {
	// Mirrors the real artifact: even a one-line prose answer carries a compiled body.
	const r = compile('就是这样。')
	expect(r.code.startsWith('function __dilSafe')).toBe(true)
	expect(r.code.endsWith('{"key":"body:0"}));')).toBe(true)
	expect(r.code.length).toBeGreaterThan(100)
})

test('compilation never throws on any prefix of a document', () => {
	// This is the property the streaming pipeline depends on: every intermediate state
	// of a partially-streamed document is syntactically invalid.
	for (let n = 1; n <= DEMO_SOURCE.length; n += 29) {
		expect(() => compile(DEMO_SOURCE.slice(0, n)), `prefix of length ${n}`).not.toThrow()
	}
})

test('emits recovery diagnostics for truncated input, then recovers', () => {
	const cut = DEMO_SOURCE.slice(0, 2000)
	const r = compile(cut)
	expect(r.diagnostics.length, 'expected diagnostics').toBeGreaterThan(0)
	const codes = new Set(r.diagnostics.map((d) => d.code))
	expect(
		codes.has('unclosed_block') || codes.has('unclosed_tag') || codes.has('unterminated_tag'),
		'expected a structural recovery code, got ' + [...codes].join(',')
	).toBe(true)
	for (const d of r.diagnostics) {
		expect(Number.isInteger(d.line) && d.line > 0).toBe(true)
		expect(Number.isInteger(d.column) && d.column > 0).toBe(true)
	}
	// and despite the errors, a usable program comes out
	expect(r.code).toContain('DIL.render(')
})

test('recovers from an unterminated tag', () => {
	const r = compile('<box border radius="lg">\n<row gap={2}')
	expect(r.diagnostics.some((d) => d.code.startsWith('unterminated') || d.code.startsWith('unclosed'))).toBe(true)
	expect(r.code).toContain('"box"')
})

test('recovers from an unterminated braced value', () => {
	const r = compile('{@body const x = DIL.useState({')
	expect(r.diagnostics.some((d) => d.code === 'unterminated_braced_value')).toBe(true)
})

test('reports mismatched and unknown blocks', () => {
	const r = compile('{#each list as x}<text>a</text>{/if}')
	expect(r.diagnostics.some((d) => d.code === 'mismatched_block_close')).toBe(true)
	const r2 = compile('{#while x}<text>a</text>{/while}')
	expect(r2.diagnostics.some((d) => d.code === 'unknown_block')).toBe(true)
})

test('control flow compiles to the expected shapes', () => {
	const ifR = compile('{#if a}<text>x</text>{:else}<text>y</text>{/if}')
	expect(ifR.code, 'condition is guarded with a false default').toContain('(__dilSafe(()=>(a),false))?')
	const eachR = compile('{#each xs as x}<text>{x}</text>{/each}')
	expect(eachR.code).toContain('(xs).map((x)=>__dilSafe(')
})

test('multi-child branches are wrapped in a Fragment', () => {
	const r = compile('{#if a}<text>x</text><text>y</text>{/if}')
	expect(r.code).toContain('__dil.jsx(__dil.Fragment,null,')
})

test('whitespace-only text runs between elements are dropped', () => {
	const r = compile('<box>\n  <text>hi</text>\n</box>')
	expect(r.constantCount, 'only "hi" should be hoisted').toBe(1)
})

test('PascalCase tags become requiredComponents, lowercase tags stay intrinsic', () => {
	const r = compile('<box><WeatherWidget city="sf"/><text>x</text></box>')
	expect(r.requiredComponents).toEqual(['WeatherWidget'])
	const r2 = compile('<box><text>x</text></box>')
	expect(r2.requiredComponents).toEqual([])
})

test('every control gets a function handler reference, never an inline call', () => {
	const r = compile('<box>{@body 0}</box><button onClick={()=>1}>go</button>')
	expect(r.code).toMatch(/__dil\.jsx\("button",\{"onClick":/)
})

test('fallback markdown is non-trivial and free of empty headings', () => {
	const r = compile(DEMO_SOURCE)
	expect(r.fallbackMarkdown.length).toBeGreaterThan(200)
	expect(r.fallbackMarkdown).not.toMatch(/^#{1,6}\s*$/m)
	expect(r.fallbackMarkdown).toContain('实验流量分配控制台')
})

test('fallback degrades controls into readable text', () => {
	const r = compile('<box><segmented-control options={[{"label":"A","value":"a"}]}/><button>提交</button><divider/></box>')
	expect(r.fallbackMarkdown).toContain('- A')
	expect(r.fallbackMarkdown).toContain('[提交]')
	expect(r.fallbackMarkdown).toContain('---')
})

test('tidyFallback removes punctuation-only lines', () => {
	const out = tidyFallback('## %\n\nreal text\n|||\n\n---\n')
	expect(out).not.toContain('## %')
	expect(out).toContain('real text')
})

test('readBalanced understands nested braces, strings and template literals', () => {
	const src = '{a: `${b({c: 1})}`}'
	const r = readBalanced(src, 0)
	expect(r.ok).toBe(true)
	expect(r.inner).toBe(src.slice(1, -1))
})

test('readBalanced reports failure instead of throwing', () => {
	const r = readBalanced('{ a: 1', 0)
	expect(r.ok).toBe(false)
})

test('splitEachClause finds the top-level `as`', () => {
	expect(splitEachClause('items as item')).toEqual({ list: 'items', item: 'item' })
	expect(splitEachClause('[a, b] as x')).toEqual({ list: '[a, b]', item: 'x' })
	expect(splitEachClause('{ a: "as b" } as y')!.item).toBe('y')
})

test('parse returns positions for every diagnostic', () => {
	const { diagnostics } = parse('<box>\n\n  <row>')
	expect(diagnostics.length).toBeGreaterThanOrEqual(1)
	for (const d of diagnostics) expect(d.line >= 1 && d.column >= 1).toBe(true)
})

test('source length and code length are reported for the UI', () => {
	const r = compile(DEMO_SOURCE)
	expect(typeof r.sourceLength).toBe('number')
	expect(typeof r.codeLength).toBe('number')
	expect(typeof r.durationMs).toBe('number')
})

test('one {@body} block with several statements is split, keyed and guarded per statement', () => {
	const r = compile('{@body const [a, setA] = DIL.useState(1);\nconst [b, setB] = DIL.useState("x");\nconst c = a * 2;}\n<box><text>{c}</text></box>')
	expect(r.diagnosticSummary).toBe('clean')
	expect(r.stateKeys).toEqual(['a', 'b'])
	expect(r.code).toContain('DIL.useState(1,{key:"a"})')
	expect(r.code).toContain('const c = __dilSafe(()=>(a * 2),undefined)')
})

test('splitStatements respects nesting', () => {
	expect(splitStatements('const a = {x:1;}; const b = "a;b"')).toEqual(['const a = {x:1;}', 'const b = "a;b"'])
})

test('markdown prose lowers to title / text+bold / list like the captured artifact', () => {
	const r = compile('## 这个示例体现了什么？\n\n它不只是 **图表**。\n\n1. **注入**：联动\n2. 第二项')
	expect(r.code).toContain('__dil.jsx("title",{"size":"lg"},__dilConstants["0"])')
	expect(r.code).toContain('__dil.jsx("text",null,__dilConstants["1"],__dil.jsx("bold",null,__dilConstants["2"])')
	expect(r.code).toContain('__dil.jsx("list",{"marker":"number"},__dil.jsx("list-item",null,__dil.jsx("text",null,__dil.jsx("bold"')
	expect(Object.values(r.constants).some((c) => typeof c === 'string' && c.includes('**')), 'no raw markdown left in constants').toBe(false)
})

test('a paragraph keeps its interpolations inline; component text stays one flow', () => {
	const r = compile('本月 {n} 次\n\n<box>count: {n}</box>')
	expect(r.code).toContain('__dilSafe(()=>(__dil.jsx("text",null,__dilConstants["0"],(n),__dilConstants["1"])),null)')
	expect(r.code).toContain('__dilSafe(()=>(__dil.jsx("box",null,__dilConstants["2"],(n))),null)')
})

test('the fallback keeps the original markdown', () => {
	const r = compile('## 标题\n\n**粗体** 段落')
	expect(r.fallbackMarkdown).toContain('## 标题')
	expect(r.fallbackMarkdown).toContain('**粗体**')
})

test('HTML entities in prose are decoded', () => {
	const r = compile('<box><text>Usage &amp; Billing &lt;3</text></box>')
	expect(Object.values(r.constants)).toContain('Usage & Billing <3')
})

test('controlled state used but never declared is declared, seeded from the control', () => {
	const r = compile('<box><segmented-control value={usage} onChange={setUsage} options={[{"label":"办公","value":"office"},{"label":"剪辑","value":"media"}]}/><slider value={budget} onChange={setBudget} min={6000} max={30000}/><checkbox checked={portable} onChange={setPortable}>便携</checkbox></box>')
	expect(r.stateKeys).toEqual(['usage', 'budget', 'portable'])
	expect(r.code).toContain('DIL.useState("office",{key:"usage"})')
	expect(r.code).toContain('DIL.useState(6000,{key:"budget"})')
	expect(r.code).toContain('DIL.useState(false,{key:"portable"})')
	expect(r.diagnostics.filter((d) => d.code === 'implicit_state').length).toBe(3)
})

test('declared state is never re-declared', () => {
	const r = compile('{@body const [tab,setTab] = DIL.useState("b")}\n<segmented-control value={tab} onChange={setTab} options={[{"label":"A","value":"a"}]}/>')
	expect(r.stateKeys).toEqual(['tab'])
	expect(r.diagnostics.some((d) => d.code === 'implicit_state')).toBe(false)
})

test('a ```html fence around the document is dropped, not rendered', () => {
	const r = compile('说明文字。\n```html\n<box><text>hi</text></box>\n```\n收尾。')
	expect(Object.values(r.constants).some((c) => typeof c === 'string' && c.includes('```'))).toBe(false)
	expect(r.diagnostics.filter((d) => d.code === 'stripped_code_fence').length).toBe(2)
})

test('the example in the system prompt compiles clean and runs', async () => {
	const r = compile('示例。\n' + EXAMPLE)
	expect(r.diagnosticSummary).toBe('clean')
	const sb = bootSandbox()
	sb.createRunner({ compiledDil: r.code, constants: r.constants, appData: r.appData })
	await sb.flush()
	expect(sb.failures.length).toBe(0)
	expect(JSON.stringify(sb.latest!.tree)).toContain('"t":"chart"')
	sb.close()
})
