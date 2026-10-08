/**
 * Frame document construction for the artifact card: the sandboxed iframe's
 * `srcdoc`, its Content-Security-Policy, the host-theme bridge, the content
 * height reporter, the in-memory storage shim, the interaction collector, and
 * the in-place reconciler that lets a `patch` reach a live artifact without
 * reloading it.
 *
 * Everything the frame needs is serialized into the document, so the frame
 * never has to ask the app for anything and cannot reach it: `sandbox` carries
 * no `allow-same-origin`, and the policy denies every origin outside the static
 * asset allowlist.
 * @module dsh-artifacts-live/client/frame
 */

import { COLLECT_MESSAGE, DATA_MESSAGE, HEIGHT_MESSAGE, STORAGE_MESSAGE, SYNC_MESSAGE, THEME_MESSAGE } from '../meta.ts'

/** Smallest frame height, so an empty document still reads as a surface. */
export const HEIGHT_MIN = 48

/** Per-width height ceiling: inline cards stay readable, wide cards get room. */
export const HEIGHT_CAP: Record<'inline' | 'wide', number> = { inline: 800, wide: 1200 }

/** Host design tokens bridged into the frame as `--viz-*` variables. */
const TOKEN_BRIDGE: readonly (readonly [string, string])[] = [
	['foreground', '--dsw-alias-label-primary'],
	['card', '--dsw-alias-bg-layer-1'],
	['muted-foreground', '--dsw-alias-label-caption'],
	['border', '--dsw-alias-border-l2'],
	['primary', '--dsw-alias-brand-primary-new-colorprimary-new-color'],
	['primary-foreground', '--dsw-alias-label-primary-inverted']
]

/** Static asset origins the frame may load from; everything else is denied. */
const RESOURCE_SOURCES = [
	'blob:',
	'data:',
	'https://cdnjs.cloudflare.com',
	'https://cdn.jsdelivr.net',
	'https://esm.sh',
	'https://fonts.bunny.net',
	'https://fonts.googleapis.com',
	'https://fonts.gstatic.com',
	'https://unpkg.com'
].join(' ')

/** The frame's Content-Security-Policy. Network access is denied by omission. */
const FRAME_CSP = [
	"default-src 'none'",
	`script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${RESOURCE_SOURCES}`,
	`style-src 'unsafe-inline' ${RESOURCE_SOURCES}`,
	`img-src ${RESOURCE_SOURCES}`,
	`font-src ${RESOURCE_SOURCES}`,
	`media-src ${RESOURCE_SOURCES}`,
	'worker-src blob: data:',
	'connect-src blob: data:',
	"frame-src 'none'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'"
].join('; ')

/** Frame stylesheet: bridges the host palette and supplies the artifact utilities. */
const FRAME_CSS = `
:root {
  color-scheme: light dark;
  --background: var(--dsh-art-background, transparent);
  --foreground: var(--dsh-art-foreground, light-dark(rgb(26 28 31), rgb(240 242 245)));
  --card: var(--dsh-art-card, light-dark(rgb(0 0 0 / 4%), rgb(255 255 255 / 6%)));
  --card-foreground: var(--dsh-art-foreground, light-dark(rgb(26 28 31), rgb(240 242 245)));
  --muted-foreground: var(--dsh-art-muted-foreground, light-dark(rgb(26 28 31 / 55%), rgb(240 242 245 / 55%)));
  --border: var(--dsh-art-border, light-dark(rgb(0 0 0 / 10%), rgb(255 255 255 / 12%)));
  --primary: var(--dsh-art-primary, light-dark(rgb(65 118 230), rgb(110 150 240)));
  --primary-foreground: var(--dsh-art-primary-foreground, light-dark(rgb(255 255 255), rgb(13 13 13)));
  --viz-series-1: var(--dsh-art-primary, light-dark(rgb(65 118 230), rgb(110 150 240)));
  --viz-series-2: light-dark(rgb(226 116 26), rgb(245 152 66));
  --viz-series-3: light-dark(rgb(16 148 82), rgb(72 196 130));
  --viz-series-4: light-dark(rgb(146 94 220), rgb(176 132 240));
  --viz-series-5: light-dark(rgb(212 66 84), rgb(240 110 126));
  --viz-series-6: light-dark(rgb(160 138 22), rgb(206 182 70));
  --radius: 8px;
  --font-size-base: 14px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--background);
  color: var(--foreground);
  font: 400 var(--font-size-base)/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; }
.viz-stat { display: flex; flex-direction: column; gap: 2px; }
.viz-stat-value { font-size: 20px; font-weight: 600; color: var(--foreground); font-variant-numeric: tabular-nums; }
.viz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.viz-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.viz-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.text-small { font-size: 12px; color: var(--muted-foreground); }
.btn {
  font: inherit; font-size: 13px; padding: 6px 12px; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--card); color: var(--foreground); cursor: pointer;
}
.btn:hover { border-color: var(--primary); }
.btn-primary { background: var(--primary); color: var(--primary-foreground); border-color: transparent; }
.form-label { font-size: 12px; color: var(--muted-foreground); }
.form-control, .form-select {
  font: inherit; font-size: 13px; padding: 5px 8px; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--card); color: var(--foreground);
  accent-color: var(--primary);
}
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
th { color: var(--muted-foreground); font-weight: 500; }
`

