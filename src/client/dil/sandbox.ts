/**
 * Sandbox host — the browser side of the iframe contract.
 *
 *   host ──postMessage──► sandboxed iframe (opaque origin, CSP default-src 'none')
 *                              └──► blob: Worker that runs the compiled program
 *
 * Creates the invisible iframe, waits for `ready`, pushes compiled revisions in and
 * receives element-tree snapshots and keyed-state reports out. It knows nothing about
 * rendering: pair it with `mount()` from the renderer.
 *
 * The frame is headless. It is never the display container: it measures nothing, paints
 * nothing, and its only output is the serialized tree the host renders into its own DOM.
 * @module dsh-genui/client/dil/sandbox
 */

import { buildRunnerHtml } from './frame.ts'
import { acceptsVersion, isFrameMessage, PROTOCOL_VERSION, type DilFrameMessage } from './protocol.ts'
import type { DilError, DilNode, DilProtocolEntry, DilStats } from './types.ts'

export { PROTOCOL_VERSION }

/** How long the frame gets to announce itself before the host gives up on it. */
const BOOT_TIMEOUT_MS = 5000

const noop = () => {}

/** One tree snapshot, as the frame forwarded it from the worker. */
export interface DilSandboxSnapshot {
	tree: DilNode | null
	version: number
	reason?: string | null
	error?: DilError | null
	stats?: DilStats | null
}

/** One compiled revision, on its way into the sandbox. */
export interface DilRunnerPayload {
	compiledDil: string
	constants?: Readonly<Record<string, unknown>>
	appData?: unknown
	/** Keyed state to seed: a snapshot saved by an earlier session. */
	initialState?: Record<string, unknown> | null
}

/** Options for {@link DilSandbox}. */
export interface DilSandboxOptions {
	/** Serve the runner from this URL instead of generating it into `srcdoc`. */
	frameUrl?: string
	/** Where the iframe lives; a shadow root keeps it scoped to the view. */
	container?: Node | null
	onSnapshot?(message: DilSandboxSnapshot): void
	onStateChange?(state: Record<string, unknown>, scope: string, reason?: string): void
	onFailure?(error: DilError, stage: string): void
	/** Everything that crossed the boundary, for diagnostics. */
	onProtocol?(entry: DilProtocolEntry): void
	/** Document the frame is created in. Defaults to the global one. */
	document?: Document
	/** Boot budget. */
	bootTimeoutMs?: number
	/** Replacement runner document; see {@link buildRunnerHtml}. */
	srcdoc?: string
}

/** The host's end of the iframe contract. */
export class DilSandbox {
	readonly frameUrl: string | undefined
	readonly container: Node | null
	frame: HTMLIFrameElement | null = null
	connected = false
	runnerId: string | null = null

	private readonly options: DilSandboxOptions
	private readonly doc: Document
	private ready: Promise<DilSandbox> | null = null
	private onWindowMessage: ((event: MessageEvent) => void) | null = null

	constructor(options: DilSandboxOptions = {}) {
		this.options = options
		this.frameUrl = options.frameUrl
		this.container = options.container ?? null
		this.doc = options.document ?? globalThis.document
	}

	/** The window the frame will post to, and the one that delivers its messages. */
	private get view(): Window & typeof globalThis {
		return (this.doc.defaultView ?? globalThis) as Window & typeof globalThis
	}

	/**
	 * Create the frame and wait for its `ready`.
	 * @returns this sandbox, once the frame speaks the protocol.
	 */
	connect(): Promise<DilSandbox> {
		if (this.ready) return this.ready
		this.ready = new Promise<DilSandbox>((resolve, reject) => {
			const frame = this.doc.createElement('iframe')
			if (this.frameUrl) frame.src = this.frameUrl
			else frame.srcdoc = this.options.srcdoc ?? buildRunnerHtml()
			// no allow-same-origin: the frame gets an opaque origin, so it cannot reach
			// this document, its storage, or its cookies
			frame.setAttribute('sandbox', 'allow-scripts')
			frame.setAttribute('referrerpolicy', 'no-referrer')
			frame.setAttribute('aria-hidden', 'true')
			frame.setAttribute('data-dil-sandbox', 'true')
			frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden'
			this.frame = frame

			const timer = setTimeout(() => {
				this.log('frame', 'boot_timeout', { ms: this.options.bootTimeoutMs ?? BOOT_TIMEOUT_MS })
				frame.remove()
				this.frame = null
				reject(new Error('sandbox frame did not become ready'))
			}, this.options.bootTimeoutMs ?? BOOT_TIMEOUT_MS)

			this.onWindowMessage = (event) => {
				if (event.source !== frame.contentWindow) return
				const message = event.data as unknown
				if (!isFrameMessage(message)) return
				if (!acceptsVersion(message)) {
					this.log('frame', 'protocol_mismatch', { got: message.protocolVersion })
					return
				}
				if (message.kind === 'ready') {
					if (this.connected) return
					this.connected = true
					clearTimeout(timer)
					this.log('frame', 'ready', { protocolVersion: message.protocolVersion })
					resolve(this)
					return
				}
				this.handle(message)
			}
			this.view.addEventListener('message', this.onWindowMessage)
			;(this.container ?? this.doc.body).appendChild(frame)
		})
		return this.ready
	}

