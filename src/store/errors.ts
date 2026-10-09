/**
 * Failure surface of the artifact store. Every rejection throws one of these
 * instead of returning `undefined`, so a model gets a located, actionable
 * diagnostic rather than a silent no-op.
 * @module dsh-intelligent-ui/store/errors
 */

export { PatchError } from '../patch.ts'

/** Base class, so a caller can catch the whole family with one clause. */
export class StoreError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ArtifactStoreError'
	}
}

/** No artifact with that id, or it belongs to another session. */
export class ArtifactNotFoundError extends StoreError {
	readonly artifactId: string
	readonly sessionId: string | undefined

	constructor(artifactId: string, sessionId?: string) {
		super(
			sessionId === undefined
				? `no artifact "${artifactId}" on disk. It may have been deleted, or the id was mistyped — list the session's artifacts to see what exists.`
				: `no artifact "${artifactId}" in session "${sessionId}". Ids are session-scoped; a session cannot address another session's artifact.`
		)
		this.name = 'ArtifactNotFoundError'
		this.artifactId = artifactId
		this.sessionId = sessionId
	}
}

/** The artifact exists but that revision number is not in its chain. */
export class VersionNotFoundError extends StoreError {
	readonly artifactId: string
	readonly version: number

	constructor(artifactId: string, version: number) {
		super(
			`artifact "${artifactId}" has no version ${String(version)}. Read it without a version to get the head, or list its versions first.`
		)
		this.name = 'VersionNotFoundError'
		this.artifactId = artifactId
		this.version = version
	}
}

/**
 * Optimistic-concurrency refusal: the caller's `expectedLatestVersion` is not
 * the head any more, so the write was rejected and **no version was appended**.
 */
export class StaleVersionError extends StoreError {
	readonly artifactId: string
	/** The version the caller assumed. */
	readonly expected: number
	/** The version actually on disk. */
	readonly actual: number
	readonly actualVersionId: string

	constructor(artifactId: string, expected: number, actual: number, actualVersionId: string) {
		super(
			`artifact "${artifactId}" moved under you: expected latest version ${String(expected)}, but the head is version ${String(actual)}. Nothing was written. Read it again — the text you searched for may already be gone — then retry against version ${String(actual)}.`
		)
		this.name = 'StaleVersionError'
		this.artifactId = artifactId
		this.expected = expected
		this.actual = actual
		this.actualVersionId = actualVersionId
	}
}

/** A configured budget was exceeded. */
export class StoreQuotaError extends StoreError {
	readonly kind: 'artifacts' | 'bytes'
	readonly limit: number
	readonly actual: number

	constructor(kind: 'artifacts' | 'bytes', limit: number, actual: number) {
		super(
			kind === 'artifacts'
				? `this session already holds ${String(actual)} artifacts (limit ${String(limit)}). Delete one with action "destroy" before creating another.`
				: `the artifact would be ${String(actual)} bytes, over the ${String(limit)} byte per-artifact limit. Split it into smaller artifacts.`
		)
		this.name = 'StoreQuotaError'
		this.kind = kind
		this.limit = limit
		this.actual = actual
	}
}

/** Another process holds the store lock and did not release it in time. */
export class StoreLockedError extends StoreError {
	readonly lockFile: string
	readonly waitedMs: number

	constructor(lockFile: string, waitedMs: number) {
		super(
			`another writer holds the artifact store lock (${lockFile}) after ${String(waitedMs)}ms. Retry the write; if the holding process died, the lock is taken over once it is stale.`
		)
		this.name = 'StoreLockedError'
		this.lockFile = lockFile
		this.waitedMs = waitedMs
	}
}

/** An artifact with that id already exists. */
export class ArtifactExistsError extends StoreError {
	readonly artifactId: string

	constructor(artifactId: string) {
		super(`artifact "${artifactId}" already exists on disk. Read it and patch the head instead of creating a new one.`)
		this.name = 'ArtifactExistsError'
		this.artifactId = artifactId
	}
}

/** The chain on disk cannot be resumed: a version file is missing or unreadable. */
export class ArtifactCorruptError extends StoreError {
	readonly artifactId: string
	readonly version: number

	constructor(artifactId: string, version: number, detail: string) {
		super(
			`artifact "${artifactId}" cannot be resumed: version ${String(version)} is unusable (${detail}). The chain stops there; older versions stay readable.`
		)
		this.name = 'ArtifactCorruptError'
		this.artifactId = artifactId
		this.version = version
	}
}
