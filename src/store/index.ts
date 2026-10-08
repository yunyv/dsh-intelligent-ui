/**
 * Durable artifact layer: versioned, append-only, on disk.
 *
 * This is what lifts artifacts out of the process-local `Map` that made every
 * card created before a restart un-patchable. One root holds one catalog:
 *
 * ```text
 * ~/.dsh/storages/dsh-genui/
 * ├── index.json
 * ├── locks/store.lock
 * └── artifacts/art-abcd2345/versions/{v0001.html,v0001.json,v0002.html,v0002.json}
 * ```
 *
 * Zero host dependencies (only `node:fs` / `node:crypto` / `node:path`), so it
 * is testable against a temp root and survives any storage-service change.
 *
 * ```ts
 * const store = new ArtifactStore({ root })          // or {} for the default root
 * store.recover()                                    // once, at plugin load
 * const record = store.create({ sessionId, title, source: html, mode: 'inline' })
 * store.patch(record.id, { oldText: '<p>a</p>', newText: '<p>b</p>', expectedLatestVersion: record.version })
 * store.read(record.id)            // head
 * store.read(record.id, 1)         // ?v=1
 * store.restore(record.id, 1)      // appends version 3 carrying version 1's content
 * ```
 * @module dsh-genui/store
 */

export { ArtifactStore } from './store.ts'
export { importLegacyRecords, ensureArtifact } from './migrate.ts'
export type { ImportOptions, ImportOutcome, LegacyArtifactRecord } from './migrate.ts'
export {
	ArtifactCorruptError,
	ArtifactExistsError,
	ArtifactNotFoundError,
	PatchError,
	StaleVersionError,
	StoreError,
	StoreLockedError,
	StoreQuotaError,
	VersionNotFoundError
} from './errors.ts'
export {
	INDEX_SCHEMA,
	VERSION_SCHEMA,
	artifactDir,
	emptyIndex,
	listArtifactIds,
	readIndex,
	readVersionMeta,
	removeArtifactDir,
	removeVersionFiles,
	storePaths,
	summaryFromChain,
	summaryFromHead,
	versionContentFile,
	versionIdOf,
	versionMetaFile,
	versionNumberExists,
	versionStem,
	versionsDir,
	walkChain,
	writeIndex,
	writeVersionFiles
} from './disk.ts'
export type { ChainScan, IndexFile, StorePaths, VersionFile } from './disk.ts'
export { ROOT_ENV, defaultStoreRoot, encodeContent, readJson, readText, sha256Of, sha256Text, writeJsonAtomic } from './io.ts'
export { acquireLock, sleepSync, withLock } from './lock.ts'
export type { LockHandle, LockOptions } from './lock.ts'
export type {
	AppendInput,
	ArtifactAction,
	ArtifactRecord,
	ArtifactSummary,
	ArtifactVersion,
	ArtifactVersionMeta,
	CreateInput,
	PatchInput,
	RecoverReport,
	RestoreInput,
	StoreOptions,
	UsageReport,
	VerifyReport
} from './types.ts'
export type { ArtifactMode, ArtifactRender } from '../meta.ts'
