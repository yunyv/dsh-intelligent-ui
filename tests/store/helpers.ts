/**
 * Shared scaffolding for the store suite: every test gets its own temp root, so
 * the suite never touches `~/.dsh/storages/dsh-genui` and never shares state with
 * another test file.
 * @module dsh-genui/tests/store/helpers
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A fresh, empty store root under the OS temp directory. */
export function newRoot(): string {
	return mkdtempSync(join(tmpdir(), 'dsh-genui-store-'))
}

/** Delete every root a test created. */
export function dropRoots(roots: string[]): void {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
	roots.length = 0
}

/** A clock that advances one millisecond per reading, so versions order deterministically. */
export function steppingClock(start = 1_700_000_000_000): () => number {
	let at = start
	return () => {
		at += 1
		return at
	}
}
