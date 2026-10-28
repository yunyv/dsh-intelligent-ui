// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = join(root, 'scripts/check-generated.mjs')
const temporaryRoot = realpathSync(tmpdir())
const fixtures: string[] = []
const outputs = [
	'lib/client.js', 'lib/index.js', 'lib/index.d.ts',
	'src/client/dil/generated/theme-css.ts', 'src/client/dil/math/generated/worker-source.ts',
]

function fixture(): string {
	const cwd = realpathSync(mkdtempSync(join(temporaryRoot, 'dil-generated-gate-')))
	fixtures.push(cwd)
	for (const name of [...outputs, 'src/source.ts']) {
		mkdirSync(dirname(join(cwd, name)), { recursive: true })
		writeFileSync(join(cwd, name), 'export const fixture = 1\n')
	}
	execFileSync('git', ['init', '-q'], { cwd })
	execFileSync('git', ['add', '--', ...outputs, 'src/source.ts'], { cwd })
	return cwd
}

function gate(cwd: string) {
	return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' })
}

afterAll(() => {
	for (const cwd of fixtures) {
		const target = realpathSync(cwd)
		if (!target.startsWith(temporaryRoot + sep) || !basename(target).startsWith('dil-generated-gate-') || target === realpathSync(root)) throw new Error('Refusing unsafe fixture cleanup')
		rmSync(target, { recursive: true })
	}
})

describe('committed generated artifact gate', () => {
	it('accepts unchanged generated outputs', () => {
		expect(gate(fixture()).status).toBe(0)
	})
	it.each(outputs)('rejects rebuilt tracked output %s', (name) => {
		const cwd = fixture()
		writeFileSync(join(cwd, name), 'export const fixture = 2\n')
		const result = gate(cwd)
		expect(result.status).toBe(1)
		expect(result.stdout + result.stderr).toContain(basename(name))
	})
	it('rejects new generated output even when it is gitignored', () => {
		const cwd = fixture()
		writeFileSync(join(cwd, '.gitignore'), 'lib/new-chunk.js\n')
		writeFileSync(join(cwd, 'lib/new-chunk.js'), 'export const extra = 1\n')
		const result = gate(cwd)
		expect(result.status).toBe(1)
		expect(result.stdout + result.stderr).toContain('lib/new-chunk.js')
	})
	it('does not reject unrelated source changes', () => {
		const cwd = fixture()
		writeFileSync(join(cwd, 'src/source.ts'), 'export const fixture = 2\n')
		expect(gate(cwd).status).toBe(0)
	})
})
