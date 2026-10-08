/**
 * Core semantics of the durable artifact store: append-only chain, restore as a
 * new head, optimistic concurrency, session scoping, quotas, and the on-disk
 * layout itself.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	ArtifactNotFoundError,
	ArtifactStore,
	INDEX_SCHEMA,
	PatchError,
	ROOT_ENV,
	StaleVersionError,
	StoreQuotaError,
	VersionNotFoundError,
	defaultStoreRoot,
	storePaths
} from '../../src/store/index.ts'
import type { StoreOptions } from '../../src/store/index.ts'
import { dropRoots, newRoot, steppingClock } from './helpers.ts'

const roots: string[] = []

function store(overrides: Partial<StoreOptions> = {}): ArtifactStore {
	const root = newRoot()
	roots.push(root)
	return new ArtifactStore({ root, now: steppingClock(), ...overrides })
}

afterEach(() => {
	dropRoots(roots)
})

/** sha256 of a string's exact UTF-8 bytes, computed independently of the store. */
function digest(text: string): string {
	return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

describe('create', () => {
	it('writes version 1 and returns the head record', () => {
		const instance = store()
		const source = '<p>one</p>'
		const record = instance.create({ sessionId: 's1', title: '  Demo  ', source, mode: 'wide' })

		expect(record.id).toMatch(/^art-[a-z0-9]{8}$/u)
		expect(record.version).toBe(1)
		expect(record.versionId).toBe(`${record.id}#1`)
		expect(record.parentVersionId).toBeNull()
		expect(record.title).toBe('Demo')
		expect(record.mode).toBe('wide')
		expect(record.source).toBe(source)
		expect(record.contentSha256).toBe(digest(source))
		expect(record.contentBytes).toBe(Buffer.byteLength(source, 'utf8'))
		expect(record.changelog).toBe('created')
		expect(record.render).toBe('reload')
		expect(record.versionCount).toBe(1)
		expect(record.sessionId).toBe('s1')
	})

	it('counts bytes, not characters', () => {
		const instance = store()
		const source = '<p>中文</p>'
		const record = instance.create({ title: '中文', source })
		expect(record.contentBytes).toBe(Buffer.byteLength(source, 'utf8'))
		expect(record.contentBytes).toBeGreaterThan(source.length)
		expect(instance.read(record.id).content).toBe(source)
	})

	it('falls back to a usable title and default mode', () => {
		const instance = store()
		const record = instance.create({ title: '   ', source: '<p>a</p>' })
		expect(record.title).toBe('Artifact')
		expect(record.mode).toBe('inline')
	})

	it('refuses an oversized source before writing anything', () => {
		const instance = store({ maxContentBytes: 8 })
		expect(() => instance.create({ source: 'x'.repeat(9) })).toThrow(StoreQuotaError)
		expect(instance.list()).toEqual([])
	})
})

describe('append-only version chain', () => {
	it('appends v2 and v3 without touching v1', () => {
		const instance = store()
		const v1 = instance.create({ sessionId: 's1', title: 'Chart', source: '<p>one</p>' })
		const v2 = instance.patch(v1.id, { oldText: 'one', newText: 'two' })
		const v3 = instance.patch(v1.id, { oldText: 'two', newText: 'three' })

		expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3])
		expect(v2.parentVersionId).toBe(v1.versionId)
		expect(v3.parentVersionId).toBe(v2.versionId)
		expect(v2.source).toBe('<p>two</p>')
		expect(v3.source).toBe('<p>three</p>')

		const versions = instance.versions(v1.id)
		expect(versions.map(version => version.versionNumber)).toEqual([1, 2, 3])
		expect(versions.map(version => version.contentSha256)).toEqual([v1.contentSha256, v2.contentSha256, v3.contentSha256])
		expect(versions[0]?.contentSha256).toBe(digest('<p>one</p>'))
		expect(instance.read(v1.id, 1).content).toBe('<p>one</p>')
		expect(instance.read(v1.id, 2).content).toBe('<p>two</p>')
		expect(instance.read(v1.id).content).toBe('<p>three</p>')
		expect(instance.read(v1.id).versionNumber).toBe(3)
	})

	it('keeps the title unless the caller changes it', () => {
		const instance = store()
		const v1 = instance.create({ title: 'Keep', source: '<p>a</p>' })
		expect(instance.patch(v1.id, { oldText: 'a', newText: 'b' }).title).toBe('Keep')
		expect(instance.patch(v1.id, { oldText: 'b', newText: 'c', title: 'New' }).title).toBe('New')
	})

	it('reconciles markup edits and reloads script edits', () => {
		const instance = store()
		const v1 = instance.create({ source: '<div id="x">a</div>' })
		expect(instance.patch(v1.id, { oldText: '>a<', newText: '>b<' }).render).toBe('reconcile')
		const scripted = instance.create({ source: '<div><script>let n=1<\/script></div>' })
		expect(instance.patch(scripted.id, { oldText: 'let n=1', newText: 'let n=2' }).render).toBe('reload')
	})

	it('delegates replacement semantics to src/patch.ts', () => {
		const instance = store()
		const v1 = instance.create({ source: '<i>a</i><i>a</i>' })
		expect(() => instance.patch(v1.id, { oldText: '', newText: 'x' })).toThrow(PatchError)
		expect(() => instance.patch(v1.id, { oldText: '<i>', newText: '<b>' })).toThrow(/appears 2 times/u)
		const patched = instance.patch(v1.id, { oldText: '<i>', newText: '<b>', replaceAll: true })
		expect(patched.source).toBe('<b>a</i><b>a</i>')
		expect(patched.version).toBe(2)
		expect(patched.changelog).toContain('patch')
	})

	it('appends a whole revision with append()', () => {
		const instance = store()
		const v1 = instance.create({ source: '<p>a</p>' })
		const v2 = instance.append(v1.id, { content: '<p>whole</p>', changelog: 'rewrote it' })
		expect(v2.version).toBe(2)
		expect(v2.source).toBe('<p>whole</p>')
		expect(v2.changelog).toBe('rewrote it')
		expect(v2.contentSha256).toBe(digest('<p>whole</p>'))
	})
})

