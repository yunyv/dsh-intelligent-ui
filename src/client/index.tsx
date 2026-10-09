/**
 * Browser half of dsh-genui: claims the `artifact` tool row so the
 * preview renders in the conversation, and registers an Artifacts page type in
 * the right-hand sidebar so every artifact keeps a persistent home.
 *
 * Three shapes matter here and are easy to get wrong:
 *
 * 1. `SlotRegistry.prototype.register` reads `this.ctx` to own its effect, so it
 *    must be called ON the registry. Detaching it into a variable drops the
 *    receiver and the call dies with "Cannot read properties of undefined".
 * 2. A seat registration that throws inside its deferred callback runs in this
 *    plugin's own effect, so an escaping error fails the fiber and rolls back
 *    every registration already made — the whole browser half disappears. Each
 *    deferred registration therefore catches its own failure, which keeps the
 *    conversation card alive even when the optional column is not.
 * 3. The right column is optional and may not exist yet when this half runs. It is
 *    therefore neither a hard dependency nor a one-shot probe: it is waited for.
 * @module dsh-genui/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotMap declarations for the seats this half registers
// into the program. Nothing here is emitted, so the browser bundle keeps its
// single runtime `require` (React).
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { ARTIFACT_TOOL_NAME, PLUGIN_ID } from '../meta.ts'
import { ArtifactView, type ArtifactViewProps } from './ArtifactView.tsx'
import { ArtifactPanel } from './Panel.tsx'
import { FenceChannel } from './fence.tsx'
import { artifactStore, panelOpener } from './store.ts'

export const name = PLUGIN_ID

/** Slot access is the one hard dependency of this half. */
export const inject = ['slots']

/** Page-type discriminator for `ctx.sidebarRight.openTab`. */
const PANEL_KIND = 'dsh-genui'

/** Registration identity; also the key the body and chip register under. */
const PANEL_DEFINITION = `${PLUGIN_ID}:panel`

/** The slice of `ctx.sidebarRightTabs` this plugin uses. */
interface TabRegistry {
	register(definition: {
		id: string
		kind: string
		title: (address: string) => string
		guide?: readonly { id: string; order: number; title: () => string; description?: () => string }[]
	}): () => void
}

/** The slice of `ctx.sidebarRight` this plugin uses. */
interface SidebarFace {
	openTab(kind: string, options?: unknown): void
}

/** One seat registration, typed to the part this plugin actually supplies. */
type SeatRegister = (
	options: { name: string; key?: string; id?: string; order?: number },
	component: (props: never) => React.ReactNode
) => () => void

/** Name one failure for the console without throwing. */
function describeFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Wire one seat on a context.
 *
 * A method call, deliberately: see the module note above.
 * @param target - the context that owns the registration.
 * @param label - name used in the diagnostic.
 * @param seat - slot key.
 * @param options - registration options for that seat.
 * @param component - the component to register.
 */
function wireOn(
	target: Context,
	label: string,
	seat: string,
	options: { name: string; key?: string; id?: string; order?: number },
	component: (props: never) => React.ReactNode
): void {
	const register: SeatRegister = (o, c) => (target.slots.register as unknown as SeatRegister)(o, c)
	try {
		target.slots.inject(seat as never, () => {
			try {
				return register(options, component)
			} catch (error) {
				console.warn(`[${PLUGIN_ID}] seat "${label}" was refused`, describeFailure(error))
				return () => undefined
			}
		})
	} catch (error) {
		console.warn(`[${PLUGIN_ID}] seat "${label}" could not be armed`, describeFailure(error))
	}
}

/**
 * Read a service off a context, whichever way this runtime exposes it.
 *
 * The framework resolves an injected dependency through the context proxy, so
 * \`scope.sidebarRight\` is the idiom. The store read (\`ctx.get\`) is what this half
 * used before and is proven to work against the real client runtime. Reading both
 * costs nothing and survives either mechanism.
 * @param scope - the context to read from.
 * @param name - the service name.
 * @returns the service value, or undefined when it is not provided.
 */
