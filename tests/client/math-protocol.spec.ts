// @vitest-environment node
/** Entity decoding exercises the shared validator, including its host-thread path. */
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { MAX_MATH_INPUT_LENGTH, MAX_MATH_SVG_LENGTH, validateMathSvg } from '../../src/client/dil/math/protocol.ts'

type Location = 'text' | 'metadata'
const root = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 -1000 1000 1000"'
function svg(value: string, location: Location): string {
	return location === 'text' ? `${root}><text>${value}</text></svg>` : `${root} data-mml-node="${value}"/>`
}

const accepted = [
	'', 'plain text; 普通文本', '&amp;', '&lt;math&gt;', '&quot;&apos;',
	'&#32;', '&#65;', '&#00065;', '&#x41;', '&#x000041;', '&#x3B1;',
	'&#55295;', '&#57344;', '&#x10000;', '&#128512;', '&#x10ffff;',
	'&amp;lt;script&amp;gt;', '&#38;#x41;',
]
const rejected = [
	'&', 'a&b', '&amp', '&amp;&unfinished', '&;', '&unknown;', '&AMP;', '&a&amp;',
	'&#;', '&#x;', '&#X41;', '&#-1;', '&#1.5;', '&#1e2;', '&#x41junk;',
	'&#0;', '&#9;', '&#10;', '&#31;', '&#xD800;', '&#xDFFF;',
	'&#x110000;', '&#9007199254740992;',
]

describe.each(['text', 'metadata'] as const)('math XML entities in %s', (location) => {
	it.each(accepted)('preserves accepted entity data: %j', (value) => {
		expect(validateMathSvg(svg(value, location))).toBeNull()
	})
	it.each(rejected)('rejects malformed or restricted entity data: %j', (value) => {
		expect(validateMathSvg(svg(value, location))).not.toBeNull()
	})
	it('keeps long leading-zero numeric references valid', () => {
		for (const entity of [`&#${'0'.repeat(20000)}65;`, `&#x${'0'.repeat(20000)}41;`]) {
			expect(validateMathSvg(svg(entity, location))).toBeNull()
		}
	})
})

it('validates decoded geometry, namespace and paint without allowing encoded URLs', () => {
	expect(validateMathSvg(`${root.replace('width="1em"', 'width="&#49;&#x65;&#109;"')}/>`)).toBeNull()
	expect(validateMathSvg(`${root.replace('/svg"', '/sv&#x67;"')}/>`)).toBeNull()
	expect(validateMathSvg(`${root}><path d="M0 0L1 1" fill="&#x23;abc"/></svg>`)).toBeNull()
	expect(validateMathSvg(`${root}><path d="M0 0L1 1" fill="&#x75;rl(https://example.invalid)"/></svg>`)).not.toBeNull()
})

it('decodes each source entity once rather than recursively repairing its result', () => {
	const prefix = 'a'.repeat(MAX_MATH_INPUT_LENGTH * 2 - 1)
	expect(validateMathSvg(svg(`${prefix}&lt;`, 'metadata'))).toBeNull()
	expect(validateMathSvg(svg(`${prefix}&amp;lt;`, 'metadata'))).not.toBeNull()
})

// Execute the actual protocol module in an interruptible VM, so a regression
// cannot freeze the test process for the ~16 seconds taken by the old regex.
// No test-only export or alternative decoder is added to production code.
const protocolSource = readFileSync(new URL('../../src/client/dil/math/protocol.ts', import.meta.url), 'utf8')
const protocolJs = ts.transpileModule(protocolSource, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
}).outputText
const validationScript = new Script(`${protocolJs}\nexports.validateMathSvg(input);`, { filename: 'math-protocol-regression.cjs' })
function boundedValidation(input: string): string | null {
	const context = createContext({ exports: {}, input }, { codeGeneration: { strings: false, wasm: false } })
	return validationScript.runInContext(context, { timeout: 500 }) as string | null
}
function nearLimit(pattern: string, suffix: string, location: Location): string {
	const count = Math.floor((MAX_MATH_SVG_LENGTH - svg(suffix, location).length) / pattern.length)
	return svg(pattern.repeat(count) + suffix, location)
}

