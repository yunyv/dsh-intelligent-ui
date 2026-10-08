/**
 * Fidelity tests against the *captured* ChatGPT artifact (`artifacts/`), not a
 * hand-written demo. If the replica can compile and run what the real model wrote,
 * and reports the same state the real client reported, the dialect is right.
 *
 * Ported verbatim from `vendor/dil-replica/replica/test/artifact.test.js` (MIT,
 * Disdjj/intelligent-ui-demo @938ab09): every assertion below is the upstream one,
 * phrased in vitest. The `any` in the tree walkers is the shape of the sandbox's
 * serialized tree, which no test constrains.
 * @module tests/dil/artifact.spec
 */

import fs from 'node:fs'
import path from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { compile, genuiComponentPatches, rewriteStatement } from '../../src/dil/index.ts'
import { ARTIFACTS_DIR, CAPTURES_DIR, bootSandbox, collectHandlers, type Sandbox } from './vendor.ts'

const SOURCE = fs.readFileSync(path.join(ARTIFACTS_DIR, 'genui-source.dil.md'), 'utf8')
const REAL_CODE = fs.readFileSync(path.join(ARTIFACTS_DIR, 'genui-compiled.js'), 'utf8')
const VIEW_STATE = JSON.parse(
	JSON.parse(fs.readFileSync(path.join(CAPTURES_DIR, 'record-421-view-state.json'), 'utf8')).request.body.text
)

const sandboxes: Sandbox[] = []
afterAll(() => sandboxes.forEach((sb) => { try { sb.close() } catch { /* already closed */ } }))

async function boot(r: ReturnType<typeof compile>): Promise<Sandbox> {
	const sb = bootSandbox()
	sandboxes.push(sb)
	sb.createRunner({ compiledDil: r.code, constants: r.constants, appData: r.appData })
	await sb.flush()
	return sb
}

function texts(node: any, out: string[] = []): string[] {
	if (!node) return out
	if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out }
	if (node.t === '#text') { out.push(node.v); return out }
	;(node.c || []).forEach((n: any) => texts(n, out))
	return out
}

function find(node: any, pred: (n: any) => boolean, out: any[] = []): any[] {
	if (!node) return out
	if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out }
	if (pred(node)) out.push(node)
	;(node.c || []).forEach((n: any) => find(n, pred, out))
	return out
}

const r = compile(SOURCE)

test('the captured source compiles without a single diagnostic', () => {
	expect(r.diagnosticSummary).toBe('clean')
	expect(r.requiredComponents, 'Chart is a compiler shim, not a host component').toEqual(['MemoryCite'])
})

test('useState keys match the real artifact and the captured view_state body', () => {
	const realKeys = [...REAL_CODE.matchAll(/DIL\.useState\([^)]*?\{key:"(\w+)"\}\)/g)].map((m) => m[1]!)
	expect(r.stateKeys).toEqual(realKeys)
	expect(r.stateKeys).toEqual(Object.keys(VIEW_STATE.updates[0].state))
	for (const k of realKeys) expect(r.code, 'missing key ' + k).toContain(`{key:"${k}"}`)
})

test('derived declarations are guarded exactly like the artifact', () => {
	expect(rewriteStatement('const n = period==="7"?7:period==="30"?10:12')).toBe('const n = __dilSafe(()=>(period==="7"?7:period==="30"?10:12),undefined)')
	expect(REAL_CODE).toContain('const n = __dilSafe(()=>(period==="7"?7:period==="30"?10:12),undefined)')
	// function declarations and hooks are left alone
	expect(rewriteStatement('function f(){return 1}')).toBe('function f(){return 1}')
	expect(rewriteStatement('const d = DIL.useAppData(a=>a)')).toBe('const d = DIL.useAppData(a=>a)')
})

test('the initial state snapshot equals what ChatGPT POSTed to /dil/view_state', async () => {
	const sb = await boot(r)
	expect(sb.failures.length).toBe(0)
	const state = await sb.requestState()
	expect(state).toEqual(VIEW_STATE.updates[0].state)
})

test('<Chart content={…}/> lowers to card + intrinsic chart with series', async () => {
	const sb = await boot(r)
	const charts = find(sb.latest!.tree, (n) => n.t === 'chart')
	expect(charts.length, 'overview tab shows the trend line and the channel bar chart').toBe(2)
	const line = charts[0].p
	expect(line.xAxis.dataKey).toBe('period')
	expect(line.series.map((s: any) => s.dataKey)).toEqual(['revenue', 'cost'])
	expect(line.series[0].type).toBe('line')
	expect(line.data.length).toBe(7)
})

test('a broken chart spec degrades to its fallback instead of throwing', async () => {
	const bad = compile('<box><Chart content={{"chartType":"donut","data":[]}}/><text>after</text></box>')
	const sb = await boot(bad)
	expect(sb.failures.length).toBe(0)
	expect(find(sb.latest!.tree, (n) => n.t === 'chart').length).toBe(0)
	expect(texts(sb.latest!.tree)).toContain('after')
})

