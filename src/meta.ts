/**
 * Wire contract shared by both halves of the plugin: the tool name the client
 * keys its Tool view on, the metadata shape the host half publishes through
 * `output.presentationMeta` (and therefore the client reads back as
 * `block.meta`), the frame message types, and the tolerant argument reader the
 * streaming preview uses while the model is still writing the call.
 * Pure: no node builtins, no host imports, so the browser bundle can share it.
 * @module dsh-artifacts-live/meta
 */

/** Package identity: the harness client-module id and the ModuleLoader entry id. */
export const PLUGIN_ID = 'dsh-artifacts-live'

/** Wire tool name; also the key the client registers under `tool.call.toolview`. */
export const ARTIFACT_TOOL_NAME = 'artifact'

/** Card width family. `wide` exists for side-by-side comparison layouts. */
export type ArtifactMode = 'inline' | 'wide'

/** How the live frame must adopt the next revision. */
export type ArtifactRender = 'reload' | 'reconcile'

/** One artifact revision as the client receives it inside the tool result. */
export interface ArtifactMeta {
	kind: 'artifact'
	action: 'create' | 'patch'
	/** Stable artifact identity for the session; patches address it. */
	id: string
	title: string
	/** Complete source, so replay restores the card without any live registry. */
	html: string
	/** Monotonic revision, starting at 1. Drives in-place adoption. */
	version: number
	mode: ArtifactMode
	render: ArtifactRender
	sizeBytes: number
	/** Owning session id, so a session-scoped catalog can filter. */
	session?: string
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

/** Narrow one untrusted value to {@link ArtifactMeta}. */
export function artifactMetaFrom(value: unknown): ArtifactMeta | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const row = value as Record<string, unknown>
	if (row.kind !== 'artifact') return undefined
	if (typeof row.id !== 'string' || row.id.length === 0) return undefined
	if (typeof row.html !== 'string') return undefined
	if (typeof row.title !== 'string') return undefined
	if (typeof row.version !== 'number' || !Number.isFinite(row.version)) return undefined
	if (row.mode !== 'inline' && row.mode !== 'wide') return undefined
	return {
		kind: 'artifact',
		action: row.action === 'patch' ? 'patch' : 'create',
		id: row.id,
		title: row.title,
		html: row.html,
		version: row.version,
		mode: row.mode,
		render: row.render === 'reconcile' ? 'reconcile' : 'reload',
		sizeBytes: typeof row.sizeBytes === 'number' ? row.sizeBytes : row.html.length,
		...(typeof row.session === 'string' ? { session: row.session } : {})
	}
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

/** A provisional meta assembled from a streaming call, before it settles. */
export function streamingMetaFromArgs(raw: string | undefined): ArtifactMeta | undefined {
	const html = partialStringField(raw, 'html')
	if (html === undefined || html.length === 0) return undefined
	const title = partialStringField(raw, 'title')
	const mode = partialStringField(raw, 'mode')
	const id = partialStringField(raw, 'id')
	return {
		kind: 'artifact',
		action: 'create',
		id: id ?? 'streaming',
		title: title === undefined || title.length === 0 ? 'Artifact' : title,
		html,
		version: 1,
		mode: mode === 'wide' ? 'wide' : 'inline',
		render: 'reload',
		sizeBytes: html.length
	}
}
