/**
 * Migration into the durable store.
 *
 * The old `src/registry.ts` table lived in process memory, so there is no
 * history to replay: a record handed here becomes version 1 of its artifact,
 * and everything the *disk* already knows wins over what memory remembers.
 * That is the rule that matters after a restart — when an artifact of the same
 * id (or, failing that, the same title inside the same session) already exists,
 * this continues it instead of minting a look-alike the model can never patch
 * again.
 * @module dsh-intelligent-ui/store/migrate
 */

import type { ArtifactMode } from '../meta.ts'
import type { ArtifactRecord } from './types.ts'
import type { ArtifactStore } from './store.ts'

/**
 * Structural mirror of `src/registry.ts`'s `ArtifactRecord`.
 *
 * Declared structurally rather than imported so the durable store never depends
 * on the in-memory registry, which is scheduled to disappear.
 */
export interface LegacyArtifactRecord {
	id: string
	title: string
	html: string
	version: number
	mode: ArtifactMode
	createdAt: number
	updatedAt: number
}

/** What one legacy record turned into. */
export interface ImportOutcome {
	id: string
	/**
	 * - `imported` — written to disk as version 1 for the first time.
	 * - `reused` — this id was already on disk; the disk head was kept.
	 * - `adopted` — another artifact of the same session and title was on disk;
	 *   that one was returned so later patches address a single artifact.
	 */
	action: 'imported' | 'reused' | 'adopted'
	/** Head of the artifact the caller must now address. */
	record: ArtifactRecord
}

/** Options for {@link importLegacyRecords}. */
export interface ImportOptions {
	/** Session the legacy records belonged to. */
	sessionId?: string
	/** Changelog recorded on freshly imported version 1. */
	changelog?: string
}

/**
 * Persist in-memory registry records, idempotently.
 *
 * Safe to call on every plugin start: a record already on disk is reused, never
 * duplicated and never rewound. A legacy record's own `version` number is *not*
 * replayed — only its newest `html` survives, so it lands as version 1 and every
 * later patch appends on top of it.
 * @param store - target store.
 * @param records - legacy records, in any order.
 * @param options - session and changelog.
 * @returns one outcome per input record, in input order.
 */
export function importLegacyRecords(store: ArtifactStore, records: readonly LegacyArtifactRecord[], options: ImportOptions = {}): ImportOutcome[] {
	return records.map(record => ensureArtifact(store, record, options))
}

/**
 * Persist one in-memory record, continuing an existing artifact when the disk
 * already holds it.
 *
 * Resolution order — the whole point of the "continue, don't duplicate" rule:
 * 1. same id on disk → `reused`,
 * 2. same title in the same session on disk → `adopted`,
 * 3. otherwise → `imported` as version 1, preserving the legacy creation time.
 * @param store - target store.
 * @param record - legacy record.
 * @param options - session and changelog.
 */
export function ensureArtifact(store: ArtifactStore, record: LegacyArtifactRecord, options: ImportOptions = {}): ImportOutcome {
	const existing = store.get(record.id)
	if (existing !== undefined) return { id: existing.id, action: 'reused', record: existing }
	const twin = store.findByTitle(options.sessionId, record.title)
	if (twin !== undefined) {
		const adopted = store.get(twin.id)
		if (adopted !== undefined) return { id: adopted.id, action: 'adopted', record: adopted }
	}
	const created = store.create({
		id: record.id,
		...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
		title: record.title,
		source: record.html,
		mode: record.mode,
		changelog: options.changelog ?? 'imported from the in-memory registry',
		createdAt: record.createdAt
	})
	return { id: created.id, action: 'imported', record: created }
}
