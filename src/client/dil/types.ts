/**
 * The DIL wire shapes, as they cross the three boundaries of this module:
 *
 *   compiler (host half) ──DilCompiled──► mount ──createRunner/setCompiledDil──► frame
 *   frame ──DilSnapshotMessage(tree)──► patch engine ──► DOM
 *   DOM event ──{__dilFn}──► trigger(fnId, args) ──► frame
 *
 * Everything in this file is deliberately tolerant: `DilCompiled` mirrors the
 * compiler's return value but types the parts this half never interprets as
 * `unknown`, so a stricter definition on either side stays assignable in both
 * directions.
 * @module dsh-genui/client/dil/types
 */

/** A prop bag as the sandbox serialized it: JSON values plus `{__dilFn}` handler refs. */
export type DilProps = Record<string, any>

/** A text node in the serialized tree. */
export interface DilTextNode {
	t: '#text'
	v: string
}

/** A fragment: flattened away before it reaches the DOM. */
export interface DilFragmentNode {
	t: '#frag'
	c?: DilNode[]
}

/** An element: a tag from the host's vocabulary, its props, its children. */
export interface DilElementNode {
	t: string
	p?: DilProps
	c?: DilNode[]
}

/** One node of the tree the sandbox posts out. */
export type DilNode = DilTextNode | DilFragmentNode | DilElementNode

/** A function prop: the handler itself lives in the worker; only this id crosses over. */
export interface DilHandlerRef {
	__dilFn: string
}

/** A failure as the sandbox describes it. */
export interface DilError {
	name?: string
	message: string
	stack?: string
}

/** Per-run counters the worker reports with every snapshot. */
export interface DilStats {
	version?: number
	renderCount?: number
	handlers?: number
	states?: number
}

/**
 * One compiled revision — the compiler's return value, narrowed to what this half
 * reads. `code` is the whole program; it is evaluated in the sandbox worker, never here.
 */
export interface DilCompiled {
	/** The program: `DIL.render(__dil.jsx(...))`, evaluated inside the worker. */
	code: string
	/** Constant pool the program reads through `DIL.useConstants()`. */
	constants?: Readonly<Record<string, unknown>>
	/** `{ opGenui: { componentResults, modelDataBindings } }`; opaque to this half. */
	appData?: unknown
	/** Host components the program references. */
	requiredComponents?: readonly string[]
	/** Keyed state names, for a host that wants to know the shape up front. */
	stateKeys?: readonly string[]
	/** Markdown projection for a host without a sandbox. */
	fallbackMarkdown?: string
	/** One-line diagnostic digest, e.g. `clean` or `undeclared_state×2`. */
	diagnosticSummary?: string
	/** Everything else the compiler returns; carried, never interpreted. */
	ok?: boolean
	protocolVersion?: number
	source?: string
	sourceLength?: number
	codeLength?: number
	constantCount?: number
	diagnostics?: readonly unknown[]
	genuiComponents?: readonly unknown[]
	durationMs?: number
	compiledAt?: string
}

/** Everything that crossed the sandbox boundary, for diagnostics. */
export interface DilProtocolEntry {
	dir: string
	kind: string
	detail?: unknown
	at: number
}

/** The host-facing options of {@link mountDilView}. */
export interface DilMountOptions {
	/** Keyed state after the worker rendered it; coalesced, `scope` defaulting to `root`. */
	onStateChange(state: Record<string, unknown>, scope?: string): void
	/** A handler fired in the sandbox: the id, and the args sent back to it. */
	onEvent(fnId: string, args: unknown): void
	/** Embedder data merged over the compiled revision's own `appData`. */
	appData?: unknown
	/** Serve the runner document from this URL instead of generating it into `srcdoc`. */
	frameUrl?: string
}

/** What the host half holds while the view is mounted. */
export interface DilMountHandle {
	/** Push the next compiled revision into the sandbox; later calls patch in place. */
	update(payload: DilCompiled): void
	/** Seed keyed state — a saved snapshot — and restart the runner with it. */
	setState(state: Record<string, unknown>): void
	/** Tear the sandbox and the DOM down. */
	destroy(): void
}

/** A DOM node carrying the renderer's own bookkeeping. */
export type DilElement = HTMLElement & { dilValue?: unknown }

/** What one component factory returns: a node, an updater, and its contract with the patcher. */
export interface DilHandle {
	node: HTMLElement
	update(props: DilProps): void
	/** Where children are patched; defaults to `node`. */
	childHost?: Node
	/** `{ domEvent: 'propName' }` — overrides the default event for a prop. */
	events?: Record<string, string>
	/** Read the value that travels back to the sandbox with the event. */
	readValue?: (event: Event) => unknown
}

/** The patcher context every factory receives. */
export interface DilContext {
	onEvent(fnId: string, args: unknown[], meta?: { type?: string; value?: unknown }): void
	onMissingComponent?(tag: string, result: unknown): void
	componentResults: Record<string, DilComponentResult>
	/**
	 * Register a cleanup for `destroy()`. A factory that starts an observer, a timer
	 * or a listener owns its own teardown, and a view outlives the page it lives in.
	 */
	onTeardown?(dispose: () => void): void
}

/** One entry of `appData.opGenui.componentResults`. */
export interface DilComponentResult {
	status?: string
	componentName?: string
}
