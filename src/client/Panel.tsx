/**
 * The right-column Artifacts panel: every artifact this session has produced,
 * with the selected one rendered live. It is the persistent home an artifact
 * keeps after its card has scrolled away, and it adopts later revisions through
 * the same shared store the cards use.
 * @module dsh-genui/client/Panel
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HEIGHT_MESSAGE, STORAGE_MESSAGE, asDilMeta, asHtmlMeta, type ArtifactMetaHtml, type FrameMessage } from '../meta.ts'
import { dilStateOf, publishDilState, subscribeDilState } from './dil-state.ts'
import { mountDilView } from './dil/mount.ts'
import type { DilCompiled, DilMountHandle } from './dil/types.ts'
import { buildFrameDoc, resolveTheme } from './frame.ts'
import { artifactStore, type ArtifactState } from './store.ts'

/** Props the panel reads from its sidebar seat. */
export interface ArtifactPanelProps {
	/** Session this tab belongs to; artifacts of other sessions are hidden. */
	sessionId?: string
}

/** Ceiling for the panel preview, which lives in a full-height column. */
const PANEL_MAX_HEIGHT = 4000

/** The artifact catalog and its live preview. */
export function ArtifactPanel(props: ArtifactPanelProps): React.ReactNode {
	const [, setTick] = useState(0)
	const [selected, setSelected] = useState<string | null>(null)

	useEffect(() => artifactStore.subscribeAll(() => { setTick(value => value + 1) }), [])

	const rows = useMemo(() => {
		const all = artifactStore.list()
		if (props.sessionId === undefined) return all
		return all.filter(state => state.meta.session === undefined || state.meta.session === props.sessionId)
	}, [props.sessionId, artifactStore.list().length, selected])

	// A frame's 「在侧栏打开」 points the column here; the reader's own click wins.
	const active = rows.find(state => state.meta.id === (selected ?? artifactStore.focused())) ?? rows[0]

	if (rows.length === 0) {
		return (
			<div style={{ padding: '14px 12px', fontSize: 12, opacity: 0.6, lineHeight: 1.6 }}>
				这个会话还没有 artifact。
				<br />
				让模型做一个可交互的页面、图表或模拟器，它就会出现在这里，并随每次修改原地更新。
			</div>
		)
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 10px 12px' }}>
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
				{rows.map(state => {
					const current = state.meta.id === active?.meta.id
					return (
						<button
							key={state.meta.id}
							type="button"
							onClick={() => setSelected(state.meta.id)}
							style={{
								font: 'inherit',
								fontSize: 11,
								padding: '3px 8px',
								borderRadius: 6,
								cursor: 'pointer',
								border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
								background: current ? 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.14))' : 'transparent',
								color: 'inherit',
								maxWidth: 200,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap'
							}}
							title={`${state.meta.title} · ${state.meta.id}`}
						>
							{state.meta.title} · v{state.meta.version}
						</button>
					)
				})}
			</div>
			{active !== undefined && <PanelSlot state={active} />}
		</div>
	)
}

/** The panel's preview area: a live frame for an HTML revision, a live interface for a DIL one. */
function PanelSlot({ state }: { state: ArtifactState }): React.ReactNode {
	const html = asHtmlMeta(state.meta)
	if (html !== undefined) return <PanelFrame key={state.meta.id} state={{ ...state, meta: html }} />
	const compiled = asDilMeta(state.meta)?.dil
	if (compiled === undefined) return null
	return <PanelDil key={state.meta.id} id={state.meta.id} compiled={compiled} />
}

/**
 * One live DIL interface inside the panel.
 *
 * This is the column's copy of what the conversation card is showing, and it holds
 * the same state: a control moved here moves there. The two are views of one
 * interface rather than two interfaces, which is the whole claim of giving a
 * generated surface a home in a column.
 * @param props - the artifact to mount and its compiled program.
 * @returns the host element the interface renders into.
 */
