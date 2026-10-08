/**
 * Charts, drawn as SVG with no library.
 *
 * Accepts both dialects:
 *   legacy  — `data=[{label,value}]`              (hand-written demos)
 *   shimmed — `data` + `series[]` + `xAxis.dataKey` (what `<Chart content>` lowers to)
 *
 * The SVG is laid out in real pixels (measured container width), so text and strokes
 * are never stretched; a ResizeObserver redraws on width changes.
 *
 * Two host-side adjustments: the observer comes from the view's own window (a
 * `ResizeObserver` from another realm throws on a node it does not know), and it is
 * disconnected through the patcher's teardown list, because in a long conversation a
 * view is destroyed far more often than a page is closed.
 * @module dsh-genui/client/dil/renderer/components/charts
 */

import type { DilContext, DilHandle, DilProps } from '../../types.ts'
import { applyCommon, currentWindow, el, esc } from '../dom.ts'

const PALETTE: readonly string[] = [
	'var(--dil-chart-1)',
	'var(--dil-chart-2)',
	'var(--dil-chart-3)',
	'var(--dil-chart-4)',
	'var(--dil-chart-5)'
]

/** One data series, normalized out of whatever dialect the model wrote. */
interface DilSeries {
	dataKey: string
	type?: string
	label?: string
	valuePrefix?: string
	valueSuffix?: string
}

