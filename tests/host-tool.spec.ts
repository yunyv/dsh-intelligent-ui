/**
 * Host-side integration: drive the real tool, through its real execute, against
 * a real store on a real temporary disk.
 *
 * The unit suites check the compiler, the store and the client separately. This
 * is the only place the three meet the way production meets them — an argument
 * object in, a revision out, and a session log that has to keep working after
 * the process that wrote it is gone.
 *
 * @module dsh-genui/tests/host-tool
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../src/store/index.ts'
import { runArtifact, type ToolConfig } from '../src/tool.ts'

/** A DIL document shaped like one a model actually writes. */
const DIL = `给团队订阅算一笔账。

{@body const [seats,setSeats] = DIL.useState(5)}
{@body const [yearly,setYearly] = DIL.useState(false)}
{@body const unit = 20 * (yearly ? 10 : 12)}
{@body const total = unit * seats}
<box gap={4}>
  <title size="lg">团队订阅成本</title>
  <slider label="席位" value={seats} onChange={setSeats} min={1} max={50}/>
  <checkbox checked={yearly} onChange={setYearly}>按年付费</checkbox>
  <title size="xl" tabularNums>\${total.toLocaleString()}</title>
</box>`

const HTML = '<div class="card"><button>示例</button></div>'

let root: string
let config: ToolConfig

/** One call of the real tool: the same entry point the harness binds. */
type Run = (args: Record<string, unknown>, sessionId?: string) => Promise<{ note: string, meta: unknown }>

/** A catalog over the current temp root, recovered the way the plugin does at load. */
function open(): ArtifactStore {
	const store = new ArtifactStore({ root, maxArtifactsPerSession: config.maxArtifactsPerSession, maxContentBytes: config.maxSourceBytes })
	store.recover()
	return store
}

/** Bind the tool entry point to one catalog. */
function bind(store: ArtifactStore): Run {
	return (args, sessionId = 'session-1') => runArtifact(store, config, args, sessionId)
}

/** A fresh catalog and a call bound to it. */
function tool(): { run: Run, store: ArtifactStore } {
	const store = open()
	return { run: bind(store), store }
}

/** Read the revision metadata out of a tool result. */
function metaOf(result: { meta: unknown }): Record<string, unknown> {
	const meta = result.meta
	if (meta === null || typeof meta !== 'object') throw new Error('expected a meta payload')
	return meta as Record<string, unknown>
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'dsh-genui-host-'))
	config = {
		maxSourceBytes: 2_000_000,
		maxArtifactsPerSession: 40,
		includeDegradedText: true
	}
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

describe('create', () => {
	it('compiles a DIL document and publishes a renderable revision', async () => {
		const { run } = tool()
		const result = await run({ action: 'create', title: '订阅成本', source: DIL })
		const meta = metaOf(result)

		expect(meta.engine).toBe('dil')
		expect(meta.action).toBe('create')
		expect(meta.title).toBe('订阅成本')
		expect(meta.version).toBe(1)
		// The compiled program is what the sandbox runs, so an empty one means the
		// card would mount and render nothing.
		const dil = meta.dil as { code: string, stateKeys: string[], fallbackMarkdown: string } | undefined
		expect(dil?.code).toContain('DIL.render(')
		expect(dil?.stateKeys).toEqual(['seats', 'yearly'])
		expect(dil?.fallbackMarkdown).toContain('团队订阅成本')
		// The store's own bookkeeping rides the revision, so a later turn can tell
		// two revisions apart without comparing payloads.
		expect(typeof meta.contentSha256).toBe('string')
		expect(meta.contentBytes).toBeGreaterThan(0)
		expect(meta.versionNumber).toBe(1)
	})

	it('states the marker the model has to write, and only the id goes in it', async () => {
		const { run } = tool()
		const result = await run({ action: 'create', source: DIL })
		const id = metaOf(result).id as string
		expect(id).toMatch(/^art-[a-z0-9]{4,}$/u)
		expect(result.note).toContain('```dsh-artifact')
		expect(result.note).toContain(id)
		// The source must never travel in the marker: the fence is a position, not a
		// payload, which is what keeps a megabyte of markup out of the answer text.
		expect(result.note).not.toContain('<box')
	})

	it('appends the markdown projection, and can be told not to', async () => {
		const withText = await tool().run({ action: 'create', source: DIL })
		expect(withText.note).toContain('团队订阅成本')

		config = { ...config, includeDegradedText: false }
		const without = await tool().run({ action: 'create', source: DIL })
		// The confirmation still names the artifact; only the projection is dropped.
		expect(without.note).toContain('Created')
		expect(without.note).not.toContain('plain-text rendering')
	})

	it('takes the escape hatch verbatim and marks the revision as HTML', async () => {
		const { run } = tool()
		const result = await run({ action: 'create', engine: 'html', html: HTML })
		const meta = metaOf(result)
		expect(meta.engine).toBe('html')
		expect(meta.html).toBe(HTML)
		expect(meta.dil).toBeUndefined()
	})

	it('refuses a document over the cap without taking a version number', async () => {
		config = { ...config, maxSourceBytes: 200 }
		const { run, store } = tool()
		await expect(run({ action: 'create', source: DIL })).rejects.toThrow(/exceeds the/u)
		expect(store.list()).toHaveLength(0)
	})

	it('names the missing argument rather than storing an empty artifact', async () => {
		const { run } = tool()
		await expect(run({ action: 'create', title: 'x' })).rejects.toThrow(/"source" is required/u)
	})
})

