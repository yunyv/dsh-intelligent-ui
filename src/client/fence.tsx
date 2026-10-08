/**
 * Fence channel: the position of an artifact inside the conversation.
 *
 * A finished turn folds its tool process, so a card rendered at the tool call is
 * out of sight by default — and no plugin seat can reach into that fold. The
 * assistant's own answer text is the one part of a finished turn that is always
 * in view, so the model marks where an artifact belongs by writing a fenced
 * marker there:
 *
 * ````md
 * ```dsh-artifact
 * art-at8dcaa7
 * ```
 * ````
 *
 * The block is the artifact's id, never its source: the source keeps travelling
 * through the tool result, which is what makes an artifact patchable and keeps a
 * megabyte of markup out of the answer text. This module finds such a block in
 * the rendered answer, hides it, and mounts the artifact's full frame in its
 * place, so one artifact is one frame that the reader meets exactly where the
 * model put it.
 *
 * The surface is the platform's own code block — `div.md-code-block`, with the
 * fence language in its `[data-code-block-banner]` — read from the rendered DOM
 * because this version exposes no fence-renderer seat. A block whose language is
 * unknown but whose first line names the fence is accepted too, so the channel
 * survives a host that stops publishing the info string.
 * @module dsh-genui/client/fence
 */

import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import type { ArtifactMeta } from '../meta.ts'
import { ArtifactFrame } from './ArtifactView.tsx'
import { artifactStore, panelOpener, sessionInput } from './store.ts'

/** Fence language that claims an artifact position. */
export const ARTIFACT_FENCE = 'dsh-artifact'

/** Marker-shaped id: what the tool hands out. */
const ARTIFACT_ID = /^art-[a-z0-9]{4,}$/u

/** The platform's code-block surface, stable across the shipped renderers. */
const CODE_BLOCK = 'div.md-code-block'

/** What one rendered code block says. */
export interface FenceReading {
	lang: string
	body: string
}

/**
 * Read the fence language and body out of one rendered code block.
 * @param block - a rendered code block element.
 * @returns the info string and the block's source text.
 */
export function readFence(block: Element): FenceReading {
	const banner = block.querySelector('[data-code-block-banner]')
	const info = banner?.textContent ?? ''
	const pre = block.querySelector('pre')
	return { lang: info.trim().split('\n')[0]?.trim() ?? '', body: pre?.textContent ?? '' }
}

/**
 * The artifact id a code block claims, or undefined when it is not a marker.
 *
 * Three shapes are accepted, in falling order of explicitness:
 *
 * 1. the block's fence language is the artifact fence;
 * 2. the block's first line names the fence — `dsh-artifact art-xxxxxxxx`;
 * 3. the block's first line **is** a marker-shaped id.
 *
 * (3) is what this build needs: its markdown renderer maps every language it does
 * not know to a localized label, so `dsh-artifact` never reaches the DOM and the
 * info string carries no information at all. Shape alone is weak, so a caller
 * must still find the id among known artifacts before claiming the block — which
 * also leaves the protocol's own examples rendering as code.
 * @param lang - the block's fence language, when the host publishes one.
 * @param body - the block's source text.
 * @returns the claimed artifact id, when there is one.
 */
export function markerIdOf(lang: string, body: string): string | undefined {
	const first = body.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? ''
	const head = first.split(/\s+/u)[0] ?? ''
	if (lang.toLowerCase() === ARTIFACT_FENCE) return ARTIFACT_ID.test(head) ? head : undefined
	if (head === ARTIFACT_FENCE) {
		const claimed = first.split(/\s+/u)[1]
		return claimed !== undefined && ARTIFACT_ID.test(claimed) ? claimed : undefined
	}
	return ARTIFACT_ID.test(head) ? head : undefined
}

/** The artifact id a rendered code block claims. */
export function markedId(block: Element): string | undefined {
	const { lang, body } = readFence(block)
	return markerIdOf(lang, body)
}

/** One artifact frame mounted in place of a marker block. */
function FenceCard({ id }: { id: string }): React.ReactNode {
	const [meta, setMeta] = useState<ArtifactMeta | undefined>(() => artifactStore.get(id)?.meta)
	useEffect(() => {
		const current = artifactStore.get(id)
		if (current !== undefined) setMeta(current.meta)
		return artifactStore.subscribe(id, (state) => {
			if (state !== undefined) setMeta(state.meta)
		})
	}, [id])
	return (
		<ArtifactFrame
			callId={`fence:${id}`}
			meta={meta}
			inputActions={sessionInput.current}
			onOpenPanel={panelOpener.current === undefined ? undefined : () => panelOpener.current?.(id)}
		/>
	)
}

