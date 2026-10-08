/**
 * Writer-lock behaviour: the store's index is one whole-file document every
 * write read-modify-writes, so version allocation has to be mutually exclusive
 * across processes. These pin the three observable states — held, abandoned, and
 * released.
 */

import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore, PatchError, StoreLockedError, sleepSync } from '../../src/store/index.ts'
import { dropRoots, newRoot } from './helpers.ts'

const roots: string[] = []

function root(): string {
	const made = newRoot()
	roots.push(made)
	return made
}

afterEach(() => {
	dropRoots(roots)
})

/** Simulate another process holding the lock. */
function holdForeignLock(store: ArtifactStore, ageMs = 0): void {
	mkdirSync(dirname(store.lockFile), { recursive: true })
	writeFileSync(store.lockFile, `${JSON.stringify({ pid: 999_999, at: Date.now() })}\n`)
	if (ageMs > 0) {
		const when = new Date(Date.now() - ageMs)
		utimesSync(store.lockFile, when, when)
	}
}

describe('store lock', () => {
	it('refuses to write while a live foreign lock is held', () => {
		const store = new ArtifactStore({ root: root(), lockTimeoutMs: 0 })
		const v1 = store.create({ sessionId: 's1', source: '<p>1</p>' })
		holdForeignLock(store)

		let raised: unknown
		try {
			store.patch(v1.id, { oldText: '1', newText: '2' })
		} catch (error) {
			raised = error
		}
		expect(raised).toBeInstanceOf(StoreLockedError)
		expect((raised as StoreLockedError).lockFile).toBe(store.lockFile)
		expect(store.read(v1.id).versionNumber).toBe(1)

		rmSync(store.lockFile)
		expect(store.patch(v1.id, { oldText: '1', newText: '2' }).version).toBe(2)
	})

	it('also refuses to read the catalog as free, but reads stay available', () => {
		const store = new ArtifactStore({ root: root(), lockTimeoutMs: 0 })
		const v1 = store.create({ source: '<p>1</p>' })
		holdForeignLock(store)
		expect(() => store.create({ source: '<p>2</p>' })).toThrow(StoreLockedError)
		expect(store.read(v1.id).content).toBe('<p>1</p>')
		expect(store.versions(v1.id)).toHaveLength(1)
		expect(store.list()).toHaveLength(1)
	})

	it('takes over an abandoned lock', () => {
		const store = new ArtifactStore({ root: root(), staleLockMs: 50, lockTimeoutMs: 500 })
		const v1 = store.create({ source: '<p>1</p>' })
		holdForeignLock(store, 60_000)
		expect(store.patch(v1.id, { oldText: '1', newText: '2' }).version).toBe(2)
		expect(existsSync(store.lockFile)).toBe(false)
	})

	it('does not take over a lock that is merely young', () => {
		const store = new ArtifactStore({ root: root(), staleLockMs: 60_000, lockTimeoutMs: 0 })
		const v1 = store.create({ source: '<p>1</p>' })
		holdForeignLock(store, 0)
		expect(() => store.patch(v1.id, { oldText: '1', newText: '2' })).toThrow(StoreLockedError)
		expect(store.read(v1.id).versionNumber).toBe(1)
	})

	it('gives up after the timeout instead of waiting forever', () => {
		const store = new ArtifactStore({ root: root(), lockTimeoutMs: 120, staleLockMs: 60_000 })
		const v1 = store.create({ source: '<p>1</p>' })
		holdForeignLock(store)
		const started = Date.now()
		expect(() => store.patch(v1.id, { oldText: '1', newText: '2' })).toThrow(StoreLockedError)
		expect(Date.now() - started).toBeGreaterThanOrEqual(100)
		expect(store.read(v1.id).versionNumber).toBe(1)
	})

	it('releases the lock after a failed write', () => {
		const store = new ArtifactStore({ root: root(), lockTimeoutMs: 0 })
		const v1 = store.create({ source: '<p>1</p>' })
		expect(() => store.patch(v1.id, { oldText: 'absent', newText: 'x' })).toThrow(PatchError)
		expect(existsSync(store.lockFile)).toBe(false)
		expect(store.patch(v1.id, { oldText: '1', newText: '2' }).version).toBe(2)
	})
})

describe('sleepSync', () => {
	it('blocks without spinning the CPU', () => {
		const started = Date.now()
		sleepSync(20)
		expect(Date.now() - started).toBeGreaterThanOrEqual(15)
		// A second call on the same shared cell is a no-op for zero durations.
		sleepSync(0)
	})
})
