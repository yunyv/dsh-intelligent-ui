/**
 * Host half of dsh-genui: one tool, two rendering paths, one durable artifact
 * layer.
 *
 * The tool the model calls is `artifact` on both paths; what changes is the
 * document it writes and who draws the result:
 *
 * - `dil` (default) — the model writes a DIL document. This half compiles it, so
 *   the session log carries the compiled program and replay never needs a
 *   compiler; the client runs that program in a sandbox and renders the tree it
 *   returns with native DOM. The projection to markdown is produced here too, so
 *   a surface that cannot run scripts still shows the content.
 * - `html` — the model writes a self-contained document that the client renders
 *   in a sandboxed frame. This is the escape hatch for what a component catalog
 *   cannot express.
 *
 * Artifacts live in {@link ArtifactStore} — on disk, append-only, versioned —
 * rather than in a process-local map, which is what used to make every card
 * created before a restart un-patchable.
 *
 * @module dsh-genui
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { compileDil } from './dil/index.ts'
import type { DilCompiled } from './dil/types.ts'
import {
	ARTIFACT_TOOL_NAME,
	PLUGIN_ID,
	type ArtifactEngine,
	type ArtifactMeta,
	type ArtifactMode,
	type ArtifactRender
} from './meta.ts'
import { normalizeArtifactSource, normalizedBytes } from './normalize.ts'
import { PatchError, applyPatch, requiresReload } from './patch.ts'
import { genuiSkillProvider, SKILL_BODY_PATH, SKILL_RESOURCE_DIR } from './skill.ts'
import { ArtifactStore, defaultStoreRoot, type ArtifactRecord } from './store/index.ts'

export const name = PLUGIN_ID

/** Services this half registers into: the tool registry and the skill registry. */
export const inject = ['tools', 'skills']

/** Deployment configuration validated by the Loader. */
export const Config = z.object({
	/** Hard cap on one revision, measured in bytes of the stored source. */
	maxSourceBytes: z.natural().default(2_000_000),
	/** How many artifacts one session may hold at once. */
	maxArtifactsPerSession: z.natural().default(40),
	/** Disk root for the artifact catalog; empty selects the default under `~/.dsh`. */
	storeRoot: z.string().default(''),
	/**
	 * Append a compiled artifact's markdown projection to the tool result.
	 *
	 * It is the only thing a surface without the browser half can show — a
	 * terminal transcript, a headless client, a copy-paste — and the compiler
	 * already had to build it. It costs one re-read per call, so it is switchable.
	 */
	includeDegradedText: z.boolean().default(true)
})

/** Validated configuration shape the Loader passes to {@link apply}. */
export interface PluginConfig {
	/** Hard cap on one revision, measured in bytes of the stored source. */
	maxSourceBytes: number
	/** How many artifacts one session may hold at once. */
	maxArtifactsPerSession: number
	/** Disk root for the artifact catalog; empty selects the default under `~/.dsh`. */
	storeRoot: string
	/** Append the markdown projection to the tool result. */
	includeDegradedText: boolean
}

const DESCRIPTION = `Create and evolve a live, interactive interface inside this conversation — not a description of one.

Two ways to write it, and the default is the first.

**Compiled interface (default).** Pass \`source\`: a DIL document. Write a short prose sentence, then \`{@body …}\` lines declaring everything you use, then ONE root \`<box>\`. It is compiled and run in a sandbox, so charts, sliders, tables and calculators arrive as something the user operates — and derived numbers recompute locally with no second model call. Load the \`genui\` skill before your first call: it carries the output format, the declare-before-use rules, and the full component inventory. If this session has no skill tool, read the same contract from ${SKILL_BODY_PATH} (its relative paths resolve against ${SKILL_RESOURCE_DIR}).

**Raw document (escape hatch).** Pass \`engine: "html"\` and \`html\`: a self-contained document, for what a component inventory cannot express (3D, force-directed graphs, a bespoke simulation). The frame supplies the document skeleton, the theme and the security policy.

When to reach for either. When the answer is something to operate rather than read, and its content is substantial rather than a three-line restatement. A static node-and-edge diagram is cheaper as a Mermaid block; a real deliverable the user wants as project files is not this.

Where it appears. The interface renders where you put its marker: write a fenced block whose language is \`dsh-artifact\` and whose only content is the id this call returned.

\`\`\`dsh-artifact
art-xxxxxxxx
\`\`\`

One artifact per reply. Put the marker after the sentence that introduces it. Never wrap the document itself in the fence, and never show the artifact as a code block instead of the marker — without a marker nothing renders in the answer.

Revising. Call \`patch\` with the id and one exact \`old_string\`/\`new_string\` replacement, never re-create the same thing. A patch keeps the user's place: what they typed, dragged and scrolled survives, and on the compiled path their control state is re-applied.

Interaction. Choices the user makes are reported back under the state key you named, so name state meaningfully (\`budget\`, not \`v1\`).`

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
	if (extra.dil === undefined) throw new Error('dsh-genui: a compiled revision needs its compiled payload')
	return { ...base, dil: extra.dil }
}

