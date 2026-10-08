/**
 * Wire contract shared by both halves of the plugin: the tool name the client
 * keys its Tool view on, the metadata shape the host half publishes through
 * `output.presentationMeta` (and therefore the client reads back as
 * `block.meta`), the frame message types, and the tolerant argument reader the
 * streaming preview uses while the model is still writing the call.
 *
 * Pure: no node builtins, no host imports, so the browser bundle can share it.
 * The one import is type-only and points at the compiler's own type module,
 * which is itself pure — that keeps a single definition of the compiled
 * payload instead of two that drift.
 * @module dsh-genui/meta
 */

import type { DilCompiled } from './dil/types.ts'

/** Package identity: the harness client-module id and the ModuleLoader entry id. */
export const PLUGIN_ID = 'dsh-genui'

/** Wire tool name; also the key the client registers under `tool.call.toolview`. */
export const ARTIFACT_TOOL_NAME = 'artifact'

/** Card width family. `wide` exists for side-by-side comparison layouts. */
export type ArtifactMode = 'inline' | 'wide'

/** How the live frame must adopt the next revision. */
export type ArtifactRender = 'reload' | 'reconcile'

/**
 * Which rendering path an artifact belongs to.
 *
 * `dil` — the model wrote a DIL document; the compiled program runs in the
 * sandbox and the host renders the tree it returns.
 * `html` — the model wrote a self-contained document; the frame renders it.
 */
export type ArtifactEngine = 'dil' | 'html'

/** One artifact revision as the client receives it inside the tool result. */
export interface ArtifactMeta {
	kind: 'artifact'
	/** Rendering path; decides which view the client mounts. */
	engine: ArtifactEngine
	action: 'create' | 'patch'
	/** Stable artifact identity for the session; patches address it. */
	id: string
	title: string
	/** Monotonic revision, starting at 1. Drives in-place adoption. */
	version: number
	/** The store's own name for the same number, so both halves agree without a translation. */
	versionNumber?: number
	/** Revision this one was built from, for history and conflict messages. */
	parentVersionId?: string
	/** SHA-256 of the stored bytes: identifies a revision without comparing payloads. */
	contentSha256?: string
	/** Stored byte length. `sizeBytes` is a character count, so the two differ for CJK. */
	contentBytes?: number
	/** One-line revision note, shown in the catalog without reading the payload. */
	changelog?: string
	mode: ArtifactMode
	/** UTF-16 length of the payload, as the client's layout code already uses it. */
	sizeBytes: number
	/** Owning session id, so a session-scoped catalog can filter. */
	session?: string
	/**
	 * Complete source, so replay restores the card without any live registry.
	 * Present for `html`.
	 */
	html?: string
	/** How `html` must be adopted. Meaningless on the `dil` path. */
	render?: ArtifactRender
	/** The compiled DIL payload. Present for `dil`. */
	dil?: DilCompiled
}

/** Frame → card: measured content height. */
export const HEIGHT_MESSAGE = 'dsh-artifacts:height'
/** Frame → card: collected interaction payload. */
export const DATA_MESSAGE = 'dsh-artifacts:data'
/** Card → frame: reconcile this revision into the live document. */
export const SYNC_MESSAGE = 'dsh-artifacts:sync'
/** Card → frame: hand back whatever the user interacted with. */
export const COLLECT_MESSAGE = 'dsh-artifacts:collect'
/** Card → frame: repaint with a new host palette, without reloading. */
export const THEME_MESSAGE = 'dsh-artifacts:theme'
/** Frame → card: the frame wrote its storage snapshot. */
export const STORAGE_MESSAGE = 'dsh-artifacts:storage'

/** One message either direction across the sandbox boundary. */
export interface FrameMessage {
	type: string
	token: string
	height?: number
	html?: string
	data?: unknown
	store?: string
	entries?: Record<string, string>
	vars?: Record<string, string>
	scheme?: string
}

/** Whether an untrusted value is a non-null object. */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