	/** Record one boundary crossing. */
	private log(dir: string, kind: string, detail?: unknown): void {
		;(this.options.onProtocol ?? noop)({ dir, kind, detail, at: Date.now() })
	}

	/** A message the frame may report the state of, and where it may come from. */
	private handle(message: DilFrameMessage): void {
		switch (message.kind) {
			case 'diagnostic':
				this.log('frame:diag', `${message.stage}:${message.phase}`, message.detail)
				break
			case 'snapshot':
				this.log('frame→host', 'snapshot', { version: message.version, reason: message.reason, hasError: !!message.error })
				;(this.options.onSnapshot ?? noop)({
					tree: (message.tree ?? null) as DilNode | null,
					version: typeof message.version === 'number' ? message.version : 0,
					reason: (message.reason ?? null) as string | null,
					error: (message.error ?? null) as DilError | null,
					stats: (message.stats ?? null) as DilStats | null
				})
				break
			case 'stateChanged': {
				const state = (message.state ?? {}) as Record<string, unknown>
				this.log('frame→host', 'stateChanged', { reason: message.reason, keys: Object.keys(state).length })
				;(this.options.onStateChange ?? noop)(state, message.scope ?? 'root', message.reason)
				break
			}
			case 'failure':
				this.log('frame→host', 'failure', { stage: message.stage, message: (message.error as DilError | undefined)?.message })
				;(this.options.onFailure ?? noop)((message.error ?? { name: 'Error', message: 'unknown failure' }) as DilError, message.stage ?? 'unknown')
				break
			case 'timeout':
				this.log('frame→host', 'timeout', { stage: message.stage })
				;(this.options.onFailure ?? noop)(
					{ name: 'Timeout', message: `sandbox exceeded its render budget (${message.stage})` },
					'timeout'
				)
				break
			case 'quarantined':
				this.log('frame→host', 'quarantined', { reason: message.reason })
				;(this.options.onFailure ?? noop)({ name: 'Quarantined', message: String(message.reason) }, 'quarantine')
				break
			case 'ack':
				this.log('frame→host', 'ack', { id: message.id, ok: message.ok })
				break
			default:
				break
		}
	}

	/** Post one message into the frame. Returns whether it went anywhere. */
	send(message: DilFrameMessage): boolean {
		const target = this.frame?.contentWindow
		if (!target) return false
		target.postMessage({ __dilFrame: true, protocolVersion: PROTOCOL_VERSION, ...message }, '*')
		return true
	}

	/** First program for a message: spawns the worker. */
	createRunner(runnerId: string, payload: DilRunnerPayload): void {
		this.runnerId = runnerId
		this.log('host→frame', 'createRunner', { runnerId, bytes: payload.compiledDil.length })
		this.send({
			kind: 'createRunner',
			runnerId,
			compiledDil: payload.compiledDil,
			constants: payload.constants ?? {},
			appData: payload.appData ?? {},
			initialState: payload.initialState ?? null
		})
	}

	/** Later revisions while streaming: state is kept, only the program changes. */
	setCompiledDil(payload: Omit<DilRunnerPayload, 'initialState'>): void {
		this.log('host→frame', 'setCompiledDil', { bytes: payload.compiledDil.length })
		this.send({
			kind: 'setCompiledDil',
			compiledDil: payload.compiledDil,
			constants: payload.constants ?? {},
			appData: payload.appData ?? {}
		})
	}

	/** Run one handler inside the sandbox; the tree it produces comes back as a snapshot. */
	trigger(fnId: string, args: readonly unknown[] = []): void {
		this.log('host→frame', 'trigger', { fnId })
		this.send({ kind: 'trigger', fnId, args: [...args] })
	}

	/** Ask the worker for its keyed state. */
	requestState(): void {
		this.send({ kind: 'stateSnapshotRequest' })
	}

	/** Tear the frame down and forget it. */
	dispose(): void {
		this.send({ kind: 'dispose' })
		if (this.onWindowMessage) this.view.removeEventListener('message', this.onWindowMessage)
		this.onWindowMessage = null
		this.frame?.remove()
		this.frame = null
		this.connected = false
		this.ready = null
	}
}
