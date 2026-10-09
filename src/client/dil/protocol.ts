/**
 * The wire contract between the host and the sandbox frame, and between the frame
 * and its worker.
 *
 * Both directions carry `__dilFrame` (host ⇄ frame) or `__dilWorker` (frame ⇄ worker)
 * plus a protocol version, so a stale frame — a cached `runner.html` from an older
 * bundle — is rejected instead of being fed messages it cannot parse.
 * @module dsh-intelligent-ui/client/dil/protocol
 */

/** Bumped whenever a message shape changes; both sides check it. */
export const PROTOCOL_VERSION = 1

/** Host → frame and frame → host marker. */
export const FRAME_FLAG = '__dilFrame'

/** Frame → worker and worker → frame marker. */
export const WORKER_FLAG = '__dilWorker'

/** Everything the frame posts to the host. */
export type FrameToHostKind =
	| 'ready'
	| 'snapshot'
	| 'stateChanged'
	| 'stateSnapshot'
	| 'failure'
	| 'timeout'
	| 'quarantined'
	| 'ack'
	| 'diagnostic'

/** Everything the host posts to the frame. */
export type HostToFrameKind =
	| 'probe'
	| 'createRunner'
	| 'setCompiledDil'
	| 'trigger'
	| 'stateSnapshotRequest'
	| 'dispose'

/** A message either way across the host ⇄ frame boundary. */
export interface DilFrameMessage {
	__dilFrame?: true
	protocolVersion?: number
	kind?: string
	runnerId?: string
	tree?: unknown
	version?: number
	error?: unknown
	stats?: unknown
	reason?: string
	scope?: string
	state?: unknown
	stage?: string
	phase?: string
	detail?: unknown
	id?: string
	ok?: boolean
	fnId?: string
	args?: unknown
	compiledDil?: string
	constants?: Readonly<Record<string, unknown>>
	appData?: unknown
	initialState?: unknown
}

/** One message either way across the frame ⇄ worker boundary. */
export interface DilWorkerMessage {
	__dilWorker?: true
	protocolVersion?: number
	kind?: string
	command?: string
	id?: string
	runnerId?: string
	data?: unknown
	fnId?: string
	args?: unknown
	ok?: boolean
	error?: unknown
	stats?: unknown
	state?: unknown
	scope?: string
	reason?: string
	version?: number
	snapshot?: unknown
	[key: string]: unknown
}

/** True when `value` is a message this half is willing to act on. */
export function isFrameMessage(value: unknown): value is DilFrameMessage {
	return typeof value === 'object' && value !== null && (value as DilFrameMessage).__dilFrame === true
}

/** True when the frame is the exact version this host speaks. */
export function acceptsVersion(message: DilFrameMessage): boolean {
	return message.protocolVersion === undefined || message.protocolVersion === PROTOCOL_VERSION
}
