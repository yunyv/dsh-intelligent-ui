/**
 * The sandbox worker, booted in a `node:vm` context that provides only what a Worker
 * has: `self`, `postMessage`, and the two `MessageChannel`s the frame would hand over.
 *
 * Shared by the worker suite and the host ⇄ client contract suite.
 */
import { MessageChannel } from 'node:worker_threads'
import vm from 'node:vm'
import { WORKER_SOURCE } from '../../../src/client/dil/generated/worker-source.ts'

/** One message the worker emitted. */
export type WorkerMessage = Record<string, any>

/** The worker plus the two ports it was handed. */
export interface Sandbox {
	posted: WorkerMessage[]
	diagnostics: WorkerMessage[]
	snapshots: WorkerMessage[]
	failures: WorkerMessage[]
	stateChanges: WorkerMessage[]
	latest: WorkerMessage | null
	latestTree(): any
	/** Every text node of the latest tree, depth first, joined by spaces. */
	treeText(): string
	/** Every `{__dilFn}` id the latest tree references. */
	collectHandlers(): string[]
	createRunner(payload: {
		runnerId?: string
		compiledDil: string
		constants?: unknown
		appData?: unknown
		initialState?: unknown
		protocolVersion?: number
	}): Promise<void>
	setCompiledDil(payload: { compiledDil: string; constants?: unknown; appData?: unknown }): Promise<void>
	trigger(fnId: string, args?: unknown[]): Promise<void>
	requestState(): Promise<WorkerMessage>
	flush(): Promise<void>
	close(): void
}

/** Boot the shipped worker source. */
export function bootSandbox(): Sandbox {
	const posted: WorkerMessage[] = []
	const diagnostics: WorkerMessage[] = []
	const snapshots: WorkerMessage[] = []
	const failures: WorkerMessage[] = []
	const stateChanges: WorkerMessage[] = []
	const stateWaiters: ((message: WorkerMessage) => void)[] = []

	const fakeSelf: Record<string, any> = {
		onmessage: null,
		postMessage: (message: WorkerMessage) => void posted.push(message),
		close: () => undefined
	}
	const context = vm.createContext({
		self: fakeSelf,
		console,
		Promise,
		Map,
		Set,
		WeakMap,
		JSON,
		Math,
		Date,
		Object,
		Array,
		String,
		Number,
		Boolean,
		RegExp,
		Error,
		TypeError,
		RangeError,
		SyntaxError,
		Symbol,
		isNaN,
		isFinite,
		parseInt,
		parseFloat,
		setTimeout,
		clearTimeout,
		queueMicrotask,
		structuredClone
	})
	;(context as Record<string, unknown>).globalThis = context
	vm.runInContext(WORKER_SOURCE, context, { filename: 'client/dil/worker.js' })

	const send = (data: unknown, ports: unknown[] = []): void => fakeSelf.onmessage({ data, ports })

	const control = new MessageChannel()
	control.port1.on('message', (message: WorkerMessage) => {
		if (message?.kind === 'diagnostic') diagnostics.push(message)
	})
	control.port1.start()
	send({ __dilWorker: true, kind: 'initializeControl', protocolVersion: 1 }, [control.port2])

	const data = new MessageChannel()
	data.port1.on('message', (message: WorkerMessage) => {
		if (!message) return
		if (message.kind === 'snapshot') snapshots.push(message)
		else if (message.kind === 'failure') failures.push(message)
		else if (message.kind === 'stateSnapshot') stateWaiters.splice(0).forEach((wait) => wait(message))
		else if (message.kind === 'stateChanged') stateChanges.push(message)
	})
	data.port1.start()

	let seq = 0
	const sandbox: Sandbox = {
		posted,
		diagnostics,
		snapshots,
		failures,
		stateChanges,
		get latest() {
			return snapshots[snapshots.length - 1] ?? null
		},
		latestTree() {
			return snapshots[snapshots.length - 1]?.tree ?? null
		},
		treeText() {
			const out: string[] = []
			const walk = (node: any): void => {
				if (!node) return
				if (node.t === '#text') out.push(String(node.v))
				for (const child of node.c ?? []) walk(child)
			}
			walk(sandbox.latestTree())
			return out.join(' ')
		},
		collectHandlers() {
			const out: string[] = []
			const walk = (node: any): void => {
				if (!node) return
				for (const value of Object.values(node.p ?? {})) {
					if (value && typeof value === 'object' && typeof (value as any).__dilFn === 'string') out.push((value as any).__dilFn)
				}
				for (const child of node.c ?? []) walk(child)
			}
			walk(sandbox.latestTree())
			return out
		},
		async createRunner(payload) {
			snapshots.length = 0
			failures.length = 0
			stateChanges.length = 0
			send({
				__dilWorker: true,
				kind: 'createRunner',
				protocolVersion: payload.protocolVersion ?? 1,
				runnerId: payload.runnerId ?? 'runner-1',
				compiledDil: payload.compiledDil,
				constants: payload.constants ?? {},
				appData: payload.appData ?? {},
				initialState: payload.initialState ?? null
			}, [data.port2])
			await sandbox.flush()
		},
		async setCompiledDil(payload) {
			data.port1.postMessage({ __dilWorker: true, kind: 'command', command: 'setCompiledDil', id: 'c' + ++seq, data: payload })
			await sandbox.flush()
		},
		async trigger(fnId, args = []) {
			send({ __dilWorker: true, kind: 'trigger', fnId, args })
			await sandbox.flush()
		},
		async requestState() {
			const wait = new Promise<WorkerMessage>((resolve) => stateWaiters.push(resolve))
			send({ __dilWorker: true, kind: 'stateSnapshotRequest' })
			await sandbox.flush()
			return wait
		},
		// Port delivery is asynchronous and takes more than one turn (worker microtask →
		// data port → host port), so drain a few turns rather than racing the queue.
		async flush() {
			for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
		},
		close() {
			for (const port of [control.port1, control.port2, data.port1, data.port2]) {
				port.unref()
				try {
					port.close()
				} catch {
					// already closed
				}
			}
		}
	}
	return sandbox
}
