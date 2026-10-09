/**
 * The artifact tool's behaviour, free of harness imports.
 *
 * Everything the tool decides lives here — what a create compiles, what a patch
 * re-derives, when a revision is refused — and nothing here imports
 * `@deepseek-ai/*`. That is deliberate: the harness's tool registry pulls ten
 * peer packages a typecheck-only install does not carry, so a tool that imported
 * it could only ever be exercised inside a running Host. Keeping the decisions
 * separate means the real code path is reachable from a unit test, and
 * `src/index.ts` is left as the thin binding that hands it to `defineTool`.
 *
 * @module dsh-intelligent-ui/tool
 */

import { compileDil } from './dil/index.ts'
import type { DilCompiled } from './dil/types.ts'
import {
	ARTIFACT_TOOL_NAME,
	type ArtifactEngine,
	type ArtifactMeta,
	type ArtifactMode,
	type ArtifactRender
} from './meta.ts'
import { normalizeArtifactSource, normalizedBytes } from './normalize.ts'
import { PatchError, applyPatch, requiresReload } from './patch.ts'
import { SKILL_BODY_PATH, SKILL_RESOURCE_DIR } from './paths.ts'
import type { ArtifactRecord, ArtifactStore } from './store/index.ts'

export { ARTIFACT_TOOL_NAME }

/**
 * JSON the tool result may carry, declared structurally.
 *
 * The harness types `output.schema`'s `json` member with its own recursive value
 * type from a package this plugin does not depend on. Spelling the same shape
 * here keeps the two assignable without adding a dependency on a transitive one.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** What one tool call returns: model-facing text plus the revision payload. */
export interface ToolValue {
	note: string
	meta: Json | null
}

/** The slice of deployment configuration the tool reads. */
export interface ToolConfig {
	/** Hard cap on one revision, measured in bytes of the stored source. */
	maxSourceBytes: number
	/** How many artifacts one session may hold at once. */
	maxArtifactsPerSession: number
	/** Append a compiled artifact's markdown projection to the tool result. */
	includeDegradedText: boolean
}

export const DESCRIPTION = `Create and evolve a live, interactive interface inside this conversation — not a description of one.

Two ways to write it, and the default is the first.

**Compiled interface (default).** Pass \`source\`: a DIL document. Write a short prose sentence, then \`{@body …}\` lines declaring everything you use, then ONE root \`<box>\`. It is compiled and run in a sandbox, so charts, sliders, tables and calculators arrive as something the user operates — and derived numbers recompute locally with no second model call. Load the \`genui\` skill before your first call: it carries the output format, the declare-before-use rules, and the full component inventory. If this session has no skill tool, read the same contract from ${SKILL_BODY_PATH} (its relative paths resolve against ${SKILL_RESOURCE_DIR}).

**Raw document (escape hatch).** Pass \`engine: "html"\`, then \`css\` and \`html\`: a self-contained document, for what a component inventory cannot express (3D, force-directed graphs, a bespoke simulation). Write \`css\` first — the arguments stream in the order you write them, so the stylesheet lands before the markup and the reader never sees unstyled content. The frame supplies the document skeleton, the theme and the security policy.

When to reach for either. When the answer is something to operate rather than read, and its content is substantial rather than a three-line restatement. A static node-and-edge diagram is cheaper as a Mermaid block; a real deliverable the user wants as project files is not this.

Where it appears. The interface renders where you put its marker: write a fenced block whose language is \`dsh-artifact\` and whose only content is the id this call returned.

\`\`\`dsh-artifact
art-xxxxxxxx
\`\`\`

One artifact per reply. Put the marker after the sentence that introduces it. Never wrap the document itself in the fence, and never show the artifact as a code block instead of the marker — without a marker nothing renders in the answer.

Revising. Call \`patch\` with the id and one exact \`old_string\`/\`new_string\` replacement, never re-create the same thing. A patch keeps the user's place: what they typed, dragged and scrolled survives, and on the compiled path their control state is re-applied.

Interaction. Choices the user makes are reported back under the state key you named, so name state meaningfully (\`budget\`, not \`v1\`).`

