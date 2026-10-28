/** MathJax 4.1.3 + NewCM 4.1.3. Only worker-entry/tests may value-import this module. */
import { mathjax } from '@mathjax/src/js/mathjax.js'
import { TeX } from '@mathjax/src/js/input/tex.js'
import { SVG } from '@mathjax/src/js/output/svg.js'
import { SvgWrapper } from '@mathjax/src/js/output/svg/Wrapper.js'
import type { OptionList } from '@mathjax/src/js/util/Options.js'
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js'
import type { LiteElement } from '@mathjax/src/js/adaptors/lite/Element.js'
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js'
import { SafeHandler } from '@mathjax/src/js/ui/safe/SafeHandler.js'
import { ColumnParser } from '@mathjax/src/js/input/tex/ColumnParser.js'
import type { ColumnState } from '@mathjax/src/js/input/tex/ColumnParser.js'
import TexError from '@mathjax/src/js/input/tex/TexError.js'
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js'
import '@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js'
import { createNewcmFont } from './newcm.ts'
import { MAX_MATH_INPUT_LENGTH, validateMathSvg } from './protocol.ts'
import type { MathRenderResult } from './protocol.ts'

const MAX_COLUMN_REPEAT = 256
const MAX_COLUMNS = 256
const MAX_MACROS = 1000
const MAX_TEMPLATE_SUBSTITUTIONS = 256
const MAX_ERROR_LENGTH = 512
const adaptor = liteAdaptor()
SafeHandler(RegisterHTMLHandler(adaptor))
const font = createNewcmFont()

// A missing static shard must fail closed; do not install a component/require
// loader, auto-load TeX packages, retry asynchronously, or fetch a font.
mathjax.asyncLoad = (file: string): never => { throw new Error(`Offline math cannot load: ${file}`) }
mathjax.asyncIsSynchronous = false

/**
 * Derived from @mathjax/src 4.1.3 mjs/input/tex/ColumnParser.js:227–236.
 * The upstream repeat() allocates new Array(n) before MAXCOLUMNS is checked.
 * Read arguments with the real parser (including macro-generated templates),
 * then bound BOTH n and the resulting template before making any allocation.
 * This adapter stays in our source, never in node_modules or vendor.
 */
ColumnParser.prototype.repeat = function boundedColumnRepeat(state: ColumnState): void {
	const num = this.getBraces(state)
	const cols = this.getBraces(state)
	const n = Number.parseInt(num, 10)
	if (String(n) !== num) throw new TexError('ColArgNotNum', 'First argument to * column specifier must be a number')
	const suffixLength = state.template.length - state.i
	if (!Number.isSafeInteger(n) || n < 0 || n > MAX_COLUMN_REPEAT || cols.length * n + suffixLength > MAX_MATH_INPUT_LENGTH) {
		throw new TexError('MathColumnLimit', 'Math column repetition exceeds the offline limit')
	}
	state.template = cols.repeat(n) + state.template.substring(state.i)
	state.i = 0
}

function fail(error: unknown): MathRenderResult {
	const message = error instanceof Error || error instanceof TexError ? error.message : 'Math rendering failed'
	return { ok: false, error: message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_ERROR_LENGTH) || 'Math rendering failed' }
}

function raise(_jax: unknown, error: unknown): never { throw error }
function documentError(_document: unknown, _math: unknown, error: unknown): never { throw error }

const tableBorders = new Set(['border-top', 'border-right', 'border-bottom', 'border-left'])

/** Only MathJax's small, generated table-border declarations are non-painting residue on SVG groups. */
function tableBorderResidue(style: string): boolean {
	if (style.length > 256) return false
	const declarations = style.split(';').map((part) => part.trim()).filter(Boolean)
	return declarations.length <= 4 && declarations.every((part) => {
		const colon = part.indexOf(':')
		return colon > 0 && tableBorders.has(part.slice(0, colon).trim())
			&& /^(?:\d+(?:\.\d*)?|\.\d+)em (?:solid|dashed|dotted)$/.test(part.slice(colon + 1).trim())
	})
}

