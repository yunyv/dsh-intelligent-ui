/**
 * The `artifact` tool view: a live, sandboxed preview inside the conversation.
 *
 * One frame per card, never remounted. While the model is still writing the
 * call, the partial source is pumped into the running frame over postMessage, so
 * markup appears as it arrives instead of the frame reloading on every delta.
 * When the call settles, the frame reloads once so the artifact's scripts run
 * against the finished document; every later `patch` whose scripts are unchanged
 * is reconciled into the live document, keeping the artifact's DOM, its input
 * values, and its in-memory variables.
 *
 * Ownership. Exactly one card per artifact carries the frame — the one that
 * created it, or the first one the transcript window still holds. Later `patch`
 * cards publish through the shared store and render a compact update row, so a
 * patch reaches the live frame instead of spawning a second preview.
 * @module dsh-intelligent-ui/client/ArtifactView
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
	COLLECT_MESSAGE,
	DATA_MESSAGE,
	HEIGHT_MESSAGE,
	STORAGE_MESSAGE,
	SYNC_MESSAGE,
	THEME_MESSAGE,
	artifactMetaFrom,
	asHtmlMeta,
	partialStringField,
	streamingMetaFromArgs,
	type ArtifactMeta,
	type ArtifactMetaHtml,
	type FrameMessage
} from '../meta.ts'
import { HEIGHT_CAP, HEIGHT_MIN, buildFrameDoc, resolveTheme } from './frame.ts'
import { artifactStore, panelOpener, sessionInput } from './store.ts'

/** Minimum gap between streamed reconciler pushes, in milliseconds. */
const PUMP_MS = 120

/** The slice of a tool-call node this view reads, across all three phases. */
export interface ArtifactBlock {
	kind?: string
	argsRaw?: string
	call?: { name?: string; argsRaw?: string } | null
	meta?: unknown
	content?: readonly { type?: string; text?: string }[]
	isError?: boolean
}

/** Props this view consumes from the `tool.call.toolview` seat. */
export interface ArtifactViewProps {
	callId: string
	phase: 'preparing' | 'start' | 'result'
	block: ArtifactBlock
	/** Injected by the slot from its declared hooks compartment. */
	useToolCallArgumentsPartial?: () => string
	/** Session input facade: the sanctioned way to hand data back to the model. */
	inputActions?: InputActions
}

const HEADER: React.CSSProperties = {
	display: 'flex',
	alignItems: 'baseline',
	gap: 8,
	flexWrap: 'wrap',
	fontSize: 12,
	opacity: 0.75,
	margin: '2px 0 6px'
}
const ACTION: React.CSSProperties = {
	font: 'inherit',
	fontSize: 11,
	padding: '2px 8px',
	borderRadius: 6,
	border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
	background: 'transparent',
	color: 'inherit',
	cursor: 'pointer'
}
const FRAME: React.CSSProperties = {
	display: 'block',
	width: '100%',
	border: 0,
	background: 'transparent',
	colorScheme: 'normal'
}

/** First line of a tool result's text content, for quiet rows. */
function firstLine(block: ArtifactBlock): string {
	for (const part of block.content ?? []) {
		if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
			const newline = part.text.indexOf('\n')
			return newline === -1 ? part.text : part.text.slice(0, newline)
		}
	}
	return 'artifact'
}

/** Whether the streamed arguments already say this call creates rather than patches. */
function looksLikeCreate(raw: string | undefined): boolean {
	const action = partialStringField(raw, 'action')
	if (action !== undefined) return action === 'create' || action.length === 0
	return partialStringField(raw, 'id') === undefined
}

/**
 * The `artifact` row in the tool process.
 *
 * It renders the artifact itself only while the call is running — the turn is
 * open then, so the reader watches the markup arrive. Once the call settles the
 * row goes compact: the artifact's frame belongs to the marker the model writes
 * in its answer (see `fence.tsx`), and the row keeps a way to reach the same
 * artifact in the right column or to preview it here instead.
 * @param props - the tool-call seat's props.
 * @returns the row.
 */