describe('patch', () => {
	it('recompiles the stored document and keeps the path it was created with', async () => {
		const { run } = tool()
		const created = await run({ action: 'create', title: '订阅成本', source: DIL })
		const id = metaOf(created).id as string

		const patched = await run({
			action: 'patch',
			id,
			old_string: 'const unit = 20 * (yearly ? 10 : 12)',
			new_string: 'const unit = 25 * (yearly ? 10 : 12)'
		})
		const meta = metaOf(patched)

		expect(meta.action).toBe('patch')
		expect(meta.version).toBe(2)
		expect(meta.engine).toBe('dil')
		expect(meta.parentVersionId).toBe(`${id}#1`)
		// A patch recompiles: the running interface is pushed a new program, not a
		// re-rendered copy of the old one.
		const dil = meta.dil as { code: string } | undefined
		expect(dil?.code).toContain('25 *')
		expect(meta.contentSha256).not.toBe(metaOf(created).contentSha256)
	})

	it('reports a bad match with the location, and changes nothing', async () => {
		const { run } = tool()
		const created = await run({ action: 'create', source: DIL })
		const id = metaOf(created).id as string

		await expect(run({ action: 'patch', id, old_string: '<nosuchtag>', new_string: 'x' }))
			.rejects.toThrow(/not found/u)
		const after = await run({ action: 'read', id })
		// Still version 1: a failed patch must not advance the head.
		expect(after.note).toContain('v1')
	})

	it('lists the known ids when the model patches something it invents', async () => {
		const { run } = tool()
		await run({ action: 'create', title: '甲', source: DIL })
		await expect(run({ action: 'patch', id: 'art-doesnotexist', old_string: 'a', new_string: 'b' }))
			.rejects.toThrow(/Known ids:/u)
	})

	it('does not reach an artifact owned by another session', async () => {
		const store = open()
		const run = bind(store)
		const created = await run({ action: 'create', source: DIL }, 'session-a')
		const id = metaOf(created).id as string
		await expect(run({ action: 'patch', id, old_string: 'a', new_string: 'b' }, 'session-b'))
			.rejects.toThrow(/unknown id/u)
	})
})

describe('after a restart', () => {
	it('reads and patches an artifact the previous process created', async () => {
		const first = tool()
		const created = await first.run({ action: 'create', title: '订阅成本', source: DIL })
		const id = metaOf(created).id as string
		await first.run({ action: 'patch', id, old_string: 'DIL.useState(5)', new_string: 'DIL.useState(9)' })

		// A new store over the same root, with no reference to the previous one, is
		// what a Host restart looks like. This is the bug the on-disk layer exists to
		// fix: before it, the transcript still showed the card and the model could no
		// longer touch it.
		const second = tool()
		const listed = await second.run({ action: 'list' })
		expect(listed.note).toContain(id)
		expect(listed.note).toContain('v2')

		const read = await second.run({ action: 'read', id })
		expect(read.note).toContain('DIL.useState(9)')

		const patched = await second.run({ action: 'patch', id, old_string: '20 *', new_string: '30 *' })
		expect(metaOf(patched).version).toBe(3)
		expect(metaOf(patched).parentVersionId).toBe(`${id}#2`)
	})

	it('keeps history addressable, so a revision can be restored', async () => {
		const first = tool()
		const created = await first.run({ action: 'create', source: DIL })
		const id = metaOf(created).id as string
		await first.run({ action: 'patch', id, old_string: 'DIL.useState(5)', new_string: 'DIL.useState(7)' })

		const { store } = tool()
		expect(store.versions(id)).toHaveLength(2)
		expect(store.read(id, 1).content).toContain('DIL.useState(5)')
		// Restore appends; it never rewrites what already happened.
		const restored = store.restore(id, 1)
		expect(restored.version).toBe(3)
		expect(store.read(id, 1).content).toContain('DIL.useState(5)')
	})
})

describe('list and destroy', () => {
	it('enumerates this session and forgets a destroyed artifact', async () => {
		const { run } = tool()
		const created = await run({ action: 'create', title: '甲', source: DIL })
		const id = metaOf(created).id as string

		expect((await run({ action: 'list' })).note).toContain('甲')
		expect((await run({ action: 'destroy', id })).note).toContain('Destroyed')
		expect((await run({ action: 'list' })).note).toContain('No artifacts')
	})
})

describe('the ordered arguments on the raw path', () => {
	it('stores one document with the stylesheet ahead of the markup', async () => {
		const { run } = tool()
		const created = await run({ action: 'create', engine: 'html', css: '.card { color: red }', html: HTML })
		const source = metaOf(created).html as string
		expect(source.startsWith('<style>')).toBe(true)
		expect(source.indexOf('.card { color: red }')).toBeLessThan(source.indexOf('<div class="card">'))
	})

	it('reads it back in the same order, so replay needs no second field', async () => {
		const { run } = tool()
		const created = await run({ action: 'create', engine: 'html', css: '.a { color: red }', html: HTML })
		const id = metaOf(created).id as string
		const read = await run({ action: 'read', id })
		expect(read.note.indexOf('<style>')).toBeLessThan(read.note.indexOf('<div class="card">'))
	})

	it('leaves the document untouched when there is no stylesheet', async () => {
		const { run } = tool()
		const created = await run({ action: 'create', engine: 'html', html: HTML })
		expect(metaOf(created).html).toBe(HTML)
	})
})