function fmtNumber(value: unknown): string {
	const n = Number(value)
	if (!Number.isFinite(n)) return String(value ?? '')
	const abs = Math.abs(n)
	if (abs >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/u, '') + '亿'
	if (abs >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/u, '') + '万'
	return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function fmtValue(value: unknown, series: DilSeries): string {
	return (series.valuePrefix ?? '') + fmtNumber(value) + (series.valueSuffix ?? '')
}

/** "Nice" axis ticks: 4–6 steps of 1/2/2.5/5 × 10^k covering [lo, hi]. */
function niceTicks(low: number, high: number): number[] {
	const lo = low
	let hi = high
	if (lo === hi) hi = lo + 1
	const raw = (hi - lo) / 4
	const magnitude = 10 ** Math.floor(Math.log10(raw))
	const step = [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => candidate >= raw) ?? raw
	const start = Math.floor(lo / step) * step
	const ticks: number[] = []
	for (let tick = start; tick <= hi + step * 1e-9; tick += step) ticks.push(Number(tick.toFixed(10)))
	const last = ticks[ticks.length - 1]
	if (last !== undefined && last < hi) ticks.push(last + step)
	return ticks
}

function normalizeSeries(entry: unknown, fallbackType: unknown): DilSeries {
	const source = (entry ?? {}) as Record<string, unknown>
	const dataKey = source.dataKey ?? source.key ?? 'value'
	return {
		dataKey: String(dataKey),
		type: source.type === undefined ? (fallbackType === undefined ? undefined : String(fallbackType)) : String(source.type),
		...(source.label === undefined ? {} : { label: String(source.label) }),
		...(source.valuePrefix === undefined ? {} : { valuePrefix: String(source.valuePrefix) }),
		...(source.valueSuffix === undefined ? {} : { valueSuffix: String(source.valueSuffix) })
	}
}

/** Normalize the two accepted data dialects into rows, series and the x key. */
function model(props: DilProps): { rows: DilProps[]; series: DilSeries[]; xKey: string } {
	const rows: DilProps[] = Array.isArray(props.data) ? (props.data as DilProps[]) : []
	const raw = Array.isArray(props.series) && props.series.length > 0
		? (props.series as unknown[])
		: [{ dataKey: 'value', type: props.type || 'bar' }]
	const series = raw.map((entry) => normalizeSeries(entry, props.type || 'bar'))
	let xKey = props.xAxis && typeof props.xAxis === 'object'
		? (props.xAxis as { dataKey?: unknown }).dataKey
		: typeof props.xAxis === 'string' ? props.xAxis : null
	if (!xKey) xKey = rows[0] && rows[0].label != null ? 'label' : 'name'
	return { rows, series, xKey: String(xKey) }
}

function legend(series: readonly DilSeries[]): string {
	if (series.length < 2 && !series[0]?.label) return ''
	return `<div class="dil-chart-legend">${series
		.map((entry, index) => `<span><i style="background:${PALETTE[index % PALETTE.length]}"></i>${esc(entry.label ?? entry.dataKey)}</span>`)
		.join('')}</div>`
}

function cartesian(props: DilProps, width: number): string {
	const { rows, series, xKey } = model(props)
	const height = typeof props.height === 'number' ? props.height : 220
	const w = Math.max(240, width)
	const pad = { l: 48, r: 12, t: 12, b: 28 }
	const plotW = w - pad.l - pad.r
	const plotH = height - pad.t - pad.b

	const values = rows.flatMap((row) => series.map((entry) => Number(row[entry.dataKey]))).filter(Number.isFinite)
	const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values, 1))
	const lo = ticks[0] ?? 0
	const hi = ticks[ticks.length - 1] ?? 1
	const y = (value: number): number => pad.t + plotH - ((value - lo) / (hi - lo || 1)) * plotH
	const band = plotW / Math.max(1, rows.length)
	const x = (index: number): number => pad.l + band * index + band / 2
	const out: string[] = []

	for (const tick of ticks) {
		const yy = y(tick).toFixed(1)
		out.push(`<line x1="${pad.l}" x2="${w - pad.r}" y1="${yy}" y2="${yy}" class="dil-chart-grid${tick === 0 ? ' dil-chart-zero' : ''}"/>`)
		out.push(`<text x="${pad.l - 8}" y="${yy}" class="dil-chart-axis" text-anchor="end" dominant-baseline="middle">${esc(fmtNumber(tick))}</text>`)
	}
	const stride = Math.max(1, Math.ceil((rows.length * 64) / plotW))
	rows.forEach((row, index) => {
		if (index % stride) return
		out.push(`<text x="${x(index).toFixed(1)}" y="${height - 8}" class="dil-chart-axis" text-anchor="middle">${esc(row[xKey])}</text>`)
	})

	const bars = series.filter((entry) => (entry.type ?? 'bar') === 'bar')
	const barW = Math.max(4, Math.min(40, (band * 0.64) / Math.max(1, bars.length)))
	series.forEach((entry, seriesIndex) => {
		const tone = PALETTE[seriesIndex % PALETTE.length]
		const tip = (row: DilProps, value: unknown): string =>
			`<title>${esc(row[xKey])} · ${esc(entry.label ?? entry.dataKey)}：${esc(fmtValue(value, entry))}</title>`
		if ((entry.type ?? 'bar') === 'line' || entry.type === 'scatter') {
			const points = rows.map((row, index) => [x(index), y(Number(row[entry.dataKey]) || 0)] as const)
			if (entry.type !== 'scatter') {
				const d = points.map(([px, py], index) => `${index ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join('')
				out.push(`<path d="${d}" fill="none" stroke="${tone}" class="dil-chart-line"/>`)
			}
			if (props.showDots !== false || entry.type === 'scatter') {
				rows.forEach((row, index) => {
					const point = points[index]!
					out.push(`<circle cx="${point[0].toFixed(1)}" cy="${point[1].toFixed(1)}" r="3.5" fill="${tone}" class="dil-chart-dot">${tip(row, row[entry.dataKey])}</circle>`)
				})
			}
			return
		}
		const barIndex = bars.indexOf(entry)
		rows.forEach((row, index) => {
			const value = Number(row[entry.dataKey]) || 0
			const bx = x(index) - (barW * bars.length) / 2 + barIndex * barW + 1
			const top = y(Math.max(value, 0))
			const h = Math.max(1, y(Math.min(value, 0)) - top)
			out.push(`<rect x="${bx.toFixed(1)}" y="${top.toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${tone}" class="dil-chart-bar">${tip(row, value)}</rect>`)
		})
	})

	return legend(series) + `<svg class="dil-chart-svg" width="${w}" height="${height}" viewBox="0 0 ${w} ${height}" role="img">${out.join('')}</svg>`
}

function pie(props: DilProps): string {
	const rows: DilProps[] = Array.isArray(props.data) ? (props.data as DilProps[]) : []
	const valueKey = (Array.isArray(props.series) && (props.series as { dataKey?: unknown }[])[0]?.dataKey) || 'value'
	const nameKey = typeof props.xAxis === 'string' ? props.xAxis : rows[0] && rows[0].label != null ? 'label' : 'name'
	const items = rows.map((row) => ({
		label: row[String(nameKey)] ?? row.label,
		value: Math.max(0, Number(row[String(valueKey)]) || 0)
	}))
	const total = items.reduce((sum, item) => sum + item.value, 0) || 1
	const radius = 70
	const inner = 44 // donut hole
	let angle = -Math.PI / 2
	const arcs = items.map((item, index) => {
		const sweep = (item.value / total) * Math.PI * 2
		const a0 = angle
		const a1 = angle + Math.max(sweep - 0.012, 0.001)
		angle += sweep
		const point = (rad: number, a: number): string => `${(80 + rad * Math.cos(a)).toFixed(2)} ${(80 + rad * Math.sin(a)).toFixed(2)}`
		const large = a1 - a0 > Math.PI ? 1 : 0
		const path = sweep >= Math.PI * 2 - 1e-6
			? `M${point(radius, 0)}A${radius} ${radius} 0 1 1 ${point(radius, Math.PI)}A${radius} ${radius} 0 1 1 ${point(radius, 0)}M${point(inner, 0)}A${inner} ${inner} 0 1 0 ${point(inner, Math.PI)}A${inner} ${inner} 0 1 0 ${point(inner, 0)}Z`
			: `M${point(radius, a0)}A${radius} ${radius} 0 ${large} 1 ${point(radius, a1)}L${point(inner, a1)}A${inner} ${inner} 0 ${large} 0 ${point(inner, a0)}Z`
		return `<path d="${path}" fill="${PALETTE[index % PALETTE.length]}" fill-rule="evenodd" class="dil-chart-slice"><title>${esc(item.label)}：${esc(fmtNumber(item.value))}</title></path>`
	})
	const legendRows = items
		.map((item, index) => `<div class="dil-pie-item"><i style="background:${PALETTE[index % PALETTE.length]}"></i><span>${esc(item.label)}</span><b>${esc(fmtNumber(item.value))}</b><em>${Math.round((item.value / total) * 100)}%</em></div>`)
		.join('')
	return `<div class="dil-pie"><svg viewBox="0 0 160 160" width="160" height="160" role="img">${arcs.join('')}</svg><div class="dil-pie-legend">${legendRows}</div></div>`
}

function chartFactory(draw: (props: DilProps, width: number) => string) {
	return (props: DilProps, ctx?: DilContext): DilHandle => {
		const node = el('div', 'dil-chart')
		let sig: string | null = null
		let latest = props
		let width = 0
		const redraw = (): void => {
			const next = JSON.stringify([latest.data, latest.series, latest.xAxis, latest.height, latest.type, width])
			if (next === sig) return
			sig = next
			node.innerHTML = draw(latest, width)
		}
		function update(p: DilProps): void {
			applyCommon(node, p)
			latest = p
			width = node.clientWidth || width || 560
			redraw()
		}
		const Observer = currentWindow().ResizeObserver
		if (typeof Observer === 'function') {
			const observer = new Observer((entries) => {
				const entry = entries[0]
				if (!entry) return
				const next = Math.round(entry.contentRect.width)
				if (next && Math.abs(next - width) > 2) {
					width = next
					redraw()
				}
			})
			observer.observe(node)
			ctx?.onTeardown?.(() => observer.disconnect())
		}
		update(props)
		return { node, update }
	}
}

export default {
	chart: chartFactory(cartesian),
	'pie-chart': chartFactory(pie)
}

export { fmtNumber, niceTicks }
