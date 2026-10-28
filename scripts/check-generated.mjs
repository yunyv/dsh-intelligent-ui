#!/usr/bin/env node
/** Run after building in a checkout: committed outputs must not be silently repaired by CI. */
import { spawnSync } from 'node:child_process'

const generated = ['lib', 'src/client/dil/generated', 'src/client/dil/math/generated']
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
if (top.error || top.status !== 0) {
	console.error('Generated artifact verification requires a Git checkout.')
	console.error(top.error?.message ?? top.stderr.trim())
	process.exitCode = 1
} else {
	const cwd = top.stdout.trim()
	const tracked = spawnSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--exit-code', '--stat', '--', ...generated], { cwd, encoding: 'utf8' })
	// Do not exclude ignored files: new build chunks must not escape the gate via .gitignore.
	const untracked = spawnSync('git', ['ls-files', '--others', '-z', '--', ...generated], { cwd, encoding: 'utf8' })
	const extra = untracked.stdout?.split('\0').filter(Boolean) ?? []
	if (tracked.error || untracked.error || tracked.status !== 0 || untracked.status !== 0 || extra.length) {
		console.error('Generated artifacts differ from the checkout. Rebuild and include the outputs with their source changes.')
		if (tracked.stdout) process.stdout.write(tracked.stdout)
		for (const name of extra) console.error(`Untracked generated output: ${JSON.stringify(name)}`)
		for (const result of [tracked, untracked]) {
			if (result.error) console.error(result.error.message)
			if (result.stderr) process.stderr.write(result.stderr)
		}
		process.exitCode = 1
	} else {
		console.log('Generated artifacts match the checkout.')
	}
}
