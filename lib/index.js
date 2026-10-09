import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Script } from "node:vm";
//#region src/meta.ts
/** Package identity: the harness client-module id and the ModuleLoader entry id. */
const PLUGIN_ID = "dsh-genui";
/** Wire tool name; also the key the client registers under `tool.call.toolview`. */
const ARTIFACT_TOOL_NAME = "artifact";
//#endregion
//#region src/paths.ts
/**
* Where the skill's files live, free of harness imports.
*
* The tool's description names the skill body so an agent without a skill tool
* can still read the contract, which means the paths have to be reachable
* without importing the skill registry. `src/skill.ts` and `src/tool.ts` both
* read them from here.
*
* @module dsh-genui/paths
*/
/** Location of the skill body, as the skill provider's locator. */
const SKILL_BODY_URL = new URL("../assets/genui-skill.md", import.meta.url);
/** Absolute path of the skill body, for agents that cannot load skills. */
const SKILL_BODY_PATH = fileURLToPath(SKILL_BODY_URL);
/** Absolute directory the skill body's relative references resolve against. */
const SKILL_RESOURCE_DIR = fileURLToPath(new URL("../assets/", import.meta.url));
//#endregion
//#region src/skill.ts
/**
* Bundled `genui` skill provider: the DIL authoring contract the model loads
* before its first DIL-mode `artifact` call.
*
* In the system this dialect was reverse-engineered from, the contract is
* injected server-side on every request and never reaches the client. DSH has a
* skill registry instead, so the same text ships here and is loaded on demand —
* which also keeps ~4 KB of dialect rules out of every unrelated turn.
*
* @module dsh-genui/skill
*/
const PROVIDER_NAME = "dsh-genui";
/**
* Rank this provider's candidates carry, mirroring the registry's own
* `BUNDLED_SKILL_RANK`.
*
* Written out rather than imported on purpose. The runtime does not carry
* `@deepseek-ai/dsh-skill` — the package declares peers it does not ship, so a
* value import compiles to a specifier that cannot resolve and the entire host
* half fails to load with `fiberPhase: failed`, which is exactly what happened
* here. Only one value was ever needed from that package and it is a constant;
* everything else this module uses is a type, and a type erases.
*
* Rank only breaks ties between same-named candidates inside one layer, and this
* provider's name is unique, so the number is a formality. `tests/host-bundle.
* spec.ts` keeps the resolved output honest about it.
*/
const BUNDLED_SKILL_RANK = 600;
const RESOURCE_BASE = {
	kind: "directory",
	path: SKILL_RESOURCE_DIR
};
const CANDIDATE = {
	name: "genui",
	description: "Authoring contract for the `artifact` tool in DIL mode: write a compiled, interactive interface instead of prose. Covers when a surface earns its place, the {@body}/DSL output format, the component and control inventory, the rules that make a document run, and how to revise a surface in place. Load before the first DIL-mode call in a session.",
	invocation: {
		modelInvocable: true,
		userInvocable: true
	},
	provider: PROVIDER_NAME,
	source: "bundled",
	resourceBase: RESOURCE_BASE,
	rank: BUNDLED_SKILL_RANK,
	locator: SKILL_BODY_URL
};
/** The bundled provider registered on `ctx.skills`. */
const genuiSkillProvider = {
	name: PROVIDER_NAME,
	list: () => Promise.resolve([CANDIDATE]),
	async get(_candidate) {
		return {
			name: CANDIDATE.name,
			description: CANDIDATE.description,
			invocation: CANDIDATE.invocation,
			provider: CANDIDATE.provider,
			source: CANDIDATE.source,
			resourceBase: RESOURCE_BASE,
			content: await readFile(SKILL_BODY_URL, "utf8")
		};
	}
};
//#endregion
//#region src/patch.ts
/** A patch the plugin refuses to apply, with a model-actionable reason. */
var PatchError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ArtifactPatchError";
	}
};
/** Locate every occurrence of `needle` with its 1-based line and column. */
function locate(haystack, needle) {
	const found = [];
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return found;
		const before = haystack.slice(0, at);
		const line = before.split("\n").length;
		const lastBreak = before.lastIndexOf("\n");
		found.push({
			line,
			column: at - lastBreak
		});
		from = at + Math.max(needle.length, 1);
	}
}
/** A short window of the artifact around one occurrence, for the error message. */
function excerpt(text, at, radius = 60) {
	const start = Math.max(0, at - radius);
	const end = Math.min(text.length, at + radius);
	const head = start > 0 ? "…" : "";
	const tail = end < text.length ? "…" : "";
	return `${head}${text.slice(start, end).replaceAll("\n", "⏎")}${tail}`;
}
/**
* Apply one exact replacement.
* @param text - current artifact source.
* @param oldString - text to find; must be non-empty and present.
* @param newString - replacement; empty deletes the matched region.
* @param replaceAll - replace every occurrence instead of requiring exactly one.
* @returns the patched source and the replacement count.
* @throws {PatchError} when the search text is empty, absent, or ambiguous.
*/
function applyPatch(text, oldString, newString, replaceAll = false) {
	if (oldString.length === 0) throw new PatchError("old_string is empty: pass the exact existing text to replace. To rewrite the whole artifact, call artifact with action \"create\" again.");
	if (oldString === newString) throw new PatchError("old_string and new_string are identical: the patch would change nothing.");
	const hits = locate(text, oldString);
	if (hits.length === 0) throw new PatchError(`old_string not found (${text.length === 0 ? "the artifact is empty" : `the artifact is ${String(text.length)} bytes`}). Read the artifact with action "read" and copy the text exactly, whitespace included.`);
	const first = text.indexOf(oldString);
	if (!replaceAll && hits.length > 1) {
		const where = hits.map((h) => `${String(h.line)}:${String(h.column)}`).join(", ");
		throw new PatchError(`old_string appears ${String(hits.length)} times (lines ${where}). Include more surrounding text to make it unique, or pass replace_all: true.`);
	}
	if (replaceAll) return {
		text: text.split(oldString).join(newString),
		replacements: hits.length
	};
	if (first === -1) throw new PatchError(`old_string not found. Near: ${excerpt(text, 0)}`);
	return {
		text: text.slice(0, first) + newString + text.slice(first + oldString.length),
		replacements: 1
	};
}
/**
* Whether two artifact revisions differ inside any `<script>` body. A markup or
* style change can be reconciled into the live document without re-running the
* artifact; a script change cannot, so the card must reload the frame.
* @param before - previous revision.
* @param after - next revision.
* @returns true when a reload is required.
*/
function requiresReload(before, after) {
	return scriptBodies(before) !== scriptBodies(after);
}
/** Concatenated `<script>` bodies, the part a DOM reconcile cannot re-execute. */
function scriptBodies(html) {
	const bodies = [];
	const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
	let match;
	while ((match = pattern.exec(html)) !== null) bodies.push(match[1] ?? "");
	return bodies.join("\0");
}
//#endregion
//#region src/store/io.ts
/**
* Byte-level disk primitives for the artifact store: hashing, UTF-8 encoding,
* atomic JSON replacement, and the default root.
*
* Zero host dependencies — only `node:fs`, `node:crypto`, `node:os` and
* `node:path` — so the whole store is unit-testable against a temp directory.
* @module dsh-genui/store/io
*/
/** Env override for the default root; the constructor option wins over it. */
const ROOT_ENV = "DSH_GENUI_STORE_DIR";
/** `<home>/.dsh/storages/dsh-genui`, the DSH storage directory convention. */
function defaultStoreRoot() {
	const fromEnv = process.env[ROOT_ENV];
	if (fromEnv !== void 0 && fromEnv.trim().length > 0) return fromEnv.trim();
	return join(homedir(), ".dsh", "storages", "dsh-genui");
}
/** Whether one thrown value is a missing-path filesystem error. */
function isMissing(error) {
	const code = error?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}