describe('restore', () => {
	it('mints v4 from v1 and leaves v1..v3 bit-identical', () => {
		const instance = store()
		const v1 = instance.create({ sessionId: 's1', title: 'Chart', source: '<p>one</p>' })
		const v2 = instance.patch(v1.id, { oldText: 'one', newText: 'two' })
		const v3 = instance.patch(v1.id, { oldText: 'two', newText: 'three' })

		const v4 = instance.restore(v1.id, 1)
		expect(v4.version).toBe(4)
		expect(v4.parentVersionId).toBe(v3.versionId)
		expect(v4.source).toBe('<p>one</p>')
		expect(v4.contentSha256).toBe(v1.contentSha256)
		expect(v4.changelog).toBe('restored from v1')
		expect(v4.render).toBe('reload')

		expect(instance.read(v1.id).content).toBe('<p>one</p>')
		expect(instance.read(v1.id).versionNumber).toBe(4)
		expect(instance.read(v1.id, 1)).toMatchObject({ content: '<p>one</p>', versionNumber: 1, versionId: v1.versionId })
		expect(instance.read(v1.id, 2)).toMatchObject({ content: '<p>two</p>', versionNumber: 2, parentVersionId: v1.versionId })
		expect(instance.read(v1.id, 3)).toMatchObject({ content: '<p>three</p>', versionNumber: 3, parentVersionId: v2.versionId, contentSha256: v3.contentSha256 })
		expect(instance.versions(v1.id).map(version => version.versionNumber)).toEqual([1, 2, 3, 4])
		expect(instance.versions(v1.id).map(version => version.action)).toEqual(['create', 'patch', 'patch', 'restore'])
	})

	it('refuses a version that is not in the chain', () => {
		const instance = store()
		const v1 = instance.create({ source: '<p>a</p>' })
		expect(() => instance.restore(v1.id, 9)).toThrow(VersionNotFoundError)
		expect(instance.versions(v1.id)).toHaveLength(1)
	})
})

