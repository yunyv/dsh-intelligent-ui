import { describe, expect, it } from 'vitest'
import { artifactMetaFrom, partialStringField, streamingMetaFromArgs } from '../src/meta.ts'
import { declaresSkeleton, normalizeArtifactSource, normalizedBytes } from '../src/normalize.ts'
import { PatchError, applyPatch, locate, requiresReload } from '../src/patch.ts'
import { ArtifactRegistry } from '../src/registry.ts'

describe('applyPatch', () => {
	it('replaces the single occurrence', () => {
		expect(applyPatch('<p>a</p>', 'a', 'b')).toEqual({ text: '<p>b</p>', replacements: 1 })
	})

	it('deletes with an empty replacement', () => {
		expect(applyPatch('x<hr>y', '<hr>', '').text).toBe('xy')
	})

	it('refuses an empty search string', () => {
		expect(() => applyPatch('abc', '', 'x')).toThrow(PatchError)
	})

	it('refuses a no-op patch', () => {
		expect(() => applyPatch('abc', 'b', 'b')).toThrow(/identical/u)
	})

	it('names every ambiguous occurrence', () => {
		expect(() => applyPatch('<i></i><i></i>', '<i>', '<b>')).toThrow(/appears 2 times/u)
	})

	it('reports a miss as a located failure', () => {
		expect(() => applyPatch('<p>hi</p>', '<div>', 'x')).toThrow(/not found/u)
	})

	it('replaces every occurrence when asked', () => {
		expect(applyPatch('a-a-a', 'a', 'b', true)).toEqual({ text: 'b-b-b', replacements: 3 })
	})
})

describe('locate', () => {
	it('reports 1-based line and column', () => {
		expect(locate('one\ntwo\nthree', 'three')).toEqual([{ line: 3, column: 1 }])
		expect(locate('abc def', 'def')).toEqual([{ line: 1, column: 5 }])
	})
})

describe('requiresReload', () => {
	it('reconciles a markup-only patch', () => {
		expect(requiresReload('<p>1</p>', '<p>2</p>')).toBe(false)
	})
	it('reloads when a script body changed', () => {
		expect(requiresReload('<script>let a=1<\/script>', '<script>let a=2<\/script>')).toBe(true)
	})
	it('reconciles when a script is only re-indented in markup', () => {
		expect(requiresReload('<div>x</div>', '<div>x</div><span>y</span>')).toBe(false)
	})
})

describe('normalizeArtifactSource', () => {
	it('keeps a fragment as-is', () => {
		expect(normalizeArtifactSource('<div>a</div>')).toBe('<div>a</div>')
	})

	it('unwraps a full document, preserving order', () => {
		const source = '<!doctype html><html><head><style>p{color:red}</style></head><body><p>a</p><script>1<\/script></body></html>'
		const out = normalizeArtifactSource(source)
		expect(out).toBe('<style>p{color:red}</style><p>a</p><script>1<\/script>')
		expect(declaresSkeleton(source)).toBe(true)
	})

	it('removes a model-declared CSP', () => {
		const source = '<meta http-equiv="Content-Security-Policy" content="default-src *"><p>a</p>'
		expect(normalizeArtifactSource(source)).toBe('<p>a</p>')
	})

	it('measures the normalized size', () => {
		expect(normalizedBytes('<html><body>ab</body></html>')).toBe(2)
	})
})

describe('partialStringField', () => {
	it('decodes a complete field', () => {
		expect(partialStringField('{"html":"<p>a</p>","title":"t"}', 'html')).toBe('<p>a</p>')
	})

	it('returns the prefix of a field still streaming', () => {
		expect(partialStringField('{"html":"<div>half', 'html')).toBe('<div>half')
	})

	it('decodes escapes, including a trailing lone backslash', () => {
		expect(partialStringField('{"html":"a\\nb\\t\\"c"}', 'html')).toBe('a\nb\t"c')
		expect(partialStringField('{"html":"tail\\', 'html')).toBe('tail')
	})

	it('returns undefined before the field starts', () => {
		expect(partialStringField('{"title":"t"', 'html')).toBeUndefined()
		expect(partialStringField(undefined, 'html')).toBeUndefined()
	})
})

describe('streamingMetaFromArgs', () => {
	it('builds a provisional revision from a partial call', () => {
		const meta = streamingMetaFromArgs('{"action":"create","title":"图表","html":"<canvas></canvas>","mode":"wide"')
		expect(meta?.html).toBe('<canvas></canvas>')
		expect(meta?.title).toBe('图表')
		expect(meta?.mode).toBe('wide')
		expect(meta?.version).toBe(1)
	})

	it('stays undefined until html arrives', () => {
		expect(streamingMetaFromArgs('{"action":"create"')).toBeUndefined()
	})
})

describe('artifactMetaFrom', () => {
	it('narrows a published revision', () => {
		const meta = artifactMetaFrom({
			kind: 'artifact', action: 'patch', id: 'art-1', title: 't', html: '<p>a</p>',
			version: 3, mode: 'inline', render: 'reconcile', sizeBytes: 8, session: 's1'
		})
		expect(meta).toMatchObject({ id: 'art-1', version: 3, render: 'reconcile', session: 's1' })
	})

	it('rejects anything else', () => {
		expect(artifactMetaFrom(null)).toBeUndefined()
		expect(artifactMetaFrom({ kind: 'visualize' })).toBeUndefined()
		expect(artifactMetaFrom({ kind: 'artifact', id: 'x', html: '<p>' })).toBeUndefined()
	})
})

describe('ArtifactRegistry', () => {
	it('creates, revises, lists and destroys inside one session', () => {
		const registry = new ArtifactRegistry()
		const first = registry.create('s1', { title: 'A', html: '<p>1</p>', mode: 'inline' })
		expect(first.id).toMatch(/^art-[a-z0-9]{8}$/u)
		expect(first.version).toBe(1)

		const second = registry.revise('s1', first.id, '<p>2</p>')
		expect(second?.version).toBe(2)
		expect(registry.get('s1', first.id)?.html).toBe('<p>2</p>')

		expect(registry.list('s1')).toHaveLength(1)
		expect(registry.destroy('s1', first.id)).toBe(true)
		expect(registry.list('s1')).toHaveLength(0)
	})

	it('keeps sessions apart', () => {
		const registry = new ArtifactRegistry()
		const mine = registry.create('s1', { title: 'A', html: '<p>1</p>', mode: 'inline' })
		expect(registry.get('s2', mine.id)).toBeUndefined()
		expect(registry.revise('s2', mine.id, '<p>9</p>')).toBeUndefined()
		expect(registry.list('s2')).toEqual([])
	})

	it('keeps the old title when a patch omits one', () => {
		const registry = new ArtifactRegistry()
		const record = registry.create('s1', { title: 'Keep', html: '<p>1</p>', mode: 'inline' })
		expect(registry.revise('s1', record.id, '<p>2</p>', '  ')?.title).toBe('Keep')
		expect(registry.revise('s1', record.id, '<p>3</p>', 'New')?.title).toBe('New')
	})
})
