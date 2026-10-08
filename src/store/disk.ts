/**
 * The on-disk format, exactly as it sits on disk:
 *
 * ```text
 * <root>/
 * ├── index.json                                  # catalog: one entry per artifact, no content
 * ├── locks/store.lock                            # writer lock (transient)
 * └── artifacts/<artifactId>/
 *     └── versions/
 *         ├── v0001.html                          # exact UTF-8 content of version 1
 *         ├── v0001.json                           # version 1 metadata sidecar
 *         ├── v0002.html
 *         └── v0002.json
 * ```
 *
 * Content lives in its own byte-exact file, never inside JSON: a multi-megabyte
 * artifact costs one write and one read, with no escaping blow-up, and its
 * sha256 is the hash of the file's bytes. Metadata lives in the sidecar and in
 * the index, so listing a catalog never reads content.
 *
 * Write order is content → sidecar → index, and the index is replaced
 * atomically. A crash between the two leaves a version on disk the index has
 * not recorded yet; {@link walkChain} and {@link ArtifactStore.recover} adopt it
 * instead of discarding it, so nothing the model authored is ever lost to a
 * half-finished write.
 * @module dsh-genui/store/disk
 */

import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ArtifactSummary, ArtifactVersionMeta } from './types.ts'
import { ensureDir, fileExists, isMissing, readBytes, readJson, removeFile, writeBytesAtomic, writeJsonAtomic } from './io.ts'

/** Bumped only when `index.json` stops being readable by this code. */
export const INDEX_SCHEMA = 'dsh-genui.store-index/1'
/** Bumped only when a `vNNNN.json` sidecar stops being readable by this code. */
export const VERSION_SCHEMA = 'dsh-genui.store-version/1'

/** Every path the store owns, derived from one root. */
export interface StorePaths {
	root: string
	indexFile: string
	artifactsDir: string
	locksDir: string
	lockFile: string
}

/** Derive the directory tree under one root. */
export function storePaths(root: string): StorePaths {
	return {
		root,
		indexFile: join(root, 'index.json'),
		artifactsDir: join(root, 'artifacts'),
		locksDir: join(root, 'locks'),
		lockFile: join(root, 'locks', 'store.lock')
	}
}

/** `<root>/artifacts/<id>`. */
export function artifactDir(paths: StorePaths, id: string): string {
	return join(paths.artifactsDir, id)
}

/** `<root>/artifacts/<id>/versions`. */
export function versionsDir(paths: StorePaths, id: string): string {
	return join(artifactDir(paths, id), 'versions')
}

/** `3` → `"v0003"`, the stem every version file shares. */
export function versionStem(versionNumber: number): string {
	return `v${String(versionNumber).padStart(4, '0')}`
}

/** Stable version id, unique for the lifetime of an artifact. */
export function versionIdOf(id: string, versionNumber: number): string {
	return `${id}#${String(versionNumber)}`
}

/** The sidecar `vNNNN.json` holding one version's metadata. */
export interface VersionFile extends ArtifactVersionMeta {
	schema: string
	/** Content file name, relative to the version directory. */
	contentFile: string
}

/** The catalog: `index.json`. */
export interface IndexFile {
	schema: string
	/** Epoch milliseconds of the last catalog write. */
	updatedAt: number
	artifacts: Record<string, ArtifactSummary>
}

/** One contiguous run of valid versions, as read from disk. */
export interface ChainScan {
	versions: VersionFile[]
	/** Newest valid version; `undefined` when even version 1 is unusable. */
	head: VersionFile | undefined
	/** Version numbers that parse but break the chain (gap, bad parent, no content). */
	corrupt: number[]
	/** Version numbers past the chain's end; reported, never deleted. */
	orphans: number[]
}

/** An empty catalog; also what a missing or unparseable index degrades to. */
export function emptyIndex(): IndexFile {
	return { schema: INDEX_SCHEMA, updatedAt: 0, artifacts: {} }
}

