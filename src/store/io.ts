/**
 * Byte-level disk primitives for the artifact store: hashing, UTF-8 encoding,
 * atomic JSON replacement, and the default root.
 *
 * Zero host dependencies — only `node:fs`, `node:crypto`, `node:os` and
 * `node:path` — so the whole store is unit-testable against a temp directory.
 * @module dsh-intelligent-ui/store/io
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Env override for the default root; the constructor option wins over it. */
export const ROOT_ENV = 'DSH_GENUI_STORE_DIR'

/** `<home>/.dsh/storages/dsh-intelligent-ui`, the DSH storage directory convention. */
export function defaultStoreRoot(): string {
	const fromEnv = process.env[ROOT_ENV]
	if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim()
	return join(homedir(), '.dsh', 'storages', 'dsh-intelligent-ui')
}

/** Whether one thrown value is a missing-path filesystem error. */
export function isMissing(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code
	return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Create a directory tree, idempotently. */
export function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true })
}

/** Exact UTF-8 bytes of a source string; the unit everything is measured in. */
export function encodeContent(text: string): Buffer {
	return Buffer.from(text, 'utf8')
}

/** Lowercase hex sha256 over exact bytes. */
export function sha256Of(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex')
}

/** Lowercase hex sha256 over a string's UTF-8 bytes. */
export function sha256Text(text: string): string {
	return sha256Of(encodeContent(text))
}

/** Read a file as UTF-8 text, or `undefined` when it does not exist. */
export function readText(file: string): string | undefined {
	try {
		return readFileSync(file, 'utf8')
	} catch (error) {
		if (isMissing(error)) return undefined
		throw error
	}
}

/** Read a file as raw bytes, or `undefined` when it does not exist. */
export function readBytes(file: string): Buffer | undefined {
	try {
		return readFileSync(file)
	} catch (error) {
		if (isMissing(error)) return undefined
		throw error
	}
}

/** Whether a path exists (any kind). */
export function fileExists(file: string): boolean {
	return existsSync(file)
}

/**
 * Parse a JSON file.
 * @returns the parsed value, or `undefined` when the file is missing *or* unparseable.
 *   Unparseable reads as absent on purpose: a half-written index must degrade to
 *   "empty catalog", never to a thrown error the model cannot act on.
 */
export function readJson<T>(file: string): T | undefined {
	const text = readText(file)
	if (text === undefined) return undefined
	try {
		return JSON.parse(text) as T
	} catch {
		return undefined
	}
}

/** Temp-file counter, so two writes in the same tick never collide. */
let tempCounter = 0

/** A sibling temp path, so `rename` never crosses a filesystem boundary. */
function tempPathFor(file: string): string {
	tempCounter += 1
	return `${file}.${String(process.pid)}-${String(tempCounter)}.tmp`
}

/** Replace a file's bytes atomically (write sibling temp, then rename). */
export function writeBytesAtomic(file: string, bytes: Uint8Array): void {
	ensureDir(dirname(file))
	const temp = tempPathFor(file)
	writeFileSync(temp, bytes)
	try {
		renameSync(temp, file)
	} catch (error) {
		removeFile(temp)
		throw error
	}
}

/** Serialize a value as tab-indented JSON, atomically. */
export function writeJsonAtomic(file: string, value: unknown): void {
	writeBytesAtomic(file, Buffer.from(`${JSON.stringify(value, null, '\t')}\n`, 'utf8'))
}

/** Delete a file, reporting whether it existed. */
export function removeFile(file: string): boolean {
	try {
		unlinkSync(file)
		return true
	} catch (error) {
		if (isMissing(error)) return false
		throw error
	}
}

/** Close a descriptor, swallowing only "already closed". */
export function closeQuietly(fd: number): void {
	try {
		closeSync(fd)
	} catch {
		/* already closed */
	}
}