/**
 * JSON the tool result may carry, declared structurally.
 *
 * The harness types `output.schema`'s `json` member with its own recursive value
 * type from a package this plugin does not depend on. Spelling the same shape
 * here keeps the two assignable without adding a dependency on a transitive one.
 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** The `note` a caller may pass instead of model-facing text. */
interface ToolValue {
	note: string
	meta: Json | null
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

/** The markdown projection, appended so a surface without the browser half still shows content. */
function degraded(compiled: DilCompiled, include: boolean): string {
	if (!include) return ''
	const body = compiled.fallbackMarkdown.trim()
	if (body.length === 0) return ''
	return `\n\nA plain-text rendering of the interface, for terminals and clients without the browser half:\n\n${body}`
}

/** Build the tool bound to one store and configuration. */
export function artifactTool(store: ArtifactStore, config: PluginConfig) {
	return defineTool({
		name: ARTIFACT_TOOL_NAME,
		description: DESCRIPTION,
		parameters: {
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
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					note: { type: 'string', required: true },
					meta: { type: 'json', required: true }
				}
			},
			render: (_args, value) => [{ type: 'text', text: value.note }],
			presentationMeta: (_args, value) => value.meta
		},
		isConcurrencySafe: (args) => args.action === 'read' || args.action === 'list',
		async execute(args, exec): Promise<ToolValue> {
			const action = args.action ?? 'create'
			const sessionId = exec.agent?.session.header.id
			const maxBytes = config.maxSourceBytes

			if (action === 'create') {
				const engine = engineOf(args.engine)
				// The raw path normalizes away a document skeleton the frame supplies;
				// the compiled path is source text and is taken verbatim.
				const source = engine === 'html'
					? normalizeArtifactSource(required(args.html, 'html', action))
					: required(args.source, 'source', action)
				if (source.trim().length === 0) throw new Error('artifact create: the document is empty.')
				const sizeBytes = engine === 'html' ? normalizedBytes(source) : new TextEncoder().encode(source).length
				if (sizeBytes > maxBytes) {
					throw new Error(`artifact create: ${String(sizeBytes)} bytes exceeds the ${String(maxBytes)} byte cap. Reduce the document or raise maxSourceBytes in the plugin config.`)
				}
				const held = store.list(sessionId)
				if (held.length >= config.maxArtifactsPerSession) {
					throw new Error(`artifact create: this session already holds ${String(held.length)} artifacts (cap ${String(config.maxArtifactsPerSession)}). Patch an existing one, destroy one, or raise maxArtifactsPerSession.`)
				}
				const title = args.title?.trim() || 'Artifact'
				// Compile before storing: a document that cannot produce a program must
				// not take a version number, or the session log would carry a revision
				// that can never render.
				const compiled = engine === 'dil' ? compileDil(source) : undefined
				const record = store.create({ ...sessionId === undefined ? {} : { sessionId }, title, source, mode: modeOf(args.mode), engine })
				const meta = metaOf(record, 'create', engine, compiled === undefined ? {} : { dil: compiled })
				const note = `Created "${record.title}" as ${record.id} (v1, ${String(sizeBytes)} bytes). Put this marker on its own line in your answer, where it belongs:\n\n${marker(record.id)}\n\nIt renders full size and interactive at that point. Change it later with action "patch" and this id; do not create it again.`
					+ (compiled === undefined ? '' : degraded(compiled, config.includeDegradedText))
				return { note, meta: meta as unknown as Json }
			}

			if (action === 'patch') {
				const id = required(args.id, 'id', action)
				const current = store.get(id)
				if (current === undefined || (sessionId !== undefined && current.sessionId !== sessionId)) {
					const known = store.list(sessionId)
					const available = known.length === 0
						? 'This session has no artifacts yet.'
						: `Known ids: ${known.map(entry => `${entry.id} ("${entry.title}", v${String(entry.version)})`).join(', ')}.`
					throw new Error(`artifact patch: unknown id "${id}". ${available}`)
				}
				const oldString = required(args.old_string, 'old_string', action)
				const newString = args.new_string ?? ''
				// Apply once up front so a bad match fails with its located message and
				// the size cap is checked before anything reaches the disk; the store
				// then re-applies it as the authoritative, version-checked write.
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
					...args.title === undefined ? {} : { title: args.title.trim() }
				})
				// The path is carried by the artifact, not re-derived: a patch recompiles
				// the way the artifact was created, whatever its source now looks like.
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
				const id = required(args.id, 'id', action)
				const record = store.get(id)
				if (record === undefined) throw new Error(`artifact read: unknown id "${id}".`)
				return {
					note: `Artifact ${record.id} "${record.title}" v${String(record.version)} — current source follows.\n\n${record.source}`,
					meta: null
				}
			}