describe('optimistic concurrency', () => {
	it('refuses a stale expectedLatestVersion and appends nothing', () => {
		const instance = store()
		const v1 = instance.create({ source: '<p>one</p>' })
		const v2 = instance.patch(v1.id, { oldText: 'one', newText: 'two' })

		let raised: unknown
		try {
			instance.patch(v1.id, { oldText: 'two', newText: 'three', expectedLatestVersion: 1 })
		} catch (error) {
			raised = error
		}
		expect(raised).toBeInstanceOf(StaleVersionError)
		const stale = raised as StaleVersionError
		expect(stale.artifactId).toBe(v1.id)
		expect(stale.expected).toBe(1)
		expect(stale.actual).toBe(2)
		expect(stale.actualVersionId).toBe(v2.versionId)
		expect(stale.message).toContain('Nothing was written')

		expect(instance.read(v1.id).versionNumber).toBe(2)
		expect(instance.read(v1.id).content).toBe('<p>two</p>')
		expect(instance.versions(v1.id)).toHaveLength(2)
	})

	it('accepts the current head version', () => {
		const instance = store()
		const v1 = instance.create({ source: '<p>one</p>' })
		const v2 = instance.patch(v1.id, { oldText: 'one', newText: 'two', expectedLatestVersion: 1 })
		expect(v2.version).toBe(2)
		const v3 = instance.restore(v1.id, 2, { expectedLatestVersion: 2 })
		expect(v3.version).toBe(3)
	})

	it('is checked after another writer moved the head', () => {
		const root = newRoot()
		roots.push(root)
		const first = new ArtifactStore({ root })
		const second = new ArtifactStore({ root })
		const v1 = first.create({ sessionId: 's1', source: '<p>one</p>' })
		second.patch(v1.id, { oldText: 'one', newText: 'two' })
		expect(() => first.patch(v1.id, { oldText: 'one', newText: 'x', expectedLatestVersion: 1 })).toThrow(StaleVersionError)
		expect(() => first.patch(v1.id, { oldText: 'two', newText: 'three', expectedLatestVersion: 2 })).not.toThrow()
		expect(second.read(v1.id).content).toBe('<p>three</p>')
	})
})

describe('lookup failures', () => {
	it('reports an unknown artifact', () => {
		const instance = store()
		expect(() => instance.read('art-missing1')).toThrow(ArtifactNotFoundError)
		expect(() => instance.patch('art-missing1', { oldText: 'a', newText: 'b' })).toThrow(ArtifactNotFoundError)
		expect(instance.get('art-missing1')).toBeUndefined()
		expect(instance.has('art-missing1')).toBe(false)
	})

	it('reports a version that does not exist', () => {
		const instance = store()
		const v1 = instance.create({ source: '<p>a</p>' })
		expect(() => instance.read(v1.id, 7)).toThrow(VersionNotFoundError)
	})
})

describe('session scoping', () => {
	it('filters list by session and refuses cross-session writes', () => {
		const instance = store()
		const mine = instance.create({ sessionId: 's1', title: 'Mine', source: '<p>1</p>' })
		instance.create({ sessionId: 's2', title: 'Theirs', source: '<p>2</p>' })

		expect(instance.list('s1').map(entry => entry.id)).toEqual([mine.id])
		expect(instance.list('s2')).toHaveLength(1)
		expect(instance.list()).toHaveLength(2)
		expect(instance.list('s3')).toEqual([])

		expect(() => instance.patch(mine.id, { oldText: '1', newText: '9', sessionId: 's2' })).toThrow(ArtifactNotFoundError)
		expect(instance.read(mine.id).content).toBe('<p>1</p>')
		expect(instance.patch(mine.id, { oldText: '1', newText: '9', sessionId: 's1' }).version).toBe(2)
	})

	it('finds an artifact by title inside one session', () => {
		const instance = store()
		const mine = instance.create({ sessionId: 's1', title: 'Sales chart', source: '<p>a</p>' })
		instance.create({ sessionId: 's2', title: 'Sales chart', source: '<p>b</p>' })
		expect(instance.findByTitle('s1', 'Sales chart')?.id).toBe(mine.id)
		expect(instance.findByTitle('s3', 'Sales chart')).toBeUndefined()
	})
})