function readService(scope: Context, name: string): unknown {
	const lookup = (scope as unknown as { get?: (service: string) => unknown }).get
	if (typeof lookup === 'function') {
		const value = lookup.call(scope, name)
		if (value !== undefined) return value
	}
	return (scope as unknown as Record<string, unknown>)[name]
}

/**
 * Register the browser half.
 * @param ctx - registrant context.
 */
export function apply(ctx: Context): void {
	wireOn(ctx, 'tool view', 'tool.call.toolview', { name: 'tool.call.toolview', key: ARTIFACT_TOOL_NAME },
		ArtifactView as unknown as (props: never) => React.ReactNode)

	// The artifact's position inside the answer: the model writes a marker fence in
	// its answer and this channel mounts the frame in its place. Wiring it here,
	// before anything optional, is deliberate — the conversation card is the part
	// that must work on every host, and a cold start may not have provided the
	// right column's services yet.
	const channel = new FenceChannel()
	const effect = (ctx as unknown as { effect?: (run: () => () => void) => unknown }).effect
	try {
		if (typeof effect === 'function') {
			effect.call(ctx, () => {
				channel.start()
				return () => { channel.stop() }
			})
		} else {
			channel.start()
		}
	} catch (error) {
	}

	// The column opens through whichever context ends up providing it. Subscribed
	// once, here, so a re-injection cannot stack a second subscription, and so the
	// reveal still fires for an artifact created before the column arrived.
	let openColumn: ((id?: string) => void) | undefined
	let revealed = false
	artifactStore.subscribeAll(() => {
		if (revealed || openColumn === undefined || artifactStore.list().length === 0) return
		revealed = true
		openColumn()
	})

	// The right column is optional, and on a cold start this half can run before the
	// column's services exist. Probing once and returning made the panel appear or
	// not depending on startup order, so the registration waits instead: `ctx.inject`
	// mounts a child plugin that stays pending until both services are present, and
	// re-runs if a provider is replaced. Everything above is wired first, so a column
	// that never arrives costs the card nothing.
	const injectable = (ctx as unknown as {
		inject?: (deps: string[], callback: (scope: Context) => void) => unknown
	}).inject
	if (typeof injectable !== 'function') return

	injectable.call(ctx, ['sidebarRightTabs', 'sidebarRight'], (scope) => {
		const tabs = readService(scope, 'sidebarRightTabs') as TabRegistry | undefined
		const sidebar = readService(scope, 'sidebarRight') as SidebarFace | undefined
		if (tabs === undefined || sidebar === undefined) return

		try {
			tabs.register({
				id: PANEL_DEFINITION,
				kind: PANEL_KIND,
				title: () => '产物',
				guide: [{
					id: `${PANEL_DEFINITION}:entry`,
					order: 42,
					title: () => '产物',
					description: () => '本会话里的 artifact 与实时预览'
				}]
			})
		} catch (error) {
			// A hot reload or a cold start can re-apply this half while the previous
			// page-type registration is still live; the column keeps working either way.
			console.warn(`[${PLUGIN_ID}] artifacts page type not registered`, describeFailure(error))
		}

		wireOn(scope, 'panel body', 'sidebar.right.pane.tab', { name: 'sidebar.right.pane.tab', key: PANEL_DEFINITION },
			ArtifactPanel as unknown as (props: never) => React.ReactNode)
		wireOn(scope, 'panel title', 'sidebar.right.pane.tab.title', { name: 'sidebar.right.pane.tab.title', key: PANEL_DEFINITION },
			(() => '产物') as unknown as (props: never) => React.ReactNode)

		// A frame inside the conversation expands into the column: one artifact, two
		// views of it.
		openColumn = (id?: string) => {
			if (id !== undefined) artifactStore.focus(id)
			try {
				sidebar.openTab(PANEL_KIND)
			} catch (error) {
				console.warn(`[${PLUGIN_ID}] could not open the artifacts column`, describeFailure(error))
			}
		}
		panelOpener.current = (id: string) => openColumn?.(id)

		// The first artifact of the page reveals the column, the way a chat product
		// surfaces the artifact it just produced. Replay re-reveals it too.
		if (!revealed && artifactStore.list().length > 0) openColumn()
	})
}

export type { ArtifactViewProps }
