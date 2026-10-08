/**
 * Artifact patch semantics: exact `old_string` → `new_string` replacement, the
 * same contract the file `edit` tool teaches the model. Pure functions, so the
 * registry can fail loud with a located diagnostic instead of a silent no-op.
 * @module dsh-artifacts-live/patch
 */

/** One located occurrence of the searched text. */
export interface Occurrence {
	/** 1-based line of the match start. */
	line: number
	/** 1-based column of the match start. */
	column: number
}

/** Outcome of one applied replacement. */
export interface PatchResult {
	text: string
	/** How many replacements were applied. */
	replacements: number
}

/** A patch the plugin refuses to apply, with a model-actionable reason. */
export class PatchError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ArtifactPatchError'
	}
}

/** Locate every occurrence of `needle` with its 1-based line and column. */
export function locate(haystack: string, needle: string): Occurrence[] {
	const found: Occurrence[] = []
	let from = 0
	for (;;) {
		const at = haystack.indexOf(needle, from)
		if (at === -1) return found
		const before = haystack.slice(0, at)
		const line = before.split('\n').length
		const lastBreak = before.lastIndexOf('\n')
		found.push({ line, column: at - lastBreak })
		from = at + Math.max(needle.length, 1)
	}
}

/** A short window of the artifact around one occurrence, for the error message. */
function excerpt(text: string, at: number, radius = 60): string {
	const start = Math.max(0, at - radius)
	const end = Math.min(text.length, at + radius)
	const head = start > 0 ? '…' : ''
	const tail = end < text.length ? '…' : ''
	return `${head}${text.slice(start, end).replaceAll('\n', '⏎')}${tail}`
}

/**
 * Apply one exact replacement.
 * @param text - current artifact source.
 * @param oldString - text to find; must be non-empty and present.
 * @param newString - replacement; empty deletes the matched region.
 * @param replaceAll - replace every occurrence instead of requiring exactly one.
 * @returns the patched source and the replacement count.
 * @throws {PatchError} when the search text is empty, absent, or ambiguous.
 */
export function applyPatch(text: string, oldString: string, newString: string, replaceAll = false): PatchResult {
	if (oldString.length === 0) {
		throw new PatchError('old_string is empty: pass the exact existing text to replace. To rewrite the whole artifact, call artifact with action "create" again.')
	}
	if (oldString === newString) {
		throw new PatchError('old_string and new_string are identical: the patch would change nothing.')
	}
	const hits = locate(text, oldString)
	if (hits.length === 0) {
		const near = text.length === 0 ? 'the artifact is empty' : `the artifact is ${String(text.length)} bytes`
		throw new PatchError(`old_string not found (${near}). Read the artifact with action "read" and copy the text exactly, whitespace included.`)
	}
	const first = text.indexOf(oldString)
	if (!replaceAll && hits.length > 1) {
		const where = hits.map(h => `${String(h.line)}:${String(h.column)}`).join(', ')
		throw new PatchError(`old_string appears ${String(hits.length)} times (lines ${where}). Include more surrounding text to make it unique, or pass replace_all: true.`)
	}
	if (replaceAll) {
		return { text: text.split(oldString).join(newString), replacements: hits.length }
	}
	if (first === -1) {
		throw new PatchError(`old_string not found. Near: ${excerpt(text, 0)}`)
	}
	return {
		text: text.slice(0, first) + newString + text.slice(first + oldString.length),
		replacements: 1
	}
}

/**
 * Whether two artifact revisions differ inside any `<script>` body. A markup or
 * style change can be reconciled into the live document without re-running the
 * artifact; a script change cannot, so the card must reload the frame.
 * @param before - previous revision.
 * @param after - next revision.
 * @returns true when a reload is required.
 */
export function requiresReload(before: string, after: string): boolean {
	return scriptBodies(before) !== scriptBodies(after)
}

/** Concatenated `<script>` bodies, the part a DOM reconcile cannot re-execute. */
function scriptBodies(html: string): string {
	const bodies: string[] = []
	const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
	let match: RegExpExecArray | null
	while ((match = pattern.exec(html)) !== null) bodies.push(match[1] ?? '')
	return bodies.join('\u0000')
}
