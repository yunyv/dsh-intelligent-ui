/**
 * The durable artifact registry: what replaces a process-local `Map`, so an
 * artifact a previous DSH run created is still addressable — and still
 * patchable — after the app restarts.
 *
 * Model, per `coda0HQ/open-artifacts` (MIT):
 * - **Append-only.** Every write appends exactly one immutable version; no code
 *   path rewrites or renumbers an existing one.
 * - **Restore mints a head.** `restore(id, 1)` produces version N+1 carrying
 *   version 1's content; versions 1..N stay bit-for-bit as they were.
 * - **Optimistic concurrency.** `expectedLatestVersion` is a compare-and-append:
 *   a mismatch throws {@link StaleVersionError} and appends nothing.
 * - **Any version is readable.** `read(id, n)` is the `?v=N` view.
 *
 * Nothing is cached in the instance: every call resolves through `index.json`
 * and the version files, which is why a brand-new instance over the same root
 * behaves exactly like the process that wrote the data. Disk layout and crash
 * recovery live in `./disk.ts`, the writer lock in `./lock.ts`.
 * @module dsh-intelligent-ui/store/store
 */

import { randomBytes } from 'node:crypto'
import type { ArtifactMode, ArtifactRender } from '../meta.ts'
import { applyPatch, requiresReload } from '../patch.ts'
import {
	artifactDir,
	listArtifactIds,
	readIndex,
	readVersionBytes,
	readVersionMeta,
	removeArtifactDir,
	storePaths,
	summaryFromChain,
	summaryFromHead,
	versionComplete,
	versionIdOf,
	versionNumberExists,
	versionNumbers,
	versionStem,
	VERSION_SCHEMA,
	walkChain,
	writeIndex,
	writeVersionFiles
} from './disk.ts'
import type { IndexFile, StorePaths, VersionFile } from './disk.ts'
import {
	ArtifactCorruptError,
	ArtifactExistsError,
	ArtifactNotFoundError,
	StaleVersionError,
	StoreQuotaError,
	VersionNotFoundError
} from './errors.ts'
import { defaultStoreRoot, encodeContent, ensureDir, sha256Of } from './io.ts'
import { withLock } from './lock.ts'
import type {
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

/** Stable id alphabet: no lookalike characters, so a model can retype an id. */
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

/** Session key for artifacts created without a session; owns one quota bucket. */
const UNSCOPED = '(unscoped)'

/** Default per-artifact content cap: 8 MiB. */
const DEFAULT_MAX_CONTENT_BYTES = 8 * 1024 * 1024

/** One short id, unique across the whole store. */
function mintId(taken: ReadonlySet<string>): string {
	for (;;) {
		const bytes = randomBytes(8)
		let id = 'art-'
		for (const byte of bytes) id += ID_ALPHABET.charAt(byte % ID_ALPHABET.length)
		if (!taken.has(id)) return id
	}
}

/** What a writing call sees once the lock is held and the head is resolved. */
interface HeadState {
	summary: ArtifactSummary
	head: VersionFile
	source: string
}

/** The next version one writing call wants to append. */
interface CommitPlan {
	action: ArtifactAction
	content: string
	title: string
	mode: ArtifactMode
	changelog: string
}

/**
 * A disk-backed, versioned artifact store.
 *
 * All methods are synchronous: the plugin writes a handful of artifacts per
 * turn and reads one at a time, and a synchronous API keeps the write path
 * (lock → resolve head → validate → append → swap index) a single atomic
 * sequence with no interleaving point. Callers may `await` the results freely —
 * `await` passes non-promises straight through.
 */
export class ArtifactStore {
	/** Disk root this instance owns. */
	readonly root: string

	readonly #paths: StorePaths
	readonly #maxArtifactsPerSession: number
	readonly #maxContentBytes: number
	readonly #lockTimeoutMs: number
	readonly #staleLockMs: number
	readonly #now: () => number
	readonly #idFactory: (taken: ReadonlySet<string>) => string

	/**
	 * @param options - root, quotas, lock tuning, injectable clock and id minter.
	 *   The root directory tree is created on construction.
	 */
	constructor(options: StoreOptions = {}) {
		this.root = options.root ?? defaultStoreRoot()
		this.#paths = storePaths(this.root)
		this.#maxArtifactsPerSession = options.maxArtifactsPerSession ?? 40
		this.#maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES
		this.#lockTimeoutMs = options.lockTimeoutMs ?? 2000
		this.#staleLockMs = options.staleLockMs ?? 10_000
		this.#now = options.now ?? Date.now
		this.#idFactory = options.idFactory ?? mintId
		ensureDir(this.#paths.artifactsDir)
		ensureDir(this.#paths.locksDir)
	}

	/** `<root>/index.json`; useful for diagnostics and for tests. */
	get indexPath(): string {
		return this.#paths.indexFile
	}

	/** `<root>/artifacts`. */
	get artifactsDir(): string {
		return this.#paths.artifactsDir
	}

	/** `<root>/locks/store.lock`. */
	get lockFile(): string {
		return this.#paths.lockFile
	}

	/** Absolute directory holding one artifact's version files. */
	directoryOf(id: string): string {
		return artifactDir(this.#paths, id)
	}

	// ---------------------------------------------------------------- writing

	/**
	 * Create an artifact and append its version 1.
	 * @param input - source, and optionally id, session, title, mode, changelog.
	 * @returns the head record, at version 1.
	 * @throws {StoreQuotaError} when the session is at its artifact cap, or the
	 *   source is over the per-artifact byte cap.
	 * @throws {ArtifactExistsError} when a forced id is already on disk.
	 */
	create(input: CreateInput): ArtifactRecord {
		const bytes = this.#guardBytes(input.source)
		const sessionId = input.sessionId
		const title = cleanTitle(input.title)
		const mode: ArtifactMode = input.mode === 'wide' ? 'wide' : 'inline'
		return this.#locked(() => {
			const index = readIndex(this.#paths)
			const entries = Object.values(index.artifacts)
			const bucket = sessionId ?? UNSCOPED
			const held = entries.filter(entry => (entry.sessionId ?? UNSCOPED) === bucket).length
			if (held >= this.#maxArtifactsPerSession) throw new StoreQuotaError('artifacts', this.#maxArtifactsPerSession, held)
			const taken = new Set(Object.keys(index.artifacts))
			const id = input.id ?? this.#idFactory(taken)
			if (taken.has(id) || versionNumberExists(this.#paths, id, 1)) throw new ArtifactExistsError(id)
			const createdAt = input.createdAt ?? this.#now()
			const meta: VersionFile = {
				schema: VERSION_SCHEMA,
				id,
				contentFile: `${versionStem(1)}.html`,
				...(sessionId === undefined ? {} : { sessionId }),
				versionNumber: 1,
				versionId: versionIdOf(id, 1),
				parentVersionId: null,
				contentSha256: sha256Of(bytes),
				contentBytes: bytes.byteLength,
				changelog: input.changelog ?? 'created',
				createdAt,
				action: 'create',
				title,
				mode,
				engine: input.engine === 'html' ? 'html' : 'dil'
			}
			writeVersionFiles(this.#paths, meta, bytes)
			const summary = summaryFromHead(meta, 1, createdAt)
			index.artifacts[id] = summary
			index.updatedAt = createdAt
			writeIndex(this.#paths, index)
			return { ...summary, source: input.source, changelog: meta.changelog, render: 'reload' }
		})
	}

	/**
	 * Append one whole new revision. The low-level path; `patch` and `restore`
	 * are built on it.
	 * @throws {ArtifactNotFoundError} | {@link StaleVersionError} | {@link StoreQuotaError}
	 */
	append(id: string, input: AppendInput): ArtifactRecord {
		return this.#commit(id, input.sessionId, input.expectedLatestVersion, state => ({
			action: 'append',
			content: input.content,
			title: input.title === undefined ? state.head.title : cleanTitle(input.title),
			mode: input.mode ?? state.head.mode,
			changelog: input.changelog ?? `appended ${String(encodeContent(input.content).byteLength)} bytes`
		}))
	}

	/**
	 * Apply an exact `oldText` → `newText` replacement to the head.
	 *
	 * Replacement semantics are `src/patch.ts` verbatim — empty or absent search
	 * text and an ambiguous match without `replaceAll` all throw `PatchError`
	 * before anything is written.
	 * @throws {PatchError} when the patch cannot be applied.
	 * @throws {StaleVersionError} when `expectedLatestVersion` is not the head.
	 */
	patch(id: string, input: PatchInput): ArtifactRecord {
		return this.#commit(id, input.sessionId, input.expectedLatestVersion, state => {
			const applied = applyPatch(state.source, input.oldText, input.newText, input.replaceAll ?? false)
			const before = encodeContent(state.source).byteLength
			const after = encodeContent(applied.text).byteLength
			return {
				action: 'patch',
				content: applied.text,
				title: input.title === undefined ? state.head.title : cleanTitle(input.title),
				mode: state.head.mode,
				changelog: input.changelog ?? `patch ${String(applied.replacements)}× (${String(before)}→${String(after)} bytes)`
			}
		})
	}

	/**
	 * Restore an old revision as a **new** head. History is untouched: version N
	 * still holds exactly what it held, and the restore lands as version N+1.
	 * @param id - artifact id.
	 * @param version - revision to copy forward.
	 * @throws {ArtifactNotFoundError} | {@link VersionNotFoundError} | {@link StaleVersionError}
	 */
	restore(id: string, version: number, input: RestoreInput = {}): ArtifactRecord {
		return this.#commit(id, input.sessionId, input.expectedLatestVersion, state => {
			const meta = readVersionMeta(this.#paths, id, version)
			const bytes = meta === undefined ? undefined : readVersionBytes(this.#paths, id, meta)
			if (meta === undefined || bytes === undefined) throw new VersionNotFoundError(id, version)
			return {
				action: 'restore',
				content: bytes.toString('utf8'),
				title: meta.title,
				mode: meta.mode,
				changelog: input.changelog ?? `restored from v${String(version)}`
			}
		})
	}

	/**
	 * Delete an artifact and its entire version history.
	 * @returns whether anything was deleted.
	 */
	destroy(id: string): boolean {
		return this.#locked(() => {
			const index = readIndex(this.#paths)
			const known = index.artifacts[id] !== undefined
			removeArtifactDir(this.#paths, id)
			if (!known) return false
			delete index.artifacts[id]
			index.updatedAt = this.#now()
			writeIndex(this.#paths, index)
			return true
		})
	}

	// ----------------------------------------------------------------- reading

	/**
	 * Read one revision.
	 * @param id - artifact id.
	 * @param version - revision number; defaults to the head (`?v=N` otherwise).
	 * @throws {ArtifactNotFoundError} when no chain exists for that id.
	 * @throws {VersionNotFoundError} when that revision is not in the chain.
	 */
	read(id: string, version?: number): ArtifactVersion {
		const resolved = this.#resolve(id)
		if (resolved === undefined) throw new ArtifactNotFoundError(id)
		const wanted = version ?? resolved.head.versionNumber
		const meta = wanted === resolved.head.versionNumber ? resolved.head : readVersionMeta(this.#paths, id, wanted)
		if (meta === undefined) throw new VersionNotFoundError(id, wanted)
		const bytes = readVersionBytes(this.#paths, id, meta)
		if (bytes === undefined) throw new VersionNotFoundError(id, wanted)
		return { ...publicMeta(meta), content: bytes.toString('utf8') }
	}

	/**
	 * The head record, or `undefined` when the id is unknown. A probe, not an
	 * action: use {@link read} when a missing artifact should be an error.
	 */
	get(id: string): ArtifactRecord | undefined {
		const resolved = this.#resolve(id)
		if (resolved === undefined) return undefined
		const bytes = readVersionBytes(this.#paths, id, resolved.head)
		if (bytes === undefined) return undefined
		const source = bytes.toString('utf8')
		return {
			...resolved.summary,
			source,
			changelog: resolved.head.changelog,
			render: this.#renderFor(id, resolved.head, source)
		}
	}

	/** Whether an artifact (or at least part of its chain) is on disk. */
	has(id: string): boolean {
		return this.#resolve(id) !== undefined
	}

	/**
	 * The catalog, oldest first.
	 * @param sessionId - filter to one session; omitted lists every artifact.
	 *   Read from `index.json` only, so call {@link recover} first if the index
	 *   may have been lost.
	 */
	list(sessionId?: string): ArtifactSummary[] {
		const index = readIndex(this.#paths)
		return Object.values(index.artifacts)
			.filter(entry => sessionId === undefined || entry.sessionId === sessionId)
			.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
	}

	/**
	 * Every revision of one artifact, version 1 first, content excluded.
	 * @throws {ArtifactNotFoundError} when no chain exists for that id.
	 */
	versions(id: string): ArtifactVersionMeta[] {
		const scan = walkChain(this.#paths, id)
		if (scan.head === undefined) throw new ArtifactNotFoundError(id)
		return scan.versions.map(publicMeta)
	}

	/** The session's artifact with this title, or `undefined`. */
	findByTitle(sessionId: string | undefined, title: string): ArtifactSummary | undefined {
		const wanted = title.trim()
		return this.list(sessionId).find(entry => entry.title.trim() === wanted)
	}

	/** Artifact count and head-content bytes, for one session or the whole store. */
	usage(sessionId?: string): UsageReport {
		let artifacts = 0
		let bytes = 0
		for (const entry of this.list(sessionId)) {
			artifacts += 1
			bytes += entry.contentBytes
		}
		return { artifacts, bytes }
	}

	// ------------------------------------------------------- repair and verify

	/**
	 * Reconcile `index.json` with what is actually on disk.
	 *
	 * Adopts artifacts whose version files survived but whose index entry did
	 * not (a crash between the two writes, or a lost index), repairs head
	 * pointers that disagree with the chain, and drops entries with nothing
	 * behind them. Orphans and corrupt versions are **reported, never deleted**:
	 * discarding content on a heuristic is worse than leaving a file behind.
	 *
	 * Idempotent and cheap; call it once when the plugin loads.
	 */
	recover(): RecoverReport {
		return this.#locked(() => {
			const index = readIndex(this.#paths)
			const ids = listArtifactIds(this.#paths)
			const onDisk = new Set(ids)
			const report: RecoverReport = { root: this.root, scanned: ids.length, adopted: [], repaired: [], dropped: [], corrupt: [], orphans: [] }
			for (const id of ids) {
				const scan = walkChain(this.#paths, id)
				report.corrupt.push(...scan.corrupt.map(n => versionIdOf(id, n)))
				report.orphans.push(...scan.orphans.map(n => versionIdOf(id, n)))
				const rebuilt = summaryFromChain(scan)
				if (rebuilt === undefined) continue
				const existing = index.artifacts[id]
				if (existing === undefined) {
					index.artifacts[id] = rebuilt
					report.adopted.push(id)
					continue
				}
				if (existing.version !== rebuilt.version || existing.contentSha256 !== rebuilt.contentSha256 || existing.versionCount !== rebuilt.versionCount || existing.title !== rebuilt.title) {
					index.artifacts[id] = rebuilt
					report.repaired.push(id)
				}
			}
			for (const id of Object.keys(index.artifacts)) {
				if (onDisk.has(id)) continue
				delete index.artifacts[id]
				report.dropped.push(id)
			}
			index.updatedAt = this.#now()
			writeIndex(this.#paths, index)
			return report
		})
	}

	/**
	 * Re-hash every version file of one artifact — the chain *and* any version
	 * past a hole — and compare against the recorded digest, so silent disk
	 * corruption is detected rather than silently patched on top of. Only the
	 * chain is writable; this is the read-side check.
	 * @throws {ArtifactNotFoundError} when the artifact has no files at all.
	 */
	verify(id: string): VerifyReport {
		const numbers = versionNumbers(this.#paths, id)
		const first = numbers.at(0)
		if (first === undefined || readVersionMeta(this.#paths, id, first) === undefined) throw new ArtifactNotFoundError(id)
		const report: VerifyReport = { id, versions: numbers.length, checked: 0, mismatched: [], unreadable: [] }
		for (const versionNumber of numbers) {
			const meta = readVersionMeta(this.#paths, id, versionNumber)
			const bytes = meta === undefined ? undefined : readVersionBytes(this.#paths, id, meta)
			if (meta === undefined || bytes === undefined) {
				report.unreadable.push(versionNumber)
				continue
			}
			report.checked += 1
			if (bytes.byteLength !== meta.contentBytes || sha256Of(bytes) !== meta.contentSha256) report.mismatched.push(versionNumber)
		}
		return report
	}

	// ---------------------------------------------------------------- internals

	/** Run `body` while holding the store-wide writer lock. */
	#locked<T>(body: () => T): T {
		return withLock(this.#paths.lockFile, { timeoutMs: this.#lockTimeoutMs, staleMs: this.#staleLockMs, now: this.#now }, body)
	}

	/** Reject an oversized source before any IO. */
	#guardBytes(content: string): Buffer {
		const bytes = encodeContent(content)
		if (bytes.byteLength > this.#maxContentBytes) throw new StoreQuotaError('bytes', this.#maxContentBytes, bytes.byteLength)
		return bytes
	}

	/**
	 * Resolve one artifact's head without writing anything.
	 *
	 * Disk beats the catalog whenever the two disagree: an index entry whose own
	 * head is unreadable, or that a higher version has landed past, is a pointer
	 * left behind by an interrupted write. Resolving through the chain instead
	 * means a lost index degrades to "the catalog is empty", never to "your
	 * artifacts are gone", and that reads and writes agree on where the head is.
	 * {@link recover} is what makes the *catalog* agree too.
	 */
	#resolve(id: string): { summary: ArtifactSummary; head: VersionFile; fromChain: boolean } | undefined {
		const entry = readIndex(this.#paths).artifacts[id]
		if (entry !== undefined) {
			const head = readVersionMeta(this.#paths, id, entry.version)
			if (head !== undefined && versionComplete(this.#paths, id, head) && !versionNumberExists(this.#paths, id, entry.version + 1)) return { summary: entry, head, fromChain: false }
		}
		const scan = walkChain(this.#paths, id)
		const summary = summaryFromChain(scan)
		if (summary === undefined || scan.head === undefined) return undefined
		return { summary, head: scan.head, fromChain: true }
	}

	/**
	 * Resolve the head for a write, repairing the in-memory catalog when disk is
	 * ahead of it — the crash orphan the previous write left behind. Adopting it
	 * is what makes the next patch land on top of the model's last work instead of
	 * overwriting a version that is already on disk.
	 */
	#resolveForWrite(index: IndexFile, id: string): ArtifactSummary | undefined {
		const entry = index.artifacts[id]
		if (entry !== undefined) {
			const head = readVersionMeta(this.#paths, id, entry.version)
			if (head !== undefined && versionComplete(this.#paths, id, head) && !versionNumberExists(this.#paths, id, entry.version + 1)) return entry
		}
		const rebuilt = summaryFromChain(walkChain(this.#paths, id))
		if (rebuilt === undefined) return entry
		index.artifacts[id] = rebuilt
		return rebuilt
	}

	/**
	 * The one place a version is appended: lock, resolve, check, plan, write
	 * content, write sidecar, swap the index. Any throw before the index swap
	 * leaves the previous head in force and at most a stray version file behind,
	 * which {@link recover} reports.
	 */
	#commit(id: string, sessionId: string | undefined, expectedLatestVersion: number | undefined, build: (state: HeadState) => CommitPlan): ArtifactRecord {
		return this.#locked(() => {
			const index = readIndex(this.#paths)
			const entry = this.#resolveForWrite(index, id)
			if (entry === undefined) throw new ArtifactNotFoundError(id, sessionId)
			if (sessionId !== undefined && entry.sessionId !== sessionId) throw new ArtifactNotFoundError(id, sessionId)
			if (expectedLatestVersion !== undefined && expectedLatestVersion !== entry.version) {
				throw new StaleVersionError(id, expectedLatestVersion, entry.version, entry.versionId)
			}
			const head = readVersionMeta(this.#paths, id, entry.version)
			const headBytes = head === undefined ? undefined : readVersionBytes(this.#paths, id, head)
			if (head === undefined || headBytes === undefined) throw new ArtifactCorruptError(id, entry.version, 'the content file or sidecar is missing')
			const source = headBytes.toString('utf8')
			const plan = build({ summary: entry, head, source })
			const bytes = this.#guardBytes(plan.content)
			const versionNumber = entry.version + 1
			const createdAt = this.#now()
			const meta: VersionFile = {
				schema: VERSION_SCHEMA,
				id,
				contentFile: `${versionStem(versionNumber)}.html`,
				...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
				versionNumber,
				versionId: versionIdOf(id, versionNumber),
				parentVersionId: entry.versionId,
				contentSha256: sha256Of(bytes),
				contentBytes: bytes.byteLength,
				changelog: plan.changelog,
				createdAt,
				action: plan.action,
				title: plan.title,
				mode: plan.mode,
				// The path is fixed at creation: a revision recompiles the same way.
				engine: head.engine
			}
			writeVersionFiles(this.#paths, meta, bytes)
			const summary = summaryFromHead(meta, entry.versionCount + 1, entry.createdAt)
			index.artifacts[id] = summary
			index.updatedAt = createdAt
			writeIndex(this.#paths, index)
			const render: ArtifactRender = plan.action === 'restore' || requiresReload(source, plan.content) ? 'reload' : 'reconcile'
			return { ...summary, source: plan.content, changelog: meta.changelog, render }
		})
	}

	/**
	 * How a live card must adopt the head: reconcile when only markup or style
	 * moved, reload as soon as any `<script>` body did — the same rule
	 * `src/patch.ts` applies, evaluated one version back.
	 */
	#renderFor(id: string, head: VersionFile, source: string): ArtifactRender {
		if (head.versionNumber <= 1) return 'reload'
		const previous = readVersionMeta(this.#paths, id, head.versionNumber - 1)
		const previousBytes = previous === undefined ? undefined : readVersionBytes(this.#paths, id, previous)
		if (previousBytes === undefined) return 'reload'
		return requiresReload(previousBytes.toString('utf8'), source) ? 'reload' : 'reconcile'
	}
}

/** Strip the on-disk envelope, keeping only the public revision fields. */
function publicMeta(meta: VersionFile): ArtifactVersionMeta {
	return {
		id: meta.id,
		...(meta.sessionId === undefined ? {} : { sessionId: meta.sessionId }),
		versionNumber: meta.versionNumber,
		versionId: meta.versionId,
		parentVersionId: meta.parentVersionId,
		contentSha256: meta.contentSha256,
		contentBytes: meta.contentBytes,
		changelog: meta.changelog,
		createdAt: meta.createdAt,
		action: meta.action,
		title: meta.title,
		mode: meta.mode,
		engine: meta.engine
	}
}

/** A title the model can retype: trimmed, never empty. */
function cleanTitle(title: string | undefined): string {
	if (title === undefined) return 'Artifact'
	const trimmed = title.trim()
	return trimmed.length === 0 ? 'Artifact' : trimmed
}