function PanelDil({ id, compiled }: { id: string, compiled: DilCompiled }): React.ReactNode {
	const hostRef = useRef<HTMLDivElement | null>(null)
	const handleRef = useRef<DilMountHandle | null>(null)
	const ready = compiled.code.length > 0

	useEffect(() => {
		const host = hostRef.current
		if (host === null || !ready) return
		const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
		const adopt = (next: Record<string, unknown>): void => { handleRef.current?.setState(next) }
		const handle = mountDilView(shadow, {
			onStateChange: (next) => { publishDilState(id, next, adopt) },
			// The mount already forwards the event into its own sandbox, which is what
			// makes this copy respond; nothing here needs to observe it.
			onEvent: () => {},
			appData: compiled.appData
		})
		handleRef.current = handle
		const unsubscribe = subscribeDilState(id, adopt)
		const opening = dilStateOf(id)
		if (Object.keys(opening).length > 0) handle.setState(opening)
		return () => {
			unsubscribe()
			handle.destroy()
			handleRef.current = null
		}
		// A new revision of the same document is pushed through update, not a rebuild.
	}, [id, ready])

	useEffect(() => {
		if (ready) handleRef.current?.update(compiled)
	}, [compiled, ready])

	return <div ref={hostRef} style={{ minHeight: 160 }} />
}

/** Artifact state whose payload is known to belong to the HTML path. */
type HtmlArtifactState = Omit<ArtifactState, 'meta'> & { meta: ArtifactMetaHtml }

/** One live HTML artifact preview inside the panel. */
function PanelFrame({ state }: { state: HtmlArtifactState }): React.ReactNode {
	const iframeRef = useRef<HTMLIFrameElement | null>(null)
	const storageRef = useRef<Record<string, string>>(state.storage)
	const adoptedRef = useRef<number>(state.meta.version)
	const sourceRef = useRef(state.meta)
	const [theme, setTheme] = useState(() => resolveTheme())
	const [generation, setGeneration] = useState(0)
	const [height, setHeight] = useState(240)

	sourceRef.current = asHtmlMeta(artifactStore.get(state.meta.id)?.meta ?? state.meta) ?? sourceRef.current
	const themeRef = useRef(theme)
	themeRef.current = theme

	const doc = useMemo(() => buildFrameDoc({
		html: sourceRef.current.html,
		title: sourceRef.current.title,
		theme: themeRef.current,
		token: sourceRef.current.id,
		seed: storageRef.current
	}), [generation, state.meta.id])

	useEffect(() => {
		const bump = () => setTheme(resolveTheme())
		const observer = new MutationObserver(bump)
		observer.observe(document.documentElement, { attributes: true })
		observer.observe(document.body, { attributes: true })
		return () => observer.disconnect()
	}, [])

	// A later revision reloads the panel frame; the panel is a viewer, so keeping
	// the artifact's storage snapshot is enough continuity.
	useEffect(() => artifactStore.subscribe(state.meta.id, (next) => {
		if (next === undefined) return
		if (next.meta.version <= adoptedRef.current) return
		adoptedRef.current = next.meta.version
		storageRef.current = artifactStore.get(state.meta.id)?.storage ?? storageRef.current
		setGeneration(value => value + 1)
	}), [state.meta.id])

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const frame = iframeRef.current
			if (frame === null || event.source !== frame.contentWindow) return
			const message = event.data as FrameMessage | null
			if (message === null || typeof message !== 'object' || message.token !== sourceRef.current.id) return
			if (message.type === HEIGHT_MESSAGE && typeof message.height === 'number' && Number.isFinite(message.height)) {
				setHeight(Math.max(120, Math.min(Math.ceil(message.height), PANEL_MAX_HEIGHT)))
				return
			}
			if (message.type === STORAGE_MESSAGE && message.store === 'local' && message.entries !== undefined) {
				storageRef.current = message.entries
				artifactStore.rememberStorage(sourceRef.current.id, message.entries)
			}
		}
		window.addEventListener('message', onMessage)
		return () => window.removeEventListener('message', onMessage)
	}, [])

	const openSource = useCallback(() => {
		void navigator.clipboard.writeText(sourceRef.current.html)
	}, [])

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
			<div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11, opacity: 0.7, flexWrap: 'wrap' }}>
				<span style={{ fontWeight: 500 }}>{state.meta.title}</span>
				<span>v{state.meta.version}</span>
				<span style={{ opacity: 0.7 }}>{state.meta.sizeBytes} 字节</span>
				<button
					type="button"
					onClick={openSource}
					style={{
						marginLeft: 'auto',
						font: 'inherit',
						fontSize: 11,
						padding: '2px 8px',
						borderRadius: 6,
						cursor: 'pointer',
						border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))',
						background: 'transparent',
						color: 'inherit'
					}}
				>
					复制源码
				</button>
			</div>
			<iframe
				ref={iframeRef}
				sandbox="allow-scripts allow-modals"
				referrerPolicy="no-referrer"
				title={state.meta.title}
				srcDoc={doc}
				style={{ display: 'block', width: '100%', border: 0, background: 'transparent', colorScheme: 'normal', height }}
			/>
		</div>
	)
}
