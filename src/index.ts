/**
 * Host half of dsh-genui: the harness binding for one tool with two rendering
 * paths and one durable artifact layer.
 *
 * The behaviour lives in `src/tool.ts`, which imports nothing from
 * `@deepseek-ai/*` so it stays reachable from a unit test — the harness's tool
 * registry pulls ten peer packages a typecheck-only install does not carry. This
 * module owns only what needs the harness: configuration, the catalog's root,
 * registration, and the presentation hooks.
 *
 * @module dsh-genui
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { ARTIFACT_TOOL_NAME, PLUGIN_ID } from './meta.ts'
import { genuiSkillProvider } from './skill.ts'
import { ArtifactStore, defaultStoreRoot } from './store/index.ts'
import {
	DESCRIPTION,
	OUTPUT_SCHEMA,
	PARAMETERS,
	isConcurrencySafe,
	runArtifact,
	type Json,
	type ToolConfig
} from './tool.ts'

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
export interface PluginConfig extends ToolConfig {
	/** Disk root for the artifact catalog; empty selects the default under `~/.dsh`. */
	storeRoot: string
}

/** The revision payload a tool result carries, as the presentation hooks see it. */
interface Presented {
	note: string
	meta: Json | null
}

/** Build the tool bound to one store and configuration. */
export function artifactTool(store: ArtifactStore, config: PluginConfig) {
	return defineTool({
		name: ARTIFACT_TOOL_NAME,
		description: DESCRIPTION,
		parameters: PARAMETERS,
		output: {
			schema: OUTPUT_SCHEMA,
			// The note is the model-facing line; the payload rides the revision
			// metadata, which is what the client reads and what replay restores from.
			render: (_args, value) => [{ type: 'text', text: (value as unknown as Presented).note }],
			presentationMeta: (_args, value) => (value as unknown as Presented).meta
		},
		isConcurrencySafe: (args) => isConcurrencySafe(args),
		execute: (args, exec) => runArtifact(store, config, args as Record<string, unknown>, exec.agent?.session.header.id),
		presentCall: () => ({ card: 'generic', title: 'Artifact', kind: 'other' }),
		presentResult: (_args, result) => {
			if (result.isError) return undefined
			const meta = result.meta as { kind?: unknown, title?: unknown, action?: unknown, version?: unknown } | null | undefined
			if (meta === null || meta === undefined || typeof meta !== 'object') return undefined
			if (meta.kind !== 'artifact' || typeof meta.title !== 'string') return undefined
			const suffix = meta.action === 'patch' ? ` · v${String(meta.version)}` : ''
			return { card: 'generic', title: `Artifact · ${meta.title}${suffix}` }
		}
	})
}

/**
 * The catalog for this load.
 *
 * The root comes from configuration, but it is the same directory across loads —
 * a plugin reload re-reads the catalog rather than starting empty, which is the
 * whole point of the on-disk layer.
 * @param config - validated deployment configuration.
 * @returns the store, recovered and ready.
 */
function openStore(config: PluginConfig): ArtifactStore {
	const root = config.storeRoot.trim().length === 0 ? defaultStoreRoot() : config.storeRoot
	const store = new ArtifactStore({
		root,
		maxArtifactsPerSession: config.maxArtifactsPerSession,
		maxContentBytes: config.maxSourceBytes
	})
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
