/**
 * Host components — PascalCase tags the model can reference but not define.
 *
 * The compiler stamps each occurrence with `__resolutionId`; the server ships the
 * outcome in `appData.opGenui.componentResults[id] = { status, componentName }`.
 * A host widget mounts only when that indirection says `resolved` *and* the name is
 * registered here — the model cannot name its way into an arbitrary component.
 * Anything else renders a quiet placeholder.
 * @module dsh-genui/client/dil/renderer/components/host
 */

import type { DilContext, DilHandle, DilProps } from '../../types.ts'
import { el, esc } from '../dom.ts'
import { iconSvg } from '../icons.ts'

/** A registered host widget: props plus the compiler's resolution record. */
export type HostFactory = (props: DilProps, result: unknown) => DilHandle

const HOST: Record<string, HostFactory> = {
	MemoryCite() {
		const node = el('span', 'dil-memory-cite')
		node.innerHTML = iconSvg('sparkles', 12) + '<span>记忆</span>'
		node.title = '这段回答引用了已保存的记忆'
		node.setAttribute('role', 'note')
		return { node, update() {} }
	}
}

/** Register one host widget under its PascalCase tag. */
export function defineHost(name: string, factory: HostFactory): void {
	HOST[name] = factory
}

/**
 * Mount a host tag, or the placeholder that says why it is not there.
 * @param tag - the PascalCase tag the tree asked for.
 * @param props - its props, including `__resolutionId`.
 * @param ctx - patcher context, carrying the compiler's `componentResults`.
 */
export function createHostComponent(tag: string, props: DilProps, ctx: DilContext): DilHandle {
	const id = props && props.__resolutionId
	const result = id && ctx.componentResults ? ctx.componentResults[String(id)] : null
	const factory = HOST[tag]
	if (factory && result && result.status === 'resolved' && result.componentName === tag) {
		const handle = factory(props, result)
		handle.node.setAttribute('data-d-resolution', String(id))
		return handle
	}
	ctx.onMissingComponent?.(tag, result)
	const node = el('div', 'dil-widget dil-widget-unresolved')
	node.innerHTML =
		`<span class="dil-widget-icon">${iconSvg('layers', 16)}</span>`
		+ `<span class="dil-widget-body"><b>${esc(tag)}</b><small>${result ? '组件状态：' + esc(result.status) : '宿主未提供该组件'}</small></span>`
	return { node, update() {} }
}
