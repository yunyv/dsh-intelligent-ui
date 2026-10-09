/**
 * The compiled-program contract of the DIL pipeline: what the host half produces
 * when it compiles model-authored source, and what the client half renders,
 * patches and replays.
 *
 * `DilCompiled` is a line-for-line mirror of the upstream `compile()` return value
 * (`vendor/dil-replica/replica/server/compiler/index.js`): same field names, same
 * value shapes, same declaration order. The client half implements against this
 * type, so nothing here may be renamed, dropped or "tidied".
 * @module dsh-intelligent-ui/dil/types
 */

/**
 * One recovery or repair note, positioned in the *source* the model wrote.
 *
 * `code` is the stable identifier the developer panel groups by (`invalid_tagname`,
 * `implicit_state`, …); `action` says what the compiler did about it (`recovered_parse`,
 * `dropped`, `replaced`, `declared`, `deferred`, `fallback`). The remaining fields are
 * the evidence for that particular code (`tag`, `directive`, `snippet`, `expected`,
 * `found`, `name`) and are present only where the reporter has them.
 */
export interface DilDiagnostic {
	/** Stable identifier of the failure or repair. */
	code: string
	/** 1-based line of the offending source position. */
	line: number
	/** 1-based column (UTF-16 units) of the offending source position. */
	column: number
	/** What the compiler did instead (`recovered_parse`, `dropped`, `replaced`, `declared`, `deferred`, `fallback`). */
	action?: string
	/** Block directive involved (`if`, `each`, `body`). */
	directive?: string
	/** Truncated source text of the fragment that failed. */
	snippet?: string
	/** State name the repair declared. */
	name?: string
	/** Tag the diagnostic is about. */
	tag?: string
	/** Tag or directive the parser wanted to close. */
	expected?: string
	/** Tag or directive it actually found. */
	found?: string
}

/**
 * A diagnostic before the source position is turned into `line` / `column`.
 *
 * The compiler stages collect `pos` (a UTF-16 index) and are positioned once, in
 * `compile`, by {@link DilDiagnostic}'s producer. Kept separate so the staged list
 * carries no half-filled line numbers.
 */
export interface PendingDiagnostic extends Omit<DilDiagnostic, 'line' | 'column'> {
	/** UTF-16 index into the source, before `lineCol` positioning. */
	pos: number
}

/** One host component occurrence, keyed by the id the compiled code passes as `__resolutionId`. */
export interface DilComponentResolution {
	/** Resolution outcome the host reported. */
	status: string
	/** State the component reported back. */
	state: Record<string, unknown>
	/** Tag name of the host component this id stands for. */
	componentName: string
}

/**
 * A widget-channel component span, exactly as the captured stream labels it:
 * `{"type":"charts_widget_v2","tree_range":[58,59],"start_index":8021,"end_index":8039}`.
 *
 * `start_index` / `end_index` are Unicode code point offsets into the source, not
 * UTF-16 units. While a tag is still being written `end_index` is the end of the
 * source so far and `streaming` marks it unfinished.
 */
export interface DilGenuiComponent {
	/** Widget type as the stream labels it (`charts_widget_v2`, `memory_cite`, …). */
	type: string
	/** The element's `[pre-order index, +1)` among all elements in the document. */
	tree_range: [number, number]
	/** Code point offset of the element's opening `<`. */
	start_index: number
	/** Code point offset just past the element's `>`, or the end of the source while streaming. */
	end_index: number
	/** Present on host components: the id `appData.opGenui.componentResults` is keyed by. */
	component_resolution_id?: string
	/** Present while the element has not been closed yet. */
	streaming?: boolean
}

/** Data the host hands to the program alongside the compiled code. */
export interface DilAppData {
	opGenui: {
		/** Resolution for every host component occurrence, keyed by `__resolutionId`. */
		componentResults: Record<string, DilComponentResolution>
		/** Host-supplied bindings the program reads through `DIL.useAppData`. */
		modelDataBindings: unknown
	}
}

/**
 * Everything one compile produced. Shipped whole to the client on every revision;
 * the client renders `code` in a sandbox using `constants` and `appData`, and falls
 * back to `fallbackMarkdown` where execution is unavailable.
 */
export interface DilCompiled {
	/** True when the source compiled with no diagnostic at all. */
	ok: boolean
	/** Version of this contract. */
	protocolVersion: number
	/** The exact source that was compiled. */
	source: string
	/** UTF-16 length of {@link source}, for the UI. */
	sourceLength: number
	/** The compiled JavaScript program. */
	code: string
	/** UTF-16 length of {@link code}, for the UI. */
	codeLength: number
	/** Text constant pool, referenced from the program as `__dilConstants["n"]`. */
	constants: Record<string, unknown>
	/** Number of entries in {@link constants}. */
	constantCount: number
	/** PascalCase tags the program expects the host to resolve, in occurrence order. */
	requiredComponents: string[]
	/** Component results and data bindings the program runs against. */
	appData: DilAppData
	/** Widget-channel spans for the streaming UI, in document order. */
	genuiComponents: DilGenuiComponent[]
	/** `useState` keys the program declares, in declaration order. */
	stateKeys: string[]
	/** Static markdown projection, for clients without a sandbox. */
	fallbackMarkdown: string
	/** Everything that went wrong or was repaired, in discovery order. */
	diagnostics: DilDiagnostic[]
	/** `clean`, or `code×n` pairs — the one-line form the UI shows. */
	diagnosticSummary: string
	/** Wall-clock milliseconds this compile took. */
	durationMs: number
	/** ISO timestamp of this compile. */
	compiledAt: string
}

/** Caller-supplied inputs to a compile. */
export interface DilCompileOptions {
	/** Host data bindings exposed to the program through `DIL.useAppData`. */
	modelDataBindings?: unknown
}