describe.each(['text', 'metadata'] as const)('bounded math entity validation in %s', (location) => {
	it('rejects dense unterminated entities within a bounded CPU budget', () => {
		const input = nearLimit('&a', '', location)
		expect(input.length).toBeLessThanOrEqual(MAX_MATH_SVG_LENGTH)
		expect(input.length).toBeGreaterThan(MAX_MATH_SVG_LENGTH - 2)
		expect(boundedValidation(input)).not.toBeNull()
	})
	it('rejects a trailing incomplete entity after many valid entities', () => {
		expect(boundedValidation(nearLimit('&amp;', '&unfinished', location))).not.toBeNull()
	})
	it('rejects a long nested entity without rescanning its ampersands', () => {
		expect(boundedValidation(nearLimit('&a', ';', location))).not.toBeNull()
	})
	it('accepts many escaped ampersands in text and enforces the existing metadata limit', () => {
		const result = boundedValidation(nearLimit('&amp;', '', location))
		if (location === 'text') expect(result).toBeNull()
		else expect(result).not.toBeNull()
	})
})

const frame = (body: string): string => `${root}>${body}</svg>`

describe('restricted SVG tag syntax matches the inserted tree', () => {
	it.each(['<g/>', '<g />', '<g  />', '<g\t/>', '<g\n/>', '<g\r/>', '<g></g >'])('accepts XML-space syntax: %j', (body) => {
		expect(validateMathSvg(frame(`${body}<path d="M0 0L1 1"/>`))).toBeNull()
	})
	it('accepts quoted attributes and whitespace around equals', () => {
		expect(validateMathSvg(frame("<g\n data-mml-node\t=\r'mrow' transform = \"translate(1, 2)\"><path d='M0 0L1 1'/></g>"))).toBeNull()
	})
	it.each([' ', '  ', '\t', '\n', '\r', '\u00a0', '\u2003', '\ufeff'])('rejects characters after a self-closing solidus: %j', (space) => {
		expect(validateMathSvg(frame(`<g transform="scale(2)"/${space}><path d="M0 0L1 1"/>`))).not.toBeNull()
	})
	it('rejects pseudo-self-closing groups that hide cumulative transforms', () => {
		expect(validateMathSvg(frame(`${'<g transform="scale(100)"/ >'.repeat(8)}<path d="M0 0L1 1"/>`))).not.toBeNull()
	})
	it('rejects pseudo-self-closing groups that hide browser nesting depth', () => {
		expect(validateMathSvg(frame(`${'<g/ >'.repeat(80)}<path d="M0 0L1 1"/>`))).not.toBeNull()
	})
	it.each(['\u00a0', '\u2003', '\ufeff', '\u2028'])('rejects non-XML syntax whitespace: %j', (space) => {
		for (const candidate of [
			frame(`<g${space}transform="scale(2)"/>`),
			frame(`<g transform${space}="scale(2)"/>`),
			frame(`<g transform=${space}"scale(2)"/>`),
			frame(`<g></g${space}>`),
			`${space}${frame('')}`,
			`${frame('')}${space}`,
			frame(`${space}<path d="M0 0L1 1"/>`),
		]) expect(validateMathSvg(candidate)).not.toBeNull()
	})
	it('retains Unicode whitespace inside quoted metadata and text', () => {
		expect(validateMathSvg(frame('<text data-mml-node="a\u00a0b">\u00a0\u2003\ufeff</text>'))).toBeNull()
	})
	it.each([
		'<g data-mml-node="a"data-c="b"/>', '<g transform=scale(2)/>',
		'<g transform="scale(2)></g>', '<g / junk>', '<g //>', '</g/>',
		'<g data-c="a" data-c="b"/>', '<g data-c="a<b"/>', '<g data-c="a>b"/>',
	])('rejects malformed or ambiguous tag syntax: %j', (body) => {
		expect(validateMathSvg(frame(body))).not.toBeNull()
	})
})