/** The tool's argument schema, as the harness consumes it. */
export const PARAMETERS = {
	action: {
		type: 'string',
		enum: ['create', 'patch', 'read', 'list', 'destroy'],
		description: '`create` opens a new artifact. `patch` replaces exact text inside an existing one by `id` — the normal way to change an artifact. `read` returns its current source. `list` enumerates this session\'s artifacts. `destroy` removes one.'
	},
	engine: {
		type: 'string',
		enum: ['dil', 'html'],
		description: 'create only: which document you are writing. `dil` (default) takes `source` and is compiled into an interface; `html` takes a self-contained `html` document.'
	},
	source: {
		type: 'string',
		description: 'create only, required on the default path: the DIL document — prose, then `{@body …}` declarations, then one root `<box>`. Load the `genui` skill for the format and the component inventory.'
	},
	css: {
		type: 'string',
		description: 'engine "html" only, and write it BEFORE `html`: the stylesheet. It streams ahead of the markup, so the reader watches a styled interface arrive instead of raw markup that snaps into place at the end. One document is stored either way.'
	},
	html: {
		type: 'string',
		description: 'create only, required with `engine: "html"`: a self-contained document — markup plus style and script. A fragment or a full document; the frame wraps it.'
	},
	title: {
		type: 'string',
		description: 'Short human-readable name, shown on the card and in the artifact panel. Required on create; optional on patch to rename.'
	},
	mode: {
		type: 'string',
		enum: ['inline', 'wide'],
		description: 'Card width: `inline` (default) or `wide` when several compact panels must sit side by side.'
	},
	id: {
		type: 'string',
		description: 'patch / read / destroy: the artifact id returned by create.'
	},
	old_string: {
		type: 'string',
		description: 'patch only, required: exact existing text to replace, whitespace included. Use action `read` first when unsure. Empty is rejected.'
	},
	new_string: {
		type: 'string',
		description: 'patch only, required: replacement text; an empty string deletes the matched region.'
	},
	replace_all: {
		type: 'boolean',
		description: 'patch only: replace every occurrence instead of requiring the match to be unique.'
	}
} as const

/** The result schema, as the harness consumes it. */
export const OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		note: { type: 'string', required: true },
		meta: { type: 'json', required: true }
	}
} as const

/** One artifact revision as the client and the session log carry it. */
function metaOf(
	record: ArtifactRecord,
	action: 'create' | 'patch',
	engine: ArtifactEngine,
	extra: { dil?: DilCompiled, render?: ArtifactRender } = {}
): ArtifactMeta {
	const base: ArtifactMeta = {
		kind: 'artifact',
		engine,
		action,
		id: record.id,
		title: record.title,
		version: record.version,
		versionNumber: record.version,
		contentSha256: record.contentSha256,
		contentBytes: record.contentBytes,
		changelog: record.changelog,
		mode: record.mode,
		sizeBytes: new TextEncoder().encode(record.source).length,
		...(record.parentVersionId === null ? {} : { parentVersionId: record.parentVersionId }),
		...(record.sessionId === undefined ? {} : { session: record.sessionId })
	}
	if (engine === 'html') return { ...base, html: record.source, render: extra.render ?? 'reload' }
	if (extra.dil === undefined) throw new Error('dsh-intelligent-ui: a compiled revision needs its compiled payload')
	return { ...base, dil: extra.dil }
}

/** The marker the model must write for an artifact to appear where it belongs. */
function marker(id: string): string {
	return `\`\`\`dsh-artifact\n${id}\n\`\`\``
}

/** Trim one required string argument, naming the action when it is missing. */
function required(value: string | undefined, field: string, action: string): string {
	if (value === undefined || value.trim().length === 0) {
		throw new Error(`artifact ${action}: "${field}" is required.`)
	}
	return value
}

/** Narrow the requested width family. */
function modeOf(value: string | undefined): ArtifactMode {
	return value === 'wide' ? 'wide' : 'inline'
}

/** Narrow the requested rendering path; the compiled interface is the default. */
function engineOf(value: string | undefined): ArtifactEngine {
	return value === 'html' ? 'html' : 'dil'
}

/**
 * Put the stylesheet ahead of the markup.
 *
 * The two arguments exist separately only so the reader sees them in this order:
 * the stylesheet streams first, so the preview is styled from its first frame
 * instead of showing raw markup and then snapping into place. Storage keeps one
 * document, so replay and export need no second field.
 * @param css - the model's stylesheet, when it wrote one.
 * @param html - the model's markup.
 * @returns one document with the stylesheet first.
 */
function withStyle(css: string | undefined, html: string): string {
	if (css === undefined || css.trim().length === 0) return html
	return `<style>\n${css.trim()}\n</style>\n${html}`
}