/** Normalize fixed MathJax output after layout, without admitting group CSS to the host dialect. */
function normalizeSvgOutput(node: LiteElement): void {
	// Source-linking metadata is unused and liteAdaptor does not XML-escape its '<' characters.
	adaptor.removeAttribute(node, 'data-latex')
	const kind = adaptor.kind(node)
	if (kind === 'g') {
		// Common mrow/mspace layout already consumed these line boxes and leading.
		for (const name of ['data-labels', 'data-mjx-linestack', 'data-mjx-linebox', 'data-mjx-lineno', 'data-lineleading']) {
			adaptor.removeAttribute(node, name)
		}
	}
	if (kind === 'g' && adaptor.getAttribute(node, 'data-mml-node') === 'mtable') {
		// ColumnParser's padding has already been consumed by the mtable layout.
		adaptor.removeAttribute(node, 'data-array-padding')
		if (adaptor.getAttribute(node, 'data-width-includes-label') === 'true') adaptor.removeAttribute(node, 'data-width-includes-label')
		const style = adaptor.getAttribute(node, 'style')
		if (typeof style === 'string' && tableBorderResidue(style)) {
			// The renderer emitted explicit SVG border lines. Clear cached Styles too.
			adaptor.setAttribute(node, 'style', '')
			adaptor.removeAttribute(node, 'style')
		}
	}
	if ((kind === 'line' || kind === 'rect') && adaptor.getAttribute(node, 'stroke') === '') {
		// Empty SVG presentation values are ignored by the browser; inheritance is unchanged.
		adaptor.removeAttribute(node, 'stroke')
	}
	for (const child of adaptor.childNodes(node)) {
		if (!adaptor.kind(child).startsWith('#')) normalizeSvgOutput(child as LiteElement)
	}
}

/** Preserve the font's em geometry regardless of the host text font's x-height. */
function rootLengthInEm(length: string): string {
	// SVG.ex() in MathJax 4.1.3 divides by this exact font parameter, rounded to
	// three decimals. Reverse that operation only at the outer SVG; never touch
	// the viewBox or path coordinates. Unitless zero remains zero.
	if (length === '0') return '0'
	const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))ex$/.exec(length)
	if (!match) throw new Error('Unexpected MathJax root length')
	const value = Number(match[1]) * font.params.x_height
	if (!Number.isFinite(value)) throw new Error('Invalid MathJax root geometry')
	return `${Number(value.toFixed(6))}em`
}

// MathJax 4.1.3's mixin declarations omit these actual wrapper hooks. Keep
// this version-pinned bridge narrow; never modify its shared wrapper prototypes.
type MathDisplayHook = { handleDisplay(): void }
type RowLayoutHooks<N> = { lineBBox: ReadonlyArray<{ lineLeading: number }>; placeLines(parents: N[]): void }
type TableLayoutHooks<N> = {
	hasLabels: boolean
	labels: N
	spaceLabels(): void
	getTableData(): { L: number }
	handlePWidth(svg: N): number
	handleLabels(svg: N, parent: N, dx: number): void
}

/**
 * A DIL formula is an intrinsic fragment, not a responsive MathJax document.
 * Preserve the fixed renderer's line boxes and label padding while avoiding
 * its container-width/pixel-compensation SVGs (svg.js:84–95 and mtable.js:190–220).
 * Each output owns its factory map, so every request keeps independent wrappers.
 */