describe('bounded complete SVG lexing', () => {
	it.each(['tag', 'tag-before-closing-root', 'attribute-name', 'attribute-quote'] as const)('rejects a near-limit malformed %s within the CPU budget', (kind) => {
		let input: string
		if (kind === 'tag') input = `<${'a'.repeat(MAX_MATH_SVG_LENGTH - 1)}`
		else if (kind === 'tag-before-closing-root') {
			const overhead = frame('<').length
			input = frame(`<${'a'.repeat(MAX_MATH_SVG_LENGTH - overhead)}`)
		} else if (kind === 'attribute-name') {
			const overhead = `${root} />`.length
			input = `${root} ${'a'.repeat(MAX_MATH_SVG_LENGTH - overhead)}/>`
		} else {
			const overhead = `${root} data-mml-node="/>`.length
			input = `${root} data-mml-node="${'a'.repeat(MAX_MATH_SVG_LENGTH - overhead)}/>`
		}
		expect(input.length).toBe(MAX_MATH_SVG_LENGTH)
		expect(boundedValidation(input)).not.toBeNull()
	})
	it('accepts many adjacent inert elements without rescanning tag tails', () => {
		expect(boundedValidation(frame('<g data-mml-node="mrow"/>'.repeat(4000)))).toBeNull()
	})
})

