/**
 * Host half of dsh-genui: registers the `artifact` tool, owns the
 * per-session artifact registry, and publishes each revision as replayable
 * presentation metadata so the browser half can render it live — and re-render
 * it on replay — without consulting any live state.
 * @module dsh-genui
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { ARTIFACT_TOOL_NAME, PLUGIN_ID, artifactMetaFrom, type ArtifactMode } from './meta.ts'
import { normalizeArtifactSource, normalizedBytes } from './normalize.ts'
import { PatchError, applyPatch, requiresReload } from './patch.ts'
import { ArtifactRegistry, type ArtifactRecord } from './registry.ts'
import { genuiSkillProvider } from './skill.ts'

export const name = PLUGIN_ID

/** Services this half registers into: the tool registry and the skill registry. */
export const inject = ['tools', 'skills']

/** Deployment configuration validated by the Loader. */
export const Config = z.object({
	/** Hard cap on one artifact revision, measured after normalization. */
	maxArtifactBytes: z.natural().default(2_000_000),
	/** How many artifacts one session may hold at once. */
	maxArtifactsPerSession: z.natural().default(40)
})

/** Validated configuration shape the Loader passes to {@link apply}. */
export interface PluginConfig {
	/** Hard cap on one artifact revision, measured after normalization. */
	maxArtifactBytes: number
	/** How many artifacts one session may hold at once. */
	maxArtifactsPerSession: number
}

const DESCRIPTION = `Create and evolve a live visual artifact inside this conversation: a self-contained HTML document the user sees rendered in a sandboxed frame, updated in place, and can interact with.

When to open one. Reach for an artifact when the answer is a thing to look at or manipulate rather than prose to read: a dashboard, chart, simulator, small game, algorithm walkthrough, UI mockup, comparison panel, or labeled diagram that moves. The content should be substantial (roughly 15+ lines), self-contained, and likely to be revisited or refined. Do not open one for a short snippet, a static diagram a Mermaid block already covers, or a real deliverable the user asked to become project files — write those to the workspace instead.

One artifact per reply. Open it once and then improve it by patching, never by recreating: \`patch\` sends only the changed text, updates the live frame in place, and preserves whatever the user already typed or dragged inside it.

Where it appears. The artifact renders where you put it: write a marker fence at the point in your answer where the artifact belongs, and the frame is mounted exactly there, full size and interactive. The marker is the id, never the source:

\`\`\`dsh-artifact
art-xxxxxxxx
\`\`\`

Never wrap the artifact's HTML in the fence, and never show the artifact as a code block instead of the marker. Put the marker after the sentence that introduces the artifact and before whatever you go on to explain. One marker per artifact per reply is enough; a later \`patch\` is followed by the same marker again so the updated frame stays anchored where the reader is looking. Without a marker nothing renders inside the answer, and the reader only finds the artifact in the right-hand column.

After creating, always keep working through the id the call returned. Read before patching when unsure of the exact current text.

What to write. Markup plus <style> and <script> — a fragment is enough, and a full HTML document also works (its <html>/<head>/<body> wrappers are unwrapped for you). The frame supplies the document, the theme, and the security policy, so do not declare a Content-Security-Policy of your own.

Theme. Use the frame's variables so the artifact follows the app's light and dark palettes: --foreground, --background, --card, --muted-foreground, --border, --primary, --primary-foreground, and the series palette --viz-series-1 through --viz-series-6. Utility classes .card, .viz-stat, .viz-grid, .viz-row, .viz-controls, .btn, .form-label, .form-control are available.

Sandbox. The artifact runs in a frame with an opaque origin: it cannot reach the app, and network calls (fetch, XHR, WebSocket, form submission) are blocked. Static assets may load only from cdnjs.cloudflare.com, cdn.jsdelivr.net, esm.sh, unpkg.com, fonts.googleapis.com, fonts.gstatic.com, or fonts.bunny.net, always with a pinned version. localStorage and sessionStorage work through an in-memory shim that survives frame reloads for the life of the artifact.

Interaction. When the user asks for something they operate — sliders, toggles, a game, a quiz — keep the artifact's meaningful state in \`window.__dshArtifactData\` as a JSON value, refreshed whenever it changes. The user can then hand that state back to you from the card, and their form fields and button clicks travel with it. This only works if you write the assignment; there is no automatic capture of internal state.`

