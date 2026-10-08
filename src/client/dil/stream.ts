/**
 * The streamed message model.
 *
 * The server sends `{p,o,v}` patches against a document whose root is `message`;
 * applying them in order reproduces the message exactly as the server built it.
 * `openTurn()` wraps an SSE connection and turns events into callbacks; the DSH host
 * half may instead feed `applyPatch` from its own transport — both paths land in the
 * same message shape.
 * @module dsh-genui/client/dil/stream
 */

/** One `{p,o,v}` patch from the stream. */
export interface DilPatch {
	/** Path, rooted at the stream document: `/message/content/…`. */
	p: string
	/** `append` | `remove` | `add` | `replace` (default). */
	o?: string
	v?: unknown
}

/** The streamed message, as much of it as this half touches. */
export interface DilMessage {
	id: string
	status: string
	content: { content_type: string; parts: string[] }
	metadata: {
		model_dil_v2: Record<string, unknown>
		genui_components: unknown[]
	}
}

type AnyRecord = Record<string, any>

/** The empty message a turn starts from. */
export function emptyMessage(id?: string): DilMessage {
	return {
		id: id ?? 'msg_' + Math.random().toString(36).slice(2, 8),
		status: 'in_progress',
		content: { content_type: 'text', parts: [''] },
		metadata: {
			model_dil_v2: {
				code: '',
				constants: {},
				appData: {},
				fallbackMarkdown: '',
				diagnostics: [],
				requiredComponents: [],
				stats: null
			},
			genui_components: []
		}
	}
}

/**
 * Apply one patch. Paths are rooted at the stream document: `/message/content/…`.
 * @param message - the message to mutate.
 * @param patch - one `{p,o,v}` patch.
 * @returns the same message, for chaining.
 */
export function applyPatch(message: DilMessage, patch: DilPatch): DilMessage {
	const tokens: (string | number)[] = (patch.p || '')
		.split('/')
		.filter(Boolean)
		.map((token) => (/^\d+$/u.test(token) ? Number(token) : token))
	if (tokens[0] === 'message') tokens.shift()
	if (!tokens.length) return message

	let cursor = message as unknown as AnyRecord
	for (let index = 0; index < tokens.length - 1; index += 1) {
		const token = tokens[index]!
		if (cursor[token] == null) cursor[token] = typeof tokens[index + 1] === 'number' ? [] : {}
		cursor = cursor[token]
	}
	const last = tokens[tokens.length - 1]!

	switch (patch.o) {
		case 'append': {
			const base = cursor[last]
			if (typeof base === 'string' && typeof patch.v === 'string') cursor[last] = base + patch.v
			else if (Array.isArray(base) && Array.isArray(patch.v)) cursor[last] = base.concat(patch.v)
			else cursor[last] = patch.v
			break
		}
		case 'remove':
			if (Array.isArray(cursor)) cursor.splice(Number(last), 1)
			else delete cursor[last]
			break
		default: // replace / add
			cursor[last] = patch.v
	}
	return message
}

/** True when this patch is the compiled program arriving — the moment to push it. */
export function patchCarriesCode(patch: DilPatch): boolean {
	return (patch.p || '').endsWith('/model_dil_v2/code')
}

/**
 * Read the compiled revision out of a message.
 * @param message - a message whose `model_dil_v2` has been streamed in.
 * @returns the compiled payload, or null while there is no program yet.
 */
export function compiledOf(message: DilMessage): Record<string, unknown> | null {
	const meta = message.metadata.model_dil_v2
	const code = meta.code
	return typeof code === 'string' && code.length > 0 ? meta : null
}

/** Callbacks one streamed turn reports through. */
export interface TurnHandlers {
	meta?(meta: Record<string, unknown>): void
	thinking?(thinking: string): void
	note?(note: { label: string; detail?: unknown; at: number }): void
	patch?(patch: DilPatch): void
	complete?(stats: unknown): void
	error?(error: { message: string }): void
	done?(): void
}

/** The parameters one turn is opened with. */
export interface TurnParams {
	q: string
	conversation_id?: string | null
	source?: string
	speed?: number
}

/**
 * Open one conversation turn over SSE.
 *
 * The URL is a parameter, not a constant: the endpoint is the host half's to define.
 * @param url - SSE endpoint, already carrying any query the host wants.
 * @param handlers - one callback per event the turn emits.
 * @returns close the connection.
 */
export function openTurn(url: string, handlers: TurnHandlers): () => void {
	const source = new EventSource(url)
	const json = <T>(fn: ((payload: T) => void) | undefined) => (event: MessageEvent) => {
		if (fn) fn(JSON.parse(String(event.data)) as T)
	}

	source.addEventListener('meta', json(handlers.meta))
	source.addEventListener('thinking', json((payload: string) => handlers.thinking?.(payload)))
	source.addEventListener('note', json(handlers.note))
	source.addEventListener('delta', (event) => {
		const data = JSON.parse(String(event.data)) as AnyRecord
		if (data.type === 'message_stream_complete') handlers.complete?.(data.stats)
		else if (!data.type) handlers.patch?.(data as DilPatch)
	})
	source.addEventListener('error', (event) => {
		const data = (event as MessageEvent).data
		if (data) handlers.error?.(JSON.parse(String(data)) as { message: string })
	})
	source.onmessage = (event) => {
		if (event.data !== '[DONE]') return
		source.close()
		handlers.done?.()
	}
	source.onerror = () => {
		// a dropped connection before [DONE] is a failure, not a reconnect: the turn is gone
		if (source.readyState === EventSource.CLOSED) return
		source.close()
		handlers.error?.({ message: '连接中断' })
		handlers.done?.()
	}
	return () => source.close()
}
