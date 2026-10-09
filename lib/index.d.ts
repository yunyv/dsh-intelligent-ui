import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/meta.d.ts
/** Card width family. `wide` exists for side-by-side comparison layouts. */
type ArtifactMode = 'inline' | 'wide';
/** How the live frame must adopt the next revision. */
type ArtifactRender = 'reload' | 'reconcile';
/**
 * Which rendering path an artifact belongs to.
 *
 * `dil` — the model wrote a DIL document; the compiled program runs in the
 * sandbox and the host renders the tree it returns.
 * `html` — the model wrote a self-contained document; the frame renders it.
 */
type ArtifactEngine = 'dil' | 'html';
//#endregion
//#region src/store/types.d.ts
/** What produced one version. Every version records its own provenance. */
type ArtifactAction = 'create' | 'patch' | 'append' | 'restore';
/** One immutable revision, without its content. */
interface ArtifactVersionMeta {
  /** Owning artifact id. */
  id: string;
  /** 1-based, contiguous, never reused. Equals the record's `version` at head. */
  versionNumber: number;
  /** Stable id of this revision: `"<id>#<versionNumber>"`. */
  versionId: string;
  /** The revision this one was appended on top of; `null` for version 1. */
  parentVersionId: string | null;
  /** Lowercase hex sha256 of the content's exact UTF-8 bytes. */
  contentSha256: string;
  /** Content length in UTF-8 bytes. */
  contentBytes: number;
  /** Why this version exists, for the model and the user. */
  changelog: string;
  /** Epoch milliseconds of this version. */
  createdAt: number;
  action: ArtifactAction;
  /** Title as of this version. */
  title: string;
  mode: ArtifactMode;
  /** Rendering path, fixed when the artifact is created. */
  engine: ArtifactEngine;
  /** Owning session, so a session-scoped catalog can filter. */
  sessionId?: string;
}
/** One immutable revision with its content resolved. */
interface ArtifactVersion extends ArtifactVersionMeta {
  /** Complete source at this revision. */
  content: string;
}
/**
 * Catalog entry: the head pointer plus everything the catalog renders. This is
 * exactly what `index.json` stores per artifact, so it never holds content.
 */
