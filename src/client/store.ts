/**
 * Browser-side artifact store: the shared, page-local view of every artifact
 * revision the transcript has published, plus the storage snapshot each
 * artifact's frame reported.
 *
 * It exists so one artifact renders exactly once. The card that created an
 * artifact owns the live frame and adopts later revisions in place through this
 * store; a `patch` card renders a compact update row instead of a second frame,
 * so patching never spawns a duplicate preview and never reloads the frame that
 * already holds the user's state.
 *
 * Publishing is split so cards can settle ownership during render (React renders
 * a whole commit before any effect runs, and transcript order is render order):
 * {@link ArtifactStore.publishQuiet} records the revision silently, and
 * {@link ArtifactStore.notify} delivers it from an effect.
 * @module dsh-artifacts-live/client/store
 */

import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ArtifactMeta } from '../meta.ts'

/** Latest revision known for one artifact. */
export interface ArtifactState {
	meta: ArtifactMeta
	/** The artifact's own storage snapshot, replayed into a reloaded frame. */
	storage: Record<string, string>
}

/** Listener invoked when an artifact's state changes or the catalog changes. */
export type ArtifactListener = (state?: ArtifactState) => void

/** Page-local registry keyed by artifact id. */
export class ArtifactStore {
	readonly #states = new Map<string, ArtifactState>()
	readonly #listeners = new Map<string, Set<ArtifactListener>>()
	readonly #global = new Set<ArtifactListener>()
	#focused: string | null = null

	/**
	 * Record one revision without notifying anyone. Older versions never
	 * overwrite a newer one, so replay settles on the highest version no matter
	 * how the transcript window is assembled.
	 * @param meta - the revision as the tool result carried it.
	 * @returns the state in force after the call.
	 */
	publishQuiet(meta: ArtifactMeta): ArtifactState {
		const known = this.#states.get(meta.id)
		if (known !== undefined && known.meta.version > meta.version) return known
		const next: ArtifactState = { meta, storage: known?.storage ?? {} }
		this.#states.set(meta.id, next)
		return next
	}

	/**
	 * Deliver one artifact's current state to its listeners and to the catalog.
	 * @param id - artifact id.
	 */
	notify(id: string): void {
		const state = this.#states.get(id)
		if (state === undefined) return
		for (const listener of this.#listeners.get(id) ?? []) listener(state)
		for (const listener of this.#global) listener(state)
	}

	/** Record and deliver in one step, for callers outside a render pass. */
	publish(meta: ArtifactMeta): ArtifactState {
		const state = this.publishQuiet(meta)
		this.notify(meta.id)
		return state
	}

	/** The revision in force, or undefined when the page has not seen the artifact. */
	get(id: string): ArtifactState | undefined {
		return this.#states.get(id)
	}

	/** Every artifact the page knows, newest revision first. */
	list(): ArtifactState[] {
		return [...this.#states.values()].sort((left, right) => right.meta.version - left.meta.version)
	}

	/** Subscribe to one artifact's revisions. */
	subscribe(id: string, listener: ArtifactListener): () => void {
		let set = this.#listeners.get(id)
		if (set === undefined) {
			set = new Set()
			this.#listeners.set(id, set)
		}
		set.add(listener)
		return () => {
			set.delete(listener)
			if (set.size === 0) this.#listeners.delete(id)
		}
	}

	/** Subscribe to any artifact's revisions, for a catalog view. */
	subscribeAll(listener: ArtifactListener): () => void {
		this.#global.add(listener)
		return () => {
			this.#global.delete(listener)
		}
	}

	/**
	 * Remember what one artifact's frame wrote to its storage, so a later reload
	 * can replay it.
	 * @param id - artifact id.
	 * @param entries - the frame's full storage map.
	 */
	rememberStorage(id: string, entries: Record<string, string>): void {
		const known = this.#states.get(id)
		if (known === undefined) return
		known.storage = entries
	}

	/**
	 * Point the right column at one artifact.
	 *
	 * A frame inside the conversation and the column are two views of one
	 * artifact, so opening the column from a frame also selects it there.
	 * @param id - artifact id.
	 */
	focus(id: string): void {
		this.#focused = id
		for (const listener of this.#global) listener(this.#states.get(id))
	}

	/** The artifact the column was last pointed at, when any. */
	focused(): string | null {
		return this.#focused
	}

	/** Forget one artifact (the model destroyed it). */
	forget(id: string): void {
		this.#states.delete(id)
		for (const listener of this.#global) listener()
	}
}

/** The single page-local store every card and the panel share. */
export const artifactStore = new ArtifactStore()

/**
 * The session input facade the tool view was rendered with.
 *
 * A frame mounted from a fence outside any slot has no slot props, so it reads
 * the facade from here instead; the tool view is always rendered in the same
 * session, and it records the facade as it renders.
 */
export const sessionInput: { current: InputActions | undefined } = { current: undefined }

/**
 * Opens one artifact in the right column, set by the browser half once the
 * sidebar services are known. A frame calls it when the reader asks to expand
 * the artifact it already sees inline.
 */
export const panelOpener: { current: ((id: string) => void) | undefined } = { current: undefined }
