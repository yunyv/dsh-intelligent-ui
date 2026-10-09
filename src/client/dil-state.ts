/**
 * One artifact's interface state, shared by every place that artifact is mounted.
 *
 * An artifact can be on screen twice — live in its conversation card and again in
 * the right column — and the two copies have to agree. Dragging a slider in one and
 * seeing the other sit still would make the column a screenshot rather than a view.
 *
 * A change travels one way: the mount that saw it publishes, and every other mount
 * is told to adopt. The publisher is skipped, and a payload identical to what is
 * already held is dropped, so a mount that echoes back the state it was just given
 * cannot start a loop.
 * @module dsh-intelligent-ui/client/dil-state
 */

/** A revision's interface state; the values its `DIL.useState` keys hold. */
export type DilStateValues = Record<string, unknown>

/** One mount's adoption point. */
export type DilStateListener = (state: DilStateValues) => void

/** Last published state, by artifact id. */
const values = new Map<string, DilStateValues>()

/** Adoption points, by artifact id. */
const listeners = new Map<string, Set<DilStateListener>>()

/**
 * The state an artifact is showing now, for a mount that is about to open.
 * @param id - artifact id.
 * @returns the last published state, or an empty object when nothing has published.
 */
export function dilStateOf(id: string): DilStateValues {
	return values.get(id) ?? {}
}

/**
 * Whether two snapshots carry the same values.
 * @param a - one snapshot.
 * @param b - another.
 * @returns true when every key agrees.
 */
function sameValues(a: DilStateValues, b: DilStateValues): boolean {
	const keys = Object.keys(a)
	if (keys.length !== Object.keys(b).length) return false
	for (const key of keys) if (a[key] !== b[key]) return false
	return true
}

/**
 * Publish a change and hand it to the other mounts of the same artifact.
 *
 * An unchanged payload returns immediately, which is what stops two mounts from
 * trading the same state back and forth.
 * @param id - artifact id.
 * @param state - the state a sandbox reported.
 * @param origin - the listener to leave out, so a publisher is not told its own news.
 */
export function publishDilState(id: string, state: DilStateValues, origin?: DilStateListener): void {
	const previous = values.get(id)
	if (previous !== undefined && sameValues(previous, state)) return
	values.set(id, state)
	for (const listener of listeners.get(id) ?? []) {
		if (listener === origin) continue
		try {
			listener(state)
		} catch {
			// One mount that cannot take the news must not stop the others.
		}
	}
}

/**
 * Adopt every later change to an artifact's state.
 * @param id - artifact id.
 * @param listener - called with each state another mount publishes.
 * @returns the disposer that stops the subscription.
 */
export function subscribeDilState(id: string, listener: DilStateListener): () => void {
	const set = listeners.get(id) ?? new Set<DilStateListener>()
	listeners.set(id, set)
	set.add(listener)
	return () => {
		set.delete(listener)
		if (set.size === 0) listeners.delete(id)
	}
}
