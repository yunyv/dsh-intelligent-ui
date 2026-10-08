/**
 * Read-only bridge to the vendored upstream replica.
 *
 * `vendor/**` is upstream code kept verbatim (MIT, Disdjj/intelligent-ui-demo
 * @938ab09); these tests never write to it. The upstream tree is CommonJS and lives
 * outside vitest's transform pipeline, so it is loaded through `createRequire` — the
 * same loader `pnpm run test:vendor` uses.
 *
 * Only the pieces a test cannot produce itself are reached this way: the scripted
 * demo document, the system-prompt example, the captured fixtures, and the Node
 * sandbox harness. The compiler under test is always ours (`src/dil`).
 * @module tests/dil/vendor
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DilCompiled, DilGenuiComponent } from '../../src/dil/types.ts'

const require = createRequire(import.meta.url)

/** `vendor/dil-replica/replica/` — the upstream server, tests and tools. */
export const REPLICA_DIR = fileURLToPath(new URL('../../vendor/dil-replica/replica/', import.meta.url))
/** `vendor/dil-replica/artifacts/` — the captured ChatGPT artifact. */
export const ARTIFACTS_DIR = fileURLToPath(new URL('../../vendor/dil-replica/artifacts/', import.meta.url))
/** `vendor/dil-replica/captures/` — the captured stream and view-state bodies. */
export const CAPTURES_DIR = fileURLToPath(new URL('../../vendor/dil-replica/captures/', import.meta.url))
/** `vendor/dil-replica/replica/test/fixtures/` — real model output that broke earlier compilers. */
export const FIXTURES_DIR = path.join(REPLICA_DIR, 'test', 'fixtures')

const vendor = (relative: string): string => path.join(REPLICA_DIR, relative)

/** The upstream compiler, used only as the behaviour-equivalence reference. */
export interface VendorCompiler {
	compile(source: string, options?: { modelDataBindings?: unknown }): DilCompiled
	parse(src: string): { nodes: unknown[]; diagnostics: { code: string }[]; diagnosticSummary: string }
	genuiComponentPatches(prev: DilGenuiComponent[], next: DilGenuiComponent[]): { p: string; o: string; v: unknown }[]
	rewriteStatement(code: string): string
	readBalanced(src: string, start: number, open?: string, close?: string): { inner: string; end: number; ok: boolean }
	splitEachClause(expr: string): { list: string; item: string } | null
	toFallback(nodes: unknown[]): string
	tidyFallback(md: string): string
	PROTOCOL_VERSION: number
}

/** One node of a sandbox-rendered tree, as the worker serializes it. */
export interface SandboxTree {
	t?: string
	v?: string
	// the harness builds these objects; nothing in the test constrains their shape
	p?: Record<string, any>
	c?: SandboxTree[]
}

/** The in-Node harness that boots the real `sandbox/worker.js`. */
export interface Sandbox {
	outbox: unknown[]
	diagnostics: unknown[]
	snapshots: unknown[]
	readonly failures: { error?: { message?: string } }[]
	readonly latest: { tree?: SandboxTree } | null
	stateChanges: unknown[]
	createRunner(payload: { compiledDil: string; constants?: Record<string, unknown>; appData?: unknown }): Sandbox
	setCompiledDil(payload: { compiledDil: string; constants?: Record<string, unknown>; appData?: unknown }): Sandbox
	trigger(fnId: string, args?: unknown[]): Sandbox
	requestState(): Promise<Record<string, any>>
	healthCheck(): string
	close(): void
	flush(): Promise<Sandbox>
}

/** The sandbox harness and its tree walkers. */
export interface SandboxTools {
	bootSandbox(): Sandbox
	collectHandlers(tree: SandboxTree | null | undefined, out?: string[]): string[]
	treeToText(node: SandboxTree | null | undefined, depth?: number, lines?: string[]): string[]
}

export const vendorCompiler = require(vendor('server/compiler/index.js')) as VendorCompiler
export const { DEMO_SOURCE } = require(vendor('server/agent/demo-source.js')) as { DEMO_SOURCE: string }
export const { EXAMPLE } = require(vendor('server/agent/system-prompt.js')) as { EXAMPLE: string }
export const { bootSandbox, collectHandlers, treeToText } = require(vendor('tools/node-sandbox.js')) as SandboxTools

/** Everything the compiled program is allowed to differ on between two runs. */
export function stable(compiled: DilCompiled): Record<string, unknown> {
	const copy: Record<string, unknown> = { ...compiled }
	delete copy.durationMs
	delete copy.compiledAt
	return copy
}