class IntrinsicSVG<N, T, D> extends SVG<N, T, D> {
	constructor(options?: OptionList) {
		super(options)
		const MathWrapper = this.factory.getNodeClass('math')
		const mathHooks = MathWrapper.prototype as unknown as MathDisplayHook
		this.factory.setNodeClass('math', class extends MathWrapper {
			override setChildPWidths(recompute: boolean, width: number | null = null, clear = true): boolean {
				// Use the already-computing natural bbox; getBBox() here would re-enter.
				return !this.parent && this.bbox.pwidth
					? SvgWrapper.prototype.setChildPWidths.call(this, recompute, this.bbox.w, false)
					: super.setChildPWidths(recompute, width, clear)
			}
			override getWrapWidth(i: number): number {
				return !this.parent && this.bbox.pwidth ? this.bbox.w : super.getWrapWidth(i)
			}
			handleDisplay(): void {
				if (!this.bbox.pwidth) mathHooks.handleDisplay.call(this)
			}
		})
		for (const kind of ['mrow', 'inferredMrow']) {
			const RowWrapper = this.factory.getNodeClass(kind)
			const rowHooks = RowWrapper.prototype as unknown as RowLayoutHooks<N>
			this.factory.setNodeClass(kind, class extends RowWrapper {
				placeLines(parents: N[]): void {
					rowHooks.placeLines.call(this, parents)
					if (this.jax.math.display) return
					let root: SvgWrapper<N, T, D> = this
					while (root.parent) root = root.parent
					if (!root.getOuterBBox().pwidth) return
					// SVG mrow omits inline leading although LineBBox includes it.
					// Correct only the finite root's line positions, not the font mode.
					const lines = (this as unknown as RowLayoutHooks<N>).lineBBox
					let leading = 0
					for (const [i, parent] of parents.entries()) {
						if (leading) this.place(0, -leading, parent)
						leading += lines[i]!.lineLeading
					}
				}
			})
		}
		const TableWrapper = this.factory.getNodeClass('mtable')
		const tableHooks = TableWrapper.prototype as unknown as TableLayoutHooks<N>
		this.factory.setNodeClass('mtable', class extends TableWrapper {
			handlePWidth(svg: N): number {
				return (this as unknown as TableLayoutHooks<N>).hasLabels ? 0 : tableHooks.handlePWidth.call(this, svg)
			}
			handleLabels(svg: N, parent: N, dx: number): void {
				const table = this as unknown as TableLayoutHooks<N>
				if (!table.hasLabels) return tableHooks.handleLabels.call(this, svg, parent, dx)
				table.spaceLabels()
				const { w, L, R } = this.getBBox()
				const labelWidth = table.getTableData().L
				this.adaptor.removeAttribute(table.labels, 'transform')
				this.place(this.node.attributes.get('side') === 'left' ? -L : w + R - labelWidth, 0, table.labels)
				this.adaptor.append(svg, table.labels)
			}
		})
	}
	protected override createRoot(wrapper: SvgWrapper<N, T, D>): [N, N] {
		const { w, h, d, pwidth } = wrapper.getOuterBBox()
		return pwidth ? this.createSVG(h, d, w) : super.createRoot(wrapper)
	}
}

/** Synchronous by contract. A new TeX/document/output instance isolates every request's macros. */
export function renderMath(tex: string, display: boolean): MathRenderResult {
	if (typeof tex !== 'string' || !tex.trim() || tex.length > MAX_MATH_INPUT_LENGTH) return { ok: false, error: 'Math input is empty or exceeds 8192 characters' }
	if (typeof display !== 'boolean' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(tex)) return { ok: false, error: 'Math input has an invalid display mode or control character' }
	try {
		const input = new TeX({
			packages: ['base', 'ams', 'newcommand'],
			maxBuffer: MAX_MATH_INPUT_LENGTH,
			maxMacros: MAX_MACROS,
			maxTemplateSubtitutions: MAX_TEMPLATE_SUBSTITUTIONS,
			formatError: raise,
		})
		input.parseOptions.columnParser.MAXCOLUMNS = MAX_COLUMNS
		// MathJax 4 defaults to splitting inline operators into sibling SVGs. The
		// host contract is one self-contained SVG, not an mjx-container fragment.
		const output = new IntrinsicSVG({ fontData: font, fontCache: 'none', useXlink: false, linebreaks: { inline: false } })
		const document = mathjax.document('', {
			InputJax: input,
			OutputJax: output,
			compileError: documentError,
			typesetError: documentError,
			safeOptions: { allow: { URLs: 'none', classes: 'none', cssIDs: 'none', styles: 'none' } },
		})
		const container = document.convert(tex, { display }) as LiteElement
		const svg = adaptor.firstChild(container) as LiteElement | undefined
		if (!svg || adaptor.kind(svg) !== 'svg' || adaptor.childNodes(container).length !== 1) throw new Error('MathJax did not produce one standalone SVG')
		for (const name of ['width', 'height']) adaptor.setAttribute(svg, name, rootLengthInEm(String(adaptor.getAttribute(svg, name))))
		adaptor.setStyle(svg, 'vertical-align', rootLengthInEm(adaptor.getStyle(svg, 'vertical-align')))
		normalizeSvgOutput(svg)
		const serialized = adaptor.outerHTML(svg)
		const invalid = validateMathSvg(serialized)
		return invalid ? { ok: false, error: invalid } : { ok: true, svg: serialized }
	} catch (error) {
		return fail(error)
	}
}
