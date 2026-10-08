// @vitest-environment node
/**
 * The sandbox worker, executed.
 *
 * The shipped `WORKER_SOURCE` is the only thing that ever evaluates model-authored code,
 * so this file boots it the way a Worker would — `self`, `postMessage`, two
 * `MessageChannel`s — and drives one compiled program end to end: first render,
 * handler round trip, keyed-state report, in-place recompile, and the failure paths.
 *
 * Nothing here loads React: the worker carries its own tiny runtime, and that runtime
 * is what these assertions are about.
 */
import { describe, expect, it } from 'vitest'
import { bootSandbox } from './support/worker-harness.ts'

/** A compiled program in the dialect the compiler emits. */
function program(body: string): string {
	return [
		'DIL.render(__dil.jsx(function __body() {',
		'\tconst [n, setN] = DIL.useState(1, {key: "n"});',
		'\tconst constants = DIL.useConstants();',
		'\tconst appData = DIL.useAppData((data) => data.tag ?? "none");',
		`\t${body}`,
		'}, {key: "body:0"}));'
	].join('\n')
}

const INITIAL_BODY = `
	return __dil.jsx("box", {gap: 2},
		__dil.jsx("text", null, "count " + n),
		__dil.jsx("text", null, "constant " + constants.label),
		__dil.jsx("text", null, "appdata " + appData),
		__dil.jsx("button", {onClick: () => setN(n + 1)}, "inc"));`

describe('the shipped worker', () => {
	it('announces itself and its protocol version', () => {
		const sandbox = bootSandbox()
		try {
			expect(sandbox.posted[0]).toMatchObject({ __dilWorker: true, kind: 'ready', protocolVersion: 1 })
		} finally {
			sandbox.close()
		}
	})
})

describe('running a compiled program', () => {
	it('renders a tree, with constants and appData read through the hook surface', async () => {
		const sandbox = bootSandbox()
		try {
			await sandbox.createRunner({
				compiledDil: program(INITIAL_BODY),
				constants: { label: 'seven' },
				appData: { tag: 'host' }
			})
			const tree = sandbox.latestTree()
			expect(tree).toMatchObject({ t: 'box' })
			expect(sandbox.treeText()).toBe('count 1 constant seven appdata host inc')
			// A serialized tree is data: no functions, only handler references.
			expect(sandbox.collectHandlers()).toHaveLength(1)
			expect(sandbox.latest?.reason).toBe('initial')
		} finally {
			sandbox.close()
		}
	})

	it('serializes fragments and drops empty children', async () => {
		const sandbox = bootSandbox()
		try {
			await sandbox.createRunner({
				compiledDil: 'DIL.render(__dil.jsx("box", null, "a", null, false, __dil.jsx(DIL.Fragment, null, "b", "c")));'
			})
			expect(sandbox.latestTree()).toMatchObject({
				t: 'box',
				c: [{ t: '#text', v: 'a' }, { t: '#frag', c: [{ t: '#text', v: 'b' }, { t: '#text', v: 'c' }] }]
			})
		} finally {
			sandbox.close()
		}
	})
})