/** Whether an untrusted value is a string array. */
function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === 'string')
}

/**
 * Recover a compiled DIL payload from persisted meta.
 *
 * Validates the fields the client actually reads to render — the program, its
 * constant pool, the streamed component spans, the state keys and the markdown
 * projection — and passes the rest through, because the value came from this
 * plugin's own host half rather than from a peer. A payload that cannot render
 * is rejected whole, so a card never mounts half a program.
 * @param value - untrusted `meta.dil`.
 * @returns the payload, or undefined when it cannot render.
 */
export function dilCompiledFrom(value: unknown): DilCompiled | undefined {
	if (!isObject(value)) return undefined
	if (typeof value.source !== 'string') return undefined
	if (typeof value.code !== 'string' || value.code.length === 0) return undefined
	if (!isObject(value.constants)) return undefined
	if (typeof value.fallbackMarkdown !== 'string') return undefined
	if (!Array.isArray(value.stateKeys)) return undefined
	if (!Array.isArray(value.genuiComponents)) return undefined
	if (!isObject(value.appData)) return undefined
	return value as unknown as DilCompiled
}

/** Narrow one untrusted value to {@link ArtifactMeta}. */
export function artifactMetaFrom(value: unknown): ArtifactMeta | undefined {
	if (!isObject(value)) return undefined
	const row = value
	if (row.kind !== 'artifact') return undefined
	if (typeof row.id !== 'string' || row.id.length === 0) return undefined
	if (typeof row.title !== 'string') return undefined
	if (typeof row.version !== 'number' || !Number.isFinite(row.version)) return undefined
	if (row.mode !== 'inline' && row.mode !== 'wide') return undefined

	// Rows written before `engine` existed are all HTML: the DIL path is the one
	// that introduced the field.
	const engine: ArtifactEngine = row.engine === 'dil' ? 'dil' : 'html'
	const mode: ArtifactMode = row.mode

	const shared = {
		kind: 'artifact' as const,
		engine,
		action: row.action === 'patch' ? ('patch' as const) : ('create' as const),
		id: row.id,
		title: row.title,
		version: row.version,
		mode,
		sizeBytes: typeof row.sizeBytes === 'number' ? row.sizeBytes : 0,
		...(typeof row.versionNumber === 'number' ? { versionNumber: row.versionNumber } : {}),
		...(typeof row.parentVersionId === 'string' ? { parentVersionId: row.parentVersionId } : {}),
		...(typeof row.contentSha256 === 'string' ? { contentSha256: row.contentSha256 } : {}),
		...(typeof row.contentBytes === 'number' ? { contentBytes: row.contentBytes } : {}),
		...(typeof row.changelog === 'string' ? { changelog: row.changelog } : {}),
		...(typeof row.session === 'string' ? { session: row.session } : {})
	}

	if (engine === 'dil') {
		const dil = dilCompiledFrom(row.dil)
		if (dil === undefined) return undefined
		return { ...shared, dil }
	}

	if (typeof row.html !== 'string') return undefined
	return {
		...shared,
		html: row.html,
		render: row.render === 'reconcile' ? 'reconcile' : 'reload',
		sizeBytes: typeof row.sizeBytes === 'number' ? row.sizeBytes : row.html.length
	}
}

/**
 * A revision on the HTML path, with the payload narrowed to actually present.
 * Components that render a frame take this rather than {@link ArtifactMeta}, so
 * "there is no html" is a type error at the point of use instead of a runtime
 * crash inside a mount effect.
 */
export type ArtifactMetaHtml = ArtifactMeta & { engine: 'html', html: string }

/** A revision on the DIL path, with the compiled payload narrowed to present. */
export type ArtifactMetaDil = ArtifactMeta & { engine: 'dil', dil: DilCompiled }

/**
 * Narrow a revision to the HTML path.
 * @param meta - a revision of either path.
 * @returns the revision with `html` guaranteed, or undefined on the DIL path.
 */
