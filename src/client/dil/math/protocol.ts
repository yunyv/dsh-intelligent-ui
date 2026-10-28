/** Data-only protocol shared by the host and the isolated, offline math Worker. */
export type MathRenderRequest = { tex: string; display: boolean }
export type MathRenderResult = { ok: true; svg: string } | { ok: false; error: string }

export const MAX_MATH_INPUT_LENGTH = 8192
export const MAX_MATH_SVG_LENGTH = 262144

const MAX_ELEMENTS = 4096
const MAX_DEPTH = 64
const MAX_GEOMETRY = 1_000_000
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?'
const singleNumber = new RegExp(`^${NUMBER}$`)
const numberToken = new RegExp(NUMBER, 'y')
const lengthPattern = new RegExp(`^(${NUMBER})(ex|em|px|pt)?$`)
const elements = new Set(['svg', 'g', 'path', 'rect', 'line', 'polyline', 'polygon', 'text'])
const geometryAttributes = new Set(['x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'rx', 'ry', 'stroke-width', 'font-size'])
const metadataAttributes = new Set(['data-mml-node', 'data-mjx-texclass', 'data-mjx-alternate', 'data-c', 'data-latex', 'data-mjx-error', 'data-mjx-char', 'data-frame-styles'])
type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** XML entities are data only; DTDs, declarations and custom entities never enter the parser. */
function decodeXml(value: string): string | null {
	let amp = value.indexOf('&')
	if (amp === -1) return value
	const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
	const parts: string[] = []
	let cursor = 0
	while (amp !== -1) {
		// Scans are disjoint: consume one complete entity, or reject without retrying later '&'s.
		const end = value.indexOf(';', amp + 1)
		if (end === -1) return null
		const entity = value.slice(amp + 1, end)
		let decoded: string
		if (Object.hasOwn(named, entity)) decoded = named[entity]!
		else {
			if (!/^#(?:\d+|x[\da-fA-F]+)$/.test(entity)) return null
			const code = entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
			if (!Number.isSafeInteger(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null
			decoded = String.fromCodePoint(code)
		}
		parts.push(value.slice(cursor, amp), decoded)
		cursor = end + 1
		amp = value.indexOf('&', cursor)
	}
	parts.push(value.slice(cursor))
	return parts.join('')
}

/** Consume complete numeric tokens, never a finite prefix of e.g. "1e" or "1e999". */
function numbers(value: string): number[] | null {
	const result: number[] = []
	let i = 0
	while (i < value.length && xmlSpaceAt(value, i)) i++
	while (i < value.length) {
		numberToken.lastIndex = i
		const match = numberToken.exec(value)
		if (!match) return null
		const number = Number(match[0])
		if (!Number.isFinite(number) || Math.abs(number) > MAX_GEOMETRY) return null
		result.push(number)
		i = numberToken.lastIndex
		const end = i
		while (i < value.length && xmlSpaceAt(value, i)) i++
		if (i === value.length) break
		if (value[i] === ',') {
			i++
			while (i < value.length && xmlSpaceAt(value, i)) i++
			if (i === value.length) return null
		} else if (i === end) return null
	}
	return result.length ? result : null
}

/** Bound the entire corrected ellipse, not just the input arc radii (SVG F.6.6). */
function arcBound(x1: number, y1: number, x2: number, y2: number, rx: number, ry: number, angle: number): number | null {
	const endpoints = Math.max(Math.abs(x1), Math.abs(y1), Math.abs(x2), Math.abs(y2))
	if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return endpoints
	const radians = (angle % 360) * Math.PI / 180
	const cos = Math.cos(radians), sin = Math.sin(radians)
	const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
	const factor = Math.max(1, Math.hypot((cos * dx + sin * dy) / rx, (-sin * dx + cos * dy) / ry))
	const a = rx * factor, b = ry * factor
	if (![factor, a, b].every(Number.isFinite)) return null
	const extentX = Math.hypot(a * cos, b * sin), extentY = Math.hypot(a * sin, b * cos)
	// The centre's offset from the endpoint midpoint is itself bounded by each projected radius.
	// Adding the ellipse extent therefore covers either centre and either arc flag, without unstable division.
	const bound = Math.max(endpoints, Math.abs((x1 + x2) / 2) + 2 * extentX, Math.abs((y1 + y2) / 2) + 2 * extentY)
	return Number.isFinite(bound) ? bound : null
}

/** Strict operand syntax plus control-point/ellipse bounds; never weaken the original operand budget. */
function pathBound(value: string): number | null {
	if (value.length > 65536) return null
	if (onlyXmlSpace(value)) return 0 // MathJax emits empty paths for vector-font spaces.
	const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }
	let i = 0, count = 0, total = 0, peak = 0, geometry = 0
	let command = '', previous = ''
	let relative = false, localRelative = false
	let x = 0, y = 0, startX = 0, startY = 0, controlX = 0, controlY = 0
	const args: number[] = []
	const include = (...coordinates: number[]) => {
		for (const coordinate of coordinates) {
			if (!Number.isFinite(coordinate)) return false
			geometry = Math.max(geometry, Math.abs(coordinate))
		}
		return true
	}
	const advance = () => {
		const op = command === 'M' && count > 2 ? 'L' : command
		const px = (index: number) => args[index]! + (localRelative ? x : 0)
		const py = (index: number) => args[index]! + (localRelative ? y : 0)
		let nextX = x, nextY = y
		if (op === 'M' || op === 'L' || op === 'T') {
			nextX = px(0); nextY = py(1)
			if (op === 'T') {
				const smooth = previous === 'Q' || previous === 'T'
				controlX = smooth ? 2 * x - controlX : x
				controlY = smooth ? 2 * y - controlY : y
				if (!include(controlX, controlY)) return false
			}
			if (op === 'M') { startX = nextX; startY = nextY }
		} else if (op === 'H') nextX = px(0)
		else if (op === 'V') nextY = py(0)
		else if (op === 'C') {
			controlX = px(2); controlY = py(3)
			nextX = px(4); nextY = py(5)
			if (!include(px(0), py(1), controlX, controlY)) return false
		} else if (op === 'S') {
			const smooth = previous === 'C' || previous === 'S'
			if (!include(smooth ? 2 * x - controlX : x, smooth ? 2 * y - controlY : y)) return false
			controlX = px(0); controlY = py(1)
			nextX = px(2); nextY = py(3)
			if (!include(controlX, controlY)) return false
		} else if (op === 'Q') {
			controlX = px(0); controlY = py(1)
			nextX = px(2); nextY = py(3)
			if (!include(controlX, controlY)) return false
		} else if (op === 'A') {
			nextX = px(5); nextY = py(6)
			const bound = arcBound(x, y, nextX, nextY, args[0]!, args[1]!, args[2]!)
			if (bound === null) return false
			geometry = Math.max(geometry, bound)
		}
		if (!include(nextX, nextY)) return false
		x = nextX; y = nextY; previous = op
		args.length = 0
		return true
	}
	const complete = () => !!command && (command === 'Z' ? count === 0 : count > 0 && count % arity[command]! === 0)
	while (i < value.length) {
		if (xmlSpaceAt(value, i) || value[i] === ',') { i++; continue }
		const char = value[i]!
		if (/[MmZzLlHhVvCcSsQqTtAa]/.test(char)) {
			if (command ? !complete() : char.toUpperCase() !== 'M') return null
			command = char.toUpperCase()
			localRelative = char !== command && command !== 'Z'
			relative ||= localRelative
			count = 0
			if (command === 'Z') { x = startX; y = startY; previous = 'Z' }
			i++
			continue
		}
		if (!command || command === 'Z') return null
		numberToken.lastIndex = i
		const match = numberToken.exec(value)
		if (!match) return null
		const number = Number(match[0])
		if (!Number.isFinite(number) || Math.abs(number) > MAX_GEOMETRY) return null
		if (command === 'A' && ([3, 4].includes(count % 7) ? number !== 0 && number !== 1 : count % 7 < 2 && number < 0)) return null
		peak = Math.max(peak, Math.abs(number))
		args.push(number)
		count++
		total++
		i = numberToken.lastIndex
		if (count % arity[command]! === 0 && !advance()) return null
	}
	return complete() ? Math.max(peak * (relative ? total : 2), geometry) : null
}

const MAX_EM_LENGTH = 512

/** Local presentation lengths remain in the SVG's own user-coordinate system. */
function validLength(value: string): boolean {
	const match = lengthPattern.exec(value)
	if (!match) return false
	const number = Number(match[1])
	const unit = match[2]
	const limit = unit === 'em' || unit === 'ex' ? MAX_EM_LENGTH : MAX_GEOMETRY
	return Number.isFinite(number) && Math.abs(number) <= limit
}

/** The engine normalizes only outer lengths to em; baseline offsets may be signed. */
function validRootLength(value: string, signed = false): boolean {
	const match = lengthPattern.exec(value)
	if (!match) return false
	const number = Number(match[1])
	return (match[2] === 'em' || (!match[2] && number === 0)) && Number.isFinite(number)
		&& Math.abs(number) <= MAX_EM_LENGTH && (signed || number >= 0)
}

function trimXmlSpace(value: string): string {
	let start = 0, end = value.length
	while (start < end && xmlSpaceAt(value, start)) start++
	while (end > start && xmlSpaceAt(value, end - 1)) end--
	return value.slice(start, end)
}

/** Consume the sole supported CSS declaration without overlapping whitespace scans. */
function validRootAlignment(value: string): boolean {
	const declaration = trimXmlSpace(value)
	const property = 'vertical-align:'
	if (!declaration.startsWith(property)) return false
	let length = trimXmlSpace(declaration.slice(property.length))
	if (length.endsWith(';')) length = trimXmlSpace(length.slice(0, -1))
	return validRootLength(length, true)
}

function multiply(a: Matrix, b: Matrix): Matrix {
	return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]
}
function boundedMatrix(matrix: Matrix, linearLimit = 10000): boolean {
	return matrix.every((number, i) => Number.isFinite(number) && Math.abs(number) <= (i < 4 ? linearLimit : MAX_GEOMETRY))
}

function transform(value: string): Matrix | null {
	if (value.length > 1024) return null
	const pattern = /[ \t\r\n]*(translate|scale|matrix|rotate|skewX|skewY)\(([^()]*)\)[ \t\r\n]*/gy
	let offset = 0
	let count = 0
	let result = IDENTITY
	while (offset < value.length) {
		pattern.lastIndex = offset
		const match = pattern.exec(value)
		if (!match || ++count > 8) return null
		const args = numbers(match[2]!)
		if (!args) return null
		const name = match[1]
		if (name === 'matrix' ? args.length !== 6 : name === 'rotate' ? ![1, 3].includes(args.length) : name === 'skewX' || name === 'skewY' ? args.length !== 1 : ![1, 2].includes(args.length)) return null
		let next: Matrix
		if (name === 'matrix') next = args as Matrix
		else if (name === 'translate') next = [1, 0, 0, 1, args[0]!, args[1] ?? 0]
		else if (name === 'scale') next = [args[0]!, 0, 0, args[1] ?? args[0]!, 0, 0]
		else {
			if (Math.abs(args[0]!) > 360) return null
			const angle = args[0]! * Math.PI / 180
			if (name === 'rotate') {
				const c = Math.cos(angle), s = Math.sin(angle), x = args[1] ?? 0, y = args[2] ?? 0
				next = [c, s, -s, c, x - c * x + s * y, y - s * x - c * y]
			} else next = name === 'skewX' ? [1, 0, Math.tan(angle), 1, 0, 0] : [1, Math.tan(angle), 0, 1, 0, 0]
		}
		// NewCM's stretched delimiter bars can exceed 100 locally. Use the same
		// existing matrix ceiling here and after composition; leaf geometry still
		// has to satisfy both user-space and root-mapped paint budgets.
		if (!boundedMatrix(next)) return null
		result = multiply(result, next)
		if (!boundedMatrix(result)) return null
		offset = pattern.lastIndex
	}
	return count ? result : null
}

function viewBox(value: string): number[] | null {
	const values = numbers(value)
	return values?.length === 4 && values[2]! > 0 && values[3]! > 0 ? values : null
}

/** Reference pixel budget only: a host may independently scale its surrounding font. */
const REFERENCE_EM_PX = 16

function userLength(value: string, fontSize: number): number {
	const match = lengthPattern.exec(value)!
	const number = Number(match[1])
	// SVG px are user units inside a viewBox; ex is conservatively bounded by one em.
	return number * (match[2] === 'pt' ? 4 / 3 : match[2] === 'em' || match[2] === 'ex' ? fontSize : 1)
}

/** Map the canonical outer em viewport into the fixed reference-pixel frame. */
function rootViewport(values: Record<string, string>): Matrix | null {
	const box = viewBox(values.viewBox!)!
	const width = Number(lengthPattern.exec(values.width!)![1]) * REFERENCE_EM_PX
	const height = Number(lengthPattern.exec(values.height!)![1]) * REFERENCE_EM_PX
	const ratios = [width / box[2]!, height / box[3]!]
	if (!ratios.every((scale) => Number.isFinite(scale) && scale <= 100)) return null
	const scale = Math.min(...ratios)
	const result: Matrix = [scale, 0, 0, scale, (width - box[2]! * scale) / 2 - box[0]! * scale, (height - box[3]! * scale) / 2 - box[1]! * scale]
	return boundedMatrix(result, 100) ? result : null
}

function projectedBound(bound: number, matrix: Matrix): number {
	if (!Number.isFinite(bound) || !matrix.every(Number.isFinite)) return Number.POSITIVE_INFINITY
	const magnification = Math.max(Math.abs(matrix[0]) + Math.abs(matrix[2]), Math.abs(matrix[1]) + Math.abs(matrix[3]))
	return bound * magnification + Math.max(Math.abs(matrix[4]), Math.abs(matrix[5]))
}

const nonnegativeLengths = new Set(['width', 'height', 'rx', 'ry', 'stroke-width', 'font-size'])
const drawnElements = new Set(['path', 'rect', 'line', 'polyline', 'polygon', 'text'])

type GeometryFrame = { name: string; matrix: Matrix; paint: Matrix; fontSize: number; strokeWidth: number; bound: number; textLength: number }

/** Both pre-existing user-space limits and the root-mapped paint budget apply. */
function withinGeometry(frame: GeometryFrame): boolean {
	const stroke = drawnElements.has(frame.name) ? frame.strokeWidth * 2 : 0 // Default SVG miter limit is four half-widths.
	return boundedMatrix(frame.matrix) && projectedBound(frame.bound + stroke, frame.matrix) <= MAX_GEOMETRY
		&& projectedBound(frame.bound + stroke, frame.paint) <= MAX_GEOMETRY
}

function withinText(frame: GeometryFrame): boolean {
	// Include advances plus ascent/descent; content never bypasses the reference paint budget.
	const bound = frame.bound + 2 * frame.fontSize * (frame.textLength + 1) + 2 * frame.strokeWidth
	return projectedBound(bound, frame.paint) <= MAX_GEOMETRY
}

/** Nested SVG is used by MathJax for stretched accents; only unitless inert viewports. */
function viewport(values: Record<string, string>): Matrix | null {
	if (!values.width || !values.height || !values.viewBox) return null
	const box = viewBox(values.viewBox)
	const width = Number(values.width), height = Number(values.height)
	const x = Number(values.x ?? '0'), y = Number(values.y ?? '0')
	if (!box || ![values.width, values.height, values.x ?? '0', values.y ?? '0'].every((value) => singleNumber.test(value))) return null
	if (width < 0 || height < 0 || box[2]! <= 0 || box[3]! <= 0) return null
	const scale = Math.min(width / box[2]!, height / box[3]!)
	const result: Matrix = [scale, 0, 0, scale, x + (width - box[2]! * scale) / 2 - box[0]! * scale, y + (height - box[3]! * scale) / 2 - box[1]! * scale]
	return boundedMatrix(result, 100) ? result : null
}

/** Locked MathJax/NewCM 4.1.3 fallback metadata, never arbitrary CSS classes. */
const textVariants = new Set([
	'-bbold', '-ex-md', '-largeop', '-lf-tp', '-rt-bt', '-size3', '-size4', '-size5', '-size6', '-size7', '-smallop',
	'-tex-bold-calligraphic', '-tex-bold-oldstyle', '-tex-calligraphic', '-tex-mathit', '-tex-oldstyle', '-tex-variant', '-uplarge', '-upsmall',
	'bold', 'bold-fraktur', 'bold-italic', 'bold-sans-serif', 'bold-script', 'double-struck', 'fraktur', 'italic', 'monospace', 'normal',
	'sans-serif', 'sans-serif-bold-italic', 'sans-serif-italic', 'script', '-explicitFont'
])
const lineClasses = new Set(['mjx-solid', 'mjx-dashed', 'mjx-dotted'])

function validAttribute(name: string, value: string, element: string, root: boolean): boolean {
	if (root) {
		if (name === 'width' || name === 'height') return validRootLength(value)
		if (geometryAttributes.has(name) || name === 'transform') return false
	}
	if (metadataAttributes.has(name)) return value.length <= MAX_MATH_INPUT_LENGTH * 2
	if (name === 'data-variant') return element === 'text' && textVariants.has(value)
	if (name === 'data-line') return element === 'line' && (value === 'h' || value === 'v')
	if (name === 'data-frame' || name === 'data-bgcolor') return element === 'rect' && value === 'true'
	if (name === 'data-padding') return element === 'g' && value === '0'
	if (name === 'data-align') return element === 'g' && /^(?:left|center|right)$/.test(value)
	if (name === 'data-vertical-align') return element === 'g' && /^(?:top|bottom|center|middle)$/.test(value)
	if (name === 'data-overflow') return element === 'g' && /^(?:auto|linebreak)$/.test(value)
	if (name === 'class') return (element === 'line' || element === 'rect') && lineClasses.has(value)
	if (name === 'xmlns') return root && value === 'http://www.w3.org/2000/svg'
	if (name === 'xmlns:xlink') return root && value === 'http://www.w3.org/1999/xlink'
	if (name === 'role') return root && value === 'img'
	if (name === 'focusable') return root && value === 'false'
	if (name === 'aria-hidden') return value === 'true' || value === 'false'
	if (name === 'viewBox') return element === 'svg' && viewBox(value) !== null
	if (name === 'style') return root && validRootAlignment(value)
	if (name === 'transform') return transform(value) !== null
	if (name === 'd') return element === 'path' && pathBound(value) !== null
	if (name === 'points') {
		const points = numbers(value)
		return (element === 'polygon' || element === 'polyline') && !!points && points.length % 2 === 0
	}
	if (geometryAttributes.has(name)) return validLength(value) && (!nonnegativeLengths.has(name) || Number(lengthPattern.exec(value)![1]) >= 0)
	if (name === 'fill' || name === 'stroke') return /^(?:currentColor|none|transparent|#[\da-fA-F]{3,8}|[a-zA-Z]{1,20})$/.test(value)
	if (name === 'stroke-dasharray') {
		if (element !== 'line' && element !== 'rect') return false
		const dash = numbers(value)
		return !!dash && dash.length <= 2 && dash.every((number) => number >= 0) && dash.some((number) => number > 0)
	}
	if (name === 'stroke-linecap') return /^(?:butt|round|square)$/.test(value)
	if (name === 'stroke-linejoin') return /^(?:miter|round|bevel)$/.test(value)
	if (name === 'fill-rule') return value === 'nonzero' || value === 'evenodd'
	if (name === 'opacity' || name === 'fill-opacity' || name === 'stroke-opacity') return singleNumber.test(value) && Number(value) >= 0 && Number(value) <= 1
	if (name === 'font-family') return element === 'text' && /^[\w ,'-]{1,128}$/.test(value)
	if (name === 'font-style') return element === 'text' && /^(?:normal|italic|oblique)$/.test(value)
	if (name === 'font-weight') return element === 'text' && /^(?:normal|bold|[1-9]00)$/.test(value)
	if (name === 'text-anchor') return /^(?:start|middle|end)$/.test(value)
	return false
}

type SvgTag = { name: string; closing: boolean; selfClosing: boolean; end: number; attributes: [string, string][] }

function xmlSpaceAt(value: string, position: number): boolean {
	const code = value.charCodeAt(position)
	return code === 32 || code === 9 || code === 10 || code === 13
}
function onlyXmlSpace(value: string): boolean {
	for (let i = 0; i < value.length; i++) if (!xmlSpaceAt(value, i)) return false
	return true
}
function nameStartAt(value: string, position: number): boolean {
	const code = value.charCodeAt(position)
	return code >= 65 && code <= 90 || code >= 97 && code <= 122
}
function namePartAt(value: string, position: number): boolean {
	const code = value.charCodeAt(position)
	return nameStartAt(value, position) || code >= 48 && code <= 57 || code === 95 || code === 58 || code === 45
}

/** Consume one complete tag without backtracking or repairing browser-ambiguous syntax. */
function readTag(value: string, start: number): SvgTag | null {
	let position = start + 1
	const closing = value[position] === '/'
	if (closing) position++
	if (!nameStartAt(value, position)) return null
	const nameStart = position++
	while (namePartAt(value, position)) position++
	const name = value.slice(nameStart, position)
	const attributes: [string, string][] = []
	while (position < value.length) {
		const beforeSpace = position
		while (xmlSpaceAt(value, position)) position++
		if (value[position] === '>') return { name, closing, selfClosing: false, end: position + 1, attributes }
		// HTML foreign-content parsing only honors an immediately adjacent '/>'.
		if (value[position] === '/') return !closing && value[position + 1] === '>'
			? { name, closing, selfClosing: true, end: position + 2, attributes } : null
		if (closing || position === beforeSpace || !nameStartAt(value, position) || attributes.length >= 32) return null
		const attributeStart = position++
		while (namePartAt(value, position)) position++
		const attributeName = value.slice(attributeStart, position)
		while (xmlSpaceAt(value, position)) position++
		if (value[position++] !== '=') return null
		while (xmlSpaceAt(value, position)) position++
		const quote = value[position++]
		if (quote !== '"' && quote !== "'") return null
		const valueStart = position
		while (position < value.length && value[position] !== quote) {
			if (value[position] === '<' || value[position] === '>') return null
			position++
		}
		if (position === value.length) return null
		attributes.push([attributeName, value.slice(valueStart, position)])
		position++
	}
	return null
}

/**
 * Return null only for the small, inert SVG dialect emitted by our MathJax build.
 * This intentionally does not repair XML: the host must insert the original string
 * only after this check succeeds. No DOM parser or MathJax import reaches the host.
 */
export function validateMathSvg(svg: string): string | null {
	if (typeof svg !== 'string' || !svg.length || svg.length > MAX_MATH_SVG_LENGTH) return 'Math SVG length is invalid'
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg) || /<!|<\?/.test(svg)) return 'Math SVG contains an XML declaration or control character'
	const stack: GeometryFrame[] = []
	let offset = 0
	let count = 0
	let ended = false
	while (offset < svg.length) {
		const opening = svg.indexOf('<', offset)
		const between = svg.slice(offset, opening === -1 ? svg.length : opening)
		if (between.includes('>')) return 'Math SVG contains invalid text'
		const text = stack.at(-1)
		if (text?.name === 'text' && between.length) {
			const decoded = decodeXml(between)
			if (decoded === null) return 'Math SVG contains invalid text'
			text.textLength += decoded.length
			if (!withinText(text)) return 'Math SVG exceeds the cumulative geometry limit'
		} else if (!onlyXmlSpace(between)) return 'Math SVG contains invalid text'
		if (opening === -1) { offset = svg.length; break }
		if (ended) return 'Math SVG has more than one root'
		const tag = readTag(svg, opening)
		if (!tag) return 'Math SVG contains malformed tag syntax'
		const { closing, name, selfClosing, attributes } = tag
		if (!elements.has(name)) return 'Math SVG contains an unsupported or active element'
		if (closing) {
			if (stack.pop()?.name !== name) return 'Math SVG has mismatched tags'
			if (!stack.length) ended = true
		} else {
			if (++count > MAX_ELEMENTS || stack.length >= MAX_DEPTH) return 'Math SVG exceeds the element or nesting limit'
			const root = !stack.length
			if (root && name !== 'svg') return 'Math SVG must have one SVG root'
			const seen = new Set<string>()
			const values: Record<string, string> = Object.create(null) as Record<string, string>
			for (const [attrName, rawValue] of attributes) {
				const value = decodeXml(rawValue)
				if (seen.has(attrName) || seen.size >= 32 || value === null || !validAttribute(attrName, value, name, root)) return 'Math SVG contains an unsafe or out-of-range attribute'
				seen.add(attrName)
				values[attrName] = value
			}
			if (root && (!seen.has('xmlns') || !seen.has('viewBox') || !seen.has('width') || !seen.has('height'))) return 'Math SVG root is missing geometry or its namespace'
			const outer = root ? rootViewport(values) : null
			if (root && !outer) return 'Math SVG exceeds the root viewport scale limit'
			let local = values.transform ? transform(values.transform)! : IDENTITY
			if (!root && name === 'svg') {
				const nested = viewport(values)
				if (!nested) return 'Math SVG contains an invalid internal viewport'
				local = multiply(local, nested)
			}
			const parent = stack.at(-1)
			const matrix = multiply(parent?.matrix ?? IDENTITY, local)
			const paint = root ? outer! : multiply(parent!.paint, local)
			const fontSize = values['font-size'] ? userLength(values['font-size'], parent?.fontSize ?? REFERENCE_EM_PX) : parent?.fontSize ?? REFERENCE_EM_PX
			let strokeWidth = values['stroke-width'] ? userLength(values['stroke-width'], fontSize) : parent?.strokeWidth ?? 1
			// The host's locked MathJax table CSS supplies 70 user units even below stroke-width="0".
			if ((name === 'line' && values['data-line']) || (name === 'rect' && values['data-frame']) || values.class && lineClasses.has(values.class)) strokeWidth = Math.max(strokeWidth, 70)
			let bound = 0
			if (values.d) bound = pathBound(values.d)!
			if (values.points) bound = numbers(values.points)!.reduce((peak, number) => Math.max(peak, Math.abs(number)), bound)
			if (!root) for (const [attrName, value] of Object.entries(values)) {
				if (geometryAttributes.has(attrName) && attrName !== 'font-size' && attrName !== 'stroke-width') bound += Math.abs(userLength(value, fontSize))
			}
			const frame: GeometryFrame = { name, matrix, paint, fontSize, strokeWidth, bound, textLength: 0 }
			if (![fontSize, strokeWidth].every(Number.isFinite) || !withinGeometry(frame)) return 'Math SVG exceeds the cumulative geometry limit'
			if (!selfClosing) stack.push(frame)
			else if (root) ended = true
		}
		offset = tag.end
	}
	return ended && !stack.length ? null : 'Math SVG is incomplete or is not SVG'
}