			if (action === 'list') {
				const held = store.list(sessionId)
				if (held.length === 0) return { note: 'No artifacts in this session yet.', meta: null }
				const rows = held.map(entry => `- ${entry.id} — "${entry.title}" v${String(entry.version)} (${String(entry.versionCount)} revision${entry.versionCount === 1 ? '' : 's'}), ${String(entry.contentBytes)} bytes, updated ${new Date(entry.updatedAt).toISOString()}${entry.sessionId === undefined ? '' : ''}`)
				return { note: `Artifacts in this session:\n${rows.join('\n')}\n\nUse action "read" for the current source of one, or patch it in place.`, meta: null }
			}

			const id = required(args.id, 'id', 'destroy')
			const existed = store.destroy(id)
			return {
				note: existed ? `Destroyed artifact ${id}. Its rendered cards stay in the transcript but no longer accept patches.` : `artifact destroy: unknown id "${id}".`,
				meta: null
			}
		},
		presentCall: () => ({ card: 'generic', title: 'Artifact', kind: 'other' }),
		presentResult: (_args, result) => {
			if (result.isError) return undefined
			const meta = result.meta as { kind?: unknown, title?: unknown, action?: unknown, version?: unknown } | null
			if (meta === null || typeof meta !== 'object' || meta.kind !== 'artifact' || typeof meta.title !== 'string') return undefined
			const suffix = meta.action === 'patch' ? ` · v${String(meta.version)}` : ''
			return { card: 'generic', title: `Artifact · ${meta.title}${suffix}` }
		}
	})
}

/**
 * The catalog for this load.
 *
 * Resolved from configuration on every `apply`, but the underlying directory is
 * the process's single catalogue — a plugin reload re-reads it rather than
 * starting empty, which is the whole point of the on-disk layer.
 * @param config - validated deployment configuration.
 * @returns the store, recovered and ready.
 */
function openStore(config: PluginConfig): ArtifactStore {
	const root = config.storeRoot.trim().length === 0 ? defaultStoreRoot() : config.storeRoot
	const store = new ArtifactStore({ root, maxArtifactsPerSession: config.maxArtifactsPerSession, maxContentBytes: config.maxSourceBytes })
	// Idempotent and cheap: claims versions a crash left without an index entry and
	// drops empty directories, so `list` agrees with what is on disk.
	store.recover()
	return store
}

/**
 * Register the artifact tool and the dialect skill into the calling profile.
 * @param ctx - registrant context.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: PluginConfig): void {
	ctx.tools.register(artifactTool(openStore(config), config))
	// The DIL contract ships as a skill rather than living in the tool description:
	// it is ~4 KB of component inventory that only matters on the turn that
	// actually writes an interface.
	ctx.skills.registerProvider(() => genuiSkillProvider)
}
