/**
 * The sandboxed runner document, generated in the client instead of served.
 *
 *   host ──srcdoc (or frameUrl)──► iframe, sandbox="allow-scripts", opaque origin
 *                                    └── blob:/data: Worker running the model's program
 *
 * Structure is upstream's `server/sandbox/frame.js` verbatim — the CSP, the hash-pinned
 * bootstrap, the worker in an inert `<template>` — with one change of delivery: the
 * document is written into `iframe.srcdoc` rather than fetched from a route, because
 * the packaged app has no route to serve it from.
 *
 * CSP notes that matter in DSH:
 *   • `default-src 'none'` stays. The runner needs no network at all — icons are
 *     inline SVG and nothing is fetched — so a CDN allowlist would only hand compiled
 *     model code a `fetch` channel. The HTML artifact frame (`src/client/frame.ts`)
 *     keeps its own allowlist because *that* frame is the display container.
 *   • `script-src 'sha256-…' 'unsafe-eval'`: the hash pins the one inline bootstrap, so
 *     nothing else can be injected into the document, while `'unsafe-eval'` is what the
 *     worker needs to evaluate the model's program. Isolation comes from having no IO.
 *   • `worker-src blob: data:` — `blob:` is the normal transport, `data:` the fallback
 *     for engines that refuse a blob worker from an opaque-origin document.
 * @module dsh-genui/client/dil/frame
 */

import { FRAME_SCRIPT, FRAME_SCRIPT_SHA256 } from './generated/frame-script.ts'
import { WORKER_SOURCE } from './generated/worker-source.ts'

export { FRAME_SCRIPT, FRAME_SCRIPT_SHA256, WORKER_SOURCE }

/** The single exception to `default-src 'none'`: where the worker may come from. */
export const WORKER_SOURCES = 'blob: data:'

/** The runner's Content-Security-Policy. Hash-pinned, network-free. */
export const DIL_FRAME_CSP = [
	"default-src 'none'",
	`script-src 'sha256-${FRAME_SCRIPT_SHA256}' 'unsafe-eval'`,
	`worker-src ${WORKER_SOURCES}`,
	"base-uri 'none'",
	"form-action 'none'",
	"frame-src 'none'",
	"object-src 'none'"
].join('; ')

/** HTML-escape so the worker source survives a round-trip through `<template>`. */
export function escapeHtmlText(source: string): string {
	return source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Overrides for {@link buildRunnerHtml}; every one of them breaks the hash pinning. */
export interface RunnerHtmlOptions {
	/** Replacement bootstrap. Pair it with a matching `csp`, or the script will not run. */
	frameScript?: string
	/** Replacement worker text. */
	workerSource?: string
	/** Replacement policy. */
	csp?: string
	/** Document title. */
	title?: string
}

/**
 * Assemble the complete `srcdoc` document for one sandbox frame.
 *
 * The worker travels in a `<template>`, which the HTML parser treats as inert content:
 * `<script>` inside it never executes, so no `script-src` exception is needed to carry
 * it, and the frame reads it back with `textContent`.
 * @param options - overrides; the defaults are the pinned upstream combination.
 * @returns the frame document.
 */
export function buildRunnerHtml(options: RunnerHtmlOptions = {}): string {
	const script = options.frameScript ?? FRAME_SCRIPT
	const worker = options.workerSource ?? WORKER_SOURCE
	if (options.csp === undefined && script !== FRAME_SCRIPT) {
		throw new Error(
			'client/dil/frame: a replacement frameScript needs a matching csp — '
			+ `the pinned hash ${FRAME_SCRIPT_SHA256} only covers the vendored bootstrap`
		)
	}
	const csp = options.csp ?? DIL_FRAME_CSP
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtmlText(options.title ?? 'DIL Runner')}</title>
    <script>${script}</script>
  </head>
  <body>
    <!-- Inert: never executed, never blocked by script-src, read via textContent. -->
    <template id="dil-worker-source">${escapeHtmlText(worker)}</template>
  </body>
</html>`
}
