/**
 * View-state reporting: keyed sandbox state → the host.
 *
 * Rapid changes (typing, dragging a slider) collapse into one update carrying the
 * latest full state. Upstream POSTs that body to `/dil/view_state`; here the sink is a
 * callback the host half owns, because in DSH the destination is a cordis service, not
 * a route this half can name. The coalescing, the id, and the scope are unchanged.
 * @module dsh-genui/client/dil/view-state
 */

/** One update as the server receives it. */
export interface DilStateUpdate {
	scope: string
	state: Record<string, unknown>
	client_update_id: string
}

/** The whole body of one report. */
export interface DilStateReport {
	client_session_id: string
	updates: DilStateUpdate[]
}

/** One RFC 4122 v4 id, from the platform generator when there is one. */
export function uuid(): string {
	const source = globalThis.crypto
	if (typeof source?.randomUUID === 'function') return source.randomUUID()
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/gu, (char) => {
		const random = (Math.random() * 16) | 0
		return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16)
	})
}

/** One id per page load, like the captured `client_session_id`. */
export const CLIENT_SESSION_ID = uuid()

/** How long rapid changes are allowed to pile up before one report goes out. */
export const STATE_REPORT_DELAY_MS = 600

/** Options for {@link createStateReporter}. */
export interface StateReporterOptions {
	/** Where one coalesced report goes. Called at most once per `delayMs`. */
	send(report: DilStateReport): void
	/** Hold reports until this says the destination is addressable. Defaults to always. */
	ready?(): boolean
	/** Coalescing window. */
	delayMs?: number
	/** The sink threw; the state is dropped, not retried. */
	onError?(error: unknown): void
}

/** A coalescing reporter over one keyed-state sink. */
export interface DilStateReporter {
	/** Record the latest full state; the report goes out after the coalescing window. */
	queue(state: Record<string, unknown>, scope?: string): void
	/** Send whatever is pending now. Returns whether anything went out. */
	flush(): boolean
	/** True while a change is waiting for its window. */
	readonly hasPending: boolean
	/** Drop the pending change without sending it. */
	cancel(): void
}

/**
 * Build a reporter.
 * @param options - the sink, the readiness gate, and the window.
 */
export function createStateReporter(options: StateReporterOptions): DilStateReporter {
	const delayMs = options.delayMs ?? STATE_REPORT_DELAY_MS
	let pending: { scope: string; state: Record<string, unknown> } | null = null
	let timer: ReturnType<typeof setTimeout> | null = null

	function flush(): boolean {
		if (timer !== null) {
			clearTimeout(timer)
			timer = null
		}
		if (!pending) return false
		if (options.ready && !options.ready()) return false // retried by the caller once the host is ready
		const { scope, state } = pending
		pending = null
		try {
			options.send({
				client_session_id: CLIENT_SESSION_ID,
				updates: [{ scope, state, client_update_id: uuid() }]
			})
			return true
		} catch (error) {
			options.onError?.(error)
			return false
		}
	}

	return {
		queue(state: Record<string, unknown>, scope = 'root'): void {
			pending = { scope, state }
			if (timer === null) timer = setTimeout(() => void flush(), delayMs)
		},
		flush,
		get hasPending(): boolean {
			return pending !== null
		},
		cancel(): void {
			if (timer !== null) {
				clearTimeout(timer)
				timer = null
			}
			pending = null
		}
	}
}