interface ArtifactSummary {
  id: string;
  sessionId?: string;
  title: string;
  mode: ArtifactMode;
  /** Rendering path, fixed when the artifact is created. */
  engine: ArtifactEngine;
  /** Epoch milliseconds of version 1. */
  createdAt: number;
  /** Epoch milliseconds of the head version. */
  updatedAt: number;
  /** Head version number. Mirrors `ArtifactVersionMeta.versionNumber`. */
  version: number;
  /** Head version id. */
  versionId: string;
  /** The head's parent; `null` while the artifact is at version 1. */
  parentVersionId: string | null;
  /** sha256 of the head content. */
  contentSha256: string;
  /** UTF-8 byte length of the head content. */
  contentBytes: number;
  /** How many versions the chain holds. */
  versionCount: number;
}
/** A head snapshot: what every writing call returns. */
interface ArtifactRecord extends ArtifactSummary {
  /** Complete source at the head. */
  source: string;
  /** The head version's changelog. */
  changelog: string;
  /** How a live card must adopt this revision. */
  render: ArtifactRender;
}
/** Arguments for {@link ArtifactStore.create}. */
interface CreateInput {
  /** Force an id (migrate path); a fresh id is minted when omitted. */
  id?: string;
  /** Owning session; omitted means the store-wide unscoped bucket. */
  sessionId?: string;
  /** Defaults to `"Artifact"`. */
  title?: string;
  /** The first version's complete source. */
  source: string;
  /** Defaults to `"inline"`. */
  mode?: ArtifactMode;
  /** Rendering path; defaults to the compiled-interface path. */
  engine?: ArtifactEngine;
  /** Defaults to `"created"`. */
  changelog?: string;
  /** Preserve a legacy creation time (migrate path). Defaults to now. */
  createdAt?: number;
}
/** Arguments for {@link ArtifactStore.append}: one whole new revision. */
interface AppendInput {
  /** Complete source of the new head. */
  content: string;
  title?: string;
  mode?: ArtifactMode;
  changelog?: string;
  sessionId?: string;
  /** Optimistic concurrency: refuse unless the head is this version number. */
  expectedLatestVersion?: number;
}
/** Arguments for {@link ArtifactStore.patch}: exact text replacement. */
interface PatchInput {
  /** Exact text to find in the current head. */
  oldText: string;
  /** Replacement; empty deletes the matched region. */
  newText: string;
  /** Replace every occurrence instead of requiring exactly one. */
  replaceAll?: boolean;
  title?: string;
  /** Defaults to a generated `patch N× "…" → "…"` line. */
  changelog?: string;
  sessionId?: string;
  expectedLatestVersion?: number;
}
/** Arguments for {@link ArtifactStore.restore}. */
interface RestoreInput {
  sessionId?: string;
  expectedLatestVersion?: number;
  /** Defaults to `restored from v<N>`. */
  changelog?: string;
}
/** Construction options. Every knob is injectable so tests stay hermetic. */
interface StoreOptions {
  /** Disk root; defaults to `~/.dsh/storages/dsh-intelligent-ui/` (or `DSH_GENUI_STORE_DIR`). */
  root?: string;
  /** Artifacts allowed per session (unscoped artifacts share one bucket). Default 40. */
  maxArtifactsPerSession?: number;
  /** Per-artifact content cap in UTF-8 bytes. Default 8 MiB. */
  maxContentBytes?: number;
  /** How long a write waits for the store lock before failing. Default 2000. */
  lockTimeoutMs?: number;
  /** Age at which an abandoned lock file may be taken over. Default 10000. */
  staleLockMs?: number;
  /** Injectable clock, epoch milliseconds. */
  now?: () => number;
  /** Injectable id minter. */
  idFactory?: (taken: ReadonlySet<string>) => string;
}
/** What {@link ArtifactStore.recover} repaired. */
interface RecoverReport {
  root: string;
  /** Artifact directories found on disk. */
  scanned: number;
  /** Artifacts present on disk but missing from the index; now indexed. */
  adopted: string[];
  /** Artifacts whose index head disagreed with the chain on disk; now repaired. */
  repaired: string[];
  /** Index entries with no artifact directory behind them; now dropped. */
  dropped: string[];
  /** Version numbers whose files are unreadable or break the chain (`"<id>#<n>"`). */
  corrupt: string[];
  /** Version numbers past the chain's end, never adopted and never deleted. */
  orphans: string[];
}
/** What {@link ArtifactStore.verify} found for one artifact. */
interface VerifyReport {
  id: string;
  /** Version files found on disk: the chain plus anything past a hole. */
  versions: number;
  /** Content files hashed and compared. */
  checked: number;
  /** Version numbers whose sha256 or byte length disagreed. */
  mismatched: number[];
  /** Version numbers whose sidecar or content file is missing or unreadable. */
  unreadable: number[];
}
/** Store-wide disk usage, as the catalog sees it. */
interface UsageReport {
  /** Artifacts counted. */
  artifacts: number;
  /** Sum of head content bytes (history is not counted). */
  bytes: number;
}
//#endregion
//#region src/store/store.d.ts
/**
 * A disk-backed, versioned artifact store.
 *
 * All methods are synchronous: the plugin writes a handful of artifacts per
 * turn and reads one at a time, and a synchronous API keeps the write path
 * (lock → resolve head → validate → append → swap index) a single atomic
 * sequence with no interleaving point. Callers may `await` the results freely —
 * `await` passes non-promises straight through.
 */
