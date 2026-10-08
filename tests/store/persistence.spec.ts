/**
 * The reason this layer exists: an artifact written by one store instance must
 * stay readable **and patchable** by an instance that shares nothing with it but
 * the directory. These tests simulate an app restart three ways — a fresh
 * instance, a re-imported module, and a repaired index — because the old
 * in-memory registry passed none of them.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactStore, INDEX_SCHEMA, StaleVersionError, VersionNotFoundError } from '../../src/store/index.ts'
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

describe('a new instance over the same root', () => {
	it('reads the head and keeps patching after three writes', () => {
		const dir = root()
		// Constructed *before* any write: it holds no snapshot that could carry state.
		const bystander = new ArtifactStore({ root: dir })
		const writer = new ArtifactStore({ root: dir })

		const v1 = writer.create({ sessionId: 's1', title: 'Chart', source: '<p>v1</p>', mode: 'wide' })
		const v2 = writer.patch(v1.id, { oldText: 'v1', newText: 'v2' })
		const v3 = writer.patch(v1.id, { oldText: 'v2', newText: 'v3' })
		expect(v2.version).toBe(2)
		expect(v3.version).toBe(3)

		// "Restart": a brand-new instance, nothing inherited.
		const after = new ArtifactStore({ root: dir })
		expect(after.read(v1.id).content).toBe('<p>v3</p>')
		expect(after.read(v1.id).versionNumber).toBe(3)
		expect(after.versions(v1.id)).toHaveLength(3)
		expect(after.list('s1')).toHaveLength(1)
		expect(after.get(v1.id)).toMatchObject({ version: 3, title: 'Chart', mode: 'wide', source: '<p>v3</p>' })

		const v4 = after.patch(v1.id, { oldText: 'v3', newText: 'v4', expectedLatestVersion: 3 })
		expect(v4.version).toBe(4)
		expect(v4.parentVersionId).toBe(v3.versionId)

		// Every other instance sees the continuation too.
		expect(bystander.read(v1.id).content).toBe('<p>v4</p>')
		expect(bystander.versions(v1.id)).toHaveLength(4)
		expect(writer.read(v1.id).content).toBe('<p>v4</p>')
	})

	it('keeps a stale expectation stale across the restart', () => {
		const dir = root()
		const writer = new ArtifactStore({ root: dir })
		const v1 = writer.create({ sessionId: 's1', source: '<p>1</p>' })
		writer.patch(v1.id, { oldText: '1', newText: '2' })

		const after = new ArtifactStore({ root: dir })
		expect(() => after.patch(v1.id, { oldText: '2', newText: '3', expectedLatestVersion: 1 })).toThrow(StaleVersionError)
		expect(after.read(v1.id).versionNumber).toBe(2)
		expect(after.patch(v1.id, { oldText: '2', newText: '3', expectedLatestVersion: 2 }).version).toBe(3)
	})

	it('continues a chain with restore after the restart', () => {
		const dir = root()
		const writer = new ArtifactStore({ root: dir })
		const v1 = writer.create({ sessionId: 's1', source: '<p>one</p>' })
		writer.patch(v1.id, { oldText: 'one', newText: 'two' })

		const after = new ArtifactStore({ root: dir })
		const v3 = after.restore(v1.id, 1)
		expect(v3.version).toBe(3)
		expect(v3.source).toBe('<p>one</p>')
		expect(after.read(v1.id, 2).content).toBe('<p>two</p>')
		expect(new ArtifactStore({ root: dir }).read(v1.id).content).toBe('<p>one</p>')
	})
})

describe('a re-imported module over the same root', () => {
	it('reopens the chain from a fresh module instance', async () => {
		const dir = root()
		const first = await import('../../src/store/index.ts')
		const store = new first.ArtifactStore({ root: dir })
		const v1 = store.create({ sessionId: 's1', title: 'T', source: '<p>a</p>' })
		store.patch(v1.id, { oldText: 'a', newText: 'b' })

		vi.resetModules()
		const second = await import('../../src/store/index.ts')
		expect(second.ArtifactStore).not.toBe(first.ArtifactStore)

		const reopened = new second.ArtifactStore({ root: dir })
		expect(reopened.read(v1.id).content).toBe('<p>b</p>')
		expect(reopened.patch(v1.id, { oldText: 'b', newText: 'c', expectedLatestVersion: 2 }).version).toBe(3)

		// The original module instance, still alive, sees the new head.
		expect(new first.ArtifactStore({ root: dir }).read(v1.id).content).toBe('<p>c</p>')
	})
})

describe('a repaired index', () => {
	it('adopts a version the index never recorded and does not overwrite it', () => {
		const dir = root()
		const store = new ArtifactStore({ root: dir })
		const v1 = store.create({ sessionId: 's1', title: 'T', source: '<p>1</p>' })
		const v2 = store.patch(v1.id, { oldText: '1', newText: '2' })

		// Simulate a crash between the version write and the index swap: disk has
		// v2, the catalog still points at v1.
		const index = JSON.parse(readFileSync(store.indexPath, 'utf8')) as { artifacts: Record<string, Record<string, unknown>> }
		const entry = index.artifacts[v1.id]
		if (entry === undefined) throw new Error('index entry missing')
		index.artifacts[v1.id] = { ...entry, version: 1, versionId: v1.versionId, parentVersionId: null, contentSha256: v1.contentSha256, contentBytes: v1.contentBytes, versionCount: 1 }
		writeFileSync(store.indexPath, JSON.stringify(index, null, '\t'))

		const reopened = new ArtifactStore({ root: dir })
		expect(reopened.read(v1.id).content).toBe('<p>2</p>')
		const v3 = reopened.patch(v1.id, { oldText: '2', newText: '3' })
		expect(v3.version).toBe(3)
		// The un-indexed v2 was adopted, not overwritten.
		expect(reopened.read(v1.id, 2).contentSha256).toBe(v2.contentSha256)
		expect(reopened.read(v1.id, 2).action).toBe('patch')
	})

	it('rebuilds a lost index and keeps writing', () => {
		const dir = root()
		const store = new ArtifactStore({ root: dir })
		const v1 = store.create({ sessionId: 's1', title: 'T', source: '<p>1</p>' })
		store.patch(v1.id, { oldText: '1', newText: '2' })
		store.patch(v1.id, { oldText: '2', newText: '3' })
		rmSync(store.indexPath)

		const reopened = new ArtifactStore({ root: dir })
		expect(reopened.read(v1.id).content).toBe('<p>3</p>')
		expect(reopened.list('s1')).toEqual([]) // the catalog itself was lost

		const report = reopened.recover()
		expect(report.scanned).toBe(1)
		expect(report.adopted).toEqual([v1.id])
		expect(report.repaired).toEqual([])
		expect(reopened.list('s1')).toHaveLength(1)
		expect(reopened.get(v1.id)).toMatchObject({ version: 3, versionCount: 3, createdAt: v1.createdAt, source: '<p>3</p>' })

		const v4 = reopened.patch(v1.id, { oldText: '3', newText: '4', expectedLatestVersion: 3 })
		expect(v4.version).toBe(4)
		expect(new ArtifactStore({ root: dir }).read(v1.id, 4).content).toBe('<p>4</p>')
	})

	it('rebuilds from an unparseable index', () => {
		const dir = root()
		const store = new ArtifactStore({ root: dir })
		const v1 = store.create({ sessionId: 's1', title: 'T', source: '<p>a</p>' })
		writeFileSync(store.indexPath, '{"schema":"dsh-genui.store-index/1","artifacts":{"art-x":')

		const reopened = new ArtifactStore({ root: dir })
		expect(reopened.read(v1.id).content).toBe('<p>a</p>')
		const report = reopened.recover()
		expect(report.adopted).toEqual([v1.id])
		expect(JSON.parse(readFileSync(reopened.indexPath, 'utf8'))).toMatchObject({ schema: INDEX_SCHEMA })
		expect(reopened.patch(v1.id, { oldText: 'a', newText: 'b' }).version).toBe(2)
	})

	it('is idempotent and reports stray files without deleting them', () => {
		const dir = root()
		const store = new ArtifactStore({ root: dir })
		const v1 = store.create({ sessionId: 's1', source: '<p>a</p>' })
		store.patch(v1.id, { oldText: 'a', newText: 'b' })

		// A version whose sidecar never landed: the chain stops at v1.
		const versions = join(store.directoryOf(v1.id), 'versions')
		writeFileSync(join(versions, 'v0003.html'), '<p>orphan</p>')

		const first = new ArtifactStore({ root: dir }).recover()
		expect(first.corrupt).toEqual([`${v1.id}#3`])
		expect(first.repaired).toEqual([])
		expect(existsSync(join(versions, 'v0003.html'))).toBe(true)

		const second = new ArtifactStore({ root: dir }).recover()
		expect(second).toMatchObject({ scanned: 1, adopted: [], repaired: [], dropped: [], corrupt: [`${v1.id}#3`] })
	})

	it('stops at a version whose content file is gone, and refills that number later', () => {
		const dir = root()
		const store = new ArtifactStore({ root: dir })
		const v1 = store.create({ sessionId: 's1', source: '<p>1</p>' })
		const v2 = store.patch(v1.id, { oldText: '1', newText: '2' })
		rmSync(join(store.directoryOf(v1.id), 'versions', 'v0002.html'))

		const after = new ArtifactStore({ root: dir })
		// The last complete version is the head; a half-written one never is.
		expect(after.read(v1.id).content).toBe('<p>1</p>')
		expect(after.read(v1.id).versionNumber).toBe(1)
		expect(after.versions(v1.id)).toHaveLength(1)
		expect(() => after.read(v1.id, 2)).toThrow(VersionNotFoundError)
		expect(after.verify(v1.id)).toEqual({ id: v1.id, versions: 2, checked: 1, mismatched: [], unreadable: [2] })
		expect(after.recover()).toMatchObject({ corrupt: [`${v1.id}#2`], repaired: [v1.id], adopted: [] })
		expect(after.list('s1').map(entry => entry.version)).toEqual([1])

		// Version 2 was never durably committed, so it is not history: the next
		// write fills that number in again, and version 1 is untouched.
		const refilled = after.patch(v1.id, { oldText: '1', newText: 'healed' })
		expect(refilled.version).toBe(2)
		expect(refilled.versionId).toBe(v2.versionId)
		expect(refilled.contentSha256).not.toBe(v2.contentSha256)
		expect(after.read(v1.id, 1).content).toBe('<p>1</p>')
		expect(after.read(v1.id).content).toBe('<p>healed</p>')
		expect(after.verify(v1.id).mismatched).toEqual([])
	})

	it('reports content that no longer matches its digest', () => {
		const dir = root()
		const store = new ArtifactStore({ root: dir })
		const v1 = store.create({ sessionId: 's1', source: '<p>a</p>' })
		store.patch(v1.id, { oldText: 'a', newText: 'b' })
		writeFileSync(join(store.directoryOf(v1.id), 'versions', 'v0001.html'), '<p>tampered</p>')

		expect(new ArtifactStore({ root: dir }).verify(v1.id)).toEqual({ id: v1.id, versions: 2, checked: 2, mismatched: [1], unreadable: [] })
	})

	it('drops a catalog entry with nothing on disk behind it', () => {
		const dir = root()
		const store = new ArtifactStore({ root: dir })
		const kept = store.create({ sessionId: 's1', source: '<p>a</p>' })
		const index = JSON.parse(readFileSync(store.indexPath, 'utf8')) as { artifacts: Record<string, Record<string, unknown>> }
		const entry = index.artifacts[kept.id]
		if (entry === undefined) throw new Error('index entry missing')
		index.artifacts['art-ghost123'] = { ...entry, id: 'art-ghost123', versionId: 'art-ghost123#1', parentVersionId: null }
		writeFileSync(store.indexPath, JSON.stringify(index, null, '\t'))

		const report = new ArtifactStore({ root: dir }).recover()
		expect(report.scanned).toBe(1)
		expect(report.dropped).toEqual(['art-ghost123'])
		expect(report.adopted).toEqual([])
		expect(new ArtifactStore({ root: dir }).list('s1').map(row => row.id)).toEqual([kept.id])
	})
})
