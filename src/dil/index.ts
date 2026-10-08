/**
 * The DIL pipeline's public surface for the host half: compile model-authored
 * source into a program the sandbox can run, and the pieces the developer panel and
 * the streaming patcher need to inspect it.
 *
 * The client half imports {@link compileDil}'s {@link DilCompiled} result shape from
 * `./types.ts`; nothing here touches the tool registry, the session, or the disk.
 * @module dsh-genui/dil
 */

import { compile } from './compiler/index.ts'
import type { DilCompiled, DilCompileOptions } from './types.ts'

/**
 * Compile one revision of a DIL document.
 *
 * Never throws: every intermediate state of a partially-streamed document is
 * syntactically invalid, and each failure becomes a diagnostic plus a best-effort
 * program (`invalid_program` falls back to plain text).
 * @param source - the model-authored document, whole or truncated mid-stream.
 * @param options - host data bindings the program should read through `DIL.useAppData`.
 * @returns the compiled program, its constants, its component resolutions, and everything that was repaired.
 */
export function compileDil(source: string, options: DilCompileOptions = {}): DilCompiled {
	return compile(source, options)
}

export { compile, PROTOCOL_VERSION } from './compiler/index.ts'
export {
	parse,
	genuiComponentPatches,
	readBalanced,
	splitEachClause,
	splitStatements,
	rewriteStatement,
	resolutionId,
	toFallback,
	tidyFallback,
	INTRINSIC
} from './compiler/index.ts'
export { genuiComponents } from './compiler/genui-components.ts'
export { lowerMarkdown, inline } from './compiler/markdown.ts'
export { isExpression, isStatement, isProgram } from './compiler/validate.ts'
export { kindOf, isIntrinsic, widgetType } from './compiler/components.ts'
export type { GenuiPatch } from './compiler/genui-components.ts'
export type { RepairResult } from './compiler/repair.ts'
export type { GeneratedProgram } from './compiler/codegen.ts'
export type { ParseResult, DilNode, DilTextNode, DilExprNode, DilStmtNode, DilElementNode, DilAttr, DilIfNode, DilIfBranch, DilEachNode } from './compiler/parser.ts'
export type { LineCol, BalancedRegion } from './compiler/scanner.ts'
export type {
	DilAppData,
	DilCompiled,
	DilCompileOptions,
	DilComponentResolution,
	DilDiagnostic,
	DilGenuiComponent,
	PendingDiagnostic
} from './types.ts'