describe('caps and catalog', () => {
	it('caps artifacts per session', () => {
		const instance = store({ maxArtifactsPerSession: 2 })
		instance.create({ sessionId: 's1', source: '<p>1</p>' })
		instance.create({ sessionId: 's1', source: '<p>2</p>' })
		expect(() => instance.create({ sessionId: 's1', source: '<p>3</p>' })).toThrow(StoreQuotaError)
		expect(instance.create({ sessionId: 's2', source: '<p>3</p>' }).version).toBe(1)
		expect(instance.usage('s1')).toEqual({ artifacts: 2, bytes: 16 })
	})

	it('refuses a patch that would push the artifact over the byte cap', () => {
		const instance = store({ maxContentBytes: 16 })
		const v1 = instance.create({ source: '0123456789' })
		expect(() => instance.patch(v1.id, { oldText: '0123456789', newText: '0123456789abcdefg' })).toThrow(StoreQuotaError)
		expect(instance.read(v1.id).versionNumber).toBe(1)
		expect(instance.read(v1.id).content).toBe('0123456789')
	})

	it('summarizes usage from the catalog', () => {
		const instance = store()
		instance.create({ sessionId: 's1', source: '<p>one</p>' })
		const second = instance.create({ sessionId: 's1', source: '<p>two</p>' })
		instance.patch(second.id, { oldText: 'two', newText: 'three!' })
		expect(instance.usage('s1')).toEqual({ artifacts: 2, bytes: 10 + 13 })
	})
})

describe('destroy', () => {
	it('removes the artifact, its history and its catalog entry', () => {
		const instance = store()
		const v1 = instance.create({ sessionId: 's1', source: '<p>a</p>' })
		instance.patch(v1.id, { oldText: 'a', newText: 'b' })
		expect(existsSync(join(instance.directoryOf(v1.id), 'versions', 'v0002.html'))).toBe(true)

		expect(instance.destroy(v1.id)).toBe(true)
		expect(existsSync(instance.directoryOf(v1.id))).toBe(false)
		expect(instance.list('s1')).toEqual([])
		expect(() => instance.read(v1.id)).toThrow(ArtifactNotFoundError)
		expect(instance.destroy(v1.id)).toBe(false)
	})
})

describe('the default root', () => {
	it('points at the DSH storage directory and can be overridden', () => {
		const previous = process.env[ROOT_ENV]
		try {
			delete process.env[ROOT_ENV]
			expect(defaultStoreRoot()).toBe(join(homedir(), '.dsh', 'storages', 'dsh-genui'))
			expect(storePaths(defaultStoreRoot()).indexFile).toBe(join(homedir(), '.dsh', 'storages', 'dsh-genui', 'index.json'))
			process.env[ROOT_ENV] = '/tmp/dsh-genui-test-root'
			expect(defaultStoreRoot()).toBe('/tmp/dsh-genui-test-root')
		} finally {
			if (previous === undefined) delete process.env[ROOT_ENV]
			else process.env[ROOT_ENV] = previous
		}
	})
})