/** One artifact revision as the tool publishes it. */
function revisionMeta(record: ArtifactRecord, sessionId: string, action: 'create' | 'patch', render: 'reload' | 'reconcile'): Record<string, string | number> {
	return {
		kind: 'artifact',
		action,
		id: record.id,
		title: record.title,
		html: record.html,
		version: record.version,
		mode: record.mode,
		render,
		sizeBytes: new TextEncoder().encode(record.html).length,
		session: sessionId
	}
}

/** The `note` a caller may pass instead of model-facing text. */
interface ToolValue {
	note: string
	meta: Record<string, string | number> | null
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

/** Build the tool bound to one registry and configuration. */
export function artifactTool(registry: ArtifactRegistry, config: PluginConfig) {
	return defineTool({
		name: ARTIFACT_TOOL_NAME,
		description: DESCRIPTION,
		parameters: {
			action: {
				type: 'string',
				enum: ['create', 'patch', 'read', 'list', 'destroy'],
				description: '`create` opens a new artifact from `html`. `patch` replaces exact text inside an existing one by `id` — the normal way to change an artifact. `read` returns its current source. `list` enumerates this session\'s artifacts. `destroy` removes one.'
			},
			html: {
				type: 'string',
				description: 'create only, required: markup plus style and script. A fragment or a full HTML document; the frame wraps it.'
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
			const sessionId = exec.agent?.session.header.id ?? 'unbound'
			const maxBytes = config.maxArtifactBytes

			if (action === 'create') {
				const source = normalizeArtifactSource(required(args.html, 'html', action))
				if (source.length === 0) throw new Error('artifact create: "html" normalized to nothing.')
				const sizeBytes = normalizedBytes(source)
				if (sizeBytes > maxBytes) {
					throw new Error(`artifact create: ${String(sizeBytes)} bytes exceeds the ${String(maxBytes)} byte cap. Reduce the document or raise maxArtifactBytes in the plugin config.`)
				}
				const held = registry.list(sessionId)
				if (held.length >= config.maxArtifactsPerSession) {
					throw new Error(`artifact create: this session already holds ${String(held.length)} artifacts (cap ${String(config.maxArtifactsPerSession)}). Patch an existing one, destroy one, or raise maxArtifactsPerSession.`)
				}
				const record = registry.create(sessionId, {
					title: args.title?.trim() || 'Artifact',
					html: source,
					mode: modeOf(args.mode)
				})
				return {
					note: `Created artifact "${record.title}" as ${record.id} (v1, ${String(sizeBytes)} bytes). Put this marker on its own line in your answer, where the artifact belongs:\n\n\`\`\`\ndsh-artifact\n${record.id}\n\`\`\`\n\nIt renders full size and interactive at that point. Change the artifact later with action "patch" and this id; do not create it again.`,
					meta: revisionMeta(record, sessionId, 'create', 'reload')
				}
			}

			if (action === 'patch') {
				const id = required(args.id, 'id', action)
				const current = registry.get(sessionId, id)
				if (current === undefined) {
					const known = registry.list(sessionId)
					const available = known.length === 0
						? 'This session has no artifacts yet.'
						: `Known ids: ${known.map(entry => `${entry.id} ("${entry.title}", v${String(entry.version)})`).join(', ')}.`
					throw new Error(`artifact patch: unknown id "${id}". ${available}`)
				}
				let patched: string
				let replacements: number
				try {
					const result = applyPatch(
						current.html,
						required(args.old_string, 'old_string', action),
						args.new_string ?? '',
						args.replace_all === true
					)
					patched = result.text
					replacements = result.replacements
				} catch (error) {
					if (error instanceof PatchError) throw new Error(`artifact patch ${id}: ${error.message}`)
					throw error
				}
				const sizeBytes = new TextEncoder().encode(patched).length
				if (sizeBytes > maxBytes) {
					throw new Error(`artifact patch ${id}: result is ${String(sizeBytes)} bytes, over the ${String(maxBytes)} byte cap. Patch in smaller steps.`)
				}
				const render = requiresReload(current.html, patched) ? 'reload' : 'reconcile'
				const record = registry.revise(sessionId, id, patched, args.title?.trim())
				if (record === undefined) throw new Error(`artifact patch: unknown id "${id}".`)
				const how = render === 'reconcile' ? 'updated in place (no reload, artifact state kept)' : 'updated (scripts changed, so the frame reloaded)'
				return {
					note: `Patched "${record.title}" (${id}) to v${String(record.version)} — ${String(replacements)} replacement${replacements === 1 ? '' : 's'}, ${String(sizeBytes)} bytes; the frame already in the conversation is ${how}. Write the same marker in this answer so the updated artifact stays anchored:\n\n\`\`\`\ndsh-artifact\n${id}\n\`\`\``,
					meta: revisionMeta(record, sessionId, 'patch', render)
				}
			}

			if (action === 'read') {
				const id = required(args.id, 'id', action)
				const record = registry.get(sessionId, id)
				if (record === undefined) throw new Error(`artifact read: unknown id "${id}".`)
				return {
					note: `Artifact ${record.id} "${record.title}" v${String(record.version)} — current source follows.\n\n${record.html}`,
					meta: revisionMeta(record, sessionId, record.version > 1 ? 'patch' : 'create', 'reload')
				}
			}

			if (action === 'list') {
				const held = registry.list(sessionId)
				if (held.length === 0) return { note: 'No artifacts in this session yet.', meta: null }
				const rows = held.map(entry => `- ${entry.id} — "${entry.title}" v${String(entry.version)}, ${String(new TextEncoder().encode(entry.html).length)} bytes, updated ${new Date(entry.updatedAt).toISOString()}`)
				return { note: `Artifacts in this session:\n${rows.join('\n')}`, meta: null }
			}

			const id = required(args.id, 'id', 'destroy')
			const existed = registry.destroy(sessionId, id)
			return {
				note: existed ? `Destroyed artifact ${id}. Its rendered cards stay in the transcript but no longer accept patches.` : `artifact destroy: unknown id "${id}".`,
				meta: null
			}
		},
		presentCall: () => ({ card: 'generic', title: 'Artifact', kind: 'other' }),
		presentResult: (_args, result) => {
			if (result.isError) return undefined
			const meta = artifactMetaFrom(result.meta)
			if (meta === undefined) return undefined
			const suffix = meta.action === 'patch' ? ` · v${String(meta.version)}` : ''
			return { card: 'generic', title: `Artifact · ${meta.title}${suffix}` }
		}
	})
}

/** Process-wide holder so a plugin reload keeps the artifacts it already knows. */
const REGISTRY_SLOT = Symbol.for('dsh-genui.registry')

/**
 * The registry for this process.
 *
 * A plugin reload — reinstalling the bundle, updating it in place — re-imports
 * this module, so a registry created inside `apply` would be replaced by an
 * empty one while the conversation still shows the artifacts it held. The holder
 * lives on the process, so ids stay patchable across a reload. A full Host
 * restart still starts empty: the transcripts keep rendering (every revision
 * rides its tool result) but the model must create a new artifact to keep
 * editing one, which is what the tool's error message says.
 * @returns the process-wide registry.
 */
function processRegistry(): ArtifactRegistry {
	const holder = globalThis as unknown as Record<symbol, ArtifactRegistry | undefined>
	let registry = holder[REGISTRY_SLOT]
	if (registry === undefined) {
		registry = new ArtifactRegistry()
		holder[REGISTRY_SLOT] = registry
	}
	return registry
}

/**
 * Register the artifact tool into the calling profile.
 * @param ctx - registrant context.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: PluginConfig): void {
	ctx.tools.register(artifactTool(processRegistry(), config))
	// The DIL dialect contract ships as a skill rather than living in the tool
	// description: it is ~4 KB of component inventory that only matters on the
	// turn that actually writes an interface.
	ctx.skills.registerProvider(() => genuiSkillProvider)
}

export { SKILL_BODY_PATH, SKILL_RESOURCE_DIR } from './skill.ts'
