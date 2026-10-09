# dsh-intelligent-ui

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)
[![tests](https://img.shields.io/badge/tests-442%20passing-brightgreen)](#development)

**Generative UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the model writes an interface instead of describing one.**

An open-source take on what ChatGPT calls **Intelligent UI** (internal codename *DIL*) and Claude calls **Artifacts** — the model's answer stops being prose about a dashboard and becomes the dashboard. Sliders you can drag, toggles you can flip, numbers that recompute locally with no second model call, and a card the model can revise in place while keeping your place.

Everything is one tool (`artifact`), two rendering paths, and an on-disk artifact layer.

> Keywords: DSH plugin · DeepSeek Harness plugin · generative UI · GenUI · ChatGPT Intelligent UI · Claude Artifacts · declarative DSL · worker sandbox · native DOM render tree · artifact version history

## What it is

Ask for something you would otherwise only read about — *"a plan calculator where I can change seats and billing period"* — and the reply **is** a working calculator. The model writes a small declarative document, DSH compiles and runs it in a sandbox, and the host draws the result with native DOM: real controls, the host's own type scale, the host's own colours, correct in both light and dark mode.

Three things follow from that, and they are the whole point:

- **You operate the answer.** A chart whose inputs you change, a checklist you tick, a config you tune — not a screenshot of one.
- **It stays correct.** Ask for a change and the model patches the same artifact in place. Version history means the revision you were looking at is still on disk.
- **It survives the session.** Artifacts are persisted, so a card from last week is still patched in place today, after an app restart.

## The two paths

| | Compiled path — `engine: "dil"` (default) | Escape hatch — `engine: "html"` |
|---|---|---|
| The model writes | a DIL document: prose, `{@body …}` declarations, one root `<box>` | a self-contained document: `css`, then `html` |
| Who executes it | a **DOM-less Worker** inside the frame runs the compiled program | the frame runs the document itself |
| Who draws it | **the host**, from a render tree, using native DOM | the frame draws itself |
| What you get | theme for free, few tokens on the wire, controls wired to each other, structure streams out first | no ceiling (canvas, WebGL, D3, your own simulation) |

The distinction that matters: **the sandbox is an execution container, not a display container.** Compiled code runs in a Worker that has no DOM, and emits a render tree the host draws. "Code inside the card reaching the host's elements" is therefore not blocked — there is no path for it to happen.

## Install

```sh
dsh plugin --profile desktop add github:yunyv/dsh-intelligent-ui
```

Then **restart the app**. The build output is committed, so a git install needs no build step and no build permission.

From a tarball, if you prefer to pin an exact artifact:

```sh
dsh plugin --profile desktop add ./dsh-intelligent-ui-0.1.0.tgz
```

From a checkout, for development:

```sh
git clone https://github.com/yunyv/dsh-intelligent-ui && cd dsh-intelligent-ui
pnpm install && pnpm run check
bash scripts/reinstall-desktop.sh
```

Do not install this by linking the source directory. A link exposes `node_modules/@deepseek-ai/*` — which exists only for type checking — to the Loader; Node resolves to those copies, their own transitive peers are not installed, and the import throws `Cannot find package`, which takes the whole plugin down.

## Use

Nothing to configure. Ask for something interactive and the model reaches for the tool. A DIL document looks like this — prose, declared state, then one tree:

```
{@body const [seats,setSeats] = DIL.useState(5)}
{@body const [yearly,setYearly] = DIL.useState(false)}
{@body const total = 200 * (yearly ? 10 : 12) * seats}
<box gap={4}>
  <title size="lg">Team subscription cost</title>
  <slider label="Seats" value={seats} onChange={setSeats} min={1} max={50}/>
  <checkbox checked={yearly} onChange={setYearly}>Billed yearly</checkbox>
  <card>
    <caption>Per year</caption>
    <title size="xl" tabularNums>${total.toLocaleString()}</title>
  </card>
</box>
```

(The `$` is a literal currency sign and `{total.toLocaleString()}` is the interpolation — DIL is not JavaScript template syntax, it only borrows the braces.)

The authoring contract — the full component inventory, the rules that make a document run — ships as a bundled **skill**, so it loads only when a turn is actually about to write one rather than sitting in every request. Say `skill genui` to read it.

Where the card appears is under the model's control too: it writes a fenced block whose language is `dsh-artifact` and whose only content is the artifact id, and the frame is mounted at that point in the answer.

## How it works

```
src/tool.ts            every decision the tool makes; imports no @deepseek-ai/*, so tests drive it directly
src/index.ts           the harness binding: Config, store root, registration, presentation hooks
src/dil/               the ported streaming DIL compiler (parser, codegen, streaming boundaries, fallback)
src/store/             the on-disk artifact layer
src/client/            the browser half: fence claiming, engine dispatch, sidebar panel
src/client/dil/        sandbox, render-tree renderer, patch model, state loop
assets/genui-skill.md  the DIL authoring contract, loaded as a bundled skill
vendor/dil-replica/    the upstream replica, verbatim (see PROVENANCE.md)
```

The compiler is a streaming compiler. It is fed a growing prefix of the document and reports which components have closed and which are still open, so the card can appear while the model is still typing it. Recovery is not all-or-nothing: a half-written element is dropped and everything around it still renders.

An artifact can be on screen twice — live in its card and again in the right column — and the two share one state, so a control moved in either one moves both.

## The artifact store

Persisted under `~/.dsh/storages/dsh-intelligent-ui/`, with the data model borrowed from [coda0HQ/open-artifacts](https://github.com/coda0HQ/open-artifacts) (MIT):

```text
index.json                               the catalogue; never holds content
artifacts/art-xxxxxxxx/versions/
  v0001.html  v0001.json                 content and metadata kept apart
  v0002.html  v0002.json
```

Versions are **appended, never rewritten**. Each carries `versionNumber`, `parentVersionId`, `contentSha256`, `contentBytes` and a `changelog`; `restore` appends a new head rather than editing history; `expectedLatestVersion` gives optimistic concurrency; `read(id, N)` fetches any historical revision.

The write order is content → sidecar → atomic index replace, and both the read and the write path treat the disk as the source of truth, so a crash in the middle cannot leave the head pointing at bytes that are not there.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `storeRoot` | `''` | artifact directory; empty means `~/.dsh/storages/dsh-intelligent-ui` |
| `maxSourceBytes` | `2000000` | refuse a document larger than this |
| `maxArtifactsPerSession` | `40` | per-session artifact ceiling |
| `includeDegradedText` | `true` | append the plain-text projection the model can read back |

## Development

```sh
pnpm run check     # typecheck (3 projects) && build && vitest && the vendored upstream suite
```

442 tests pass: 344 ours, 98 vendored from upstream. The browser half is tested against the **built** `lib/client.js` through the real `__ModuleLoader__.load({ id, factory })` contract, so a registration or render failure there is a real defect rather than a test-harness artefact.

To iterate on `src/client/**` without restarting the app, build and copy the bundle into the installed copy; the browser picks it up:

```sh
pnpm run build && cp lib/client.js ~/.dsh/profiles/desktop/node_modules/dsh-intelligent-ui/lib/client.js
```

Anything on the host side needs a reinstall **and a restart**.

## Notes for plugin authors

Three failures worth knowing about, all of which are invisible in review and were found the hard way.

**A host half fails silently.** An unresolvable module specifier leaves no trace in the transcript: the plugin entry simply reports `fiberPhase: failed` and its tool is absent. Declaring a package in `peerDependencies` to get its types makes the bundler externalise it — so if the runtime does not actually ship that package, the plugin never runs while every `inject`, Config and skill assertion still passes. `tests/host-bundle.spec.ts` asserts that the built entry imports nothing outside the runtime-provided set.

**A successfully-loaded module is cached for the life of the process.** Toggling a plugin entry off and on re-imports it, which rescues a load that *failed*. It does not re-read a file whose module already loaded: the ESM cache answers, `apply` runs against the old code, and the package on disk is irrelevant. Changed code needs a restart.

**`ctx.inject(deps, cb)` is how you wait for an optional service.** Probing with `ctx.get(name)` and returning when it is absent works right up until a cold start runs your plugin before the provider is up, and then it fails intermittently forever. An optional dependency is not a hard `inject` entry, and it is not a one-shot probe — it is something to wait for.

## Provenance and license

MIT. The DIL path vendors [Disdjj/intelligent-ui-demo](https://github.com/Disdjj/intelligent-ui-demo) (MIT) verbatim under `vendor/`; the compiler and sandbox under `src/dil/` and `src/client/dil/` are ports of it. Exact commits, what was changed and why are in [PROVENANCE.md](PROVENANCE.md). Third-party code is never edited in place — changes happen in `src/`.

The protocol is a snapshot of ChatGPT's DIL `protocolVersion 14` and upstream may change it at any time; the details are sealed inside `src/dil/` and `src/client/dil/`.

Two deliberate divergences from upstream, both recorded as tests rather than as drift: a closing tag inside a block no longer swallows the rest of the document, and the plain-text projection keeps an interpolation's place (`n = {n}` rather than `n = `) so a terminal reader does not get a sentence with a hole in it.
