/**
 * The persisted artifact model: an append-only chain of immutable versions on
 * disk, plus the lightweight catalog entry the index carries so listing never
 * has to touch version content.
 *
 * Semantics follow `coda0HQ/open-artifacts` (MIT): every write appends exactly
 * one version and never rewrites history; `restore` mints a *new* head instead
 * of moving a pointer; a caller that passes `expectedLatestVersion` is refused
 * when the head moved underneath it; any version stays readable as `?v=N`.
 *
 * Pure types: no node builtins, so this module is safe to import from either
 * half of the plugin.
 * @module dsh-genui/store/types
 */

import type { ArtifactEngine, ArtifactMode, ArtifactRender } from '../meta.ts'

/** What produced one version. Every version records its own provenance. */
export type ArtifactAction = 'create' | 'patch' | 'append' | 'restore'

/** One immutable revision, without its content. */
export interface ArtifactVersionMeta {
	/** Owning artifact id. */
	id: string
	/** 1-based, contiguous, never reused. Equals the record's `version` at head. */
	versionNumber: number
	/** Stable id of this revision: `"<id>#<versionNumber>"`. */
	versionId: string
	/** The revision this one was appended on top of; `null` for version 1. */
	parentVersionId: string | null
	/** Lowercase hex sha256 of the content's exact UTF-8 bytes. */
	contentSha256: string
	/** Content length in UTF-8 bytes. */
	contentBytes: number
	/** Why this version exists, for the model and the user. */
	changelog: string
	/** Epoch milliseconds of this version. */
	createdAt: number
	action: ArtifactAction
	/** Title as of this version. */
	title: string
	mode: ArtifactMode
	/** Rendering path, fixed when the artifact is created. */
	engine: ArtifactEngine
	/** Owning session, so a session-scoped catalog can filter. */
	sessionId?: string
}

/** One immutable revision with its content resolved. */
export interface ArtifactVersion extends ArtifactVersionMeta {
	/** Complete source at this revision. */
	content: string
}

/**
 * Catalog entry: the head pointer plus everything the catalog renders. This is
 * exactly what `index.json` stores per artifact, so it never holds content.
 */
export interface ArtifactSummary {
	id: string
	sessionId?: string
	title: string
	mode: ArtifactMode
	/** Rendering path, fixed when the artifact is created. */
	engine: ArtifactEngine
	/** Epoch milliseconds of version 1. */
	createdAt: number
	/** Epoch milliseconds of the head version. */
	updatedAt: number
	/** Head version number. Mirrors `ArtifactVersionMeta.versionNumber`. */
	version: number
	/** Head version id. */
	versionId: string
	/** The head's parent; `null` while the artifact is at version 1. */
	parentVersionId: string | null
	/** sha256 of the head content. */
	contentSha256: string
	/** UTF-8 byte length of the head content. */
	contentBytes: number
	/** How many versions the chain holds. */
	versionCount: number
}

/** A head snapshot: what every writing call returns. */
export interface ArtifactRecord extends ArtifactSummary {
	/** Complete source at the head. */
	source: string
	/** The head version's changelog. */
	changelog: string
	/** How a live card must adopt this revision. */
	render: ArtifactRender
}

/** Arguments for {@link ArtifactStore.create}. */
export interface CreateInput {
	/** Force an id (migrate path); a fresh id is minted when omitted. */
	id?: string
	/** Owning session; omitted means the store-wide unscoped bucket. */
	sessionId?: string
	/** Defaults to `"Artifact"`. */
	title?: string
	/** The first version's complete source. */
	source: string
	/** Defaults to `"inline"`. */
	mode?: ArtifactMode
	/** Rendering path; defaults to the compiled-interface path. */
	engine?: ArtifactEngine
	/** Defaults to `"created"`. */
	changelog?: string
	/** Preserve a legacy creation time (migrate path). Defaults to now. */
	createdAt?: number
}

/** Arguments for {@link ArtifactStore.append}: one whole new revision. */
export interface AppendInput {
	/** Complete source of the new head. */
	content: string
	title?: string
	mode?: ArtifactMode
	changelog?: string
	sessionId?: string
	/** Optimistic concurrency: refuse unless the head is this version number. */
	expectedLatestVersion?: number
}

/** Arguments for {@link ArtifactStore.patch}: exact text replacement. */
export interface PatchInput {
	/** Exact text to find in the current head. */
	oldText: string
	/** Replacement; empty deletes the matched region. */
	newText: string
	/** Replace every occurrence instead of requiring exactly one. */
	replaceAll?: boolean
	title?: string
	/** Defaults to a generated `patch N× "…" → "…"` line. */
	changelog?: string
	sessionId?: string
	expectedLatestVersion?: number
}

/** Arguments for {@link ArtifactStore.restore}. */
export interface RestoreInput {
	sessionId?: string
	expectedLatestVersion?: number
	/** Defaults to `restored from v<N>`. */
	changelog?: string
}

/** Construction options. Every knob is injectable so tests stay hermetic. */
export interface StoreOptions {
	/** Disk root; defaults to `~/.dsh/storages/dsh-genui/` (or `DSH_GENUI_STORE_DIR`). */
	root?: string
	/** Artifacts allowed per session (unscoped artifacts share one bucket). Default 40. */
	maxArtifactsPerSession?: number
	/** Per-artifact content cap in UTF-8 bytes. Default 8 MiB. */
	maxContentBytes?: number
	/** How long a write waits for the store lock before failing. Default 2000. */
	lockTimeoutMs?: number
	/** Age at which an abandoned lock file may be taken over. Default 10000. */
	staleLockMs?: number
	/** Injectable clock, epoch milliseconds. */
	now?: () => number
	/** Injectable id minter. */
	idFactory?: (taken: ReadonlySet<string>) => string
}

/** What {@link ArtifactStore.recover} repaired. */
export interface RecoverReport {
	root: string
	/** Artifact directories found on disk. */
	scanned: number
	/** Artifacts present on disk but missing from the index; now indexed. */
	adopted: string[]
	/** Artifacts whose index head disagreed with the chain on disk; now repaired. */
	repaired: string[]
	/** Index entries with no artifact directory behind them; now dropped. */
	dropped: string[]
	/** Version numbers whose files are unreadable or break the chain (`"<id>#<n>"`). */
	corrupt: string[]
	/** Version numbers past the chain's end, never adopted and never deleted. */
	orphans: string[]
}

/** What {@link ArtifactStore.verify} found for one artifact. */
export interface VerifyReport {
	id: string
	/** Version files found on disk: the chain plus anything past a hole. */
	versions: number
	/** Content files hashed and compared. */
	checked: number
	/** Version numbers whose sha256 or byte length disagreed. */
	mismatched: number[]
	/** Version numbers whose sidecar or content file is missing or unreadable. */
	unreadable: number[]
}

/** Store-wide disk usage, as the catalog sees it. */
export interface UsageReport {
	/** Artifacts counted. */
	artifacts: number
	/** Sum of head content bytes (history is not counted). */
	bytes: number
}