/** How a claimed block becomes a frame; injectable so tests can observe mounts. */
export type FenceMount = (host: HTMLElement, id: string) => () => void

/** Mount a live React frame in the host element. */
export const reactFenceMount: FenceMount = (host, id) => {
	const root = createRoot(host)
	root.render(<FenceCard id={id} />)
	return () => { root.unmount() }
}

/** One claimed block. */
interface Claim {
	host: HTMLElement
	id: string
	dispose: () => void
}

/**
 * Watches the rendered transcript for artifact markers and mounts each one's
 * frame in place of its block.
 */
export class FenceChannel {
	readonly #claims = new Map<Element, Claim>()
	readonly #mount: FenceMount
	readonly #observe: ParentNode
	#observer: MutationObserver | null = null
	#unsubscribe: (() => void) | undefined
	#scheduled = false
	#poll: ReturnType<typeof setInterval> | null = null

	/**
	 * @param mount - how a claimed block becomes a frame.
	 * @param observe - subtree to watch; the whole document by default.
	 */
	constructor(mount: FenceMount = reactFenceMount, observe: ParentNode = document) {
		this.#mount = mount
		this.#observe = observe
	}

	/** Claim every marker currently rendered and follow later ones. */
	start(): void {
		this.scan()
		this.#unsubscribe = artifactStore.subscribeAll(() => { this.scan() })
		const target = this.#observe === document ? document.body : this.#observe
		if (target === null) {
			// A cold start can apply plugins before the document has a body; the
			// channel then waits for one instead of silently never observing.
			document.addEventListener('DOMContentLoaded', () => { this.start() }, { once: true })
			return
		}
		// Element additions only: a marker arrives as a rendered block, and the
		// transcript mutates constantly while a turn streams. Scans are coalesced
		// onto a frame so a busy DOM cannot turn into a scan storm.
		this.#observer = new MutationObserver(() => {
			if (this.#scheduled) return
			this.#scheduled = true
			const run = () => {
				this.#scheduled = false
				this.scan()
			}
			if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
			else setTimeout(run, 16)
		})
		this.#observer.observe(target, { childList: true, subtree: true })
		// The observer is not enough on its own: a cold start renders the transcript
		// in one burst and the store fills from effects just after it, so the single
		// scan that could have matched both a marker and its artifact is exactly the
		// one a coalesced frame callback can drop. This poll makes claiming
		// independent of that timing — which is what lets the channel work with no
		// host seat at all.
		this.#poll = setInterval(() => {
			if (document.visibilityState === 'hidden') return
			this.scan()
		}, 1000)
	}

	/** Release every frame and stop watching. */
	stop(): void {
		if (this.#poll !== null) clearInterval(this.#poll)
		this.#poll = null
		this.#unsubscribe?.()
		this.#unsubscribe = undefined
		this.#observer?.disconnect()
		this.#observer = null
		for (const claim of this.#claims.values()) claim.dispose()
		this.#claims.clear()
	}

	/** How many markers are currently claimed, for diagnostics and tests. */
	get claimed(): number {
		return this.#claims.size
	}

	/**
	 * Claim newly rendered markers and forget blocks the transcript dropped.
	 *
	 * A block is claimed only once the artifact is known, so a marker for an id
	 * this page has not seen — a transcript replayed without its tool results —
	 * keeps rendering as code instead of claiming an empty frame.
	 */
	scan(): void {
		for (const [block, claim] of this.#claims) {
			if (claim.host.isConnected && block.isConnected) continue
			claim.dispose()
			this.#claims.delete(block)
		}
		for (const block of this.#observe.querySelectorAll(CODE_BLOCK)) {
			if (this.#claims.has(block)) continue
			const id = markedId(block)
			if (id === undefined || artifactStore.get(id) === undefined) continue
			const host = block.ownerDocument.createElement('div')
			host.setAttribute('data-dsh-artifact', id)
			block.parentNode?.insertBefore(host, block)
			if (block instanceof HTMLElement) block.style.display = 'none'
			this.#claims.set(block, { host, id, dispose: this.#mount(host, id) })
		}
	}
}