declare class ArtifactStore {
  #private;
  /** Disk root this instance owns. */
  readonly root: string;
  /**
   * @param options - root, quotas, lock tuning, injectable clock and id minter.
   *   The root directory tree is created on construction.
   */
  constructor(options?: StoreOptions);
  /** `<root>/index.json`; useful for diagnostics and for tests. */
  get indexPath(): string;
  /** `<root>/artifacts`. */
  get artifactsDir(): string;
  /** `<root>/locks/store.lock`. */
  get lockFile(): string;
  /** Absolute directory holding one artifact's version files. */
  directoryOf(id: string): string;
  /**
   * Create an artifact and append its version 1.
   * @param input - source, and optionally id, session, title, mode, changelog.
   * @returns the head record, at version 1.
   * @throws {StoreQuotaError} when the session is at its artifact cap, or the
   *   source is over the per-artifact byte cap.
   * @throws {ArtifactExistsError} when a forced id is already on disk.
   */
  create(input: CreateInput): ArtifactRecord;
  /**
   * Append one whole new revision. The low-level path; `patch` and `restore`
   * are built on it.
   * @throws {ArtifactNotFoundError} | {@link StaleVersionError} | {@link StoreQuotaError}
   */
  append(id: string, input: AppendInput): ArtifactRecord;
  /**
   * Apply an exact `oldText` → `newText` replacement to the head.
   *
   * Replacement semantics are `src/patch.ts` verbatim — empty or absent search
   * text and an ambiguous match without `replaceAll` all throw `PatchError`
   * before anything is written.
   * @throws {PatchError} when the patch cannot be applied.
   * @throws {StaleVersionError} when `expectedLatestVersion` is not the head.
   */
  patch(id: string, input: PatchInput): ArtifactRecord;
  /**
   * Restore an old revision as a **new** head. History is untouched: version N
   * still holds exactly what it held, and the restore lands as version N+1.
   * @param id - artifact id.
   * @param version - revision to copy forward.
   * @throws {ArtifactNotFoundError} | {@link VersionNotFoundError} | {@link StaleVersionError}
   */
  restore(id: string, version: number, input?: RestoreInput): ArtifactRecord;
  /**
   * Delete an artifact and its entire version history.
   * @returns whether anything was deleted.
   */
  destroy(id: string): boolean;
  /**
   * Read one revision.
   * @param id - artifact id.
   * @param version - revision number; defaults to the head (`?v=N` otherwise).
   * @throws {ArtifactNotFoundError} when no chain exists for that id.
   * @throws {VersionNotFoundError} when that revision is not in the chain.
   */
  read(id: string, version?: number): ArtifactVersion;
  /**
   * The head record, or `undefined` when the id is unknown. A probe, not an
   * action: use {@link read} when a missing artifact should be an error.
   */
  get(id: string): ArtifactRecord | undefined;
  /** Whether an artifact (or at least part of its chain) is on disk. */
  has(id: string): boolean;
  /**
   * The catalog, oldest first.
   * @param sessionId - filter to one session; omitted lists every artifact.
   *   Read from `index.json` only, so call {@link recover} first if the index
   *   may have been lost.
   */
  list(sessionId?: string): ArtifactSummary[];
  /**
   * Every revision of one artifact, version 1 first, content excluded.
   * @throws {ArtifactNotFoundError} when no chain exists for that id.
   */
  versions(id: string): ArtifactVersionMeta[];
  /** The session's artifact with this title, or `undefined`. */
  findByTitle(sessionId: string | undefined, title: string): ArtifactSummary | undefined;
  /** Artifact count and head-content bytes, for one session or the whole store. */
  usage(sessionId?: string): UsageReport;
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
  recover(): RecoverReport;
  /**
   * Re-hash every version file of one artifact — the chain *and* any version
   * past a hole — and compare against the recorded digest, so silent disk
   * corruption is detected rather than silently patched on top of. Only the
   * chain is writable; this is the read-side check.
   * @throws {ArtifactNotFoundError} when the artifact has no files at all.
   */
  verify(id: string): VerifyReport;
}
//#endregion
//#region src/tool.d.ts
/** The slice of deployment configuration the tool reads. */
interface ToolConfig {
  /** Hard cap on one revision, measured in bytes of the stored source. */
  maxSourceBytes: number;
  /** How many artifacts one session may hold at once. */
  maxArtifactsPerSession: number;
  /** Append a compiled artifact's markdown projection to the tool result. */
  includeDegradedText: boolean;
}
//#endregion
//#region src/index.d.ts
declare const name = "dsh-intelligent-ui";
/** Services this half registers into: the tool registry and the skill registry. */
declare const inject: string[];
/** Deployment configuration validated by the Loader. */
declare const Config: z<Schemastery.ObjectS<NoInfer<{
  /** Hard cap on one revision, measured in bytes of the stored source. */
  maxSourceBytes: z<number, number, "defined">;
  /** How many artifacts one session may hold at once. */
  maxArtifactsPerSession: z<number, number, "defined">;
  /** Disk root for the artifact catalog; empty selects the default under `~/.dsh`. */
  storeRoot: z<string, string, "defined">;
  /**
   * Append a compiled artifact's markdown projection to the tool result.
   *
   * It is the only thing a surface without the browser half can show — a
   * terminal transcript, a headless client, a copy-paste — and the compiler
   * already had to build it. It costs one re-read per call, so it is switchable.
   */
  includeDegradedText: z<boolean, boolean, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  /** Hard cap on one revision, measured in bytes of the stored source. */
  maxSourceBytes: z<number, number, "defined">;
  /** How many artifacts one session may hold at once. */
  maxArtifactsPerSession: z<number, number, "defined">;
  /** Disk root for the artifact catalog; empty selects the default under `~/.dsh`. */
  storeRoot: z<string, string, "defined">;
  /**
   * Append a compiled artifact's markdown projection to the tool result.
   *
   * It is the only thing a surface without the browser half can show — a
   * terminal transcript, a headless client, a copy-paste — and the compiler
   * already had to build it. It costs one re-read per call, so it is switchable.
   */
  includeDegradedText: z<boolean, boolean, "defined">;
}>>, "plain">;
/** Validated configuration shape the Loader passes to {@link apply}. */
interface PluginConfig extends ToolConfig {
  /** Disk root for the artifact catalog; empty selects the default under `~/.dsh`. */
  storeRoot: string;
}
/** Build the tool bound to one store and configuration. */
declare function artifactTool(store: ArtifactStore, config: PluginConfig): import("@deepseek-ai/dsh-tools").ToolDefinition;
/**
 * Register the artifact tool and the dialect skill into the calling profile.
 * @param ctx - registrant context.
 * @param config - validated deployment configuration.
 */
declare function apply(ctx: Context, config: PluginConfig): void;
//#endregion
export { Config, PluginConfig, apply, artifactTool, inject, name };