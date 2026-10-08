/**
 * Per-session artifact registry: the object model behind "an artifact" — a
 * named, addressable, versioned document the model creates once and patches by
 * id afterwards. Kept in memory and scoped by session id; every revision also
 * rides the tool result, so rendering never depends on this registry being
 * alive (replay restores cards from the session log alone).
 * @module dsh-artifacts-live/registry
 */

import type { ArtifactMode } from './meta.ts'

/** One live artifact. */
export interface ArtifactRecord {
	id: string
	title: string
	html: string
	/** Monotonic revision, starting at 1. */
	version: number
	mode: ArtifactMode
	createdAt: number
	updatedAt: number
}

/** Fields supplied when an artifact is created. */
export interface ArtifactDraft {
	title: string
	html: string
	mode: ArtifactMode
}

/** Stable id alphabet: no lookalike characters, so a model can retype an id. */
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

/** One short id, unique inside the session. */
function mintId(taken: ReadonlySet<string>): string {
	for (;;) {
		const bytes = new Uint8Array(8)
		globalThis.crypto.getRandomValues(bytes)
		let id = 'art-'
		for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length]
		if (!taken.has(id)) return id
	}
}

/** Artifacts of every live session, keyed by session id. */
export class ArtifactRegistry {
	readonly #sessions = new Map<string, Map<string, ArtifactRecord>>()

	/** The session's artifact table, created on first use. */
	#table(sessionId: string): Map<string, ArtifactRecord> {
		let table = this.#sessions.get(sessionId)
		if (table === undefined) {
			table = new Map()
			this.#sessions.set(sessionId, table)
		}
		return table
	}

	/** Create one artifact and return its first revision. */
	create(sessionId: string, draft: ArtifactDraft): ArtifactRecord {
		const table = this.#table(sessionId)
		const now = Date.now()
		const record: ArtifactRecord = {
			id: mintId(new Set(table.keys())),
			title: draft.title,
			html: draft.html,
			version: 1,
			mode: draft.mode,
			createdAt: now,
			updatedAt: now
		}
		table.set(record.id, record)
		return record
	}

	/** One artifact, or undefined when the id is unknown to this session. */
	get(sessionId: string, id: string): ArtifactRecord | undefined {
		return this.#sessions.get(sessionId)?.get(id)
	}

	/** Every artifact of the session, oldest first. */
	list(sessionId: string): ArtifactRecord[] {
		const table = this.#sessions.get(sessionId)
		return table === undefined ? [] : [...table.values()].sort((left, right) => left.createdAt - right.createdAt)
	}

	/**
	 * Replace one artifact's source with the next revision.
	 * @param sessionId - owning session.
	 * @param id - artifact id.
	 * @param html - full source after the patch.
	 * @param title - optional new title; the old one is kept when omitted.
	 * @returns the updated record, or undefined when the id is unknown.
	 */
	revise(sessionId: string, id: string, html: string, title?: string): ArtifactRecord | undefined {
		const table = this.#sessions.get(sessionId)
		const current = table?.get(id)
		if (table === undefined || current === undefined) return undefined
		const next: ArtifactRecord = {
			...current,
			html,
			title: title === undefined || title.trim().length === 0 ? current.title : title.trim(),
			version: current.version + 1,
			updatedAt: Date.now()
		}
		table.set(id, next)
		return next
	}

	/** Drop one artifact. */
	destroy(sessionId: string, id: string): boolean {
		return this.#sessions.get(sessionId)?.delete(id) ?? false
	}

	/** Drop one session's whole table (session teardown). */
	forget(sessionId: string): void {
		this.#sessions.delete(sessionId)
	}

	/** Drop every table (plugin dispose). */
	clear(): void {
		this.#sessions.clear()
	}
}