/** Read the catalog. Missing, unparseable or foreign-schema all read as empty. */
export function readIndex(paths: StorePaths): IndexFile {
	const parsed = readJson<Partial<IndexFile>>(paths.indexFile)
	if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return emptyIndex()
	const artifacts: Record<string, ArtifactSummary> = {}
	const raw = parsed.artifacts
	if (raw !== undefined && typeof raw === 'object' && raw !== null) {
		for (const [id, entry] of Object.entries(raw)) {
			if (isSummary(entry)) artifacts[id] = entry
		}
	}
	return {
		schema: typeof parsed.schema === 'string' ? parsed.schema : INDEX_SCHEMA,
		updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
		artifacts
	}
}

/** Replace the catalog atomically. */
export function writeIndex(paths: StorePaths, index: IndexFile): void {
	ensureDir(paths.root)
	writeJsonAtomic(paths.indexFile, { ...index, schema: INDEX_SCHEMA })
}

/** Path of one version's sidecar. */
export function versionMetaFile(paths: StorePaths, id: string, versionNumber: number): string {
	return join(versionsDir(paths, id), `${versionStem(versionNumber)}.json`)
}

/** Path of one version's content. */
export function versionContentFile(paths: StorePaths, id: string, versionNumber: number): string {
	return join(versionsDir(paths, id), `${versionStem(versionNumber)}.html`)
}

/** Whether either half of a version is on disk. */
export function versionNumberExists(paths: StorePaths, id: string, versionNumber: number): boolean {
	return fileExists(versionMetaFile(paths, id, versionNumber)) || fileExists(versionContentFile(paths, id, versionNumber))
}

/**
 * Whether a version is *complete*: its sidecar parsed and its content file is
 * still there.
 *
 * Only complete versions are immutable history. A version with a sidecar but no
 * content was never durably committed, so it is not addressable, the chain stops
 * before it, and a later write may fill that version number in again.
 */
export function versionComplete(paths: StorePaths, id: string, meta: VersionFile): boolean {
	return fileExists(join(versionsDir(paths, id), meta.contentFile))
}

/** Write one version: content bytes first, then the sidecar that describes them. */
export function writeVersionFiles(paths: StorePaths, meta: VersionFile, bytes: Uint8Array): void {
	const dir = versionsDir(paths, meta.id)
	ensureDir(dir)
	writeBytesAtomic(join(dir, meta.contentFile), bytes)
	writeJsonAtomic(versionMetaFile(paths, meta.id, meta.versionNumber), meta)
}

/** Read one version's sidecar, or `undefined` when it is missing or unparseable. */
export function readVersionMeta(paths: StorePaths, id: string, versionNumber: number): VersionFile | undefined {
	const parsed = readJson<Partial<VersionFile>>(versionMetaFile(paths, id, versionNumber))
	if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return undefined
	if (parsed.schema !== VERSION_SCHEMA) return undefined
	if (parsed.id !== id || parsed.versionNumber !== versionNumber) return undefined
	if (typeof parsed.contentFile !== 'string' || !/^v\d+\.html$/u.test(parsed.contentFile)) return undefined
	if (typeof parsed.versionId !== 'string' || typeof parsed.contentSha256 !== 'string') return undefined
	if (typeof parsed.contentBytes !== 'number' || typeof parsed.createdAt !== 'number') return undefined
	if (typeof parsed.changelog !== 'string' || typeof parsed.title !== 'string') return undefined
	if (typeof parsed.action !== 'string') return undefined
	if (parsed.mode !== 'inline' && parsed.mode !== 'wide') return undefined
	if (parsed.parentVersionId !== null && typeof parsed.parentVersionId !== 'string') return undefined
	return parsed as VersionFile
}

/** Read one version's content bytes. */
export function readVersionBytes(paths: StorePaths, id: string, meta: VersionFile): Buffer | undefined {
	return readBytes(join(versionsDir(paths, id), meta.contentFile))
}

/** Version numbers present on disk, ascending; a sidecar or content file counts. */
export function versionNumbers(paths: StorePaths, id: string): number[] {
	let names: string[]
	try {
		names = readdirSync(versionsDir(paths, id))
	} catch (error) {
		if (isMissing(error)) return []
		throw error
	}
	const found = new Set<number>()
	for (const name of names) {
		const match = /^v(\d+)(?:\.json|\.html)$/u.exec(name)
		const digits = match?.[1]
		if (digits === undefined) continue
		found.add(Number(digits))
	}
	return [...found].sort((left, right) => left - right)
}