/** The markdown projection, appended so a surface without the browser half still shows content. */
function degraded(compiled: DilCompiled, include: boolean): string {
	if (!include) return ''
	const body = compiled.fallbackMarkdown.trim()
	if (body.length === 0) return ''
	return `\n\nA plain-text rendering of the interface, for terminals and clients without the browser half:\n\n${body}`
}

/**
 * Resolve an artifact this session is allowed to touch.
 *
 * Ownership is enforced on every action, not only on writes: a session must not
 * be able to read or destroy another session's artifact just because it guessed
 * the id. An artifact the caller does not own is reported exactly like one that
 * does not exist, so the refusal itself leaks nothing.
 *
 * @param store - the artifact catalog.
 * @param id - the id the model passed.
 * @param sessionId - the calling session, when the caller has one.
 * @param action - the action name, for the message.
 * @returns the current revision.
 */
function owned(store: ArtifactStore, id: string, sessionId: string | undefined, action: string): ArtifactRecord {
	const record = store.get(id)
	if (record !== undefined && (sessionId === undefined || record.sessionId === sessionId)) return record
	const known = store.list(sessionId)
	const available = known.length === 0
		? 'This session has no artifacts yet.'
		: `Known ids: ${known.map(entry => `${entry.id} ("${entry.title}", v${String(entry.version)})`).join(', ')}.`
	throw new Error(`artifact ${action}: unknown id "${id}". ${available}`)
}

/** Arguments that only read, so sibling calls cannot conflict. */
export function isConcurrencySafe(args: { action?: string }): boolean {
	return args.action === 'read' || args.action === 'list' || args.action === undefined
}

/**
 * The model-facing text of one call.
 *
 * Everything a result says goes through here, including the markdown projection
 * of a compiled artifact. That projection is the only thing a surface without
 * the browser half can show — a terminal transcript, a headless client, a
 * copy-paste — so this is the function that decides whether such a session sees
 * the artifact's content or a bare confirmation line.
 *
 * @param _args - the call arguments, unused.
 * @param value - the tool result.
 * @returns one text block.
 */
export function renderArtifact(_args: unknown, value: unknown): { type: 'text', text: string }[] {
	return [{ type: 'text', text: (value as ToolValue).note }]
}

/**
 * The revision payload the client reads, and what replay restores from.
 * @param _args - the call arguments, unused.
 * @param value - the tool result.
 * @returns the payload, or `null` for the actions that carry none.
 */
export function presentArtifactMeta(_args: unknown, value: unknown): Json | null {
	return (value as ToolValue).meta
}

/**
 * Run one `artifact` call.
 *
 * `sessionId` is passed rather than read from a context object so this stays
 * callable without the harness.
 * @param store - the artifact catalog.
 * @param config - deployment configuration.
 * @param args - the model's arguments, unvalidated beyond what the schema guarantees.
 * @param sessionId - owning session, when the caller has one.
 * @returns the model-facing note and the revision payload.
 */
