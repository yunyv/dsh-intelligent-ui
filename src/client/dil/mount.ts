/**
 * `mountDilView` — the one entry point the host half calls.
 *
 *   update(DilCompiled) ─► sandbox(frame ─► worker) ─► tree ─► renderer ─► shadow DOM
 *                                     ▲                              │
 *                                     └──── trigger(fnId, args) ◄────┘ DOM event
 *
 * What this function owns: the stylesheet and the view element in the given shadow
 * root, the frame, the patched-up DOM tree, the coalesced keyed-state report, and the
 * teardown of all four. What it deliberately does not own: the card chrome (React, the
 * host half), the streaming (the host half), and the fallback markdown for a client
 * without a sandbox (the host half).
 *
 * The tree itself is rendered with the plain DOM renderer, never React: the sandbox
 * emits data, the patcher keeps node identity across revisions (an `<input>` keeps
 * focus while the model streams its own next revision), and a React tree would re-own
 * the very nodes that identity depends on.
 * @module dsh-genui/client/dil/mount
 */

import { mount as mountRenderer, type DilRenderer } from './renderer/index.ts'
import { DilSandbox, type DilSandboxSnapshot, type DilRunnerPayload } from './sandbox.ts'
import { installDilStyles, resolveScheme, THEME_ATTRIBUTE, watchScheme } from './theme.ts'
import type { DilCompiled, DilError, DilMountHandle, DilMountOptions, DilProtocolEntry } from './types.ts'
import { createStateReporter, STATE_REPORT_DELAY_MS } from './view-state.ts'

/** Class on the element the tree renders into; the stylesheet is keyed on it. */
export const VIEW_CLASS = 'dil-root'

/** Marker on the element this module created, so a host can find it again. */
export const VIEW_ATTRIBUTE = 'data-dil-view'

/** Marker on the hidden element that hosts the frame. */
export const FRAME_HOST_ATTRIBUTE = 'data-dil-frame-host'

/** One failure the sandbox reported, kept for the host half to inspect. */
export interface DilViewFailure {
	error: DilError
	stage: string
}

/** Everything the wrapper keeps that the frozen handle does not expose. */
export interface DilViewInternals {
	/** The public handle. `mountDilView` returns exactly this. */
	handle: DilMountHandle
	/** The element the tree renders into (`.dil-root`). */
	element: HTMLElement
	/** The frame this view owns. */
	sandbox: DilSandbox
	/** Every boundary crossing, in order; useful for the diagnostics panel and tests. */
	protocol: DilProtocolEntry[]
	/** Snapshots received, including the ones an error suppressed. */
	snapshots(): readonly DilSandboxSnapshot[]
	/** Failures the sandbox reported. */
	failures(): readonly DilViewFailure[]
}

/** Merge the compiled revision's appData under the embedder's, as upstream does. */
function mergeAppData(compiled: unknown, local: unknown): unknown {
	const server = (compiled ?? {}) as Record<string, any>
	const embedder = (local ?? {}) as Record<string, any>
	return {
		...server,
		...embedder,
		opGenui: { ...(server.opGenui ?? {}), ...(embedder.opGenui ?? {}) }
	}
}

/**
 * Mount a DIL view, and keep the internals reachable for tests and diagnostics.
 * @param root - the shadow root to render in; a style element and the view element are added to it.
 * @param opts - state sink, event sink, embedder appData, optional frame URL.
 * @returns the handle plus the parts the frozen contract does not expose.
 */
