/** Dedicated Blob Worker entry. Bundled by scripts/build-math-worker.mjs, not the host client. */
import { renderMath } from './engine.ts'
import type { MathRenderResult } from './protocol.ts'

type MathWorkerScope = {
	onmessage: ((event: { data: unknown }) => void) | null
	postMessage(message: { id: number | string; result: MathRenderResult }): void
}
const scope = globalThis as unknown as MathWorkerScope
const denyNetwork = (): never => { throw new Error('Math Worker network access is disabled') }

// No arbitrary JavaScript is evaluated, and no resource/extension loader is
// installed. Also seal browser networking and nested-worker entry points so a
// future dependency cannot accidentally turn this offline worker into a client.
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'RTCPeerConnection', 'importScripts', 'Worker', 'SharedWorker']) {
	Object.defineProperty(globalThis, name, { value: denyNetwork, writable: false, configurable: false })
}
Object.defineProperty(globalThis, 'caches', { value: undefined, writable: false, configurable: false })
if (typeof navigator !== 'undefined') Object.defineProperty(navigator, 'sendBeacon', { value: denyNetwork, writable: false, configurable: false })

scope.onmessage = (event): void => {
	const data = event.data
	if (!data || typeof data !== 'object') return
	const message = data as Record<string, unknown>
	const id = message.id
	if (!(typeof id === 'number' && Number.isSafeInteger(id)) && !(typeof id === 'string' && id.length <= 128)) return
	const result: MathRenderResult = typeof message.tex === 'string' && typeof message.display === 'boolean'
		? renderMath(message.tex, message.display)
		: { ok: false, error: 'Invalid math Worker request' }
	scope.postMessage({ id: id as number | string, result })
}