export function ArtifactView(props: ArtifactViewProps): React.ReactNode {
	const partial = props.useToolCallArgumentsPartial === undefined ? '' : props.useToolCallArgumentsPartial()
	const block = props.block
	const isResult = props.phase === 'result'
	const argsRaw = block.call?.argsRaw ?? block.argsRaw
	const meta = isResult && block.isError !== true
		? (artifactMetaFrom(block.meta) ?? streamingMetaFromArgs(argsRaw))
		: undefined

	// This row is the only place that receives the session input facade, and a
	// frame mounted from a fence outside any slot reads it from the store.
	useEffect(() => {
		if (props.inputActions !== undefined) sessionInput.current = props.inputActions
	}, [props.inputActions])

	// Publishing is what the fence and the panel read; it is silent here because
	// the row itself does not depend on the catalog.
	useEffect(() => {
		if (isResult && meta !== undefined) artifactStore.publish(meta)
	}, [isResult, meta?.id, meta?.version, meta?.action])

	// `isResult` marks the settled phase whatever the outcome; `meta` stays
	// undefined on a failed call so the row can show its error line instead of
	// pretending the artifact is still being written.
	if (isResult && (block.isError === true || meta === undefined)) return <QuietRow text={firstLine(block)} />
	if (isResult && meta !== undefined) {
		// A settled revision carries its payload in one of two shapes. This row only
		// knows how to frame the HTML one; a DIL revision is a compiled program whose
		// interface belongs to the marker the model writes in its answer, so the row
		// stays compact and points at the column instead.
		const settled = asHtmlMeta(meta)
		return settled === undefined ? <DilRow meta={meta} /> : <ArtifactRow meta={settled} />
	}

	const provisional = props.phase === 'preparing' ? streamingMetaFromArgs(partial) : streamingMetaFromArgs(argsRaw)
	const provisionalHtml = provisional === undefined ? undefined : asHtmlMeta(provisional)
	// A DIL document has no compiled program until the call settles, so there is
	// nothing to mount yet — the row says so instead of drawing an empty frame.
	if (provisional !== undefined && provisionalHtml === undefined) return <QuietRow text="GenUI · 正在生成界面…" />
	if (provisionalHtml === undefined) return <QuietRow text="Artifact · 生成中…" />
	if (!looksLikeCreate(argsRaw)) return <QuietRow text="Artifact · 正在修改…" />
	return (
		<ArtifactFrame
			callId={props.callId}
			meta={undefined}
			pumpHtml={provisionalHtml.html}
			inputActions={props.inputActions}
		/>
	)
}

/** A single quiet line, for failures and empty results. */
function QuietRow({ text }: { text: string }): React.ReactNode {
	return <div style={HEADER}>{text}</div>
}

/**
 * The settled row for a DIL revision: what the interface is, and where to open it.
 *
 * Unlike the HTML row there is nothing to preview inline: the compiled program's
 * interface is rendered at the marker the model wrote, and duplicating it here
 * would put two live copies of the same state on screen.
 * @param props - the revision this row reports.
 * @returns the row.
 */
function DilRow({ meta }: { meta: ArtifactMeta }): React.ReactNode {
	return (
		<div style={HEADER}>
			<span style={{ fontWeight: 500 }}>{meta.title}</span>
			<span>v{meta.version}</span>
			<span>· {meta.dil?.stateKeys.length ?? 0} 个控件状态</span>
			<span style={{ opacity: 0.55 }}>{meta.id}</span>
			<span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
				<button type="button" style={ACTION} onClick={() => panelOpener.current?.(meta.id)}>在侧栏打开</button>
			</span>
		</div>
	)
}

/**
 * The settled row: what the artifact is, and the two ways to open it.
 * @param props - the revision this row reports.
 * @returns the row.
 */
function ArtifactRow({ meta }: { meta: ArtifactMetaHtml }): React.ReactNode {
	const [preview, setPreview] = useState(false)
	return (
		<div>
			<div style={HEADER}>
				<span style={{ fontWeight: 500 }}>{meta.title}</span>
				<span>v{meta.version}</span>
				<span>· {meta.sizeBytes} 字节</span>
				<span style={{ opacity: 0.55 }}>{meta.id}</span>
				<span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
					<button type="button" style={ACTION} onClick={() => panelOpener.current?.(meta.id)}>在侧栏打开</button>
					<button type="button" style={ACTION} onClick={() => setPreview(value => !value)}>
						{preview ? '收起预览' : '在此预览'}
					</button>
				</span>
			</div>
			{preview && <ArtifactFrame callId={`row:${meta.id}`} meta={meta} inputActions={sessionInput.current} />}
		</div>
	)
}

/**
 * One artifact frame: sandbox, stream pump, height bridge, storage, adoption.
 * Exported because the turn tail renders the same frame when the tool process is
 * folded — the in-place card is inside the fold and therefore out of sight.
 */