export function asHtmlMeta(meta: ArtifactMeta): ArtifactMetaHtml | undefined {
	return meta.engine === 'html' && typeof meta.html === 'string' ? meta as ArtifactMetaHtml : undefined
}

/**
 * Narrow a revision to the DIL path.
 * @param meta - a revision of either path.
 * @returns the revision with `dil` guaranteed, or undefined on the HTML path.
 */
export function asDilMeta(meta: ArtifactMeta): ArtifactMetaDil | undefined {
	return meta.engine === 'dil' && meta.dil !== undefined ? meta as ArtifactMetaDil : undefined
}

/**
 * Read one string field out of a possibly incomplete JSON argument stream.
 *
 * While the model is still emitting a tool call, the accumulated `argsRaw` is a
 * JSON document cut mid-flight, so this scans the named string and decodes its
 * escapes without ever parsing the whole object. Returns the decoded prefix.
 * @param raw - accumulated argument text, complete or not.
 * @param field - property name to read.
 * @returns the decoded value, or undefined when the field has not started.
 */
export function partialStringField(raw: string | undefined, field: string): string | undefined {
	if (raw === undefined || raw.length === 0) return undefined
	const key = new RegExp(`"${field}"\\s*:\\s*"`, 'u')
	const match = key.exec(raw)
	if (match === null) return undefined
	let out = ''
	let index = match.index + match[0].length
	while (index < raw.length) {
		const char = raw[index]
		if (char === '"') return out
		if (char !== '\\') {
			out += char
			index += 1
			continue
		}
		const next = raw[index + 1]
		if (next === undefined) return out
		if (next === 'u') {
			const hex = raw.slice(index + 2, index + 6)
			if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/u.test(hex)) return out
			out += String.fromCharCode(Number.parseInt(hex, 16))
			index += 6
			continue
		}
		out += unescapeOne(next)
		index += 2
	}
	return out
}

/** Decode one JSON string escape body. */
function unescapeOne(char: string): string {
	switch (char) {
		case 'n': return '\n'
		case 't': return '\t'
		case 'r': return '\r'
		case 'b': return '\b'
		case 'f': return '\f'
		default: return char
	}
}

/**
 * A provisional meta assembled from a streaming call, before it settles.
 *
 * The client renders this while the model is still writing, so only the fields
 * needed to draw something are read, and nothing here is trusted as final.
 * @param raw - accumulated argument text, complete or not.
 * @param engine - override the path; by default it is read from the stream.
 * @returns a provisional meta, or undefined before the payload has started.
 */
export function streamingMetaFromArgs(raw: string | undefined, engine?: ArtifactEngine): ArtifactMeta | undefined {
	// The tool's own default is the DIL path, so a stream that has not yet reached
	// `engine` is assumed to be DIL. An explicit caller always wins.
	const requested = partialStringField(raw, 'engine')
	const path: ArtifactEngine = engine ?? (requested === 'html' ? 'html' : 'dil')
	const title = partialStringField(raw, 'title')
	const mode = partialStringField(raw, 'mode')
	const id = partialStringField(raw, 'id')
	const shared = {
		kind: 'artifact' as const,
		engine: path,
		action: 'create' as const,
		id: id ?? 'streaming',
		title: title === undefined || title.length === 0 ? 'Artifact' : title,
		version: 1,
		mode: mode === 'wide' ? ('wide' as const) : ('inline' as const),
		sizeBytes: 0
	}
	if (path === 'html') {
		const html = partialStringField(raw, 'html')
		if (html === undefined || html.length === 0) return undefined
		return { ...shared, html, render: 'reload', sizeBytes: html.length }
	}
	const source = partialStringField(raw, 'source')
	if (source === undefined || source.length === 0) return undefined
	// A partial document has no compiled program yet, so the card cannot mount a
	// view from it. The source travels so the preview can show what is arriving;
	// the real payload replaces this meta when the call settles.
	return { ...shared, dil: { source } as unknown as DilCompiled }
}

/** Whether a string-array field was recovered, for callers that need the check. */
export { isStringArray }
