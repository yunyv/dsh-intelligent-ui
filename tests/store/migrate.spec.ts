/**
 * Migration: an in-memory registry record becomes version 1 on disk, and a
 * second hand-off — including one after a restart — continues the artifact that
 * is already there instead of minting a look-alike the model could never patch
 * again.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactStore, ensureArtifact, importLegacyRecords } from '../../src/store/index.ts'
import type { LegacyArtifactRecord } from '../../src/store/index.ts'
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

/** One record as the in-memory registry held it. */
function legacy(overrides: Partial<LegacyArtifactRecord> = {}): LegacyArtifactRecord {
	return {
		id: 'art-legacy01',
		title: '旧卡片',
		html: '<p>hi</p>',
		version: 3,
		mode: 'inline',
		createdAt: 1_600_000_000_000,
		updatedAt: 1_600_000_009_000,
		...overrides
	}
}

describe('importLegacyRecords', () => {
	it('writes version 1 and is idempotent on a second hand-off', () => {
		const store = new ArtifactStore({ root: root() })
		const first = importLegacyRecords(store, [legacy()], { sessionId: 's1' })
		expect(first).toHaveLength(1)
		expect(first[0]?.action).toBe('imported')
		expect(first[0]?.id).toBe('art-legacy01')
		expect(first[0]?.record).toMatchObject({
			version: 1,
			versionId: 'art-legacy01#1',
			parentVersionId: null,
			sessionId: 's1',
			title: '旧卡片',
			source: '<p>hi</p>',
			createdAt: 1_600_000_000_000
		})

		const second = importLegacyRecords(store, [legacy()], { sessionId: 's1' })
		expect(second[0]?.action).toBe('reused')
		expect(second[0]?.record.version).toBe(1)
		expect(store.list('s1')).toHaveLength(1)
	})

	it('imports every record it is given, preserving input order', () => {
		const store = new ArtifactStore({ root: root() })
		const outcomes = importLegacyRecords(store, [
			legacy({ id: 'art-aaaa1111', title: 'A' }),
			legacy({ id: 'art-bbbb2222', title: 'B' })
		], { sessionId: 's1' })
		expect(outcomes.map(outcome => outcome.id)).toEqual(['art-aaaa1111', 'art-bbbb2222'])
		expect(store.list('s1')).toHaveLength(2)
		expect(store.read('art-bbbb2222').content).toBe('<p>hi</p>')
	})

	it('keeps writing on top of an import', () => {
		const store = new ArtifactStore({ root: root() })
		importLegacyRecords(store, [legacy()], { sessionId: 's1' })
		const patched = store.patch('art-legacy01', { oldText: 'hi', newText: 'ho' })
		expect(patched.version).toBe(2)
		expect(patched.source).toBe('<p>ho</p>')
		expect(store.read('art-legacy01', 1).content).toBe('<p>hi</p>')
	})

	it('reuses rather than rewinds after a restart', () => {
		const dir = root()
		const first = new ArtifactStore({ root: dir })
		importLegacyRecords(first, [legacy()], { sessionId: 's1' })
		first.patch('art-legacy01', { oldText: 'hi', newText: 'v2' })

		const after = new ArtifactStore({ root: dir })
		const outcome = importLegacyRecords(after, [legacy()], { sessionId: 's1' })
		expect(outcome[0]?.action).toBe('reused')
		expect(outcome[0]?.record.version).toBe(2)
		expect(outcome[0]?.record.source).toBe('<p>v2</p>')
		expect(after.versions('art-legacy01')).toHaveLength(2)
	})
})

describe('ensureArtifact', () => {
	it('adopts the artifact that already holds the same title in the session', () => {
		const store = new ArtifactStore({ root: root() })
		const live = store.create({ sessionId: 's1', title: '同名', source: '<p>disk</p>' })

		const outcome = ensureArtifact(store, legacy({ id: 'art-cccc3333', title: '同名', html: '<p>memory</p>' }), { sessionId: 's1' })
		expect(outcome.action).toBe('adopted')
		expect(outcome.id).toBe(live.id)
		expect(outcome.record.source).toBe('<p>disk</p>') // disk wins over memory
		expect(store.list('s1')).toHaveLength(1)
		expect(store.patch(live.id, { oldText: 'disk', newText: 'patched' }).source).toBe('<p>patched</p>')
	})

	it('does not adopt a same-title artifact from another session', () => {
		const store = new ArtifactStore({ root: root() })
		store.create({ sessionId: 's2', title: '同名', source: '<p>other</p>' })
		const outcome = ensureArtifact(store, legacy({ id: 'art-cccc3333', title: '同名' }), { sessionId: 's1' })
		expect(outcome.action).toBe('imported')
		expect(store.list('s1')).toHaveLength(1)
		expect(store.list('s2')).toHaveLength(1)
	})

	it('prefers an exact id match over a title match', () => {
		const store = new ArtifactStore({ root: root() })
		const exact = store.create({ id: 'art-legacy01', sessionId: 's1', title: 'Other', source: '<p>exact</p>' })
		const outcome = ensureArtifact(store, legacy(), { sessionId: 's1' })
		expect(outcome.action).toBe('reused')
		expect(outcome.id).toBe(exact.id)
		expect(outcome.record.source).toBe('<p>exact</p>')
	})
})