describe('the event round trip', () => {
	it('runs the handler that the tree references and renders the result', async () => {
		const sandbox = bootSandbox()
		try {
			await sandbox.createRunner({ compiledDil: program(INITIAL_BODY), constants: { label: 'x' } })
			const [fnId] = sandbox.collectHandlers()
			expect(fnId).toBeDefined()
			await sandbox.trigger(fnId!, [])
			expect(sandbox.treeText()).toContain('count 2')
			// The handler call renders once immediately (`event`) and once more from the
			// state change it caused (`setState`); both carry the same tree.
			expect(sandbox.snapshots.some((message) => message.reason === 'event')).toBe(true)
			expect(sandbox.latest?.version).toBeGreaterThan(1)
		} finally {
			sandbox.close()
		}
	})

	it('reports the keyed state after the change, which is what the host persists', async () => {
		const sandbox = bootSandbox()
		try {
			await sandbox.createRunner({ compiledDil: program(INITIAL_BODY), constants: { label: 'x' } })
			await sandbox.trigger(sandbox.collectHandlers()[0]!, [])
			const change = sandbox.stateChanges.at(-1)
			expect(change).toMatchObject({ kind: 'stateChanged', scope: 'root', state: { n: 2 } })
			expect(change?.reason).toBe('event')
		} finally {
			sandbox.close()
		}
	})

	it('seeds keyed state from the snapshot a previous session saved', async () => {
		const sandbox = bootSandbox()
		try {
			await sandbox.createRunner({ compiledDil: program(INITIAL_BODY), constants: { label: 'x' }, initialState: { n: 41 } })
			expect(sandbox.treeText()).toContain('count 41')
			expect(sandbox.stateChanges.at(-1)?.state).toMatchObject({ n: 41 })
		} finally {
			sandbox.close()
		}
	})

	it('answers a state request with every keyed slot', async () => {
		const sandbox = bootSandbox()
		try {
			await sandbox.createRunner({ compiledDil: program(INITIAL_BODY), constants: { label: 'x' }, initialState: { n: 3 } })
			const state = await sandbox.requestState()
			expect(state.state).toEqual({ n: 3 })
		} finally {
			sandbox.close()
		}
	})

	it('reports an unknown handler instead of throwing into the void', async () => {
		const sandbox = bootSandbox()
		try {
			await sandbox.createRunner({ compiledDil: program(INITIAL_BODY), constants: { label: 'x' } })
			await sandbox.trigger('fn404', [])
			expect(sandbox.failures.at(-1)).toMatchObject({ kind: 'failure', stage: 'event' })
			expect(String(sandbox.failures.at(-1)?.error?.message)).toContain('fn404')
		} finally {
			sandbox.close()
		}
	})
})

describe('streaming recompiles', () => {
	it('replaces the program in place and reports the new tree as a source change', async () => {
		const sandbox = bootSandbox()
		try {
			await sandbox.createRunner({ compiledDil: program(INITIAL_BODY), constants: { label: 'x' } })
			const before = sandbox.latest?.version
			await sandbox.setCompiledDil({
				compiledDil: program('\treturn __dil.jsx("box", null, __dil.jsx("text", null, "replaced"));'),
				constants: { label: 'x' },
				appData: {}
			})
			expect(sandbox.treeText()).toBe('replaced')
			expect(sandbox.latest?.reason).toBe('source')
			expect(sandbox.latest?.version).toBeGreaterThan(before)
		} finally {
			sandbox.close()
		}
	})

	it('keeps the last good tree when the new program throws', async () => {
		const sandbox = bootSandbox()
		try {
			await sandbox.createRunner({ compiledDil: program(INITIAL_BODY), constants: { label: 'x' } })
			await sandbox.setCompiledDil({ compiledDil: 'throw new Error("boom");', constants: {} })
			expect(sandbox.failures.at(-1)).toMatchObject({ kind: 'failure', stage: 'evaluate' })
			expect(sandbox.treeText()).toContain('count 1')
		} finally {
			sandbox.close()
		}
	})

	it('answers a program that never calls render with an empty tree, not a crash', async () => {
		const sandbox = bootSandbox()
		try {
			await sandbox.createRunner({ compiledDil: 'const unused = 1;' })
			expect(sandbox.latest?.tree).toBeNull()
			expect(sandbox.failures).toHaveLength(0)
		} finally {
			sandbox.close()
		}
	})

	it('refuses a createRunner from another protocol version', async () => {
		const sandbox = bootSandbox()
		try {
			sandbox.snapshots.length = 0
			await sandbox.createRunner({ compiledDil: program(INITIAL_BODY), protocolVersion: 7 })
			expect(sandbox.snapshots).toHaveLength(0)
			expect(sandbox.diagnostics.some((message) => message.phase === 'rejected')).toBe(true)
		} finally {
			sandbox.close()
		}
	})
})
