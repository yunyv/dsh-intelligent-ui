// @vitest-environment node
/** Inspect the real offline npm pack list, not just package.json's own claims. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const temporaryRoot = realpathSync(tmpdir())
let cache = ''
let files = new Set<string>()

beforeAll(() => {
	cache = mkdtempSync(join(temporaryRoot, 'dil-package-test-'))
	const result = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--offline', '--json', '--cache', cache], {
		cwd: root, encoding: 'utf8', timeout: 20_000,
	})
	expect(result.status, `${result.error ?? ''}\n${result.stderr}`).toBe(0)
	const packed = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>
	expect(packed).toHaveLength(1)
	files = new Set(packed[0]!.files.map((file) => file.path))
}, 30_000)

afterAll(() => {
	if (!cache) return
	const actual = realpathSync(cache)
	if (dirname(actual) !== temporaryRoot || !basename(actual).startsWith('dil-package-test-') || actual === realpathSync(root)) throw new Error('Refusing unexpected package cache cleanup')
	rmSync(actual, { recursive: true, force: false })
})

describe('published package contents', () => {
	it('retains compiled entrypoints, plugin registration and authoring assets', () => {
		for (const path of ['lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'cordis.patch.yml', 'assets/genui-skill.md']) expect(files.has(path), path).toBe(true)
	})

	it('ships the provenance document linked by both READMEs', () => {
		expect(files.has('PROVENANCE.md')).toBe(true)
	})

	it('ships the Worker once while retaining handwritten source for reference', () => {
		expect(files.has('src/client/dil/math/generated/worker-source.ts')).toBe(false)
		for (const path of ['src/client/dil/math/engine.ts', 'src/client/dil/math/protocol.ts', 'src/client/dil/math/service.ts']) expect(files.has(path), path).toBe(true)
	})

	it('ships third-party notices and all retained licence texts', () => {
		for (const name of ['THIRD_PARTY_NOTICES.md', 'APACHE-2.0.txt', 'GUST-FONT-LICENSE.txt', 'LPPL-1.3c.txt']) expect(files.has(`assets/math/${name}`), name).toBe(true)
	})
})