describe('on-disk format', () => {
	it('lays the store out as documented', () => {
		const instance = store()
		const v1 = instance.create({ sessionId: 's1', source: '<p>a</p>' })
		instance.patch(v1.id, { oldText: 'a', newText: 'b' })
		const tree = readdirSync(instance.root, { recursive: true, encoding: 'utf8' }).sort()
		expect(tree).toEqual([
			'artifacts',
			`artifacts/${v1.id}`,
			`artifacts/${v1.id}/versions`,
			`artifacts/${v1.id}/versions/v0001.html`,
			`artifacts/${v1.id}/versions/v0001.json`,
			`artifacts/${v1.id}/versions/v0002.html`,
			`artifacts/${v1.id}/versions/v0002.json`,
			'index.json',
			'locks'
		])
	})

	it('keeps content out of the index and in per-version files', () => {
		const instance = store()
		const secret = 'CONTENT-MUST-NOT-APPEAR-IN-THE-INDEX'
		const v1 = instance.create({ sessionId: 's1', title: 'T', source: `<p>${secret}</p>` })
		const v2 = instance.patch(v1.id, { oldText: secret, newText: 'replaced' })

		const indexRaw = readFileSync(instance.indexPath, 'utf8')
		expect(indexRaw).not.toContain(secret)
		expect(indexRaw).not.toContain('<p>')
		const index = JSON.parse(indexRaw) as { schema: string; updatedAt: number; artifacts: Record<string, { version: number; versionId: string; contentSha256: string; contentBytes: number; versionCount: number }> }
		expect(index.schema).toBe(INDEX_SCHEMA)
		expect(index.updatedAt).toBe(v2.updatedAt)
		expect(index.artifacts[v1.id]).toMatchObject({ version: 2, versionId: v2.versionId, contentSha256: v2.contentSha256, versionCount: 2 })

		const versionDir = join(instance.directoryOf(v1.id), 'versions')
		expect(existsSync(join(versionDir, 'v0001.html'))).toBe(true)
		expect(existsSync(join(versionDir, 'v0001.json'))).toBe(true)
		expect(readFileSync(join(versionDir, 'v0001.html'), 'utf8')).toBe(`<p>${secret}</p>`)
		expect(readFileSync(join(versionDir, 'v0002.html'), 'utf8')).toBe('<p>replaced</p>')

		const sidecar = JSON.parse(readFileSync(join(versionDir, 'v0002.json'), 'utf8')) as Record<string, unknown>
		expect(sidecar).toMatchObject({
			schema: 'dsh-genui.store-version/1',
			id: v1.id,
			versionNumber: 2,
			versionId: v2.versionId,
			parentVersionId: v1.versionId,
			contentFile: 'v0002.html',
			action: 'patch'
		})
	})

	it('records the digest of the bytes actually on disk', () => {
		const instance = store()
		const source = '<p>中文 &amp; <b>bold</b></p>\n<p>second</p>'
		const record = instance.create({ source })
		const raw = readFileSync(join(instance.directoryOf(record.id), 'versions', 'v0001.html'))
		expect(createHash('sha256').update(raw).digest('hex')).toBe(record.contentSha256)
		expect(raw.byteLength).toBe(record.contentBytes)
		expect(instance.verify(record.id)).toEqual({ id: record.id, versions: 1, checked: 1, mismatched: [], unreadable: [] })
	})

	it('leaves no lock file behind', () => {
		const instance = store()
		const v1 = instance.create({ source: '<p>a</p>' })
		instance.patch(v1.id, { oldText: 'a', newText: 'b' })
		expect(existsSync(instance.lockFile)).toBe(false)
	})

	it('leaves no temp files behind', () => {
		const instance = store()
		const v1 = instance.create({ source: '<p>a</p>' })
		instance.patch(v1.id, { oldText: 'a', newText: 'b' })
		instance.append(v1.id, { content: '<p>c</p>' })
		const entries = readdirSync(instance.root, { recursive: true, encoding: 'utf8' })
		expect(entries.filter(entry => entry.endsWith('.tmp'))).toEqual([])
		expect(entries.some(entry => entry.endsWith('v0003.html'))).toBe(true)
	})
})