export function mountDilViewInternal(root: ShadowRoot, opts: DilMountOptions): DilViewInternals {
	const document = root.ownerDocument ?? globalThis.document
	const view = (document.defaultView ?? globalThis) as Window & typeof globalThis
	installDilStyles(root)

	const element = document.createElement('div')
	element.className = VIEW_CLASS
	element.setAttribute(VIEW_ATTRIBUTE, '')
	element.setAttribute(THEME_ATTRIBUTE, resolveScheme(document, view))
	root.appendChild(element)

	// The frame lives beside the tree, not in it: a sibling with no layout box, so the
	// tree's own children stay the only children the stylesheet sees.
	const frameHost = document.createElement('div')
	frameHost.setAttribute(FRAME_HOST_ATTRIBUTE, '')
	frameHost.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
	root.appendChild(frameHost)

	const protocol: DilProtocolEntry[] = []
	const snapshotLog: DilSandboxSnapshot[] = []
	const failures: DilViewFailure[] = []
	const stopWatching = watchScheme(document, view, (scheme) => element.setAttribute(THEME_ATTRIBUTE, scheme))

	const runnerId = 'dil_' + Math.random().toString(36).slice(2, 10)
	let state: Record<string, unknown> = {}
	let program: DilCompiled | null = null
	let pendingProgram: DilRunnerPayload | null = null
	let runnerCreated = false
	let destroyed = false

	const reporter = createStateReporter({
		delayMs: STATE_REPORT_DELAY_MS,
		send: (report) => {
			const update = report.updates[0]
			if (update) opts.onStateChange(update.state, update.scope)
		}
	})

	// The renderer and the sandbox call each other, so both are late-bound: a DOM event
	// has to reach the sandbox (that is what makes the interface respond) and a snapshot
	// has to reach the renderer. Neither can be created with the other already in hand.
	let renderer: DilRenderer | null = null

	const sandbox = new DilSandbox({
		frameUrl: opts.frameUrl,
		container: frameHost,
		document,
		onProtocol: (entry) => protocol.push(entry),
		onSnapshot: (snapshot) => {
			snapshotLog.push(snapshot)
			if (snapshot.error) {
				// keep the last good tree on screen: a mid-stream error must not blank the UI
				failures.push({ error: snapshot.error, stage: 'render' })
				return
			}
			if (!snapshot.tree) return
			renderer?.update(snapshot.tree)
		},
		onStateChange: (next, scope) => {
			if (!destroyed) reporter.queue(next, scope)
		},
		onFailure: (error, stage) => {
			failures.push({ error, stage })
		}
	})

	renderer = mountRenderer(element, null, {
		appData: opts.appData,
		document,
		onEvent: (fnId, args) => {
			if (destroyed) return
			// The handler runs in the sandbox, so a DOM event is a round trip: send the id
			// and the value back first, then let the host observe the same call.
			sandbox.trigger(fnId, args)
			opts.onEvent(fnId, args)
		}
	})

	function payloadOf(compiled: DilCompiled, seed: Record<string, unknown> | null): DilRunnerPayload {
		return {
			compiledDil: compiled.code,
			constants: compiled.constants ?? {},
			appData: mergeAppData(compiled.appData, opts.appData),
			initialState: seed
		}
	}

	/** Push the current program, spawning the worker on the first delivery. */
	function push(payload: DilRunnerPayload, restart: boolean): void {
		if (!sandbox.connected) {
			pendingProgram = payload
			return
		}
		if (!runnerCreated || restart) {
			runnerCreated = true
			sandbox.createRunner(runnerId, payload)
			return
		}
		sandbox.setCompiledDil({
			compiledDil: payload.compiledDil,
			constants: payload.constants,
			appData: payload.appData
		})
	}

	sandbox.connect().then(
		() => {
			if (destroyed) return
			if (pendingProgram) {
				const payload = pendingProgram
				pendingProgram = null
				push(payload, false)
			}
		},
		(error: unknown) => {
			failures.push({
				error: { name: 'SandboxError', message: error instanceof Error ? error.message : String(error) },
				stage: 'connect'
			})
		}
	)

	const handle: DilMountHandle = {
		update(compiled: DilCompiled): void {
			if (destroyed) return
			program = compiled
			if (compiled.appData !== undefined) renderer?.setAppData(mergeAppData(compiled.appData, opts.appData))
			push(payloadOf(compiled, state), false)
		},
		setState(next: Record<string, unknown>): void {
			if (destroyed) return
			// A seed is a saved snapshot of every keyed slot, so a merge only ever adds
			// names the snapshot did not have.
			state = { ...state, ...next }
			if (!program || !runnerCreated) {
				// Nothing to restart yet: the next createRunner carries the seed.
				if (pendingProgram) pendingProgram = { ...pendingProgram, initialState: state }
				return
			}
			push(payloadOf(program, state), true)
		},
		destroy(): void {
			if (destroyed) return
			destroyed = true
			// The last keystrokes are the ones a user most expects to survive a card
			// closing, so a pending report goes out rather than being cancelled.
			reporter.flush()
			stopWatching()
			sandbox.dispose()
			renderer?.destroy()
			element.remove()
			frameHost.remove()
		}
	}

	return {
		handle,
		element,
		sandbox,
		protocol,
		snapshots: () => snapshotLog,
		failures: () => failures
	}
}

/**
 * Mount a DIL view into a shadow root.
 * @param root - the shadow root to render in.
 * @param opts - state sink, event sink, embedder appData, optional frame URL.
 * @returns the handle the host half drives: `update` per revision, `setState` to seed, `destroy` to tear down.
 */
export function mountDilView(root: ShadowRoot, opts: DilMountOptions): DilMountHandle {
	return mountDilViewInternal(root, opts).handle
}

export type { DilMountHandle, DilMountOptions }