export function ArtifactFrame({ callId, meta, pumpHtml, inputActions, onOpenPanel }: {
	callId: string
	meta: ArtifactMetaHtml | undefined
	/** Streamed source while the call is still running; absent on a settled frame. */
	pumpHtml?: string
	inputActions?: InputActions
	/** Expands this same artifact in the right column; absent inside the panel. */
	onOpenPanel?: (() => void) | undefined
}): React.ReactNode {
	const iframeRef = useRef<HTMLIFrameElement | null>(null)
	const storageRef = useRef<Record<string, string>>(meta === undefined ? {} : artifactStore.get(meta.id)?.storage ?? {})
	const adoptedRef = useRef<number>(meta?.version ?? 0)
	const sourceRef = useRef<ArtifactMeta | undefined>(meta)
	const pendingRef = useRef<((data: unknown) => void) | null>(null)
	const loadedRef = useRef(false)
	const pumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const lastPumpRef = useRef(0)

	const [theme, setTheme] = useState(() => resolveTheme())
	const themeRef = useRef(theme)
	themeRef.current = theme

	// The document is built once and rebuilt only for an explicit reload, so the
	// running frame survives every patch and every theme switch.
	const [frame, setFrame] = useState(() => ({
		html: meta?.html ?? '',
		title: meta?.title ?? 'Artifact',
		nonce: 0
	}))
	const doc = useMemo(() => buildFrameDoc({
		html: frame.html,
		title: frame.title,
		theme: themeRef.current,
		token: callId,
		seed: storageRef.current
	}), [frame.nonce, callId])

	sourceRef.current = artifactStore.get(meta?.id ?? '')?.meta ?? meta

	const pushToFrame = useCallback((message: Record<string, unknown>): boolean => {
		const frameElement = iframeRef.current
		if (frameElement?.contentWindow == null) return false
		frameElement.contentWindow.postMessage(message, '*')
		return true
	}, [])

	// Streamed markup: reconcile into the running document, throttled so a fast
	// token stream cannot queue more reconciliations than the frame can paint.
	useEffect(() => {
		if (pumpHtml === undefined || pumpHtml.length === 0) return
		const send = () => {
			lastPumpRef.current = Date.now()
			pushToFrame({ type: SYNC_MESSAGE, token: callId, html: pumpHtml })
		}
		const elapsed = Date.now() - lastPumpRef.current
		if (elapsed >= PUMP_MS) {
			send()
			return
		}
		if (pumpTimerRef.current !== null) clearTimeout(pumpTimerRef.current)
		pumpTimerRef.current = setTimeout(send, PUMP_MS - elapsed)
		return () => {
			if (pumpTimerRef.current !== null) clearTimeout(pumpTimerRef.current)
		}
	}, [pumpHtml, callId, pushToFrame])

	// Follow the host palette without reloading: repaint in place.
	useEffect(() => {
		const bump = () => setTheme(resolveTheme())
		const observer = new MutationObserver(bump)
		observer.observe(document.documentElement, { attributes: true })
		observer.observe(document.body, { attributes: true })
		// A host always provides matchMedia; a DOM without it still renders the
		// frame, it simply stops following the system scheme.
		const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined
		media?.addEventListener('change', bump)
		return () => {
			observer.disconnect()
			media?.removeEventListener('change', bump)
		}
	}, [])

	useEffect(() => {
		pushToFrame({ type: THEME_MESSAGE, token: callId, vars: theme.vars, scheme: theme.scheme })
	}, [theme, callId, pushToFrame])

	// Adopt later revisions: reconcile in place when nothing re-runnable changed,
	// otherwise reload with the storage snapshot the frame reported. This is also
	// what loads the finished document when a streamed card settles.
	useEffect(() => {
		if (meta === undefined) return
		return artifactStore.subscribe(meta.id, (state) => {
			if (state === undefined) return
			if (state.meta.version <= adoptedRef.current) return
			// This frame renders the HTML path only. A revision that arrives on the
			// other path is a different artifact's problem, not this frame's.
			const settled = asHtmlMeta(state.meta)
			if (settled === undefined) return
			adoptedRef.current = settled.version
			if (settled.render === 'reconcile' && loadedRef.current
				&& pushToFrame({ type: SYNC_MESSAGE, token: callId, html: settled.html })) {
				return
			}
			storageRef.current = artifactStore.get(settled.id)?.storage ?? storageRef.current
			setFrame(current => ({ html: settled.html, title: settled.title, nonce: current.nonce + 1 }))
		})
	}, [meta?.id, callId, pushToFrame])

	// Frame traffic, addressed by source so a sibling card can never drive this frame.
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const frameElement = iframeRef.current
			if (frameElement === null || event.source !== frameElement.contentWindow) return
			const message = event.data as FrameMessage | null
			if (message === null || typeof message !== 'object' || message.token !== callId) return
			if (message.type === HEIGHT_MESSAGE) {
				if (typeof message.height !== 'number' || !Number.isFinite(message.height)) return
				loadedRef.current = true
				const mode = sourceRef.current?.mode ?? 'inline'
				setHeight(Math.max(HEIGHT_MIN, Math.min(Math.ceil(message.height), HEIGHT_CAP[mode])))
				return
			}
			if (message.type === STORAGE_MESSAGE) {
				if (message.store !== 'local' || message.entries === undefined) return
				storageRef.current = message.entries
				const id = sourceRef.current?.id
				if (id !== undefined) artifactStore.rememberStorage(id, message.entries)
				return
			}
			if (message.type === DATA_MESSAGE) {
				const resolve = pendingRef.current
				pendingRef.current = null
				if (resolve !== null) resolve(message.data)
			}
		}
		window.addEventListener('message', onMessage)
		return () => window.removeEventListener('message', onMessage)
	}, [callId])

	const [height, setHeight] = useState(HEIGHT_MIN)
	const [busy, setBusy] = useState(false)
	const [notice, setNotice] = useState<string | null>(null)

	/** Ask the frame for the user's interaction and hand it to the session input. */
	const submitInteraction = useCallback(() => {
		const source = sourceRef.current
		if (source === undefined) return
		if (inputActions === undefined) {
			setNotice('这个会话没有可用的输入通道')
			return
		}
		setBusy(true)
		setNotice(null)
		const timer = setTimeout(() => {
			if (pendingRef.current === null) return
			pendingRef.current = null
			setBusy(false)
			setNotice('artifact 未在 2 秒内响应采集请求')
		}, 2000)
		pendingRef.current = (data) => {
			clearTimeout(timer)
			const span = inputActions.captureInsertion()
			const inserted = inputActions.insertText(interactionReport(source, data), span)
			if (!inserted) {
				setBusy(false)
				setNotice('插入被拒绝：草稿已变化，请重试')
				return
			}
			inputActions.submit()
			setBusy(false)
			setNotice('已把交互数据发回会话')
		}
		if (!pushToFrame({ type: COLLECT_MESSAGE, token: callId, id: source.id })) {
			clearTimeout(timer)
			pendingRef.current = null
			setBusy(false)
			setNotice('预览还没准备好')
		}
	}, [inputActions, callId, pushToFrame])

	/** Keep the rendered source for a user who wants it outside the app. */
	const exportHtml = useCallback(() => {
		const html = buildFrameDoc({
			html: sourceRef.current?.html ?? '',
			title: sourceRef.current?.title ?? 'Artifact',
			theme: themeRef.current,
			token: callId,
			seed: storageRef.current
		})
		const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
		const anchor = document.createElement('a')
		anchor.href = url
		anchor.download = `${(sourceRef.current?.title ?? 'artifact').replaceAll(/[^\p{L}\p{N}_-]+/gu, '-').replaceAll(/^-|-$/gu, '') || 'artifact'}.html`
		anchor.click()
		setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
	}, [callId])

	const copySource = useCallback(() => {
		void navigator.clipboard.writeText(sourceRef.current?.html ?? '')
		setNotice('源码已复制')
	}, [])

	const title = sourceRef.current?.title ?? 'Artifact'
	const id = sourceRef.current?.id
	const version = sourceRef.current?.version

	return (
		<div>
			<div style={HEADER}>
				<span style={{ fontWeight: 500 }}>{title}</span>
				{version !== undefined && <span style={{ opacity: 0.7 }}>v{version}</span>}
				{id !== undefined && <span style={{ opacity: 0.55 }}>{id}</span>}
				{version === undefined && <span style={{ opacity: 0.7 }}>生成中…</span>}
				<span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
					{onOpenPanel !== undefined && (
						<button type="button" style={ACTION} onClick={onOpenPanel}>在侧栏打开</button>
					)}
					<button type="button" style={ACTION} disabled={busy || version === undefined} onClick={submitInteraction}>
						{busy ? '提交中…' : '提交交互数据'}
					</button>
					<button type="button" style={ACTION} onClick={copySource}>复制源码</button>
					<button type="button" style={ACTION} onClick={exportHtml}>导出 HTML</button>
				</span>
			</div>
			{notice !== null && <div style={{ ...HEADER, opacity: 0.65 }}>{notice}</div>}
			<iframe
				ref={iframeRef}
				sandbox="allow-scripts allow-modals"
				referrerPolicy="no-referrer"
				title={title}
				srcDoc={doc}
				style={{ ...FRAME, height }}
			/>
		</div>
	)
}

/** The message a submitted interaction becomes in the conversation. */
export function interactionReport(meta: ArtifactMeta, data: unknown): string {
	const body = JSON.stringify(data ?? null, null, 2)
	return [
		`我在 artifact「${meta.title}」（${meta.id}，v${meta.version}）里的交互数据：`,
		'',
		'```json',
		body.length > 12_000 ? `${body.slice(0, 12_000)}\n… (截断)` : body,
		'```',
		'',
		'请据此继续。'
	].join('\n')
}