/** The palette and scheme a frame is built with. */
export interface ThemeSnapshot {
	vars: Record<string, string>
	scheme: 'light' | 'dark'
}

/** Drop a token value that could break out of the frame's stylesheet. */
export function sanitizeCssValue(value: string): string {
	const trimmed = value.trim()
	return /[;{}<>]/u.test(trimmed) ? '' : trimmed
}

/** Minimal HTML text escape for the frame title. */
function escapeHtml(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Read the bridged palette and the host color scheme off the app's own body,
 * where the design tokens are mounted.
 * @returns the palette map and the scheme the frame must paint with.
 */
export function resolveTheme(): ThemeSnapshot {
	const computed = getComputedStyle(document.body)
	const vars: Record<string, string> = {}
	for (const [frameName, hostToken] of TOKEN_BRIDGE) {
		vars[frameName] = computed.getPropertyValue(hostToken)
	}
	const scheme = computed.colorScheme
	const dark = scheme.includes('dark') && !scheme.includes('light')
	const light = scheme.includes('light') && !scheme.includes('dark')
	return {
		vars,
		scheme: dark ? 'dark'
			: light ? 'light'
				: document.body.hasAttribute('data-ds-dark-theme') ? 'dark'
					// A host always provides matchMedia; without it the system scheme is
					// simply unknown and the light palette wins.
					: typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
	}
}

/** Options for {@link buildFrameDoc}. */
export interface FrameDocOptions {
	/** Artifact source, already normalized by the host half. */
	html: string
	title: string
	theme: ThemeSnapshot
	/** Correlation token echoed on every frame message. */
	token: string
	/** Seeded in-memory storage, replayed from the card's cache on reload. */
	seed?: Record<string, string>
}

/**
 * Assemble the complete `srcdoc` document for one artifact frame.
 * @param options - source, palette, and correlation token.
 * @returns the frame document.
 */
export function buildFrameDoc(options: FrameDocOptions): string {
	const rootVars = Object.entries(options.theme.vars)
		.map(([name, value]) => [name, sanitizeCssValue(value)] as const)
		.filter(([, value]) => value.length > 0)
		.map(([name, value]) => `--dsh-art-${name}: ${value};`)
		.join(' ')
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<title>${escapeHtml(options.title)}</title>
<style>${FRAME_CSS}
:root { ${rootVars} color-scheme: ${options.theme.scheme}; }
body { padding: 4px 2px; }
</style>
</head>
<body>
<div id="dsh-artifact-root">${options.html}</div>
<script>${bridgeScript(options.token, options.seed ?? {})}<\/script>
</body>
</html>
`
}

/**
 * The frame-side bridge: storage shim, height report, interaction collector,
 * and the reconciler that adopts a patched revision in place.
 * @param token - correlation token echoed on every message.
 * @param seed - storage entries restored from the card's cache.
 * @returns the inline script body.
 */
function bridgeScript(token: string, seed: Record<string, string>): string {
	return `
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var SEED = ${JSON.stringify(seed)};
  function post(message) { try { parent.postMessage(message, '*'); } catch (error) {} }

  // ---- in-memory storage: an opaque origin has no real localStorage ----
  function makeStore(name, initial) {
    var data = {};
    for (var key in initial) if (Object.prototype.hasOwnProperty.call(initial, key)) data[key] = initial[key];
    function flush() { post({ type: 'dsh-artifacts:storage', token: TOKEN, store: name, entries: data }); }
    var api = {
      getItem: function (key) { key = String(key); return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
      setItem: function (key, value) { data[String(key)] = String(value); flush(); },
      removeItem: function (key) { delete data[String(key)]; flush(); },
      clear: function () { data = {}; flush(); },
      key: function (index) { var keys = Object.keys(data); return index < keys.length ? keys[index] : null; }
    };
    Object.defineProperty(api, 'length', { get: function () { return Object.keys(data).length; } });
    return api;
  }
  var localStore = makeStore('local', SEED);
  var sessionStore = makeStore('session', {});
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { return localStore; } });
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: function () { return sessionStore; } });
  } catch (error) {}

  // ---- height: the card sizes the frame, the frame cannot size itself ----
  function report() {
    post({ type: 'dsh-artifacts:height', token: TOKEN, height: document.documentElement.scrollHeight });
  }
  try { new ResizeObserver(report).observe(document.documentElement); } catch (error) {}
  addEventListener('load', report);
  post({ type: 'dsh-artifacts:height', token: TOKEN, height: document.documentElement.scrollHeight });

  // ---- interaction capture: explicit state, form values, button presses ----
  var clicks = [];
  function labelOf(element) {
    var explicit = element.getAttribute && element.getAttribute('data-artifact-action');
    var text = explicit || element.textContent || element.tagName;
    return String(text).replace(/\\s+/g, ' ').trim().slice(0, 80);
  }
  document.addEventListener('click', function (event) {
    var element = event.target;
    while (element && element !== document.body) {
      if (element.tagName === 'BUTTON' || element.tagName === 'A' || (element.getAttribute && element.getAttribute('role') === 'button')) break;
      element = element.parentElement;
    }
    if (!element || element === document.body) return;
    var label = labelOf(element);
    for (var index = 0; index < clicks.length; index++) {
      if (clicks[index].label === label) { clicks[index].count++; return; }
    }
    clicks.push({ label: label, count: 1 });
  }, true);
  function collect() {
    var payload = { state: null, fields: {}, actions: clicks.slice(0, 50) };
    try { if (window.__dshArtifactData !== undefined) payload.state = window.__dshArtifactData; } catch (error) {}
    var nodes = document.querySelectorAll('input, textarea, select');
    for (var index = 0; index < nodes.length; index++) {
      var node = nodes[index];
      if (node.type === 'password' || node.type === 'hidden') continue;
      var key = node.name || node.id || ('field-' + index);
      var value;
      if (node.type === 'checkbox' || node.type === 'radio') value = node.checked;
      else if (node.tagName === 'SELECT' && node.multiple) value = Array.prototype.map.call(node.selectedOptions, function (option) { return option.value; });
      else value = node.value;
      if (!Object.prototype.hasOwnProperty.call(payload.fields, key)) payload.fields[key] = value;
      else payload.fields[key] = [].concat(payload.fields[key], value);
    }
    return payload;
  }

  // ---- in-place adoption: reconcile a patched revision without reloading ----
  function syncAttributes(current, next) {
    var index, attributes = current.attributes;
    for (index = attributes.length - 1; index >= 0; index--) {
      if (!next.hasAttribute(attributes[index].name)) current.removeAttribute(attributes[index].name);
    }
    attributes = next.attributes;
    for (index = 0; index < attributes.length; index++) {
      if (current.getAttribute(attributes[index].name) !== attributes[index].value) {
        current.setAttribute(attributes[index].name, attributes[index].value);
      }
    }
  }
  function syncNode(current, next) {
    if (current.nodeType !== next.nodeType) { current.replaceWith(next); return; }
    if (current.nodeType !== 1) {
      if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
      return;
    }
    if (current.tagName !== next.tagName) { current.replaceWith(next); return; }
    syncAttributes(current, next);
    if (current.tagName === 'SCRIPT' || current.tagName === 'STYLE') {
      if (current.textContent !== next.textContent) current.textContent = next.textContent;
      return;
    }
    syncChildren(current, next);
  }
  function syncChildren(current, next) {
    var index = 0;
    for (;;) {
      var currentChild = current.childNodes[index];
      var nextChild = next.childNodes[index];
      if (!currentChild && !nextChild) return;
      if (currentChild && !nextChild) { current.removeChild(currentChild); continue; }
      if (!currentChild && nextChild) { current.appendChild(nextChild); index++; continue; }
      syncNode(currentChild, nextChild);
      index++;
    }
  }
  addEventListener('message', function (event) {
    var message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'dsh-artifacts:collect' && message.token === TOKEN) {
      post({ type: 'dsh-artifacts:data', token: TOKEN, data: collect() });
      return;
    }
    if (message.type === 'dsh-artifacts:sync' && message.token === TOKEN && typeof message.html === 'string') {
      var parsed = new DOMParser().parseFromString('<div id="dsh-artifact-root">' + message.html + '</div>', 'text/html');
      var incoming = parsed.getElementById('dsh-artifact-root');
      var live = document.getElementById('dsh-artifact-root');
      if (incoming && live) syncChildren(live, incoming);
      report();
      return;
    }
    if (message.type === 'dsh-artifacts:theme' && message.token === TOKEN && message.vars) {
      var root = document.documentElement;
      for (var name in message.vars) {
        if (message.vars[name]) root.style.setProperty('--dsh-art-' + name, message.vars[name]);
      }
      if (message.scheme) root.style.colorScheme = message.scheme;
      report();
    }
  });
})();
`
}

/** Correlation and message types, re-exported for the card component. */
export { COLLECT_MESSAGE, DATA_MESSAGE, HEIGHT_MESSAGE, STORAGE_MESSAGE, SYNC_MESSAGE, THEME_MESSAGE }
