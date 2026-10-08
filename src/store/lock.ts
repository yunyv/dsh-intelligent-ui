/**
 * One writer at a time, across processes: an `O_EXCL` lock file at the store
 * root, taken over when its holder died.
 *
 * The store's index is a single whole-file document that every write
 * read-modify-writes, so the version-number allocation and the index update have
 * to be mutually exclusive — without this, two writers could both allocate
 * version N and one would silently overwrite the other's content. Optimistic
 * `expectedLatestVersion` catches a *logical* race the caller knew about; this
 * lock catches the physical one it could not.
 * @module dsh-genui/store/lock
 */

import { openSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { StoreLockedError } from './errors.ts'
import { closeQuietly, ensureDir, isMissing } from './io.ts'

/** Lock acquisition tuning. */
export interface LockOptions {
	/** Total wait before {@link StoreLockedError}. `0` means try once. */
	timeoutMs: number
	/** Age past which a lock file is presumed abandoned and taken over. */
	staleMs: number
	/** Injectable clock, epoch milliseconds. */
	now: () => number
}

/** A held lock. Always release it in a `finally`. */
export interface LockHandle {
	release(): void
}

/** Shared futex for {@link sleepSync}; Node allows `Atomics.wait` on the main thread. */
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4))

/** Block the current thread without burning CPU. */
export function sleepSync(ms: number): void {
	if (ms <= 0) return
	try {
		Atomics.wait(SLEEP_CELL, 0, 0, ms)
	} catch {
		const until = Date.now() + ms
		while (Date.now() < until) { /* fallback spin */ }
	}
}

/**
 * Take the store lock.
 * @param lockFile - lock path; its directory is created on demand.
 * @param options - timeout, staleness and clock.
 * @returns the held lock.
 * @throws {StoreLockedError} when a live holder keeps it past `timeoutMs`.
 */
export function acquireLock(lockFile: string, options: LockOptions): LockHandle {
	ensureDir(dirname(lockFile))
	const startedAt = options.now()
	for (;;) {
		let fd: number | undefined
		try {
			fd = openSync(lockFile, 'wx')
			writeSync(fd, `${JSON.stringify({ pid: process.pid, at: options.now() })}\n`)
			closeQuietly(fd)
			let released = false
			return {
				release(): void {
					if (released) return
					released = true
					try {
						unlinkSync(lockFile)
					} catch (error) {
						if (!isMissing(error)) throw error
					}
				}
			}
		} catch (error) {
			if (fd !== undefined) closeQuietly(fd)
			if (!isHeld(error)) throw error
		}
		let ageMs: number
		try {
			ageMs = options.now() - statSync(lockFile).mtimeMs
		} catch (error) {
			// The holder released between our open and our stat: retry immediately.
			if (isMissing(error)) continue
			throw error
		}
		if (ageMs > options.staleMs) {
			try {
				unlinkSync(lockFile)
			} catch {
				/* another waiter got there first */
			}
			continue
		}
		const waitedMs = options.now() - startedAt
		if (waitedMs >= options.timeoutMs) throw new StoreLockedError(lockFile, waitedMs)
		sleepSync(Math.min(25, Math.max(1, options.timeoutMs - waitedMs)))
	}
}

/** Run `body` under the store lock. */
export function withLock<T>(lockFile: string, options: LockOptions, body: () => T): T {
	const lock = acquireLock(lockFile, options)
	try {
		return body()
	} finally {
		lock.release()
	}
}

/** Whether one thrown value means "the lock file already exists". */
function isHeld(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === 'EEXIST'
}
