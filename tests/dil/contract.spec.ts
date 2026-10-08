/**
 * The host↔client contract, pinned without reference to `vendor/`.
 *
 * `src/dil/types.ts` is what the client half implements against, so the field names
 * and their order are part of the agreement: `appData.opGenui.componentResults` is
 * keyed by the id the program passes as `__resolutionId`, `genuiComponents` drives
 * the streaming patches, `stateKeys` names the values reported back to the model.
 * `tests/dil/parity.spec.ts` proves these match upstream; this file proves they are
 * still what `types.ts` promises if the vendored reference is ever removed.
 * @module tests/dil/contract.spec
 */

import { expect, test } from 'vitest'
import * as dil from '../../src/dil/index.ts'

/** `compile()`'s return value, field for field — `vendor/.../server/compiler/index.js:87`. */
const COMPILED_FIELDS = [
	'ok',
	'protocolVersion',
	'source',
	'sourceLength',
	'code',
	'codeLength',
	'constants',
	'constantCount',
	'requiredComponents',
	'appData',
	'genuiComponents',
	'stateKeys',
	'fallbackMarkdown',
	'diagnostics',
	'diagnosticSummary',
	'durationMs',
	'compiledAt'
]

test('the public surface of src/dil is exactly these names', () => {
	expect(Object.keys(dil).sort()).toEqual([
		'INTRINSIC',
		'PROTOCOL_VERSION',
		'compile',
		'compileDil',
		'genuiComponentPatches',
		'genuiComponents',
		'inline',
		'isExpression',
		'isIntrinsic',
		'isProgram',
		'isStatement',
		'kindOf',
		'lowerMarkdown',
		'parse',
		'readBalanced',
		'resolutionId',
		'rewriteStatement',
		'splitEachClause',
		'splitStatements',
		'tidyFallback',
		'toFallback',
		'widgetType'
	])
	for (const name of Object.keys(dil)) expect((dil as Record<string, unknown>)[name], name).toBeDefined()
})

test('a compiled program carries exactly the contract fields, in order', () => {
	const plain = dil.compileDil('hi')
	expect(Object.keys(plain)).toEqual(COMPILED_FIELDS)
	expect(plain.protocolVersion).toBe(dil.PROTOCOL_VERSION)
	expect(plain.source).toBe('hi')
	expect(plain.sourceLength).toBe(2)
	expect(plain.codeLength).toBe(plain.code.length)
	expect(plain.constantCount).toBe(Object.keys(plain.constants).length)
	expect(typeof plain.durationMs).toBe('number')
	expect(Date.parse(plain.compiledAt)).not.toBeNaN()
})

test('appData carries componentResults and the caller\'s modelDataBindings', () => {
	const plain = dil.compileDil('hi')
	expect(Object.keys(plain.appData)).toEqual(['opGenui'])
	expect(Object.keys(plain.appData.opGenui)).toEqual(['componentResults', 'modelDataBindings'])
	expect(plain.appData.opGenui.componentResults).toEqual({})
	expect(plain.appData.opGenui.modelDataBindings).toEqual({})

	const bound = dil.compileDil('hi', { modelDataBindings: { user: { plan: 'pro' } } })
	expect(bound.appData.opGenui.modelDataBindings).toEqual({ user: { plan: 'pro' } })

	const host = dil.compileDil('<box><WeatherWidget city="sf"/></box>')
	const [id] = Object.keys(host.appData.opGenui.componentResults)
	expect(host.requiredComponents).toEqual(['WeatherWidget'])
	expect(host.appData.opGenui.componentResults[id!]).toEqual({ status: 'resolved', state: {}, componentName: 'WeatherWidget' })
	expect(host.genuiComponents[0]!.component_resolution_id).toBe(id)
})

test('genuiComponents is a code-point-indexed span list the stream can patch', () => {
	// the leading emoji is one code point but two UTF-16 units, so slicing the spans out
	// of a code-point view of the source proves which unit the capture's 8021 uses
	const source = '🎯\n<box><a/></box>\n<Chart content={{"chartType":"pie","data":[{"value":1}]}}/><MemoryCite/>'
	const { genuiComponents } = dil.compileDil(source)
	const points = [...source]
	expect(genuiComponents).toHaveLength(2)

	const chart = genuiComponents[0]!
	expect(chart.type).toBe('charts_widget_v2')
	// the leading prose becomes a lowered `<text>` element, so it holds element index 0:
	// `tree_range` counts every element in the lowered tree, synthetic ones included
	expect(chart.tree_range).toEqual([3, 4])
	expect(points.slice(chart.start_index, chart.end_index).join('')).toBe('<Chart content={{"chartType":"pie","data":[{"value":1}]}}/>')
	expect(chart.streaming).toBeUndefined()

	const cite = genuiComponents[1]!
	expect(cite.type).toBe('memory_cite')
	expect(cite.tree_range).toEqual([4, 5])
	expect(points.slice(cite.start_index, cite.end_index).join('')).toBe('<MemoryCite/>')
	expect(cite.component_resolution_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('every state key is the same string the /dil/view_state body uses', () => {
	const { code, stateKeys } = dil.compileDil('{@body const [tab,setTab] = DIL.useState("a")}\n<segmented-control value={tab} onChange={setTab} options={[{"label":"A","value":"a"}]}/>')
	expect(stateKeys).toEqual(['tab'])
	for (const key of stateKeys) expect(code).toContain(`{key:"${key}"}`)
})