describe('root mapping participates in cumulative paint bounds', () => {
	const mapped = (body: string, box = '0 0 1 1') => `<svg xmlns="http://www.w3.org/2000/svg" width="6em" height="6em" viewBox="${box}">${body}</svg>`
	it.each([
		['large absolute path', '<path d="M0 0L500000 0L0 500000"/>'],
		['large polyline', '<polyline points="0 0 500000 500000"/>'],
		['large local rectangle', '<rect x="500000" width="500000" height="1"/>'],
		['large explicit stroke', '<path d="M0 0L1 1" stroke="currentColor" stroke-width="999999"/>'],
		['large inherited stroke', '<g stroke="currentColor" stroke-width="999999"><path d="M0 0L1 1"/></g>'],
		['nested viewport inherits root mapping', '<svg width="1" height="1" viewBox="0 0 1 1"><path d="M0 0L500000 0L0 500000"/></svg>'],
		['known table CSS stroke is not invisible to the bound', '<g transform="scale(100)"><g data-mml-node="mtable" transform="scale(100)" stroke-width="0"><line data-line="h" class="mjx-solid"/></g></g>'],
		['inherited text size and content', '<g font-size="100000"><text>abcdefghijklmnopqrst</text></g>'],
		['local em resolves against inherited font size', '<g font-size="100000"><text x="512em">x</text></g>'],
		['points resolve inherited transform', '<g transform="scale(100)"><polygon points="0 0 5000 5000"/></g>'],
	])('rejects mapped %s without relying on browser clipping', (_name, body) => {
		expect(validateMathSvg(mapped(body!))).not.toBeNull()
	})
	it('counts fixed table CSS stroke even when a tiny zero-stroke primitive would fit', () => {
		const control = '<g transform="scale(100)"><g transform="scale(100)" stroke-width="0"><line x2="0.1"/></g></g>'
		const table = '<g transform="scale(100)"><g data-mml-node="mtable" transform="scale(100)" stroke-width="0"><line x2="0.1" data-line="h" class="mjx-solid"/></g></g>'
		expect(validateMathSvg(frame(control))).toBeNull()
		expect(validateMathSvg(frame(table))).not.toBeNull()
	})
	it('accounts for the root viewBox origin', () => {
		expect(validateMathSvg(mapped('<path d="M0 0L1 1"/>', '1000000 0 1 1'))).not.toBeNull()
	})
	it('measures root viewport scale in reference CSS pixels, not the em coefficient', () => {
		expect(validateMathSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10em" height="10em" viewBox="0 0 0.1 0.1"><path d="M0 0L1 1"/></svg>')).not.toBeNull()
	})
	it.each([
		'<g transform="translate(100,-100)"><path d="M0 0L20 20" stroke-width="2"/></g>',
		'<svg x="1" y="2" width="100" height="100" viewBox="0 0 100 100"><path d="M0 0L20 20"/></svg>',
		'<g font-size="20"><text x="1em" font-size="1em">中</text></g>',
		'<g stroke-width="2"><line x1="1pt" y1="0" x2="10px" y2="0"/></g>',
	])('keeps bounded local coordinates and inheritance %s', (body) => {
		expect(validateMathSvg(frame(body))).toBeNull()
	})
	it.each(['width', 'height', 'rx', 'ry', 'stroke-width', 'font-size'])('rejects invalid negative local %s instead of modelling a browser fallback', (attribute) => {
		expect(validateMathSvg(frame(`<rect ${attribute}="-1"/>`))).not.toBeNull()
	})
})

describe('SVG numeric grammar uses actual SVG whitespace', () => {
	it.each(['\u00a0', '\u2003', '\ufeff', '\u2028'])('rejects non-SVG numeric separators %j', (space) => {
		for (const body of [
			`<g transform="${space}scale(1)"/>`,
			`<g transform="scale(1${space},1)"/>`,
			`<path d="M0${space}0L1 1"/>`,
			`<polyline points="0${space}0 1 1"/>`,
		]) expect(validateMathSvg(frame(body))).not.toBeNull()
		expect(validateMathSvg(`${root.replace('0 -1000 1000 1000', `0${space}-1000 1000 1000`)}/>`)).not.toBeNull()
	})
})

describe('path control points and corrected ellipse radii stay within geometry bounds', () => {
	const pathSvg = (d: string) => frame(`<path d="${d}" stroke-width="0"/>`)
	it.each([
		['arc center outside the operand peak', 'M500000 500000A500000 500000 0 1 0 499999 499999'],
		['automatically expanded arc radii', 'M0 0A400000 1 0 0 1 400000 400000'],
		['rotated corrected radii', 'M0 0A400000 1 45 0 1 400000 -400000'],
		['relative corrected radii', 'M0 0a4000 .001 45 0 1 100 -100'],
		['nonfinite corrected radii', 'M0 0A400000 1e-300 0 0 1 400000 400000'],
		['repeated smooth quadratic reflection', 'M0 0Q0 0 0 0T400000 0 -400000 0 400000 0 -400000 0'],
		['reflected cubic control outside the coordinate budget', 'M400000 0C0 0 -400000 0 400000 0S-400000 0 400000 0'],
	])('rejects %s without weakening the old coordinate budget', (_name, d) => {
		expect(validateMathSvg(pathSvg(d!))).not.toBeNull()
	})
	it.each([
		'', '\t \n',
		'M0 0L1 1H2V3C1 2 3 4 5 6S7 8 9 10Q1 2 3 4T5 6A5 6 30 0 1 7 8Z',
		'm10 20c1 2 3 4 5 6s7 8 9 10q1 2 3 4t5 6',
		'm1 2 3 4h5v6zm7 8l9 10',
		'M0 0A5 5 0 0 1 10 0',
		'M0 0a5 6 30 1 0 10 10',
		'M0 0A5 5 0 0 1 10 0 5 5 0 1 0 20 0',
		'M0 0Q1 1 2 2T3 3Zt1 1',
		'M0 0C1 1 2 2 3 3S4 4 5 5L6 6S7 7 8 8',
		'M0 0A0 500000 45 1 1 100000 100000',
		'M0 0A400000 1 0 1 1 0 0',
		'M0 0A1e-300 1e-300 0 0 1 1 1',
		'M1 1Z',
	])('preserves bounded path commands and degenerate arcs %j', (d) => {
		expect(validateMathSvg(pathSvg(d))).toBeNull()
	})
	it.each([
		'L0 0', 'M0 0Q1 2', 'M0 0Z1 1', 'M0 0R1 1',
		'M0 0A1 1 0 2 0 1 1', 'M0 0A-1 1 0 0 0 1 1',
		'M0 0A1 1 0 0 0 1',
	])('keeps malformed or unsupported path syntax rejected %j', (d) => {
		expect(validateMathSvg(pathSvg(d))).not.toBeNull()
	})
	it.each(['q1 1 1 1t1 1', 'a1 1 0 0 1 1 1'])('bounds repeated path consumption within the VM budget: %s', (part) => {
		const d = `M0 0${part.repeat(3000)}`
		expect(d.length).toBeLessThan(65536)
		expect(boundedValidation(pathSvg(d))).toBeNull()
	})
})

describe('bounded local stretches use the existing cumulative matrix and paint budgets', () => {
	it.each(['scale(104)', 'scale(1,104.066)', 'matrix(1 0 0 104.066 0 0)', 'scale(10000)'])('accepts a stretch whose actual cumulative geometry is bounded: %s', (value) => {
		expect(validateMathSvg(frame(`<g transform="${value}"><path stroke-width="0" d="M0 0L1 1"/></g>`))).toBeNull()
	})
	it.each(['scale(10001)', 'matrix(10001 0 0 1 0 0)', 'scale(100) scale(101)'])('keeps the existing cumulative matrix ceiling: %s', (value) => {
		expect(validateMathSvg(frame(`<g transform="${value}"><path stroke-width="0" d="M0 0L1 1"/></g>`))).not.toBeNull()
	})
	it('keeps the cumulative matrix ceiling across group ancestors', () => {
		expect(validateMathSvg(frame('<g transform="scale(100)"><g transform="scale(101)"><path stroke-width="0" d="M0 0L1 1"/></g></g>'))).not.toBeNull()
	})
	it('still rejects a locally bounded stretch whose user coordinates exceed the budget', () => {
		expect(validateMathSvg(frame('<g transform="scale(1000)"><path stroke-width="0" d="M0 0L1000 1000"/></g>'))).toMatch(/cumulative geometry limit/)
	})
	it('still rejects a locally bounded stretch whose root-mapped paint exceeds the budget', () => {
		const value = frame('<g transform="scale(1000)"><path stroke-width="0" d="M0 0L10 10"/></g>').replace('width="1em" height="1em"', 'width="6em" height="6em"').replace('0 -1000 1000 1000', '0 0 1 1')
		expect(validateMathSvg(value)).toMatch(/cumulative geometry limit/)
	})
})

describe('fixed MathJax dash paint has a bounded numeric dialect', () => {
	it.each(['140', '70 210', '70 209.9', '70,210', '0 140', '&#55;0 210', '\t70\r\n210'])('accepts finite line/rect dash data %j', (dash) => {
		for (const element of ['line', 'rect']) expect(validateMathSvg(`${root}><${element} stroke-width="70" stroke-dasharray="${dash}"/></svg>`)).toBeNull()
	})
	it.each(['', 'none', '0', '0 0', '-1 2', '1 -2', '1 2 3', '1px 2px', '1e999 2', 'NaN 2', '1000001 1', '70\u00a0210', 'url(https://example.invalid)', '70;fill:red'])('rejects noncanonical dash data %j', (dash) => {
		expect(validateMathSvg(`${root}><line stroke-dasharray="${dash}"/></svg>`)).not.toBeNull()
	})
	it.each(['svg', 'g', 'text', 'path'])('does not allow dash paint on %s', (element) => {
		const value = element === 'svg' ? `${root} stroke-dasharray="70 210"/>` : `${root}><${element} stroke-dasharray="70 210"/></svg>`
		expect(validateMathSvg(value)).not.toBeNull()
	})
	it.each([
		'<g data-mml-node="mtable" data-array-padding="0 0"/>',
		'<g data-mml-node="mtable" style="border-left: .07em dashed;"/>',
		'<line stroke="" stroke-dasharray="70 210"/>',
		'<line stroke-dasharray="70 210" onload="alert(1)"/>',
		'<line stroke-dasharray="70 210" style="stroke:url(https://example.invalid)"/>',
	])('still refuses unnormalized metadata, style, empty paint and active extras: %s', (body) => {
		expect(validateMathSvg(`${root}>${body}</svg>`)).not.toBeNull()
	})
})

describe('unresolved MathJax layout state never enters the host', () => {
	it.each([
		'<g data-labels="true"/>', '<g data-mjx-linestack="true"/>',
		'<g data-mjx-linebox="true"/>', '<g data-mjx-lineno="0"/>',
		'<g data-mml-node="mspace" data-lineleading="1em"/>',
		'<g data-table="true"/>',
		'<svg preserveAspectRatio="xMaxYMid" viewBox="0 0 1 1"><path d="M0 0L1 1"/></svg>',
	])('rejects unresolved layout attributes rather than repairing them: %s', (body) => {
		expect(validateMathSvg(`${root}>${body}</svg>`)).not.toBeNull()
	})
	it.each([
		`${root.replace('width="1em"', 'width="100%"')}/>`,
		`${root} data-mjx-viewBox="0 0 1000 1000"/>`,
		`${root} style="vertical-align: 0; min-width: 1em;"/>`,
	])('rejects full-width root state before insertion: %s', (value) => {
		expect(validateMathSvg(value)).not.toBeNull()
	})
})

describe('canonical outer SVG geometry', () => {
	it.each(['0', '0em', '-0em', '+1em', '.5em', '1e-3em', '512em'])('accepts normalized root width %j', (width) => {
		expect(validateMathSvg(`${root.replace('width="1em"', `width="${width}"`)}/>`)).toBeNull()
	})
	it.each(['0', '0em', '-0.2em', '1em', '-1em', '512em', '-512em'])('preserves bounded signed baseline %j', (alignment) => {
		expect(validateMathSvg(`${root} style="vertical-align: ${alignment};"/>`)).toBeNull()
	})
	it.each(['1', '1px', '1pt', '1ex', '0px', '0pt', '0ex', '&#49;px'])('rejects noncanonical root width %j', (width) => {
		expect(validateMathSvg(`${root.replace('width="1em"', `width="${width}"`)}/>`)).not.toBeNull()
	})
	it.each(['1', '1px', '1pt', '1ex', '999999px', '-999999px', '513em', '-513em'])('rejects noncanonical or excessive baseline %j', (alignment) => {
		expect(validateMathSvg(`${root} style="vertical-align: ${alignment};"/>`)).not.toBeNull()
	})
	it.each(['font-size="1000000px"', 'font-size="1px"', 'x="0"', 'y="0"', 'stroke-width="999999"', 'transform="scale(2)"'])('rejects unproduced root overrides %s', (attributes) => {
		expect(validateMathSvg(`${root} ${attributes}/>`)).not.toBeNull()
	})
	it('keeps local user-unit positions, fallback font sizes and transforms', () => {
		expect(validateMathSvg(frame('<g transform="translate(1,-2)"><text font-size="884px" x="2">中</text></g>'))).toBeNull()
	})
	it.each([' vertical-align: -0.2em; ', '\tvertical-align:\n-0.2em;\r'])('accepts bounded baseline with ASCII CSS whitespace %j', (style) => {
		expect(validateMathSvg(`${root} style="${style}"/>`)).toBeNull()
	})
	it.each(['\u00a0', '\u2003', '\ufeff', '\u2028'])('rejects non-CSS whitespace in baseline syntax %j', (space) => {
		for (const style of [`${space}vertical-align:1em;`, `vertical-align:${space}1em;`, `vertical-align:1em;${space}`]) {
			expect(validateMathSvg(`${root} style="${style}"/>`)).not.toBeNull()
		}
	})
	it('rejects a near-limit malformed baseline within the CPU budget', () => {
		const overhead = `${root} style="vertical-align:;;"/>`.length
		const input = `${root} style="vertical-align:${' '.repeat(MAX_MATH_SVG_LENGTH - overhead)};;"/>`
		expect(input.length).toBe(MAX_MATH_SVG_LENGTH)
		expect(boundedValidation(input)).not.toBeNull()
	})
})