test('host components carry a resolution id that appData can resolve', async () => {
	const sb = await boot(r)
	const [cite] = find(sb.latest!.tree, (n) => n.t === 'MemoryCite')
	expect(cite, 'MemoryCite should reach the host').toBeTruthy()
	const id = cite!.p.__resolutionId
	expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
	expect(r.appData.opGenui.componentResults[id]!.componentName).toBe('MemoryCite')
})

test('all three workspaces render and their handlers work', async () => {
	const sb = await boot(r)
	const [tabs] = find(sb.latest!.tree, (n) => n.t === 'segmented-control' && n.p.value === 'overview')
	expect(tabs, 'tab switcher present').toBeTruthy()

	sb.trigger(tabs.p.onChange.__dilFn, ['sandbox'])
	await sb.flush()
	let all = texts(sb.latest!.tree).join('')
	expect(all.includes('计费沙盒') || all.includes('Credits'), 'sandbox tab rendered').toBe(true)

	// charge once: wallet decreases and the ledger gains a row
	const before = (await sb.requestState()).wallet
	const charge = find(sb.latest!.tree, (n) => n.t === 'button' && texts(n).join('').includes('试扣'))[0]
	expect(charge, 'charge button present').toBeTruthy()
	sb.trigger(charge.p.onClick.__dilFn, [])
	await sb.flush()
	const after = await sb.requestState()
	expect(after.wallet, `wallet ${before} → ${after.wallet}`).toBeLessThan(before)
	expect(after.ledger.length).toBe(1)

	const [tabs2] = find(sb.latest!.tree, (n) => n.t === 'segmented-control' && n.p.value === 'sandbox')
	sb.trigger(tabs2.p.onChange.__dilFn, ['audit'])
	await sb.flush()
	all = texts(sb.latest!.tree).join('')
	expect(all, 'audit tab lists events').toContain('EVT-1042')
	expect(collectHandlers(sb.latest!.tree).length > 0).toBe(true)
})

test('every streamed prefix of the real source compiles and never throws in the sandbox', async () => {
	const sb = bootSandbox()
	sandboxes.push(sb)
	let started = false
	let rendered = 0
	for (let n = 400; n <= SOURCE.length; n += 997) {
		const part = compile(SOURCE.slice(0, n))
		if (!started) { sb.createRunner({ compiledDil: part.code, constants: part.constants, appData: part.appData }); started = true } else sb.setCompiledDil({ compiledDil: part.code, constants: part.constants, appData: part.appData })
		await sb.flush()
		if (sb.latest && sb.latest.tree) rendered++
	}
	expect(rendered, 'most prefixes should produce a tree, got ' + rendered).toBeGreaterThan(10)
}, 60_000)

// ---------------------------------------------------------------------------
// genui_components
// ---------------------------------------------------------------------------

test('genui_components source ranges match the capture exactly (code-point offsets)', () => {
	const got = r.genuiComponents.map((c) => [c.type, c.start_index, c.end_index])
	expect(got).toEqual([
		['charts_widget_v2', 8021, 8209],
		['charts_widget_v2', 8416, 8723],
		['charts_widget_v2', 14464, 14740],
		['memory_cite', 23408, 23422]
	])
	expect(r.genuiComponents[3]!.component_resolution_id).toBe(r.constants[Object.keys(r.constants).pop()!])
})

test('a widget that is still being written is marked and its end grows', () => {
	const a = compile(SOURCE.slice(0, 8045)).genuiComponents
	const b = compile(SOURCE.slice(0, 8150)).genuiComponents
	expect(a[0]!.streaming).toBe(true)
	expect(b[0]!.end_index).toBeGreaterThan(a[0]!.end_index)
	const done = compile(SOURCE.slice(0, 8300)).genuiComponents
	expect(done[0]!.end_index).toBe(8209)
	expect(done[0]!.streaming).toBeUndefined()
})

test('component patches use the captured add / replace end_index / append ops', () => {
	const steps = [8045, 8150, 8300, 8500, 9000].map((n) => compile(SOURCE.slice(0, n)).genuiComponents)
	const ops: { p: string; o: string; v: any }[] = []
	let prev: typeof steps[number] = []
	for (const next of steps) { ops.push(...genuiComponentPatches(prev, next)); prev = next }
	expect(ops[0]!.o).toBe('add')
	expect(ops[0]!.p).toBe('/message/metadata/genui_components')
	expect(ops.some((o) => o.p === '/message/metadata/genui_components/0/end_index' && o.o === 'replace')).toBe(true)
	expect(ops.some((o) => o.o === 'append' && o.v[0].start_index === 8416)).toBe(true)
})