/** Every artifact directory name under the root. */
export function listArtifactIds(paths: StorePaths): string[] {
	let entries
	try {
		entries = readdirSync(paths.artifactsDir, { withFileTypes: true })
	} catch (error) {
		if (isMissing(error)) return []
		throw error
	}
	return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

/** Delete one artifact's whole directory, version history included. */
export function removeArtifactDir(paths: StorePaths, id: string): void {
	rmSync(artifactDir(paths, id), { recursive: true, force: true })
}

/** Delete a stray version file pair. */
export function removeVersionFiles(paths: StorePaths, id: string, versionNumber: number): void {
	removeFile(versionMetaFile(paths, id, versionNumber))
	removeFile(versionContentFile(paths, id, versionNumber))
}

/**
 * Walk an artifact's chain from version 1 upward.
 *
 * Stops at the first version that is missing, unreadable, misnumbered, whose
 * parent is not the version before it, or whose content file is gone — a chain
 * with a hole cannot be patched safely, so the caller keeps the last good head
 * rather than guessing. Everything past the stop is reported as corrupt (when
 * its own files are present) or orphaned (when its number simply follows).
 * @returns the contiguous prefix, its head, and what could not be joined to it.
 */
export function walkChain(paths: StorePaths, id: string): ChainScan {
	const present = versionNumbers(paths, id)
	const versions: VersionFile[] = []
	const corrupt: number[] = []
	const orphans: number[] = []
	let expectedParent: string | null = null
	let stopped = false
	for (const versionNumber of present) {
		if (stopped) {
			orphans.push(versionNumber)
			continue
		}
		const meta = readVersionMeta(paths, id, versionNumber)
		if (meta === undefined) {
			corrupt.push(versionNumber)
			stopped = true
			continue
		}
		const wants: string | null = versionNumber === 1 ? null : expectedParent
		if (meta.parentVersionId !== wants || !fileExists(join(versionsDir(paths, id), meta.contentFile))) {
			corrupt.push(versionNumber)
			stopped = true
			continue
		}
		versions.push(meta)
		expectedParent = meta.versionId
	}
	return { versions, head: versions.at(-1), corrupt, orphans }
}

/** The catalog entry that summarizes a chain head. */
export function summaryFromHead(head: VersionFile, versionCount: number, createdAt: number): ArtifactSummary {
	return {
		id: head.id,
		...(head.sessionId === undefined ? {} : { sessionId: head.sessionId }),
		title: head.title,
		mode: head.mode,
		createdAt,
		updatedAt: head.createdAt,
		version: head.versionNumber,
		versionId: head.versionId,
		parentVersionId: head.parentVersionId,
		contentSha256: head.contentSha256,
		contentBytes: head.contentBytes,
		versionCount
	}
}

/** The catalog entry for a scanned chain: head fields, plus version 1's birth time. */
export function summaryFromChain(scan: ChainScan): ArtifactSummary | undefined {
	const head = scan.head
	if (head === undefined) return undefined
	const first = scan.versions[0]
	return summaryFromHead(head, scan.versions.length, first === undefined ? head.createdAt : first.createdAt)
}

/** Whether one parsed index entry has the fields every reader relies on. */
function isSummary(value: unknown): value is ArtifactSummary {
	if (typeof value !== 'object' || value === null) return false
	const row = value as Record<string, unknown>
	return (
		typeof row.id === 'string' &&
		typeof row.title === 'string' &&
		(row.mode === 'inline' || row.mode === 'wide') &&
		typeof row.createdAt === 'number' &&
		typeof row.updatedAt === 'number' &&
		typeof row.version === 'number' &&
		typeof row.versionId === 'string' &&
		(row.parentVersionId === null || typeof row.parentVersionId === 'string') &&
		typeof row.contentSha256 === 'string' &&
		typeof row.contentBytes === 'number' &&
		typeof row.versionCount === 'number'
	)
}