export async function runArtifact(
	store: ArtifactStore,
	config: ToolConfig,
	args: Record<string, unknown>,
	sessionId: string | undefined
): Promise<ToolValue> {
	const action = typeof args.action === 'string' ? args.action : 'create'
	const title = typeof args.title === 'string' ? args.title : undefined
	const str = (key: string): string | undefined => typeof args[key] === 'string' ? args[key] as string : undefined
	const maxBytes = config.maxSourceBytes

	if (action === 'create') {
		const engine = engineOf(str('engine'))
		// The raw path normalizes away a document skeleton the frame supplies; the
		// compiled path is source text and is taken verbatim.
		const source = engine === 'html'
			? normalizeArtifactSource(withStyle(str('css'), required(str('html'), 'html', action)))
			: required(str('source'), 'source', action)
		if (source.trim().length === 0) throw new Error('artifact create: the document is empty.')
		const sizeBytes = engine === 'html' ? normalizedBytes(source) : new TextEncoder().encode(source).length
		if (sizeBytes > maxBytes) {
			throw new Error(`artifact create: ${String(sizeBytes)} bytes exceeds the ${String(maxBytes)} byte cap. Reduce the document or raise maxSourceBytes in the plugin config.`)
		}
		const held = store.list(sessionId)
		if (held.length >= config.maxArtifactsPerSession) {
			throw new Error(`artifact create: this session already holds ${String(held.length)} artifacts (cap ${String(config.maxArtifactsPerSession)}). Patch an existing one, destroy one, or raise maxArtifactsPerSession.`)
		}
		const resolvedTitle = title?.trim() || 'Artifact'
		// Compile before storing: a document that cannot produce a program must not
		// take a version number, or the session log would carry a revision that can
		// never render.
		const compiled = engine === 'dil' ? compileDil(source) : undefined
		const record = store.create({
			...(sessionId === undefined ? {} : { sessionId }),
			title: resolvedTitle,
			source,
			mode: modeOf(str('mode')),
			engine
		})
		const meta = metaOf(record, 'create', engine, compiled === undefined ? {} : { dil: compiled })
		const note = `Created "${record.title}" as ${record.id} (v1, ${String(sizeBytes)} bytes). Put this marker on its own line in your answer, where it belongs:\n\n${marker(record.id)}\n\nIt renders full size and interactive at that point. Change it later with action "patch" and this id; do not create it again.`
			+ (compiled === undefined ? '' : degraded(compiled, config.includeDegradedText))
		return { note, meta: meta as unknown as Json }
	}

	if (action === 'patch') {
		const id = required(str('id'), 'id', action)
		const current = owned(store, id, sessionId, action)
		const oldString = required(str('old_string'), 'old_string', action)
		const newString = str('new_string') ?? ''
		// Apply once up front so a bad match fails with its located message and the
		// size cap is checked before anything reaches the disk; the store then
		// re-applies it as the authoritative, version-checked write.
		let preview: string
		let replacements: number
		try {
			const result = applyPatch(current.source, oldString, newString, args.replace_all === true)
			preview = result.text
			replacements = result.replacements
		} catch (error) {
			if (error instanceof PatchError) throw new Error(`artifact patch ${id}: ${error.message}`)
			throw error
		}
		const sizeBytes = new TextEncoder().encode(preview).length
		if (sizeBytes > maxBytes) {
			throw new Error(`artifact patch ${id}: result is ${String(sizeBytes)} bytes, over the ${String(maxBytes)} byte cap. Patch in smaller steps.`)
		}
		const record = store.patch(id, {
			oldText: oldString,
			newText: newString,
			replaceAll: args.replace_all === true,
			expectedLatestVersion: current.version,
			...(title === undefined ? {} : { title: title.trim() })
		})
		// The path is carried by the artifact, not re-derived: a patch recompiles the
		// way the artifact was created, whatever its source now looks like.
		const engine: ArtifactEngine = record.engine
		const recompiled = engine === 'dil' ? compileDil(record.source) : undefined
		const render: ArtifactRender = requiresReload(current.source, record.source) ? 'reload' : 'reconcile'
		const meta = metaOf(record, 'patch', engine, engine === 'dil' ? { dil: recompiled } : { render })
		const how = engine === 'html'
			? (render === 'reconcile' ? 'updated in place (no reload, artifact state kept)' : 'updated (scripts changed, so the frame reloaded)')
			: 'recompiled and pushed to the running interface, which keeps the user\'s control state'
		const note = `Patched "${record.title}" (${id}) to v${String(record.version)} — ${String(replacements)} replacement${replacements === 1 ? '' : 's'}, ${String(sizeBytes)} bytes; the interface already in the conversation is ${how}. Write the same marker in this answer so the updated artifact stays anchored:\n\n${marker(id)}`
			+ (recompiled === undefined ? '' : degraded(recompiled, config.includeDegradedText))
		return { note, meta: meta as unknown as Json }
	}

	if (action === 'read') {
		const id = required(str('id'), 'id', action)
		const record = owned(store, id, sessionId, action)
		return {
			note: `Artifact ${record.id} "${record.title}" v${String(record.version)} — current source follows.\n\n${record.source}`,
			meta: null
		}
	}

	if (action === 'list') {
		const held = store.list(sessionId)
		if (held.length === 0) return { note: 'No artifacts in this session yet.', meta: null }
		const rows = held.map(entry => `- ${entry.id} — "${entry.title}" v${String(entry.version)} (${String(entry.versionCount)} revision${entry.versionCount === 1 ? '' : 's'}), ${String(entry.contentBytes)} bytes, updated ${new Date(entry.updatedAt).toISOString()}`)
		return { note: `Artifacts in this session:\n${rows.join('\n')}\n\nUse action "read" for the current source of one, or patch it in place.`, meta: null }
	}

	const id = required(str('id'), 'id', 'destroy')
	// Resolved first so another session's artifact cannot be destroyed by id guess.
	owned(store, id, sessionId, 'destroy')
	const existed = store.destroy(id)
	return {
		note: existed ? `Destroyed artifact ${id}. Its rendered cards stay in the transcript but no longer accept patches.` : `artifact destroy: unknown id "${id}".`,
		meta: null
	}
}