/** Create a directory tree, idempotently. */
function ensureDir(dir) {
	mkdirSync(dir, { recursive: true });
}
/** Exact UTF-8 bytes of a source string; the unit everything is measured in. */
function encodeContent(text) {
	return Buffer.from(text, "utf8");
}
/** Lowercase hex sha256 over exact bytes. */
function sha256Of(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
/** Read a file as UTF-8 text, or `undefined` when it does not exist. */
function readText(file) {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if (isMissing(error)) return void 0;
		throw error;
	}
}
/** Read a file as raw bytes, or `undefined` when it does not exist. */
function readBytes(file) {
	try {
		return readFileSync(file);
	} catch (error) {
		if (isMissing(error)) return void 0;
		throw error;
	}
}
/** Whether a path exists (any kind). */
function fileExists(file) {
	return existsSync(file);
}
/**
* Parse a JSON file.
* @returns the parsed value, or `undefined` when the file is missing *or* unparseable.
*   Unparseable reads as absent on purpose: a half-written index must degrade to
*   "empty catalog", never to a thrown error the model cannot act on.
*/
function readJson(file) {
	const text = readText(file);
	if (text === void 0) return void 0;
	try {
		return JSON.parse(text);
	} catch {
		return;
	}
}
/** Temp-file counter, so two writes in the same tick never collide. */
let tempCounter = 0;
/** A sibling temp path, so `rename` never crosses a filesystem boundary. */
function tempPathFor(file) {
	tempCounter += 1;
	return `${file}.${String(process.pid)}-${String(tempCounter)}.tmp`;
}
/** Replace a file's bytes atomically (write sibling temp, then rename). */
function writeBytesAtomic(file, bytes) {
	ensureDir(dirname(file));
	const temp = tempPathFor(file);
	writeFileSync(temp, bytes);
	try {
		renameSync(temp, file);
	} catch (error) {
		removeFile(temp);
		throw error;
	}
}
/** Serialize a value as tab-indented JSON, atomically. */
function writeJsonAtomic(file, value) {
	writeBytesAtomic(file, Buffer.from(`${JSON.stringify(value, null, "	")}\n`, "utf8"));
}
/** Delete a file, reporting whether it existed. */
function removeFile(file) {
	try {
		unlinkSync(file);
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}
/** Close a descriptor, swallowing only "already closed". */
function closeQuietly(fd) {
	try {
		closeSync(fd);
	} catch {}
}
//#endregion
//#region src/store/disk.ts
/**
* The on-disk format, exactly as it sits on disk:
*
* ```text
* <root>/
* ├── index.json                                  # catalog: one entry per artifact, no content
* ├── locks/store.lock                            # writer lock (transient)
* └── artifacts/<artifactId>/
*     └── versions/
*         ├── v0001.html                          # exact UTF-8 content of version 1
*         ├── v0001.json                           # version 1 metadata sidecar
*         ├── v0002.html
*         └── v0002.json
* ```
*
* Content lives in its own byte-exact file, never inside JSON: a multi-megabyte
* artifact costs one write and one read, with no escaping blow-up, and its
* sha256 is the hash of the file's bytes. Metadata lives in the sidecar and in
* the index, so listing a catalog never reads content.
*
* Write order is content → sidecar → index, and the index is replaced
* atomically. A crash between the two leaves a version on disk the index has
* not recorded yet; {@link walkChain} and {@link ArtifactStore.recover} adopt it
* instead of discarding it, so nothing the model authored is ever lost to a
* half-finished write.
* @module dsh-genui/store/disk
*/
/** Bumped only when `index.json` stops being readable by this code. */
const INDEX_SCHEMA = "dsh-genui.store-index/1";
/** Bumped only when a `vNNNN.json` sidecar stops being readable by this code. */
const VERSION_SCHEMA = "dsh-genui.store-version/1";
/** Derive the directory tree under one root. */
function storePaths(root) {
	return {
		root,
		indexFile: join(root, "index.json"),
		artifactsDir: join(root, "artifacts"),
		locksDir: join(root, "locks"),
		lockFile: join(root, "locks", "store.lock")
	};
}
/** `<root>/artifacts/<id>`. */
function artifactDir(paths, id) {
	return join(paths.artifactsDir, id);
}
/** `<root>/artifacts/<id>/versions`. */
function versionsDir(paths, id) {
	return join(artifactDir(paths, id), "versions");
}
/** `3` → `"v0003"`, the stem every version file shares. */
function versionStem(versionNumber) {
	return `v${String(versionNumber).padStart(4, "0")}`;
}
/** Stable version id, unique for the lifetime of an artifact. */
function versionIdOf(id, versionNumber) {
	return `${id}#${String(versionNumber)}`;
}
/** An empty catalog; also what a missing or unparseable index degrades to. */
function emptyIndex() {
	return {
		schema: INDEX_SCHEMA,
		updatedAt: 0,
		artifacts: {}
	};
}
/** Read the catalog. Missing, unparseable or foreign-schema all read as empty. */
function readIndex(paths) {
	const parsed = readJson(paths.indexFile);
	if (parsed === void 0 || typeof parsed !== "object" || parsed === null) return emptyIndex();
	const artifacts = {};
	const raw = parsed.artifacts;
	if (raw !== void 0 && typeof raw === "object" && raw !== null) {
		for (const [id, entry] of Object.entries(raw)) if (isSummary(entry)) artifacts[id] = entry;
	}
	return {
		schema: typeof parsed.schema === "string" ? parsed.schema : INDEX_SCHEMA,
		updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
		artifacts
	};
}
/** Replace the catalog atomically. */
function writeIndex(paths, index) {
	ensureDir(paths.root);
	writeJsonAtomic(paths.indexFile, {
		...index,
		schema: INDEX_SCHEMA
	});
}
/** Path of one version's sidecar. */
function versionMetaFile(paths, id, versionNumber) {
	return join(versionsDir(paths, id), `${versionStem(versionNumber)}.json`);
}
/** Path of one version's content. */
function versionContentFile(paths, id, versionNumber) {
	return join(versionsDir(paths, id), `${versionStem(versionNumber)}.html`);
}
/** Whether either half of a version is on disk. */
function versionNumberExists(paths, id, versionNumber) {
	return fileExists(versionMetaFile(paths, id, versionNumber)) || fileExists(versionContentFile(paths, id, versionNumber));
}
/**
* Whether a version is *complete*: its sidecar parsed and its content file is
* still there.
*
* Only complete versions are immutable history. A version with a sidecar but no
* content was never durably committed, so it is not addressable, the chain stops
* before it, and a later write may fill that version number in again.
*/
function versionComplete(paths, id, meta) {
	return fileExists(join(versionsDir(paths, id), meta.contentFile));
}
/** Write one version: content bytes first, then the sidecar that describes them. */
function writeVersionFiles(paths, meta, bytes) {
	const dir = versionsDir(paths, meta.id);
	ensureDir(dir);
	writeBytesAtomic(join(dir, meta.contentFile), bytes);
	writeJsonAtomic(versionMetaFile(paths, meta.id, meta.versionNumber), meta);
}
/** Read one version's sidecar, or `undefined` when it is missing or unparseable. */
function readVersionMeta(paths, id, versionNumber) {
	const parsed = readJson(versionMetaFile(paths, id, versionNumber));
	if (parsed === void 0 || typeof parsed !== "object" || parsed === null) return void 0;
	if (parsed.schema !== "dsh-genui.store-version/1") return void 0;
	if (parsed.id !== id || parsed.versionNumber !== versionNumber) return void 0;
	if (typeof parsed.contentFile !== "string" || !/^v\d+\.html$/u.test(parsed.contentFile)) return void 0;
	if (typeof parsed.versionId !== "string" || typeof parsed.contentSha256 !== "string") return void 0;
	if (typeof parsed.contentBytes !== "number" || typeof parsed.createdAt !== "number") return void 0;
	if (typeof parsed.changelog !== "string" || typeof parsed.title !== "string") return void 0;
	if (typeof parsed.action !== "string") return void 0;
	if (parsed.mode !== "inline" && parsed.mode !== "wide") return void 0;
	if (parsed.parentVersionId !== null && typeof parsed.parentVersionId !== "string") return void 0;
	return parsed;
}
/** Read one version's content bytes. */
function readVersionBytes(paths, id, meta) {
	return readBytes(join(versionsDir(paths, id), meta.contentFile));
}
/** Version numbers present on disk, ascending; a sidecar or content file counts. */
function versionNumbers(paths, id) {
	let names;
	try {
		names = readdirSync(versionsDir(paths, id));
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	const found = /* @__PURE__ */ new Set();
	for (const name of names) {
		const digits = /^v(\d+)(?:\.json|\.html)$/u.exec(name)?.[1];
		if (digits === void 0) continue;
		found.add(Number(digits));
	}
	return [...found].sort((left, right) => left - right);
}
/** Every artifact directory name under the root. */
function listArtifactIds(paths) {
	let entries;
	try {
		entries = readdirSync(paths.artifactsDir, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}
/** Delete one artifact's whole directory, version history included. */
function removeArtifactDir(paths, id) {
	rmSync(artifactDir(paths, id), {
		recursive: true,
		force: true
	});
}
/**
* Walk an artifact's chain from version 1 upward.
*
* Stops at the first version that is missing, unreadable, misnumbered, whose
* parent is not the version before it, or whose content file is gone — a chain
* with a hole cannot be patched safely, so the caller keeps the last good head
* rather than guessing. Everything past the stop is reported as corrupt (when
* its own files are present) or orphaned (when its number simply follows).
* @returns the contiguous prefix, its head, and what could not be joined to it.
*/
function walkChain(paths, id) {
	const present = versionNumbers(paths, id);
	const versions = [];
	const corrupt = [];
	const orphans = [];
	let expectedParent = null;
	let stopped = false;
	for (const versionNumber of present) {
		if (stopped) {
			orphans.push(versionNumber);
			continue;
		}
		const meta = readVersionMeta(paths, id, versionNumber);
		if (meta === void 0) {
			corrupt.push(versionNumber);
			stopped = true;
			continue;
		}
		const wants = versionNumber === 1 ? null : expectedParent;
		if (meta.parentVersionId !== wants || !fileExists(join(versionsDir(paths, id), meta.contentFile))) {
			corrupt.push(versionNumber);
			stopped = true;
			continue;
		}
		versions.push(meta);
		expectedParent = meta.versionId;
	}
	return {
		versions,
		head: versions.at(-1),
		corrupt,
		orphans
	};
}
/** The catalog entry that summarizes a chain head. */
function summaryFromHead(head, versionCount, createdAt) {
	return {
		id: head.id,
		...head.sessionId === void 0 ? {} : { sessionId: head.sessionId },
		title: head.title,
		mode: head.mode,
		engine: head.engine,
		createdAt,
		updatedAt: head.createdAt,
		version: head.versionNumber,
		versionId: head.versionId,
		parentVersionId: head.parentVersionId,
		contentSha256: head.contentSha256,
		contentBytes: head.contentBytes,
		versionCount
	};
}
/** The catalog entry for a scanned chain: head fields, plus version 1's birth time. */
function summaryFromChain(scan) {
	const head = scan.head;
	if (head === void 0) return void 0;
	const first = scan.versions[0];
	return summaryFromHead(head, scan.versions.length, first === void 0 ? head.createdAt : first.createdAt);
}
/** Whether one parsed index entry has the fields every reader relies on. */
function isSummary(value) {
	if (typeof value !== "object" || value === null) return false;
	const row = value;
	return typeof row.id === "string" && typeof row.title === "string" && (row.mode === "inline" || row.mode === "wide") && (row.engine === "dil" || row.engine === "html") && typeof row.createdAt === "number" && typeof row.updatedAt === "number" && typeof row.version === "number" && typeof row.versionId === "string" && (row.parentVersionId === null || typeof row.parentVersionId === "string") && typeof row.contentSha256 === "string" && typeof row.contentBytes === "number" && typeof row.versionCount === "number";
}
//#endregion
//#region src/store/errors.ts
/** Base class, so a caller can catch the whole family with one clause. */
var StoreError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ArtifactStoreError";
	}
};
/** No artifact with that id, or it belongs to another session. */
var ArtifactNotFoundError = class extends StoreError {
	artifactId;
	sessionId;
	constructor(artifactId, sessionId) {
		super(sessionId === void 0 ? `no artifact "${artifactId}" on disk. It may have been deleted, or the id was mistyped — list the session's artifacts to see what exists.` : `no artifact "${artifactId}" in session "${sessionId}". Ids are session-scoped; a session cannot address another session's artifact.`);
		this.name = "ArtifactNotFoundError";
		this.artifactId = artifactId;
		this.sessionId = sessionId;
	}
};
/** The artifact exists but that revision number is not in its chain. */
var VersionNotFoundError = class extends StoreError {
	artifactId;
	version;
	constructor(artifactId, version) {
		super(`artifact "${artifactId}" has no version ${String(version)}. Read it without a version to get the head, or list its versions first.`);
		this.name = "VersionNotFoundError";
		this.artifactId = artifactId;
		this.version = version;
	}
};
/**
* Optimistic-concurrency refusal: the caller's `expectedLatestVersion` is not
* the head any more, so the write was rejected and **no version was appended**.
*/
var StaleVersionError = class extends StoreError {
	artifactId;
	/** The version the caller assumed. */
	expected;
	/** The version actually on disk. */
	actual;
	actualVersionId;
	constructor(artifactId, expected, actual, actualVersionId) {
		super(`artifact "${artifactId}" moved under you: expected latest version ${String(expected)}, but the head is version ${String(actual)}. Nothing was written. Read it again — the text you searched for may already be gone — then retry against version ${String(actual)}.`);
		this.name = "StaleVersionError";
		this.artifactId = artifactId;
		this.expected = expected;
		this.actual = actual;
		this.actualVersionId = actualVersionId;
	}
};
/** A configured budget was exceeded. */
var StoreQuotaError = class extends StoreError {
	kind;
	limit;
	actual;
	constructor(kind, limit, actual) {
		super(kind === "artifacts" ? `this session already holds ${String(actual)} artifacts (limit ${String(limit)}). Delete one with action "destroy" before creating another.` : `the artifact would be ${String(actual)} bytes, over the ${String(limit)} byte per-artifact limit. Split it into smaller artifacts.`);
		this.name = "StoreQuotaError";
		this.kind = kind;
		this.limit = limit;
		this.actual = actual;
	}
};
/** Another process holds the store lock and did not release it in time. */
var StoreLockedError = class extends StoreError {
	lockFile;
	waitedMs;
	constructor(lockFile, waitedMs) {
		super(`another writer holds the artifact store lock (${lockFile}) after ${String(waitedMs)}ms. Retry the write; if the holding process died, the lock is taken over once it is stale.`);
		this.name = "StoreLockedError";
		this.lockFile = lockFile;
		this.waitedMs = waitedMs;
	}
};
/** An artifact with that id already exists. */
var ArtifactExistsError = class extends StoreError {
	artifactId;
	constructor(artifactId) {
		super(`artifact "${artifactId}" already exists on disk. Read it and patch the head instead of creating a new one.`);
		this.name = "ArtifactExistsError";
		this.artifactId = artifactId;
	}
};
/** The chain on disk cannot be resumed: a version file is missing or unreadable. */
var ArtifactCorruptError = class extends StoreError {
	artifactId;
	version;
	constructor(artifactId, version, detail) {
		super(`artifact "${artifactId}" cannot be resumed: version ${String(version)} is unusable (${detail}). The chain stops there; older versions stay readable.`);
		this.name = "ArtifactCorruptError";
		this.artifactId = artifactId;
		this.version = version;
	}
};
//#endregion
//#region src/store/lock.ts
/**
* One writer at a time, across processes: an `O_EXCL` lock file at the store
* root, taken over when its holder died.
*
* The store's index is a single whole-file document that every write
* read-modify-writes, so the version-number allocation and the index update have
* to be mutually exclusive — without this, two writers could both allocate
* version N and one would silently overwrite the other's content. Optimistic
* `expectedLatestVersion` catches a *logical* race the caller knew about; this
* lock catches the physical one it could not.
* @module dsh-genui/store/lock
*/
/** Shared futex for {@link sleepSync}; Node allows `Atomics.wait` on the main thread. */
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
/** Block the current thread without burning CPU. */
function sleepSync(ms) {
	if (ms <= 0) return;
	try {
		Atomics.wait(SLEEP_CELL, 0, 0, ms);
	} catch {
		const until = Date.now() + ms;
		while (Date.now() < until);
	}
}
/**
* Take the store lock.
* @param lockFile - lock path; its directory is created on demand.
* @param options - timeout, staleness and clock.
* @returns the held lock.
* @throws {StoreLockedError} when a live holder keeps it past `timeoutMs`.
*/
function acquireLock(lockFile, options) {
	ensureDir(dirname(lockFile));
	const startedAt = options.now();
	for (;;) {
		let fd;
		try {
			fd = openSync(lockFile, "wx");
			writeSync(fd, `${JSON.stringify({
				pid: process.pid,
				at: options.now()
			})}\n`);
			closeQuietly(fd);
			let released = false;
			return { release() {
				if (released) return;
				released = true;
				try {
					unlinkSync(lockFile);
				} catch (error) {
					if (!isMissing(error)) throw error;
				}
			} };
		} catch (error) {
			if (fd !== void 0) closeQuietly(fd);
			if (!isHeld(error)) throw error;
		}
		let ageMs;
		try {
			ageMs = options.now() - statSync(lockFile).mtimeMs;
		} catch (error) {
			if (isMissing(error)) continue;
			throw error;
		}
		if (ageMs > options.staleMs) {
			try {
				unlinkSync(lockFile);
			} catch {}
			continue;
		}
		const waitedMs = options.now() - startedAt;
		if (waitedMs >= options.timeoutMs) throw new StoreLockedError(lockFile, waitedMs);
		sleepSync(Math.min(25, Math.max(1, options.timeoutMs - waitedMs)));
	}
}
/** Run `body` under the store lock. */
function withLock(lockFile, options, body) {
	const lock = acquireLock(lockFile, options);
	try {
		return body();
	} finally {
		lock.release();
	}
}
/** Whether one thrown value means "the lock file already exists". */
function isHeld(error) {
	return error?.code === "EEXIST";
}
//#endregion
//#region src/store/store.ts
/**
* The durable artifact registry: what replaces a process-local `Map`, so an
* artifact a previous DSH run created is still addressable — and still
* patchable — after the app restarts.
*
* Model, per `coda0HQ/open-artifacts` (MIT):
* - **Append-only.** Every write appends exactly one immutable version; no code
*   path rewrites or renumbers an existing one.
* - **Restore mints a head.** `restore(id, 1)` produces version N+1 carrying
*   version 1's content; versions 1..N stay bit-for-bit as they were.
* - **Optimistic concurrency.** `expectedLatestVersion` is a compare-and-append:
*   a mismatch throws {@link StaleVersionError} and appends nothing.
* - **Any version is readable.** `read(id, n)` is the `?v=N` view.
*
* Nothing is cached in the instance: every call resolves through `index.json`
* and the version files, which is why a brand-new instance over the same root
* behaves exactly like the process that wrote the data. Disk layout and crash
* recovery live in `./disk.ts`, the writer lock in `./lock.ts`.
* @module dsh-genui/store/store
*/
/** Stable id alphabet: no lookalike characters, so a model can retype an id. */
const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
/** Session key for artifacts created without a session; owns one quota bucket. */
const UNSCOPED = "(unscoped)";
/** Default per-artifact content cap: 8 MiB. */
const DEFAULT_MAX_CONTENT_BYTES = 8388608;
/** One short id, unique across the whole store. */
function mintId(taken) {
	for (;;) {
		const bytes = randomBytes(8);
		let id = "art-";
		for (const byte of bytes) id += ID_ALPHABET.charAt(byte % 31);
		if (!taken.has(id)) return id;
	}
}
/**
* A disk-backed, versioned artifact store.
*
* All methods are synchronous: the plugin writes a handful of artifacts per
* turn and reads one at a time, and a synchronous API keeps the write path
* (lock → resolve head → validate → append → swap index) a single atomic
* sequence with no interleaving point. Callers may `await` the results freely —
* `await` passes non-promises straight through.
*/
var ArtifactStore = class {
	/** Disk root this instance owns. */
	root;
	#paths;
	#maxArtifactsPerSession;
	#maxContentBytes;
	#lockTimeoutMs;
	#staleLockMs;
	#now;
	#idFactory;
	/**
	* @param options - root, quotas, lock tuning, injectable clock and id minter.
	*   The root directory tree is created on construction.
	*/
	constructor(options = {}) {
		this.root = options.root ?? defaultStoreRoot();
		this.#paths = storePaths(this.root);
		this.#maxArtifactsPerSession = options.maxArtifactsPerSession ?? 40;
		this.#maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
		this.#lockTimeoutMs = options.lockTimeoutMs ?? 2e3;
		this.#staleLockMs = options.staleLockMs ?? 1e4;
		this.#now = options.now ?? Date.now;
		this.#idFactory = options.idFactory ?? mintId;
		ensureDir(this.#paths.artifactsDir);
		ensureDir(this.#paths.locksDir);
	}
	/** `<root>/index.json`; useful for diagnostics and for tests. */
	get indexPath() {
		return this.#paths.indexFile;
	}
	/** `<root>/artifacts`. */
	get artifactsDir() {
		return this.#paths.artifactsDir;
	}
	/** `<root>/locks/store.lock`. */
	get lockFile() {
		return this.#paths.lockFile;
	}
	/** Absolute directory holding one artifact's version files. */
	directoryOf(id) {
		return artifactDir(this.#paths, id);
	}
	/**
	* Create an artifact and append its version 1.
	* @param input - source, and optionally id, session, title, mode, changelog.
	* @returns the head record, at version 1.
	* @throws {StoreQuotaError} when the session is at its artifact cap, or the
	*   source is over the per-artifact byte cap.
	* @throws {ArtifactExistsError} when a forced id is already on disk.
	*/
	create(input) {
		const bytes = this.#guardBytes(input.source);
		const sessionId = input.sessionId;
		const title = cleanTitle(input.title);
		const mode = input.mode === "wide" ? "wide" : "inline";
		return this.#locked(() => {
			const index = readIndex(this.#paths);
			const entries = Object.values(index.artifacts);
			const bucket = sessionId ?? UNSCOPED;
			const held = entries.filter((entry) => (entry.sessionId ?? UNSCOPED) === bucket).length;
			if (held >= this.#maxArtifactsPerSession) throw new StoreQuotaError("artifacts", this.#maxArtifactsPerSession, held);
			const taken = new Set(Object.keys(index.artifacts));
			const id = input.id ?? this.#idFactory(taken);
			if (taken.has(id) || versionNumberExists(this.#paths, id, 1)) throw new ArtifactExistsError(id);
			const createdAt = input.createdAt ?? this.#now();
			const meta = {
				schema: VERSION_SCHEMA,
				id,
				contentFile: `${versionStem(1)}.html`,
				...sessionId === void 0 ? {} : { sessionId },
				versionNumber: 1,
				versionId: versionIdOf(id, 1),
				parentVersionId: null,
				contentSha256: sha256Of(bytes),
				contentBytes: bytes.byteLength,
				changelog: input.changelog ?? "created",
				createdAt,
				action: "create",
				title,
				mode,
				engine: input.engine === "html" ? "html" : "dil"
			};
			writeVersionFiles(this.#paths, meta, bytes);
			const summary = summaryFromHead(meta, 1, createdAt);
			index.artifacts[id] = summary;
			index.updatedAt = createdAt;
			writeIndex(this.#paths, index);
			return {
				...summary,
				source: input.source,
				changelog: meta.changelog,
				render: "reload"
			};
		});
	}
	/**
	* Append one whole new revision. The low-level path; `patch` and `restore`
	* are built on it.
	* @throws {ArtifactNotFoundError} | {@link StaleVersionError} | {@link StoreQuotaError}
	*/
	append(id, input) {
		return this.#commit(id, input.sessionId, input.expectedLatestVersion, (state) => ({
			action: "append",
			content: input.content,
			title: input.title === void 0 ? state.head.title : cleanTitle(input.title),
			mode: input.mode ?? state.head.mode,
			changelog: input.changelog ?? `appended ${String(encodeContent(input.content).byteLength)} bytes`
		}));
	}
	/**
	* Apply an exact `oldText` → `newText` replacement to the head.
	*
	* Replacement semantics are `src/patch.ts` verbatim — empty or absent search
	* text and an ambiguous match without `replaceAll` all throw `PatchError`
	* before anything is written.
	* @throws {PatchError} when the patch cannot be applied.
	* @throws {StaleVersionError} when `expectedLatestVersion` is not the head.
	*/
	patch(id, input) {
		return this.#commit(id, input.sessionId, input.expectedLatestVersion, (state) => {
			const applied = applyPatch(state.source, input.oldText, input.newText, input.replaceAll ?? false);
			const before = encodeContent(state.source).byteLength;
			const after = encodeContent(applied.text).byteLength;
			return {
				action: "patch",
				content: applied.text,
				title: input.title === void 0 ? state.head.title : cleanTitle(input.title),
				mode: state.head.mode,
				changelog: input.changelog ?? `patch ${String(applied.replacements)}× (${String(before)}→${String(after)} bytes)`
			};
		});
	}
	/**
	* Restore an old revision as a **new** head. History is untouched: version N
	* still holds exactly what it held, and the restore lands as version N+1.
	* @param id - artifact id.
	* @param version - revision to copy forward.
	* @throws {ArtifactNotFoundError} | {@link VersionNotFoundError} | {@link StaleVersionError}
	*/
	restore(id, version, input = {}) {
		return this.#commit(id, input.sessionId, input.expectedLatestVersion, (state) => {
			const meta = readVersionMeta(this.#paths, id, version);
			const bytes = meta === void 0 ? void 0 : readVersionBytes(this.#paths, id, meta);
			if (meta === void 0 || bytes === void 0) throw new VersionNotFoundError(id, version);
			return {
				action: "restore",
				content: bytes.toString("utf8"),
				title: meta.title,
				mode: meta.mode,
				changelog: input.changelog ?? `restored from v${String(version)}`
			};
		});
	}
	/**
	* Delete an artifact and its entire version history.
	* @returns whether anything was deleted.
	*/
	destroy(id) {
		return this.#locked(() => {
			const index = readIndex(this.#paths);
			const known = index.artifacts[id] !== void 0;
			removeArtifactDir(this.#paths, id);
			if (!known) return false;
			delete index.artifacts[id];
			index.updatedAt = this.#now();
			writeIndex(this.#paths, index);
			return true;
		});
	}
	/**
	* Read one revision.
	* @param id - artifact id.
	* @param version - revision number; defaults to the head (`?v=N` otherwise).
	* @throws {ArtifactNotFoundError} when no chain exists for that id.
	* @throws {VersionNotFoundError} when that revision is not in the chain.
	*/
	read(id, version) {
		const resolved = this.#resolve(id);
		if (resolved === void 0) throw new ArtifactNotFoundError(id);
		const wanted = version ?? resolved.head.versionNumber;
		const meta = wanted === resolved.head.versionNumber ? resolved.head : readVersionMeta(this.#paths, id, wanted);
		if (meta === void 0) throw new VersionNotFoundError(id, wanted);
		const bytes = readVersionBytes(this.#paths, id, meta);
		if (bytes === void 0) throw new VersionNotFoundError(id, wanted);
		return {
			...publicMeta(meta),
			content: bytes.toString("utf8")
		};
	}
	/**
	* The head record, or `undefined` when the id is unknown. A probe, not an
	* action: use {@link read} when a missing artifact should be an error.
	*/
	get(id) {
		const resolved = this.#resolve(id);
		if (resolved === void 0) return void 0;
		const bytes = readVersionBytes(this.#paths, id, resolved.head);
		if (bytes === void 0) return void 0;
		const source = bytes.toString("utf8");
		return {
			...resolved.summary,
			source,
			changelog: resolved.head.changelog,
			render: this.#renderFor(id, resolved.head, source)
		};
	}
	/** Whether an artifact (or at least part of its chain) is on disk. */
	has(id) {
		return this.#resolve(id) !== void 0;
	}
	/**
	* The catalog, oldest first.
	* @param sessionId - filter to one session; omitted lists every artifact.
	*   Read from `index.json` only, so call {@link recover} first if the index
	*   may have been lost.
	*/
	list(sessionId) {
		const index = readIndex(this.#paths);
		return Object.values(index.artifacts).filter((entry) => sessionId === void 0 || entry.sessionId === sessionId).sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
	}
	/**
	* Every revision of one artifact, version 1 first, content excluded.
	* @throws {ArtifactNotFoundError} when no chain exists for that id.
	*/
	versions(id) {
		const scan = walkChain(this.#paths, id);
		if (scan.head === void 0) throw new ArtifactNotFoundError(id);
		return scan.versions.map(publicMeta);
	}
	/** The session's artifact with this title, or `undefined`. */
	findByTitle(sessionId, title) {
		const wanted = title.trim();
		return this.list(sessionId).find((entry) => entry.title.trim() === wanted);
	}
	/** Artifact count and head-content bytes, for one session or the whole store. */
	usage(sessionId) {
		let artifacts = 0;
		let bytes = 0;
		for (const entry of this.list(sessionId)) {
			artifacts += 1;
			bytes += entry.contentBytes;
		}
		return {
			artifacts,
			bytes
		};
	}
	/**
	* Reconcile `index.json` with what is actually on disk.
	*
	* Adopts artifacts whose version files survived but whose index entry did
	* not (a crash between the two writes, or a lost index), repairs head
	* pointers that disagree with the chain, and drops entries with nothing
	* behind them. Orphans and corrupt versions are **reported, never deleted**:
	* discarding content on a heuristic is worse than leaving a file behind.
	*
	* Idempotent and cheap; call it once when the plugin loads.
	*/
	recover() {
		return this.#locked(() => {
			const index = readIndex(this.#paths);
			const ids = listArtifactIds(this.#paths);
			const onDisk = new Set(ids);
			const report = {
				root: this.root,
				scanned: ids.length,
				adopted: [],
				repaired: [],
				dropped: [],
				corrupt: [],
				orphans: []
			};
			for (const id of ids) {
				const scan = walkChain(this.#paths, id);
				report.corrupt.push(...scan.corrupt.map((n) => versionIdOf(id, n)));
				report.orphans.push(...scan.orphans.map((n) => versionIdOf(id, n)));
				const rebuilt = summaryFromChain(scan);
				if (rebuilt === void 0) continue;
				const existing = index.artifacts[id];
				if (existing === void 0) {
					index.artifacts[id] = rebuilt;
					report.adopted.push(id);
					continue;
				}
				if (existing.version !== rebuilt.version || existing.contentSha256 !== rebuilt.contentSha256 || existing.versionCount !== rebuilt.versionCount || existing.title !== rebuilt.title) {
					index.artifacts[id] = rebuilt;
					report.repaired.push(id);
				}
			}
			for (const id of Object.keys(index.artifacts)) {
				if (onDisk.has(id)) continue;
				delete index.artifacts[id];
				report.dropped.push(id);
			}
			index.updatedAt = this.#now();
			writeIndex(this.#paths, index);
			return report;
		});
	}
	/**
	* Re-hash every version file of one artifact — the chain *and* any version
	* past a hole — and compare against the recorded digest, so silent disk
	* corruption is detected rather than silently patched on top of. Only the
	* chain is writable; this is the read-side check.
	* @throws {ArtifactNotFoundError} when the artifact has no files at all.
	*/
	verify(id) {
		const numbers = versionNumbers(this.#paths, id);
		const first = numbers.at(0);
		if (first === void 0 || readVersionMeta(this.#paths, id, first) === void 0) throw new ArtifactNotFoundError(id);
		const report = {
			id,
			versions: numbers.length,
			checked: 0,
			mismatched: [],
			unreadable: []
		};
		for (const versionNumber of numbers) {
			const meta = readVersionMeta(this.#paths, id, versionNumber);
			const bytes = meta === void 0 ? void 0 : readVersionBytes(this.#paths, id, meta);
			if (meta === void 0 || bytes === void 0) {
				report.unreadable.push(versionNumber);
				continue;
			}
			report.checked += 1;
			if (bytes.byteLength !== meta.contentBytes || sha256Of(bytes) !== meta.contentSha256) report.mismatched.push(versionNumber);
		}
		return report;
	}
	/** Run `body` while holding the store-wide writer lock. */
	#locked(body) {
		return withLock(this.#paths.lockFile, {
			timeoutMs: this.#lockTimeoutMs,
			staleMs: this.#staleLockMs,
			now: this.#now
		}, body);
	}
	/** Reject an oversized source before any IO. */
	#guardBytes(content) {
		const bytes = encodeContent(content);
		if (bytes.byteLength > this.#maxContentBytes) throw new StoreQuotaError("bytes", this.#maxContentBytes, bytes.byteLength);
		return bytes;
	}
	/**
	* Resolve one artifact's head without writing anything.
	*
	* Disk beats the catalog whenever the two disagree: an index entry whose own
	* head is unreadable, or that a higher version has landed past, is a pointer
	* left behind by an interrupted write. Resolving through the chain instead
	* means a lost index degrades to "the catalog is empty", never to "your
	* artifacts are gone", and that reads and writes agree on where the head is.
	* {@link recover} is what makes the *catalog* agree too.
	*/
	#resolve(id) {
		const entry = readIndex(this.#paths).artifacts[id];
		if (entry !== void 0) {
			const head = readVersionMeta(this.#paths, id, entry.version);
			if (head !== void 0 && versionComplete(this.#paths, id, head) && !versionNumberExists(this.#paths, id, entry.version + 1)) return {
				summary: entry,
				head,
				fromChain: false
			};
		}
		const scan = walkChain(this.#paths, id);
		const summary = summaryFromChain(scan);
		if (summary === void 0 || scan.head === void 0) return void 0;
		return {
			summary,
			head: scan.head,
			fromChain: true
		};
	}
	/**
	* Resolve the head for a write, repairing the in-memory catalog when disk is
	* ahead of it — the crash orphan the previous write left behind. Adopting it
	* is what makes the next patch land on top of the model's last work instead of
	* overwriting a version that is already on disk.
	*/
	#resolveForWrite(index, id) {
		const entry = index.artifacts[id];
		if (entry !== void 0) {
			const head = readVersionMeta(this.#paths, id, entry.version);
			if (head !== void 0 && versionComplete(this.#paths, id, head) && !versionNumberExists(this.#paths, id, entry.version + 1)) return entry;
		}
		const rebuilt = summaryFromChain(walkChain(this.#paths, id));
		if (rebuilt === void 0) return entry;
		index.artifacts[id] = rebuilt;
		return rebuilt;
	}
	/**
	* The one place a version is appended: lock, resolve, check, plan, write
	* content, write sidecar, swap the index. Any throw before the index swap
	* leaves the previous head in force and at most a stray version file behind,
	* which {@link recover} reports.
	*/
	#commit(id, sessionId, expectedLatestVersion, build) {
		return this.#locked(() => {
			const index = readIndex(this.#paths);
			const entry = this.#resolveForWrite(index, id);
			if (entry === void 0) throw new ArtifactNotFoundError(id, sessionId);
			if (sessionId !== void 0 && entry.sessionId !== sessionId) throw new ArtifactNotFoundError(id, sessionId);
			if (expectedLatestVersion !== void 0 && expectedLatestVersion !== entry.version) throw new StaleVersionError(id, expectedLatestVersion, entry.version, entry.versionId);
			const head = readVersionMeta(this.#paths, id, entry.version);
			const headBytes = head === void 0 ? void 0 : readVersionBytes(this.#paths, id, head);
			if (head === void 0 || headBytes === void 0) throw new ArtifactCorruptError(id, entry.version, "the content file or sidecar is missing");
			const source = headBytes.toString("utf8");
			const plan = build({
				summary: entry,
				head,
				source
			});
			const bytes = this.#guardBytes(plan.content);
			const versionNumber = entry.version + 1;
			const createdAt = this.#now();
			const meta = {
				schema: VERSION_SCHEMA,
				id,
				contentFile: `${versionStem(versionNumber)}.html`,
				...entry.sessionId === void 0 ? {} : { sessionId: entry.sessionId },
				versionNumber,
				versionId: versionIdOf(id, versionNumber),
				parentVersionId: entry.versionId,
				contentSha256: sha256Of(bytes),
				contentBytes: bytes.byteLength,
				changelog: plan.changelog,
				createdAt,
				action: plan.action,
				title: plan.title,
				mode: plan.mode,
				engine: head.engine
			};
			writeVersionFiles(this.#paths, meta, bytes);
			const summary = summaryFromHead(meta, entry.versionCount + 1, entry.createdAt);
			index.artifacts[id] = summary;
			index.updatedAt = createdAt;
			writeIndex(this.#paths, index);
			const render = plan.action === "restore" || requiresReload(source, plan.content) ? "reload" : "reconcile";
			return {
				...summary,
				source: plan.content,
				changelog: meta.changelog,
				render
			};
		});
	}
	/**
	* How a live card must adopt the head: reconcile when only markup or style
	* moved, reload as soon as any `<script>` body did — the same rule
	* `src/patch.ts` applies, evaluated one version back.
	*/
	#renderFor(id, head, source) {
		if (head.versionNumber <= 1) return "reload";
		const previous = readVersionMeta(this.#paths, id, head.versionNumber - 1);
		const previousBytes = previous === void 0 ? void 0 : readVersionBytes(this.#paths, id, previous);
		if (previousBytes === void 0) return "reload";
		return requiresReload(previousBytes.toString("utf8"), source) ? "reload" : "reconcile";
	}
};
/** Strip the on-disk envelope, keeping only the public revision fields. */
function publicMeta(meta) {
	return {
		id: meta.id,
		...meta.sessionId === void 0 ? {} : { sessionId: meta.sessionId },
		versionNumber: meta.versionNumber,
		versionId: meta.versionId,
		parentVersionId: meta.parentVersionId,
		contentSha256: meta.contentSha256,
		contentBytes: meta.contentBytes,
		changelog: meta.changelog,
		createdAt: meta.createdAt,
		action: meta.action,
		title: meta.title,
		mode: meta.mode,
		engine: meta.engine
	};
}
/** A title the model can retype: trimmed, never empty. */
function cleanTitle(title) {
	if (title === void 0) return "Artifact";
	const trimmed = title.trim();
	return trimmed.length === 0 ? "Artifact" : trimmed;
}
//#endregion
//#region src/dil/compiler/scanner.ts
/** 1-based line/column of a UTF-16 index — what diagnostics report. */
function lineCol(src, index) {
	let line = 1;
	let column = 1;
	for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") {
		line++;
		column = 1;
	} else column++;
	return {
		line,
		column
	};
}
const REGEX_PRECEDERS = "([{,;:=!&|?+-*%~^<>";
/**
* Scan a balanced `open … close` region starting at `start` (src[start] === open).
* Returns the inner text and whether it closed. Never throws: an unterminated region
* runs to the end of the source with `ok: false`, which the parser turns into a
* recovery diagnostic.
*/
function readBalanced(src, start, open = "{", close = "}") {
	let i = start;
	let depth = 0;
	const stack = [];
	const top = () => stack[stack.length - 1];
	let prevSig = "";
	while (i < src.length) {
		const c = src[i];
		const t = top();
		if (t && t.type === "str") {
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === t.q) stack.pop();
			i++;
			continue;
		}
		if (t && t.type === "tmpl") {
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === "`") {
				stack.pop();
				i++;
				continue;
			}
			if (c === "$" && src[i + 1] === "{") {
				stack.push({
					type: "brace",
					depthAtOpen: depth
				});
				depth++;
				i += 2;
				prevSig = "{";
				continue;
			}
			i++;
			continue;
		}
		if (c === "\"" || c === "'") {
			stack.push({
				type: "str",
				q: c
			});
			i++;
			prevSig = c;
			continue;
		}
		if (c === "`") {
			stack.push({ type: "tmpl" });
			i++;
			prevSig = c;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			i += 2;
			while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		if (c === "/" && (prevSig === "" || REGEX_PRECEDERS.includes(prevSig))) {
			i = skipRegex(src, i + 1);
			continue;
		}
		if (c === open) {
			depth++;
			i++;
			prevSig = c;
			continue;
		}
		if (c === close) {
			depth--;
			i++;
			if (t && t.type === "brace" && depth === t.depthAtOpen) {
				stack.pop();
				prevSig = close;
				continue;
			}
			if (depth === 0) return {
				inner: src.slice(start + 1, i - 1),
				end: i,
				ok: true
			};
			prevSig = c;
			continue;
		}
		if (!/\s/.test(c)) prevSig = c;
		i++;
	}
	return {
		inner: src.slice(start + 1),
		end: src.length,
		ok: false
	};
}
function skipRegex(src, i) {
	let inClass = false;
	while (i < src.length) {
		const d = src[i];
		if (d === "\\") {
			i += 2;
			continue;
		}
		if (d === "[") inClass = true;
		else if (d === "]") inClass = false;
		else if (d === "/" && !inClass) return i + 1;
		else if (d === "\n") return i;
		i++;
	}
	return i;
}
/**
* Index of the first `match(expr, i)` at bracket/string depth 0, or -1. The
* predicate form lets callers look for multi-character separators (` as `).
*/
function findTopLevel(expr, match, from = 0) {
	let depth = 0;
	let quote = null;
	for (let i = from; i < expr.length; i++) {
		const c = expr[i];
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === "\"" || c === "'" || c === "`") {
			quote = c;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (depth === 0 && match(expr, i)) return i;
	}
	return -1;
}
/** Index of a single character at depth 0, or -1. */
function topLevelIndex(expr, ch, from = 0) {
	return findTopLevel(expr, (s, i) => s[i] === ch, from);
}
/** `{#each list as item}` → { list, item } split at the top-level ` as `. */
function splitEachClause(expr) {
	const i = findTopLevel(expr, (s, j) => s.startsWith(" as ", j));
	return i < 0 ? null : {
		list: expr.slice(0, i).trim(),
		item: expr.slice(i + 4).trim()
	};
}
/** UTF-16 index → Unicode code point index; linear to build, O(1) per lookup. */
function codePointIndexer(src) {
	const table = new Uint32Array(src.length + 1);
	let cp = 0;
	for (let i = 0; i < src.length; i++) {
		table[i] = cp;
		const c = src.charCodeAt(i);
		const isLowSurrogate = c >= 56320 && c <= 57343;
		const prev = i > 0 ? src.charCodeAt(i - 1) : 0;
		if (isLowSurrogate && prev >= 55296 && prev <= 56319) continue;
		cp++;
	}
	table[src.length] = cp;
	return (i) => table[Math.max(0, Math.min(i, src.length))];
}
//#endregion
//#region src/dil/compiler/parser.ts
/**
* DIL parser: source → AST, with recovery diagnostics.
*
*   markdown prose          → { type:'text' }
*   {@body stmt}            → { type:'stmt' }      hoisted into the render function
*   {expr}                  → { type:'expr' }
*   {#if}…{:else if}…{/if}  → { type:'if', branches }
*   {#each xs as x}…{/each} → { type:'each', list, item, body }
*   <tag attr=…>…</tag>     → { type:'element', name, attrs, children, pos, end, closed }
*
* Malformed input is the *normal* case: the source arrives a few dozen bytes at a time
* and almost every intermediate state is invalid. Every failure is recorded as a
* diagnostic and parsing continues with a best-effort AST — this function never throws.
*
* Ported from `vendor/dil-replica/replica/server/compiler/parser.js` (MIT,
* Disdjj/intelligent-ui-demo @938ab09). One upstream bug fixed — see
* {@link readClosingTag}.
* @module dsh-genui/dil/compiler/parser
*/
const TAG_NAME = /^[A-Za-z_$][\w$]*(?:[-.][A-Za-z_$][\w$]*)*/;
const ATTR_NAME = /^[A-Za-z_$][\w$:-]*/;
const BLOCK_OPEN = /* @__PURE__ */ new Set(["if", "each"]);
/**
* Elements whose content is literal text, never DIL. Code samples are full of `{`,
* `}`, `<` and `:=` — parsed as DIL they become broken JavaScript and the whole
* program fails to evaluate (`<code>for i := 0; …{ wg.Add(1) }</code>`).
*/
const RAW_TEXT = /* @__PURE__ */ new Set([
	"code",
	"pre",
	"code-block"
]);
/** Collector for one parse: positions each report and de-duplicates by code+line+column. */
var Diagnostics = class {
	src;
	items = [];
	seen = /* @__PURE__ */ new Set();
	constructor(src) {
		this.src = src;
	}
	add(code, index, extra = {}) {
		const { line, column } = lineCol(this.src, index);
		const key = `${code}:${line}:${column}`;
		if (this.seen.has(key)) return;
		this.seen.add(key);
		this.items.push({
			code,
			line,
			column,
			...extra
		});
	}
	/** `clean`, or `code×n` pairs — the one-line form the UI shows. */
	summary() {
		if (!this.items.length) return "clean";
		const counts = /* @__PURE__ */ new Map();
		for (const d of this.items) counts.set(d.code, (counts.get(d.code) || 0) + 1);
		return [...counts.entries()].map(([k, v]) => `${k}×${v}`).join(" ");
	}
};
function parse(src) {
	const diag = new Diagnostics(src);
	return {
		nodes: mergeText(parseNodes({
			src,
			i: 0,
			diag
		}, null).nodes),
		diagnostics: diag.items,
		diagnosticSummary: diag.summary()
	};
}
/**
* Parse a run of siblings. Stops at EOF, at `</closeTag>`, or at a `{:…}` / `{/…}`
* terminator, which is returned to the enclosing block to interpret.
*/
function parseNodes(ctx, closeTag) {
	const { src } = ctx;
	const nodes = [];
	let textStart = -1;
	const flushText = (end) => {
		if (textStart < 0) return;
		const raw = src.slice(textStart, end);
		if (raw.length) nodes.push({
			type: "text",
			value: decodeEntities(raw),
			pos: textStart
		});
		textStart = -1;
	};
	while (ctx.i < src.length) {
		const c = src[ctx.i];
		const next = src[ctx.i + 1];
		if (closeTag && c === "<" && next === "/") {
			const closing = readClosingTag(ctx, closeTag);
			if (closing) {
				flushText(closing.at);
				return {
					nodes,
					terminator: closing.terminator,
					name: closing.name,
					length: closing.length
				};
			}
		}
		if (c === "{" && (next === ":" || next === "/")) {
			flushText(ctx.i);
			const term = readTerminator(ctx);
			if (term) return {
				nodes,
				...term
			};
			continue;
		}
		if (c === "{" && next === "@") {
			flushText(ctx.i);
			const stmt = readAppDirective(ctx);
			if (stmt) nodes.push(stmt);
			continue;
		}
		if (c === "{" && next === "#") {
			flushText(ctx.i);
			const block = readBlock(ctx, closeTag);
			if (block) nodes.push(block);
			continue;
		}
		if (c === "<" && /[A-Za-z_$]/.test(next || "")) {
			flushText(ctx.i);
			const el = parseElement(ctx);
			if (el) nodes.push(el);
			continue;
		}
		if (c === "{") {
			flushText(ctx.i);
			const pos = ctx.i;
			const braced = readBalanced(src, pos);
			if (!braced.ok) ctx.diag.add("unterminated_braced_value", pos, { action: "recovered_parse" });
			const code = braced.inner.trim();
			if (code) nodes.push({
				type: "expr",
				code,
				pos
			});
			ctx.i = braced.end;
			continue;
		}
		if (textStart < 0) textStart = ctx.i;
		ctx.i++;
	}
	flushText(src.length);
	if (closeTag) ctx.diag.add("unclosed_block", src.length, {
		directive: closeTag,
		action: "recovered_parse"
	});
	return {
		nodes,
		terminator: null
	};
}
/**
* `</name>` closing the current element. Null when it is not a tag at all.
*
* Upstream bug fixed here: this function used to report only `{ at, terminator }`,
* without the `name` and `length` the block closers read. A `</tag>` that closed the
* *surrounding element* from inside a `{#if}` / `{#each}` body therefore reached
* `closeBlock` with `length === undefined`: `ctx.i += undefined` became `NaN`, the
* sibling loop's `ctx.i < src.length` turned false, and the whole rest of the
* document was silently dropped (with a `mismatched_block_close` diagnostic naming
* `undefined`). It now reports the tag it found and a zero advance, because it
* already moved the cursor past `>`.
*/
function readClosingTag(ctx, closeTag) {
	const { src } = ctx;
	const m = TAG_NAME.exec(src.slice(ctx.i + 2));
	if (!m) return null;
	const at = ctx.i;
	const gt = src.indexOf(">", at + 2 + m[0].length);
	if (gt < 0) {
		ctx.diag.add("unterminated_tag", at, { tag: m[0] });
		ctx.i = src.length;
		return {
			at,
			terminator: null
		};
	}
	if (m[0] !== closeTag) ctx.diag.add("mismatched_tag", at, {
		expected: closeTag,
		found: m[0],
		action: "recovered_parse"
	});
	ctx.i = gt + 1;
	return {
		at,
		terminator: "close",
		name: m[0],
		length: 0
	};
}
/**
* `{:else}`, `{:else if expr}`, `{/if}`, `{/each}`. The cursor is left *on* the
* terminator — the enclosing block advances past it by `length`. A malformed
* terminator is consumed one character at a time and parsing continues.
*/
function readTerminator(ctx) {
	const { src } = ctx;
	const kind = src[ctx.i + 1] === ":" ? "else" : "close";
	const simple = /^\{[:/](\w+)\}/.exec(src.slice(ctx.i));
	if (simple) return {
		terminator: kind,
		name: simple[1],
		length: simple[0].length
	};
	if (kind === "else" && /^\{:else\s+if\s/.test(src.slice(ctx.i, ctx.i + 16))) {
		const braced = readBalanced(src, ctx.i);
		if (!braced.ok) ctx.diag.add("unterminated_braced_value", ctx.i, {
			directive: "if",
			action: "recovered_parse"
		});
		return {
			terminator: "else",
			name: "else",
			cond: braced.inner.replace(/^:else\s+if\s+/, "").trim() || "false",
			length: braced.end - ctx.i
		};
	}
	ctx.diag.add("malformed_terminator", ctx.i, { action: "recovered_parse" });
	ctx.i += 1;
	return null;
}
/** A balanced region that spans another `{@` or a tag line has eaten too much. */
function runsIntoNextDirective(inner) {
	return /\n\s*(\{@|<[A-Za-z])/.test(inner);
}
/** `{@body …}` — one or more statements hoisted into the render function. */
function readAppDirective(ctx) {
	const { src } = ctx;
	const pos = ctx.i;
	let braced = readBalanced(src, pos);
	if (!braced.ok || runsIntoNextDirective(braced.inner)) {
		const eol = src.indexOf("\n", pos);
		if (eol < 0) {
			ctx.diag.add("unterminated_braced_value", pos, {
				directive: "body",
				action: "deferred"
			});
			ctx.i = src.length;
			return null;
		}
		ctx.diag.add("unterminated_braced_value", pos, {
			directive: "body",
			action: "recovered_parse"
		});
		braced = {
			inner: src.slice(pos + 1, eol),
			end: eol,
			ok: false
		};
	}
	ctx.i = braced.end;
	const m = /^\s*([A-Za-z_$][\w$]*)\s*([\s\S]*)$/.exec(braced.inner.slice(1));
	if (!m) {
		ctx.diag.add("empty_app_directive", pos, { action: "recovered_parse" });
		return null;
	}
	return {
		type: "stmt",
		name: m[1],
		code: m[2].trim(),
		pos
	};
}
function readBlock(ctx, closeTag) {
	const { src } = ctx;
	const pos = ctx.i;
	const braced = readBalanced(src, pos);
	if (!braced.ok) ctx.diag.add("unterminated_braced_value", pos, { action: "recovered_parse" });
	ctx.i = braced.end;
	const m = /^([A-Za-z_$][\w$]*)\s*([\s\S]*)$/.exec(braced.inner.slice(1).trim());
	if (!m || !BLOCK_OPEN.has(m[1])) {
		ctx.diag.add("unknown_block", pos, {
			action: "dropped",
			directive: m ? m[1] : ""
		});
		return null;
	}
	return m[1] === "if" ? readIf(ctx, closeTag, pos, m[2].trim()) : readEach(ctx, closeTag, pos, m[2].trim());
}
function readIf(ctx, closeTag, pos, firstCond) {
	const node = {
		type: "if",
		pos,
		branches: []
	};
	let cond = firstCond;
	for (;;) {
		const branch = parseNodes(ctx, closeTag);
		node.branches.push({
			cond,
			body: mergeText(branch.nodes)
		});
		if (branch.terminator === "else") {
			ctx.i += branch.length;
			cond = branch.cond != null ? branch.cond : null;
			continue;
		}
		closeBlock(ctx, branch, "if", pos);
		return node;
	}
}
function readEach(ctx, closeTag, pos, head) {
	const parts = splitEachClause(head);
	if (!parts) ctx.diag.add("malformed_each", pos, { action: "recovered_parse" });
	const body = parseNodes(ctx, closeTag);
	closeBlock(ctx, body, "each", pos);
	return {
		type: "each",
		pos,
		list: parts ? parts.list : "[]",
		item: parts ? parts.item : "item",
		body: mergeText(body.nodes)
	};
}
function closeBlock(ctx, result, directive, pos) {
	if (result.terminator === "close") {
		ctx.i += result.length;
		if (result.name !== directive) ctx.diag.add("mismatched_block_close", pos, {
			expected: directive,
			found: result.name,
			action: "recovered_parse"
		});
	} else ctx.diag.add("unclosed_block", pos, {
		directive,
		action: "recovered_parse"
	});
}
function parseElement(ctx) {
	const { src } = ctx;
	const pos = ctx.i;
	const nameMatch = TAG_NAME.exec(src.slice(pos + 1));
	if (!nameMatch) {
		ctx.i++;
		return null;
	}
	const name = nameMatch[0];
	const { attrs, end, selfClosing, open } = readAttributes(ctx, name, pos + 1 + name.length);
	if (!open && !selfClosing) {
		ctx.diag.add("unterminated_tag", pos, {
			tag: name,
			action: "recovered_parse"
		});
		ctx.i = src.length;
		return {
			type: "element",
			name,
			attrs,
			children: [],
			pos,
			end: src.length,
			closed: false
		};
	}
	ctx.i = end;
	if (selfClosing) return {
		type: "element",
		name,
		attrs,
		children: [],
		pos,
		end,
		closed: true
	};
	if (RAW_TEXT.has(name)) return readRawText(ctx, name, attrs, pos);
	const inner = parseNodes(ctx, name);
	const closed = inner.terminator === "close";
	if (!closed) ctx.diag.add("unclosed_tag", pos, {
		tag: name,
		action: "recovered_parse"
	});
	return {
		type: "element",
		name,
		attrs,
		children: mergeText(inner.nodes),
		pos,
		end: ctx.i,
		closed
	};
}
/** Everything up to `</name>` is one text node (entities decoded). */
function readRawText(ctx, name, attrs, pos) {
	const { src } = ctx;
	const close = src.indexOf(`</${name}>`, ctx.i);
	const end = close < 0 ? src.length : close;
	const value = decodeEntities(src.slice(ctx.i, end));
	const children = value ? [{
		type: "text",
		value,
		pos: ctx.i,
		raw: true
	}] : [];
	if (close < 0) {
		ctx.diag.add("unclosed_tag", pos, {
			tag: name,
			action: "recovered_parse"
		});
		ctx.i = src.length;
		return {
			type: "element",
			name,
			attrs,
			children,
			pos,
			end: src.length,
			closed: false
		};
	}
	ctx.i = close + name.length + 3;
	return {
		type: "element",
		name,
		attrs,
		children,
		pos,
		end: ctx.i,
		closed: true
	};
}
/**
* Attribute forms: `name="str"`, `name={expr}`, `name=raw`, bare `name` (true).
* Returns at `>` / `/>`, or at EOF with neither flag set.
*/
function readAttributes(ctx, tag, i) {
	const { src } = ctx;
	const attrs = [];
	const skipWs = (j) => j + /^\s*/.exec(src.slice(j))[0].length;
	while (i < src.length) {
		i = skipWs(i);
		if (src.startsWith("/>", i)) return {
			attrs,
			end: i + 2,
			selfClosing: true,
			open: false
		};
		if (src[i] === ">") return {
			attrs,
			end: i + 1,
			selfClosing: false,
			open: true
		};
		if (i >= src.length) break;
		const am = ATTR_NAME.exec(src.slice(i));
		if (!am) {
			ctx.diag.add("malformed_attribute", i, {
				tag,
				action: "recovered_parse"
			});
			i++;
			continue;
		}
		const name = am[0];
		const afterName = skipWs(i + name.length);
		if (src[afterName] !== "=") {
			attrs.push({
				name,
				kind: "boolean",
				value: true,
				pos: i
			});
			i = afterName;
			continue;
		}
		const j = skipWs(afterName + 1);
		const q = src[j];
		if (q === "\"" || q === "'") {
			let k = j + 1;
			let value = "";
			while (k < src.length && src[k] !== q) {
				if (src[k] === "\\") {
					value += src[k] + (src[k + 1] || "");
					k += 2;
					continue;
				}
				value += src[k];
				k++;
			}
			if (k >= src.length) ctx.diag.add("unterminated_string", j, {
				tag,
				action: "recovered_parse"
			});
			attrs.push({
				name,
				kind: "string",
				value,
				pos: j
			});
			i = Math.min(k + 1, src.length);
		} else if (q === "{") {
			const braced = readBalanced(src, j);
			if (!braced.ok) ctx.diag.add("unterminated_braced_value", j, {
				tag,
				action: "recovered_parse"
			});
			attrs.push({
				name,
				kind: "expr",
				value: braced.inner.trim(),
				pos: j
			});
			i = braced.end;
		} else {
			const raw = (/^[^\s/>]+/.exec(src.slice(j)) || [""])[0];
			attrs.push({
				name,
				kind: "raw",
				value: raw,
				pos: j
			});
			i = j + raw.length;
		}
	}
	return {
		attrs,
		end: src.length,
		selfClosing: false,
		open: false
	};
}
/**
* Text is JSX-like, so models sometimes escape it as HTML (`Usage &amp; Billing`).
* Decode the common entities; the renderer only ever sets text, never HTML, so the
* decoded characters are safe.
*/
const ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: "\"",
	apos: "'",
	nbsp: "\xA0",
	"#39": "'"
};
function decodeEntities(s) {
	return s.indexOf("&") < 0 ? s : s.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, k) => ENTITIES[k] ?? "");
}
/**
* Merge adjacent text runs (one constant per run, like the real compiler) and drop
* layout whitespace between elements — whitespace-only runs that span a newline.
*/
function mergeText(nodes) {
	const out = [];
	for (const n of nodes) {
		if (n.type === "text" && /^\s*$/.test(n.value) && n.value.includes("\n")) continue;
		const prev = out[out.length - 1];
		if (n.type === "text" && prev && prev.type === "text") prev.value += n.value;
		else out.push(n);
	}
	return out;
}
//#endregion
//#region src/dil/compiler/components.ts
/**
* The compiler's view of the component vocabulary.
*
*   intrinsic  lowercase tags rendered by the host renderer (`box`, `chart`, …)
*   shim       PascalCase tags the compiler lowers itself (`<Chart content>`)
*   host       any other PascalCase tag: resolved by the host through
*              `appData.opGenui.componentResults[__resolutionId]`
*
* Ported from `vendor/dil-replica/replica/server/compiler/components.js` (MIT,
* Disdjj/intelligent-ui-demo @938ab09) — behaviour unchanged.
* @module dsh-genui/dil/compiler/components
*/
const INTRINSIC = /* @__PURE__ */ new Set([
	"box",
	"row",
	"column",
	"grid",
	"grid-item",
	"card",
	"divider",
	"spacer",
	"text",
	"title",
	"caption",
	"bold",
	"label",
	"code",
	"icon",
	"badge",
	"button",
	"input",
	"textarea",
	"checkbox",
	"radio",
	"radio-group",
	"select",
	"slider",
	"segmented-control",
	"table",
	"table-row",
	"table-cell",
	"list",
	"list-item",
	"progress",
	"chart",
	"pie-chart",
	"image",
	"link"
]);
function isIntrinsic(name) {
	return INTRINSIC.has(name) || /^[a-z][a-z0-9-]*$/.test(name);
}
/** Tags the compiler rewrites itself → the function the generated code calls. */
const SHIMS = { Chart: {
	fn: "DilChartContentPropShim",
	source: `function DilChartContentPropShim({content=undefined,fallback=null}){
const c = __dilSafe(()=>(content ?? {}),{});
const data = __dilSafe(()=>(Array.isArray(c.data) && c.data.every(r=>r && typeof r==="object" && !Array.isArray(r)) ? c.data : []),[]);
const valid = __dilSafe(()=>(["bar","line","pie","scatter"].includes(c.chartType) && data.length>0),false);
const raw = __dilSafe(()=>(Array.isArray(c.series) ? c.series.filter(s=>s && typeof s.dataKey==="string") : []),[]);
const series = __dilSafe(()=>((raw.length ? raw : [{dataKey:"value"}]).map(s=>({type:c.chartType,dataKey:s.dataKey,label:s.label ?? s.dataKey,stack:s.stack,valuePrefix:s.valuePrefix,valueSuffix:s.valueSuffix}))),[]);
const xKey = __dilSafe(()=>(typeof c.xKey==="string" ? c.xKey : "name"),"name");
const vertical = __dilSafe(()=>(c.chartType==="bar" && c.layout==="vertical"),false);
if (!valid) return fallback;
const meta = c.meta || {};
return __dil.jsx("card",{"gap":3},
typeof meta.title==="string" ? __dil.jsx("title",{"size":"sm"},meta.title) : null,
typeof meta.description==="string" ? __dil.jsx("text",{"size":"sm","color":"secondary"},meta.description) : null,
c.chartType==="pie"
  ? __dil.jsx("pie-chart",{"data":data,"series":[{dataKey:typeof c.valueKey==="string"?c.valueKey:"value",label:(raw[0]||{}).label,valuePrefix:(raw[0]||{}).valuePrefix}],"xAxis":typeof c.nameKey==="string"?c.nameKey:xKey,"height":240})
  : __dil.jsx("chart",{"data":data,"series":series,"xAxis":{dataKey:xKey},"layout":vertical?"vertical":"horizontal","height":vertical&&data.length>9?64+data.length*24:240,"showDots":c.chartType==="line"&&data.length<=40}),
typeof meta.footer==="string" ? __dil.jsx("text",{"size":"sm","color":"tertiary"},meta.footer) : null);
}`
} };
function kindOf(name) {
	if (SHIMS[name]) return "shim";
	return isIntrinsic(name) ? "intrinsic" : "host";
}
/** `genui_components[].type` as labelled in the captured stream. */
const WIDGET_TYPES = {
	Chart: "charts_widget_v2",
	MemoryCite: "memory_cite"
};
function widgetType(name) {
	return WIDGET_TYPES[name] || name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
/**
* A deterministic, UUID-shaped resolution id for the n-th host component. The real
* server mints one when it resolves the component (`component_resolution_id`).
*/
function resolutionId(name, index) {
	let h1 = 2166136261;
	let h2 = 16777619;
	const s = `${name}#${index}`;
	for (let i = 0; i < s.length; i++) {
		h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619) >>> 0;
		h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519) >>> 0;
	}
	const hex = (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(2);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
//#endregion
//#region src/dil/compiler/validate.ts
/**
* Syntax validation of model-written JavaScript fragments.
*
* The program is evaluated as one unit (`new Function(program)`), so a single
* unparsable fragment anywhere — `<code>a := b</code>` read as DIL, an unclosed
* object literal — fails the *whole* interface on every recompile. Checking each
* fragment here, and replacing the bad ones with a safe placeholder, turns that
* into one missing value.
*
* Only *compiles* the fragment (vm.Script with a wrapper); nothing is executed.
*
* Ported from `vendor/dil-replica/replica/server/compiler/validate.js` (MIT,
* Disdjj/intelligent-ui-demo @938ab09) — behaviour unchanged.
* @module dsh-genui/dil/compiler/validate
*/
const cache = /* @__PURE__ */ new Map();
const CACHE_LIMIT = 4e3;
function parses(wrapped) {
	const cached = cache.get(wrapped);
	if (cached !== void 0) return cached;
	let ok = true;
	try {
		new Script(`(function(){${wrapped}\n})`);
	} catch {
		ok = false;
	}
	if (cache.size > CACHE_LIMIT) cache.clear();
	cache.set(wrapped, ok);
	return ok;
}
/** An expression usable as `(${code})`. */
function isExpression(code) {
	return parses(`return (${code}\n);`);
}
/** A statement usable inside the render function body. */
function isStatement(code) {
	return parses(`${code}\n;`);
}
/** The finished program, as the sandbox will evaluate it. */
function isProgram(code) {
	return parses(code);
}
//#endregion
//#region src/dil/compiler/codegen.ts
/**
* AST → JavaScript, in the shape of the captured artifact:
*
*   - every text run goes to a constant pool, referenced as `__dilConstants["n"]`
*   - every expression is wrapped in `__dilSafe(() => expr, fallback)`, so one bad
*     expression degrades locally instead of blanking the whole interface
*   - elements become `__dil.jsx(tag, props, ...children)`
*
* Host components are emitted as a *string* tag plus a `__resolutionId` prop. The real
* compiler emits a bare identifier and injects the resolved function into the sandbox;
* the replica lets the host renderer resolve the name instead. Same fallback
* behaviour, far less machinery.
*
* Ported from `vendor/dil-replica/replica/server/compiler/codegen.js` (MIT,
* Disdjj/intelligent-ui-demo @938ab09) — behaviour unchanged.
* @module dsh-genui/dil/compiler/codegen
*/
/** A JSON-parseable object/array literal can go to the constant pool (no eval). */
function hoistable(expr) {
	const t = expr.trim();
	if (t.length < 24 || !(t.startsWith("[") || t.startsWith("{"))) return false;
	try {
		const v = JSON.parse(t);
		return v != null && typeof v === "object";
	} catch {
		return false;
	}
}
function createGenerator() {
	const invalid = [];
	/** The expression itself, or `fallback` if it is not valid JavaScript. */
	const expr = (code, pos, fallback = "undefined") => {
		if (isExpression(code)) return code;
		invalid.push({
			code: "invalid_expression",
			action: "replaced",
			pos: pos ?? 0,
			snippet: code.slice(0, 80)
		});
		return fallback;
	};
	const constants = {};
	let constSeq = 0;
	const components = /* @__PURE__ */ new Set();
	const shims = /* @__PURE__ */ new Set();
	const resolutions = {};
	let hostSeq = 0;
	const constant = (value) => {
		const key = String(constSeq++);
		constants[key] = value;
		return `__dilConstants[${JSON.stringify(key)}]`;
	};
	const gen = (node) => {
		switch (node.type) {
			case "text": return constant(node.value);
			case "expr": return `__dilSafe(()=>(${expr(node.code, node.pos, "null")}),null)`;
			case "if": return genIf(node);
			case "each": {
				const body = genBranch(node.body);
				return `__dilSafe(()=>((${expr(node.list, node.pos, "[]")}).map((${/^[A-Za-z_$][\w$]*$|^[[{][\s\S]*[\]}]$/.test(node.item.trim()) ? node.item : "item"})=>__dilSafe(()=>(${body}),null))),null)`;
			}
			case "element": return genElement(node);
			default: return "";
		}
	};
	const genIf = (node) => {
		let out = "null";
		for (let i = node.branches.length - 1; i >= 0; i--) {
			const b = node.branches[i];
			const body = genBranch(b.body);
			out = b.cond == null ? body : `(__dilSafe(()=>(${expr(b.cond, node.pos, "false")}),false))?${body}:${out}`;
		}
		return out;
	};
	const genBranch = (nodes) => {
		const kids = nodes.map(gen).filter(Boolean);
		if (!kids.length) return "null";
		if (kids.length === 1) return kids[0];
		return `__dil.jsx(__dil.Fragment,null,${kids.join(",")})`;
	};
	/** Can evaluating this attribute throw? JSON literals (`{3}`, `{true}`, `{[…]}`) cannot. */
	const isDynamic = (attr) => {
		if (attr.kind !== "expr" && attr.kind !== "raw") return false;
		try {
			JSON.parse(attr.value.trim());
			return false;
		} catch {
			return true;
		}
	};
	const genProp = (attr, kind) => {
		const key = JSON.stringify(attr.name);
		switch (attr.kind) {
			case "boolean": return `${key}:true`;
			case "string": return `${key}:${JSON.stringify(attr.value)}`;
			case "raw": return `${key}:${expr(attr.value, attr.pos)}`;
			default: {
				const value = expr(attr.value.trim() || "undefined", attr.pos);
				if (kind === "shim") return `${key}:__dilSafe(()=>(${value}),void 0)`;
				return `${key}:${hoistable(value) ? constant(JSON.parse(value)) : value}`;
			}
		}
	};
	const genElement = (node) => {
		const kind = kindOf(node.name);
		const props = [];
		if (kind === "shim") shims.add(node.name);
		if (kind === "host") {
			components.add(node.name);
			const id = resolutionId(node.name, hostSeq++);
			resolutions[id] = {
				status: "resolved",
				state: {},
				componentName: node.name
			};
			props.push(`"__resolutionId":${constant(id)}`);
		}
		for (const a of node.attrs) props.push(genProp(a, kind));
		const tag = kind === "shim" ? SHIMS[node.name].fn : JSON.stringify(node.name);
		const guarded = kind !== "intrinsic" || node.attrs.some(isDynamic) || node.children.some((c) => c.type === "expr");
		const kids = node.children.map((c) => guarded && c.type === "expr" ? `(${expr(c.code, c.pos, "null")})` : gen(c)).filter(Boolean);
		const call = `__dil.jsx(${[
			tag,
			props.length ? `{${props.join(",")}}` : "null",
			...kids
		].join(",")})`;
		return guarded ? `__dilSafe(()=>(${call}),null)` : call;
	};
	return { generate(nodes) {
		return {
			tree: genBranch(nodes),
			constants,
			components: [...components],
			shimSources: [...shims].map((name) => SHIMS[name].source),
			resolutions,
			invalid
		};
	} };
}
//#endregion
//#region src/dil/compiler/statements.ts
/**
* What the compiler does to each `{@body …}` statement before hoisting it into the
* render function — matching the captured artifact:
*
*   const [tab,setTab] = DIL.useState("overview")
*     → const [tab,setTab] = DIL.useState("overview",{key:"tab"})
*   const n = period==="7"?7:12
*     → const n = __dilSafe(()=>(period==="7"?7:12),undefined)
*
* The state variable's name becomes its *semantic key*: the address under which the
* value is reported to `/dil/view_state` and fed back to the model next turn. Plain
* declarations get the same per-expression guard as the tree, so one bad derived
* value degrades to `undefined` instead of killing the render.
*
* Ported from `vendor/dil-replica/replica/server/compiler/statements.js` (MIT,
* Disdjj/intelligent-ui-demo @938ab09) — behaviour unchanged.
* @module dsh-genui/dil/compiler/statements
*/
const USE_STATE_DECL = /^(const|let|var)\s+\[\s*([A-Za-z_$][\w$]*)\s*(?:,\s*[A-Za-z_$][\w$]*\s*)?\]\s*=\s*DIL\.useState\s*\(/;
const PLAIN_DECL = /^(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/;
/** One `{@body}` may hold several statements; split at top-level `;`. */
function splitStatements(code) {
	const out = [];
	let start = 0;
	for (let i = topLevelIndex(code, ";"); i >= 0; i = topLevelIndex(code, ";", start)) {
		out.push(code.slice(start, i));
		start = i + 1;
	}
	out.push(code.slice(start));
	return out.map((s) => s.trim()).filter(Boolean);
}
function rewriteStatement(code) {
	const src = code.trim().replace(/;\s*$/, "");
	const us = USE_STATE_DECL.exec(src);
	if (us) {
		const open = us[0].length - 1;
		const args = readBalanced(src, open, "(", ")");
		if (!args.ok || topLevelIndex(args.inner, ",") >= 0) return src;
		const init = args.inner.trim() || "undefined";
		return `${src.slice(0, open)}(${init},{key:${JSON.stringify(us[2])}})${src.slice(args.end)}`;
	}
	const pd = PLAIN_DECL.exec(src);
	if (pd) {
		const rhs = src.slice(pd[0].length).trim();
		if (!rhs || /^DIL\./.test(rhs)) return src;
		if (topLevelIndex(rhs, ",") >= 0 || topLevelIndex(rhs, ";") >= 0) return src;
		return `${pd[1]} ${pd[2]} = __dilSafe(()=>(${rhs}),undefined)`;
	}
	if (/^(const|let|var|function|async\s+function|class|if|for|while|switch|try|return)\b/.test(src)) return src;
	return `try{${src}}catch{}`;
}
/** The `useState` keys a list of statements declares, in order. */
function stateKeysOf(statements) {
	return statements.map((s) => USE_STATE_DECL.exec(s)).filter(Boolean).map((m) => m[2]);
}
//#endregion
//#region src/dil/compiler/fallback.ts
function toFallback(nodes, ctx = { listDepth: 0 }) {
	const out = [];
	for (const node of nodes) {
		if (node.type === "text") {
			out.push(node.value);
			continue;
		}
		if (node.type === "if") {
			const first = node.branches[0];
			if (first) out.push(toFallback(first.body, ctx));
			continue;
		}
		if (node.type === "each") {
			out.push(toFallback(node.body, ctx));
			continue;
		}
		if (node.type === "expr") {
			out.push(`{${node.code}}`);
			continue;
		}
		if (node.type !== "element") continue;
		out.push(elementFallback(node, ctx));
	}
	return out.join("").replace(/\n{3,}/g, "\n\n");
}
function elementFallback(node, ctx) {
	const inner = () => toFallback(node.children, ctx).trim();
	switch (node.name) {
		case "title": return `\n\n## ${inner()}\n\n`;
		case "caption": return `\n${inner()}\n`;
		case "badge": return ` ${inner()} `;
		case "button": return ` [${inner()}]`;
		case "divider": return "\n\n---\n\n";
		case "list": return `\n${toFallback(node.children, ctx)}\n`;
		case "list-item": return `\n${"  ".repeat(ctx.listDepth)}- ${inner()}`;
		case "table-row": return `| ${columnize(node)} |`;
		case "chart":
		case "pie-chart":
		case "Chart": return "\n[图表：当前环境不支持渲染]\n";
		case "icon": return "";
		case "select":
		case "segmented-control": {
			const opts = readOptions(node);
			return opts ? `\n${opts.map((o) => `- ${o.label}`).join("\n")}\n当前所选项不可用。\n` : inner();
		}
		default: return inner();
	}
}
/**
* Projection leaves debris (headings whose content was dynamic, rows of empty cells).
* Drop lines with no letters or digits, keeping list bullets and rules.
*/
function tidyFallback(md) {
	const hasWord = (s) => /[\p{L}\p{N}]/u.test(s);
	return md.split("\n").map((l) => l.trim()).filter((l) => {
		if (!l) return false;
		if (/^#{1,6}\s*$/.test(l)) return false;
		if (/^#{1,6}\s/.test(l) && !hasWord(l.replace(/^#+\s*/, ""))) return false;
		if (l.startsWith("|")) {
			if (!l.replace(/^\|/, "").replace(/\|$/, "").split("|").some(hasWord)) return false;
		}
		return hasWord(l) || /^[-*]\s/.test(l) || l === "---";
	}).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function columnize(row) {
	return row.children.filter((c) => c.type === "element" && c.name === "table-cell").map((c) => toFallback(c.children, { listDepth: 0 }).trim()).join(" | ");
}
/** `options={[…]}` when it is a JSON literal; dynamic options cannot be projected. */
function readOptions(node) {
	const attr = node.attrs.find((a) => a.name === "options");
	if (!attr || attr.kind !== "expr") return null;
	try {
		const v = JSON.parse(attr.value.trim());
		if (Array.isArray(v)) return v.map((o) => ({
			label: String(o.label ?? o.value ?? ""),
			value: o.value
		}));
	} catch {}
	return null;
}
//#endregion
//#region src/dil/compiler/genui-components.ts
/**
* `genui_components` — source spans of widget-channel components, exactly as the
* captured stream labels them:
*
*   {"type":"charts_widget_v2","tree_range":[58,59],"start_index":8021,"end_index":8039}
*
* Offsets are Unicode code points, not UTF-16 units (the capture's 8021 is 8024 as a
* JS string index because of three astral emoji earlier in the document). While a tag
* is still being written its end is the end of the source so far, so `end_index`
* grows from patch to patch and `streaming` marks it unfinished.
*
* `tree_range` is the element's [pre-order index, +1) among all elements.
*
* Ported from `vendor/dil-replica/replica/server/compiler/genui-components.js` (MIT,
* Disdjj/intelligent-ui-demo @938ab09) — behaviour unchanged.
* @module dsh-genui/dil/compiler/genui-components
*/
function genuiComponents(nodes, source, resolutionIds) {
	const cp = codePointIndexer(source);
	const out = [];
	let index = 0;
	let hostSeq = 0;
	const visit = (list) => {
		for (const n of list) {
			if (n.type === "if") {
				n.branches.forEach((b) => visit(b.body));
				continue;
			}
			if (n.type === "each") {
				visit(n.body);
				continue;
			}
			if (n.type !== "element") continue;
			const at = index++;
			const kind = kindOf(n.name);
			if (kind !== "intrinsic") {
				const c = {
					type: widgetType(n.name),
					tree_range: [at, at + 1],
					start_index: cp(n.pos),
					end_index: cp(n.end)
				};
				if (kind === "host") c.component_resolution_id = resolutionIds[hostSeq++];
				if (!n.closed) c.streaming = true;
				out.push(c);
			}
			visit(n.children);
		}
	};
	visit(nodes);
	return out;
}
//#endregion
//#region src/dil/compiler/markdown.ts
const HEADING = /^(#{1,6})\s+(.*)$/;
const ORDERED = /^\d+[.)]\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;
const FENCE = /^```[\w-]*$/;
/** Inline markdown → array of text nodes and `bold` / `code` elements. */
function inline(text, pos) {
	const out = [];
	const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
	let last = 0;
	let m;
	while (m = re.exec(text)) {
		if (m.index > last) out.push({
			type: "text",
			value: text.slice(last, m.index),
			pos
		});
		const name = m[1] != null ? "bold" : "code";
		out.push(el(name, [{
			type: "text",
			value: m[1] != null ? m[1] : m[2],
			pos
		}], pos));
		last = re.lastIndex;
	}
	if (last < text.length) out.push({
		type: "text",
		value: text.slice(last),
		pos
	});
	return out;
}
function el(name, children, pos, attrs = []) {
	return {
		type: "element",
		name,
		attrs,
		children,
		pos,
		end: pos,
		closed: true,
		synthetic: true
	};
}
const attr = (name, value) => ({
	name,
	kind: "string",
	value
});
/**
* Lower one prose text run into block elements. Consecutive non-blank lines form a
* paragraph; list items group into one list; headings and rules stand alone.
*/
function lowerBlock(text, pos) {
	const out = [];
	let para = [];
	let list = null;
	const flushPara = () => {
		if (para.length) out.push(el("text", inline(para.join(" "), pos), pos));
		para = [];
	};
	const flushList = () => {
		if (list) out.push(list.node);
		list = null;
	};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) {
			flushPara();
			flushList();
			continue;
		}
		if (FENCE.test(line)) {
			flushPara();
			flushList();
			continue;
		}
		const heading = HEADING.exec(line);
		const ordered = heading ? null : ORDERED.exec(line);
		const bullet = heading || ordered ? null : BULLET.exec(line);
		if (heading) {
			flushPara();
			flushList();
			const size = heading[1].length <= 2 ? "lg" : "md";
			out.push(el("title", inline(heading[2], pos), pos, [attr("size", size)]));
		} else if (RULE.test(line)) {
			flushPara();
			flushList();
			out.push(el("divider", [], pos));
		} else if (ordered || bullet) {
			flushPara();
			const marker = ordered ? "number" : "bullet";
			if (!list || list.marker !== marker) {
				flushList();
				list = {
					marker,
					node: el("list", [], pos, marker === "number" ? [attr("marker", "number")] : [])
				};
			}
			list.node.children.push(el("list-item", [el("text", inline((ordered ?? bullet)[1], pos), pos)], pos));
		} else {
			flushList();
			para.push(line);
		}
	}
	flushPara();
	flushList();
	return out;
}
/**
* Walk the AST.
*
*   document level  (root, and if/each bodies at root) — prose becomes blocks
*   inside elements — only inline `**bold**` / `code` is lowered, and only when the
*                     run has block syntax on its own lines is it split into blocks.
*                     Wrapping every run would break `count: {n}`, whose text and
*                     expression must stay one flow inside a flex container.
*/
function lowerMarkdown(nodes, { document = true } = {}) {
	if (document) return lowerDocument(nodes);
	const out = [];
	for (const n of nodes) if (n.type === "text") {
		if (n.raw || !/\S/.test(n.value)) out.push(n);
		else if (hasBlockSyntax(n.value)) out.push(...lowerBlock(n.value, n.pos));
		else out.push(...inline(n.value, n.pos));
	} else out.push(lowerChildren(n, false));
	return out;
}
/**
* At document level, a paragraph can be several AST nodes: `本月 {n} 次` is text +
* expr + text. Gather each run of inline nodes up to a blank line or a block node,
* lower the text parts, and keep the expressions in place inside one `<text>`.
*/
function lowerDocument(nodes) {
	const out = [];
	let run = [];
	const flushRun = () => {
		if (!run.length) return;
		if (!run.some((n) => n.type === "expr")) out.push(...lowerBlock(run.map((n) => n.type === "text" ? n.value : "").join(""), run[0].pos));
		else {
			const parts = [];
			for (const n of run) parts.push(...n.type === "text" ? inline(n.value.replace(/\s*\n\s*/g, " "), n.pos) : [n]);
			out.push(el("text", parts, run[0].pos));
		}
		run = [];
	};
	for (const n of nodes) {
		if (n.type === "expr") {
			run.push(n);
			continue;
		}
		if (n.type === "text") {
			n.value.split(/\n\s*\n/).forEach((piece, i) => {
				if (i > 0) flushRun();
				if (hasBlockSyntax(piece)) {
					flushRun();
					out.push(...lowerBlock(piece, n.pos));
					return;
				}
				if (/\S/.test(piece)) run.push({
					...n,
					value: piece
				});
			});
			continue;
		}
		flushRun();
		out.push(lowerChildren(n, true));
	}
	flushRun();
	return out;
}
function lowerChildren(n, document) {
	if (n.type === "if") return {
		...n,
		branches: n.branches.map((b) => ({
			...b,
			body: lowerMarkdown(b.body, { document })
		}))
	};
	if (n.type === "each") return {
		...n,
		body: lowerMarkdown(n.body, { document })
	};
	if (n.type === "element" && !n.synthetic) return {
		...n,
		children: lowerMarkdown(n.children, { document: false })
	};
	return n;
}
/** A line that is a heading, list item or rule on its own. */
function hasBlockSyntax(value) {
	return value.split("\n").some((l) => {
		const t = l.trim();
		return HEADING.test(t) || ORDERED.test(t) || BULLET.test(t);
	});
}
//#endregion
//#region src/dil/compiler/repair.ts
/**
* Repairs for the two mistakes models make most often, applied before codegen.
* Each one is recorded as a diagnostic so the developer panel shows what was fixed.
*
* 1. Undeclared controlled state.
*      <segmented-control value={usage} onChange={setUsage} options={…}/>
*    with no `{@body const [usage,setUsage] = DIL.useState(…)}` anywhere. Without a
*    repair the control is dropped (its props throw). The pair `x` / `setX` is
*    unambiguous, so declare it, seeding the initial value from the control itself:
*    the first option, a slider's `min`, an unchecked checkbox, an empty input.
*
* 2. Markdown code fences around the whole document (```html … ```). The markup
*    inside parses fine; the fence lines would render as literal backticks. They are
*    dropped during markdown lowering (see markdown.js); here we only report them.
*
* Ported from `vendor/dil-replica/replica/server/compiler/repair.js` (MIT,
* Disdjj/intelligent-ui-demo @938ab09) — behaviour unchanged, except that the two
* seed fallbacks that used to return a raw boolean now stringify it: they are
* interpolated into generated source, where `true` and `'true'` are the same text.
* @module dsh-genui/dil/compiler/repair
*/
const IDENT = /^[A-Za-z_$][\w$]*$/;
/** Every identifier a set of statements declares (`const a`, `[a,setA]`, `function f`). */
function declaredNames(statements) {
	const names = /* @__PURE__ */ new Set();
	for (const s of statements) {
		let m;
		const destructure = /^(?:const|let|var)\s+\[([^\]]*)\]/.exec(s);
		if (destructure) destructure[1].split(",").map((x) => x.trim()).filter(Boolean).forEach((n) => names.add(n));
		const re = /(?:^|[;\s])(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
		while (m = re.exec(s)) names.add(m[1]);
	}
	return names;
}
/** Initial value for a control whose state was never declared. */
function seedFor(node) {
	const attr = (name) => node.attrs.find((a) => a.name === name);
	const options = attr("options");
	if (options && options.kind === "expr") try {
		const list = JSON.parse(options.value);
		if (Array.isArray(list) && list.length) {
			const first = list[0];
			return JSON.stringify(first && typeof first === "object" ? first.value ?? first.label : first);
		}
	} catch {
		const o = `(${options.value})`;
		return `__dilSafe(()=>(${o}[0]?.value ?? ${o}[0]),"")`;
	}
	if (node.name === "checkbox" || node.name === "switch") return "false";
	if (node.name === "slider") {
		const min = attr("min");
		return min ? min.kind === "string" ? JSON.stringify(Number(min.value)) : String(min.value) : "0";
	}
	if (node.name === "radio-group") {
		const radio = node.children.find((c) => c.type === "element" && c.name === "radio");
		const v = radio && radio.attrs.find((a) => a.name === "value");
		if (v) return v.kind === "string" ? JSON.stringify(v.value) : String(v.value);
	}
	return "\"\"";
}
function controlPairs(nodes, out = []) {
	for (const n of nodes) {
		if (n.type === "if") {
			n.branches.forEach((b) => controlPairs(b.body, out));
			continue;
		}
		if (n.type === "each") {
			controlPairs(n.body, out);
			continue;
		}
		if (n.type !== "element") continue;
		const value = n.attrs.find((a) => (a.name === "value" || a.name === "checked") && a.kind === "expr");
		const change = n.attrs.find((a) => a.name === "onChange" && a.kind === "expr");
		if (value && change) {
			const v = value.value.trim();
			const setter = change.value.trim();
			if (IDENT.test(v) && setter === "set" + v[0].toUpperCase() + v.slice(1)) out.push({
				name: v,
				setter,
				node: n
			});
		}
		controlPairs(n.children, out);
	}
	return out;
}
function repairUndeclaredState(nodes, statements) {
	const declared = declaredNames(statements);
	const added = [];
	const repairs = [];
	for (const { name, setter, node } of controlPairs(nodes)) {
		if (declared.has(name) || declared.has(setter)) continue;
		declared.add(name);
		declared.add(setter);
		const seed = seedFor(node);
		added.push(`const [${name},${setter}] = DIL.useState(${isExpression(seed) ? seed : "\"\""})`);
		repairs.push({
			code: "implicit_state",
			action: "declared",
			name,
			tag: node.name,
			pos: node.pos
		});
	}
	return {
		statements: added,
		repairs
	};
}
/** ` ```html ` style fence lines in top-level prose — reported, dropped in lowering. */
function findFences(nodes) {
	const out = [];
	for (const n of nodes) {
		if (n.type !== "text") continue;
		const re = /^[ \t]*```[\w-]*[ \t]*$/gm;
		let m;
		while (m = re.exec(n.value)) out.push({
			code: "stripped_code_fence",
			action: "dropped",
			pos: n.pos + m.index
		});
	}
	return out;
}
const SAFE_PRELUDE = "function __dilSafe(evaluate,failureValue){try{return evaluate()}catch{return failureValue}}";
/** `clean`, or `code×n` pairs — the one-line form the UI shows. */
function summarize(diagnostics) {
	if (!diagnostics.length) return "clean";
	const counts = /* @__PURE__ */ new Map();
	for (const d of diagnostics) counts.set(d.code, (counts.get(d.code) || 0) + 1);
	return [...counts].map(([k, v]) => `${k}×${v}`).join(" ");
}
function compile(source, options = {}) {
	const t0 = Date.now();
	const { nodes, diagnostics: parseDiagnostics } = parse(source);
	const diagnostics = [...parseDiagnostics];
	const lowered = lowerMarkdown(nodes);
	const { tree, constants, components, shimSources, resolutions, invalid } = createGenerator().generate(lowered);
	const declared = nodes.filter((n) => n.type === "stmt").flatMap((n) => splitStatements(n.code));
	const implicit = repairUndeclaredState(nodes, declared.filter((c) => isStatement(rewriteStatement(c))));
	const stmtNodes = nodes.filter((n) => n.type === "stmt");
	const dropped = [];
	const valid = declared.filter((code) => {
		if (isStatement(rewriteStatement(code))) return true;
		const owner = stmtNodes.find((n) => n.code.includes(code.slice(0, 40))) || stmtNodes[0];
		dropped.push({
			code: "invalid_statement",
			action: "dropped",
			pos: owner ? owner.pos : 0,
			snippet: code.slice(0, 80)
		});
		return false;
	});
	const statements = [...implicit.statements, ...valid];
	for (const r of [
		...implicit.repairs,
		...findFences(nodes),
		...dropped,
		...invalid
	]) {
		const { pos, ...rest } = r;
		diagnostics.push({
			...rest,
			...lineCol(source, pos)
		});
	}
	const body = [
		"const __dilConstants=DIL.useConstants();",
		"const __dilModelDataBindings=DIL.useAppData((appData)=>appData.opGenui?.modelDataBindings??{});",
		...statements.map((s) => `${rewriteStatement(s)};`),
		`return ${tree};`
	].join("\n");
	let code = [
		SAFE_PRELUDE,
		...shimSources,
		`DIL.render(__dil.jsx(()=>{\n${body}\n},{"key":"body:0"}));`
	].join("\n\n");
	if (!isProgram(code)) {
		diagnostics.push({
			code: "invalid_program",
			action: "fallback",
			line: 1,
			column: 1
		});
		code = `${SAFE_PRELUDE}\n\nDIL.render(__dil.jsx(()=>__dil.jsx("text",null,${JSON.stringify(tidyFallback(toFallback(nodes)))}),{"key":"body:0"}));`;
	}
	return {
		ok: diagnostics.length === 0,
		protocolVersion: 1,
		source,
		sourceLength: source.length,
		code,
		codeLength: code.length,
		constants,
		constantCount: Object.keys(constants).length,
		requiredComponents: components,
		appData: { opGenui: {
			componentResults: resolutions,
			modelDataBindings: options.modelDataBindings || {}
		} },
		genuiComponents: genuiComponents(lowered, source, Object.keys(resolutions)),
		stateKeys: stateKeysOf(statements),
		fallbackMarkdown: tidyFallback(toFallback(nodes)),
		diagnostics,
		diagnosticSummary: summarize(diagnostics),
		durationMs: Date.now() - t0,
		compiledAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
//#endregion
//#region src/dil/index.ts
/**
* The DIL pipeline's public surface for the host half: compile model-authored
* source into a program the sandbox can run, and the pieces the developer panel and
* the streaming patcher need to inspect it.
*
* The client half imports {@link compileDil}'s {@link DilCompiled} result shape from
* `./types.ts`; nothing here touches the tool registry, the session, or the disk.
* @module dsh-genui/dil
*/
/**
* Compile one revision of a DIL document.
*
* Never throws: every intermediate state of a partially-streamed document is
* syntactically invalid, and each failure becomes a diagnostic plus a best-effort
* program (`invalid_program` falls back to plain text).
* @param source - the model-authored document, whole or truncated mid-stream.
* @param options - host data bindings the program should read through `DIL.useAppData`.
* @returns the compiled program, its constants, its component resolutions, and everything that was repaired.
*/
function compileDil(source, options = {}) {
	return compile(source, options);
}
//#endregion
//#region src/normalize.ts
/**
* Artifact source normalization. The frame supplies the document skeleton,
* theme, and Content-Security-Policy, so a model that writes a complete HTML
* document still lands correctly: the skeleton tags are unwrapped (order
* preserved, nothing dropped) and any CSP the model tried to declare is removed
* so it cannot weaken the frame's own policy.
* @module dsh-genui/normalize
*/
/** Skeleton tags whose open/close forms are unwrapped, keeping their content. */
const SKELETON = /<\/?(?:!doctype\b[^>]*|html\b[^>]*|head\b[^>]*|body\b[^>]*)\/?>/gi;
/** A model-declared Content-Security-Policy meta, in either attribute order. */
const CSP_META = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi;
/**
* Reduce a source to frame-embeddable content.
* @param source - fragment or complete document.
* @returns markup safe to embed in the frame's `<body>`.
*/
function normalizeArtifactSource(source) {
	return source.replace(CSP_META, "").replace(SKELETON, "").trim();
}
/**
* The size the frame actually carries, measured after normalization so the cap
* reflects what the browser must parse.
* @param source - raw model source.
* @returns UTF-8 byte length of the normalized source.
*/
function normalizedBytes(source) {
	return new TextEncoder().encode(normalizeArtifactSource(source)).length;
}
//#endregion
//#region src/tool.ts
/**
* The artifact tool's behaviour, free of harness imports.
*
* Everything the tool decides lives here — what a create compiles, what a patch
* re-derives, when a revision is refused — and nothing here imports
* `@deepseek-ai/*`. That is deliberate: the harness's tool registry pulls ten
* peer packages a typecheck-only install does not carry, so a tool that imported
* it could only ever be exercised inside a running Host. Keeping the decisions
* separate means the real code path is reachable from a unit test, and
* `src/index.ts` is left as the thin binding that hands it to `defineTool`.
*
* @module dsh-genui/tool
*/
const DESCRIPTION = `Create and evolve a live, interactive interface inside this conversation — not a description of one.

Two ways to write it, and the default is the first.

**Compiled interface (default).** Pass \`source\`: a DIL document. Write a short prose sentence, then \`{@body …}\` lines declaring everything you use, then ONE root \`<box>\`. It is compiled and run in a sandbox, so charts, sliders, tables and calculators arrive as something the user operates — and derived numbers recompute locally with no second model call. Load the \`genui\` skill before your first call: it carries the output format, the declare-before-use rules, and the full component inventory. If this session has no skill tool, read the same contract from ${SKILL_BODY_PATH} (its relative paths resolve against ${SKILL_RESOURCE_DIR}).

**Raw document (escape hatch).** Pass \`engine: "html"\`, then \`css\` and \`html\`: a self-contained document, for what a component inventory cannot express (3D, force-directed graphs, a bespoke simulation). Write \`css\` first — the arguments stream in the order you write them, so the stylesheet lands before the markup and the reader never sees unstyled content. The frame supplies the document skeleton, the theme and the security policy.

When to reach for either. When the answer is something to operate rather than read, and its content is substantial rather than a three-line restatement. A static node-and-edge diagram is cheaper as a Mermaid block; a real deliverable the user wants as project files is not this.

Where it appears. The interface renders where you put its marker: write a fenced block whose language is \`dsh-artifact\` and whose only content is the id this call returned.

\`\`\`dsh-artifact
art-xxxxxxxx
\`\`\`

One artifact per reply. Put the marker after the sentence that introduces it. Never wrap the document itself in the fence, and never show the artifact as a code block instead of the marker — without a marker nothing renders in the answer.

Revising. Call \`patch\` with the id and one exact \`old_string\`/\`new_string\` replacement, never re-create the same thing. A patch keeps the user's place: what they typed, dragged and scrolled survives, and on the compiled path their control state is re-applied.

Interaction. Choices the user makes are reported back under the state key you named, so name state meaningfully (\`budget\`, not \`v1\`).`;
/** The tool's argument schema, as the harness consumes it. */
const PARAMETERS = {
	action: {
		type: "string",
		enum: [
			"create",
			"patch",
			"read",
			"list",
			"destroy"
		],
		description: "`create` opens a new artifact. `patch` replaces exact text inside an existing one by `id` — the normal way to change an artifact. `read` returns its current source. `list` enumerates this session's artifacts. `destroy` removes one."
	},
	engine: {
		type: "string",
		enum: ["dil", "html"],
		description: "create only: which document you are writing. `dil` (default) takes `source` and is compiled into an interface; `html` takes a self-contained `html` document."
	},
	source: {
		type: "string",
		description: "create only, required on the default path: the DIL document — prose, then `{@body …}` declarations, then one root `<box>`. Load the `genui` skill for the format and the component inventory."
	},
	css: {
		type: "string",
		description: "engine \"html\" only, and write it BEFORE `html`: the stylesheet. It streams ahead of the markup, so the reader watches a styled interface arrive instead of raw markup that snaps into place at the end. One document is stored either way."
	},
	html: {
		type: "string",
		description: "create only, required with `engine: \"html\"`: a self-contained document — markup plus style and script. A fragment or a full document; the frame wraps it."
	},
	title: {
		type: "string",
		description: "Short human-readable name, shown on the card and in the artifact panel. Required on create; optional on patch to rename."
	},
	mode: {
		type: "string",
		enum: ["inline", "wide"],
		description: "Card width: `inline` (default) or `wide` when several compact panels must sit side by side."
	},
	id: {
		type: "string",
		description: "patch / read / destroy: the artifact id returned by create."
	},
	old_string: {
		type: "string",
		description: "patch only, required: exact existing text to replace, whitespace included. Use action `read` first when unsure. Empty is rejected."
	},
	new_string: {
		type: "string",
		description: "patch only, required: replacement text; an empty string deletes the matched region."
	},
	replace_all: {
		type: "boolean",
		description: "patch only: replace every occurrence instead of requiring the match to be unique."
	}
};
/** The result schema, as the harness consumes it. */
const OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		note: {
			type: "string",
			required: true
		},
		meta: {
			type: "json",
			required: true
		}
	}
};
/** One artifact revision as the client and the session log carry it. */
function metaOf(record, action, engine, extra = {}) {
	const base = {
		kind: "artifact",
		engine,
		action,
		id: record.id,
		title: record.title,
		version: record.version,
		versionNumber: record.version,
		contentSha256: record.contentSha256,
		contentBytes: record.contentBytes,
		changelog: record.changelog,
		mode: record.mode,
		sizeBytes: new TextEncoder().encode(record.source).length,
		...record.parentVersionId === null ? {} : { parentVersionId: record.parentVersionId },
		...record.sessionId === void 0 ? {} : { session: record.sessionId }
	};
	if (engine === "html") return {
		...base,
		html: record.source,
		render: extra.render ?? "reload"
	};
	if (extra.dil === void 0) throw new Error("dsh-genui: a compiled revision needs its compiled payload");
	return {
		...base,
		dil: extra.dil
	};
}
/** The marker the model must write for an artifact to appear where it belongs. */
function marker(id) {
	return `\`\`\`dsh-artifact\n${id}\n\`\`\``;
}
/** Trim one required string argument, naming the action when it is missing. */
function required(value, field, action) {
	if (value === void 0 || value.trim().length === 0) throw new Error(`artifact ${action}: "${field}" is required.`);
	return value;
}
/** Narrow the requested width family. */
function modeOf(value) {
	return value === "wide" ? "wide" : "inline";
}
/** Narrow the requested rendering path; the compiled interface is the default. */
function engineOf(value) {
	return value === "html" ? "html" : "dil";
}
/**
* Put the stylesheet ahead of the markup.
*
* The two arguments exist separately only so the reader sees them in this order:
* the stylesheet streams first, so the preview is styled from its first frame
* instead of showing raw markup and then snapping into place. Storage keeps one
* document, so replay and export need no second field.
* @param css - the model's stylesheet, when it wrote one.
* @param html - the model's markup.
* @returns one document with the stylesheet first.
*/
function withStyle(css, html) {
	if (css === void 0 || css.trim().length === 0) return html;
	return `<style>\n${css.trim()}\n</style>\n${html}`;
}
/** The markdown projection, appended so a surface without the browser half still shows content. */
function degraded(compiled, include) {
	if (!include) return "";
	const body = compiled.fallbackMarkdown.trim();
	if (body.length === 0) return "";
	return `\n\nA plain-text rendering of the interface, for terminals and clients without the browser half:\n\n${body}`;
}
/**
* Resolve an artifact this session is allowed to touch.
*
* Ownership is enforced on every action, not only on writes: a session must not
* be able to read or destroy another session's artifact just because it guessed
* the id. An artifact the caller does not own is reported exactly like one that
* does not exist, so the refusal itself leaks nothing.
*
* @param store - the artifact catalog.
* @param id - the id the model passed.
* @param sessionId - the calling session, when the caller has one.
* @param action - the action name, for the message.
* @returns the current revision.
*/
function owned(store, id, sessionId, action) {
	const record = store.get(id);
	if (record !== void 0 && (sessionId === void 0 || record.sessionId === sessionId)) return record;
	const known = store.list(sessionId);
	const available = known.length === 0 ? "This session has no artifacts yet." : `Known ids: ${known.map((entry) => `${entry.id} ("${entry.title}", v${String(entry.version)})`).join(", ")}.`;
	throw new Error(`artifact ${action}: unknown id "${id}". ${available}`);
}
/** Arguments that only read, so sibling calls cannot conflict. */
function isConcurrencySafe(args) {
	return args.action === "read" || args.action === "list" || args.action === void 0;
}
/**
* The model-facing text of one call.
*
* Everything a result says goes through here, including the markdown projection
* of a compiled artifact. That projection is the only thing a surface without
* the browser half can show — a terminal transcript, a headless client, a
* copy-paste — so this is the function that decides whether such a session sees
* the artifact's content or a bare confirmation line.
*
* @param _args - the call arguments, unused.
* @param value - the tool result.
* @returns one text block.
*/
function renderArtifact(_args, value) {
	return [{
		type: "text",
		text: value.note
	}];
}
/**
* The revision payload the client reads, and what replay restores from.
* @param _args - the call arguments, unused.
* @param value - the tool result.
* @returns the payload, or `null` for the actions that carry none.
*/
function presentArtifactMeta(_args, value) {
	return value.meta;
}
/**
* Run one `artifact` call.
*
* `sessionId` is passed rather than read from a context object so this stays
* callable without the harness.
* @param store - the artifact catalog.
* @param config - deployment configuration.
* @param args - the model's arguments, unvalidated beyond what the schema guarantees.
* @param sessionId - owning session, when the caller has one.
* @returns the model-facing note and the revision payload.
*/
async function runArtifact(store, config, args, sessionId) {
	const action = typeof args.action === "string" ? args.action : "create";
	const title = typeof args.title === "string" ? args.title : void 0;
	const str = (key) => typeof args[key] === "string" ? args[key] : void 0;
	const maxBytes = config.maxSourceBytes;
	if (action === "create") {
		const engine = engineOf(str("engine"));
		const source = engine === "html" ? normalizeArtifactSource(withStyle(str("css"), required(str("html"), "html", action))) : required(str("source"), "source", action);
		if (source.trim().length === 0) throw new Error("artifact create: the document is empty.");
		const sizeBytes = engine === "html" ? normalizedBytes(source) : new TextEncoder().encode(source).length;
		if (sizeBytes > maxBytes) throw new Error(`artifact create: ${String(sizeBytes)} bytes exceeds the ${String(maxBytes)} byte cap. Reduce the document or raise maxSourceBytes in the plugin config.`);
		const held = store.list(sessionId);
		if (held.length >= config.maxArtifactsPerSession) throw new Error(`artifact create: this session already holds ${String(held.length)} artifacts (cap ${String(config.maxArtifactsPerSession)}). Patch an existing one, destroy one, or raise maxArtifactsPerSession.`);
		const resolvedTitle = title?.trim() || "Artifact";
		const compiled = engine === "dil" ? compileDil(source) : void 0;
		const record = store.create({
			...sessionId === void 0 ? {} : { sessionId },
			title: resolvedTitle,
			source,
			mode: modeOf(str("mode")),
			engine
		});
		const meta = metaOf(record, "create", engine, compiled === void 0 ? {} : { dil: compiled });
		return {
			note: `Created "${record.title}" as ${record.id} (v1, ${String(sizeBytes)} bytes). Put this marker on its own line in your answer, where it belongs:\n\n${marker(record.id)}\n\nIt renders full size and interactive at that point. Change it later with action "patch" and this id; do not create it again.` + (compiled === void 0 ? "" : degraded(compiled, config.includeDegradedText)),
			meta
		};
	}
	if (action === "patch") {
		const id = required(str("id"), "id", action);
		const current = owned(store, id, sessionId, action);
		const oldString = required(str("old_string"), "old_string", action);
		const newString = str("new_string") ?? "";
		let preview;
		let replacements;
		try {
			const result = applyPatch(current.source, oldString, newString, args.replace_all === true);
			preview = result.text;
			replacements = result.replacements;
		} catch (error) {
			if (error instanceof PatchError) throw new Error(`artifact patch ${id}: ${error.message}`);
			throw error;
		}
		const sizeBytes = new TextEncoder().encode(preview).length;
		if (sizeBytes > maxBytes) throw new Error(`artifact patch ${id}: result is ${String(sizeBytes)} bytes, over the ${String(maxBytes)} byte cap. Patch in smaller steps.`);
		const record = store.patch(id, {
			oldText: oldString,
			newText: newString,
			replaceAll: args.replace_all === true,
			expectedLatestVersion: current.version,
			...title === void 0 ? {} : { title: title.trim() }
		});
		const engine = record.engine;
		const recompiled = engine === "dil" ? compileDil(record.source) : void 0;
		const render = requiresReload(current.source, record.source) ? "reload" : "reconcile";
		const meta = metaOf(record, "patch", engine, engine === "dil" ? { dil: recompiled } : { render });
		const how = engine === "html" ? render === "reconcile" ? "updated in place (no reload, artifact state kept)" : "updated (scripts changed, so the frame reloaded)" : "recompiled and pushed to the running interface, which keeps the user's control state";
		return {
			note: `Patched "${record.title}" (${id}) to v${String(record.version)} — ${String(replacements)} replacement${replacements === 1 ? "" : "s"}, ${String(sizeBytes)} bytes; the interface already in the conversation is ${how}. Write the same marker in this answer so the updated artifact stays anchored:\n\n${marker(id)}` + (recompiled === void 0 ? "" : degraded(recompiled, config.includeDegradedText)),
			meta
		};
	}
	if (action === "read") {
		const record = owned(store, required(str("id"), "id", action), sessionId, action);
		return {
			note: `Artifact ${record.id} "${record.title}" v${String(record.version)} — current source follows.\n\n${record.source}`,
			meta: null
		};
	}
	if (action === "list") {
		const held = store.list(sessionId);
		if (held.length === 0) return {
			note: "No artifacts in this session yet.",
			meta: null
		};
		return {
			note: `Artifacts in this session:\n${held.map((entry) => `- ${entry.id} — "${entry.title}" v${String(entry.version)} (${String(entry.versionCount)} revision${entry.versionCount === 1 ? "" : "s"}), ${String(entry.contentBytes)} bytes, updated ${new Date(entry.updatedAt).toISOString()}`).join("\n")}\n\nUse action "read" for the current source of one, or patch it in place.`,
			meta: null
		};
	}
	const id = required(str("id"), "id", "destroy");
	owned(store, id, sessionId, "destroy");
	return {
		note: store.destroy(id) ? `Destroyed artifact ${id}. Its rendered cards stay in the transcript but no longer accept patches.` : `artifact destroy: unknown id "${id}".`,
		meta: null
	};
}
//#endregion
//#region src/index.ts
const name = PLUGIN_ID;
/** Services this half registers into: the tool registry and the skill registry. */
const inject = ["tools", "skills"];
/** Deployment configuration validated by the Loader. */
const Config = z.object({
	/** Hard cap on one revision, measured in bytes of the stored source. */
	maxSourceBytes: z.natural().default(2e6),
	/** How many artifacts one session may hold at once. */
	maxArtifactsPerSession: z.natural().default(40),
	/** Disk root for the artifact catalog; empty selects the default under `~/.dsh`. */
	storeRoot: z.string().default(""),
	/**
	* Append a compiled artifact's markdown projection to the tool result.
	*
	* It is the only thing a surface without the browser half can show — a
	* terminal transcript, a headless client, a copy-paste — and the compiler
	* already had to build it. It costs one re-read per call, so it is switchable.
	*/
	includeDegradedText: z.boolean().default(true)
});
/** Build the tool bound to one store and configuration. */
function artifactTool(store, config) {
	return defineTool({
		name: ARTIFACT_TOOL_NAME,
		description: DESCRIPTION,
		parameters: PARAMETERS,
		output: {
			schema: OUTPUT_SCHEMA,
			render: renderArtifact,
			presentationMeta: presentArtifactMeta
		},
		isConcurrencySafe: (args) => isConcurrencySafe(args),
		execute: (args, exec) => runArtifact(store, config, args, exec.agent?.session.header.id),
		presentCall: () => ({
			card: "generic",
			title: "Artifact",
			kind: "other"
		}),
		presentResult: (_args, result) => {
			if (result.isError) return void 0;
			const meta = result.meta;
			if (meta === null || meta === void 0 || typeof meta !== "object") return void 0;
			if (meta.kind !== "artifact" || typeof meta.title !== "string") return void 0;
			const suffix = meta.action === "patch" ? ` · v${String(meta.version)}` : "";
			return {
				card: "generic",
				title: `Artifact · ${meta.title}${suffix}`
			};
		}
	});
}
/**
* The catalog for this load.
*
* The root comes from configuration, but it is the same directory across loads —
* a plugin reload re-reads the catalog rather than starting empty, which is the
* whole point of the on-disk layer.
* @param config - validated deployment configuration.
* @returns the store, recovered and ready.
*/
function openStore(config) {
	const store = new ArtifactStore({
		root: config.storeRoot.trim().length === 0 ? defaultStoreRoot() : config.storeRoot,
		maxArtifactsPerSession: config.maxArtifactsPerSession,
		maxContentBytes: config.maxSourceBytes
	});
	store.recover();
	return store;
}
/**
* Register the artifact tool and the dialect skill into the calling profile.
* @param ctx - registrant context.
* @param config - validated deployment configuration.
*/
function apply(ctx, config) {
	ctx.tools.register(artifactTool(openStore(config), config));
	ctx.skills.registerProvider(() => genuiSkillProvider);
}
//#endregion
export { Config, apply, artifactTool, inject, name };
