window.__ModuleLoader__.load({
	id: "dsh-intelligent-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react_dom_client = require("react-dom/client");
		//#region src/meta.ts
		/** Package identity: the harness client-module id and the ModuleLoader entry id. */
		const PLUGIN_ID = "dsh-intelligent-ui";
		/** Wire tool name; also the key the client registers under `tool.call.toolview`. */
		const ARTIFACT_TOOL_NAME = "artifact";
		/** Card → frame: reconcile this revision into the live document. */
		const SYNC_MESSAGE = "dsh-artifacts:sync";
		/** Card → frame: repaint with a new host palette, without reloading. */
		const THEME_MESSAGE = "dsh-artifacts:theme";
		/** Whether an untrusted value is a non-null object. */
		function isObject(value) {
			return typeof value === "object" && value !== null;
		}
		/**
		* Recover a compiled DIL payload from persisted meta.
		*
		* Validates the fields the client actually reads to render — the program, its
		* constant pool, the streamed component spans, the state keys and the markdown
		* projection — and passes the rest through, because the value came from this
		* plugin's own host half rather than from a peer. A payload that cannot render
		* is rejected whole, so a card never mounts half a program.
		* @param value - untrusted `meta.dil`.
		* @returns the payload, or undefined when it cannot render.
		*/
		function dilCompiledFrom(value) {
			if (!isObject(value)) return void 0;
			if (typeof value.source !== "string") return void 0;
			if (typeof value.code !== "string" || value.code.length === 0) return void 0;
			if (!isObject(value.constants)) return void 0;
			if (typeof value.fallbackMarkdown !== "string") return void 0;
			if (!Array.isArray(value.stateKeys)) return void 0;
			if (!Array.isArray(value.genuiComponents)) return void 0;
			if (!isObject(value.appData)) return void 0;
			return value;
		}
		/** Narrow one untrusted value to {@link ArtifactMeta}. */
		function artifactMetaFrom(value) {
			if (!isObject(value)) return void 0;
			const row = value;
			if (row.kind !== "artifact") return void 0;
			if (typeof row.id !== "string" || row.id.length === 0) return void 0;
			if (typeof row.title !== "string") return void 0;
			if (typeof row.version !== "number" || !Number.isFinite(row.version)) return void 0;
			if (row.mode !== "inline" && row.mode !== "wide") return void 0;
			const engine = row.engine === "dil" ? "dil" : "html";
			const mode = row.mode;
			const shared = {
				kind: "artifact",
				engine,
				action: row.action === "patch" ? "patch" : "create",
				id: row.id,
				title: row.title,
				version: row.version,
				mode,
				sizeBytes: typeof row.sizeBytes === "number" ? row.sizeBytes : 0,
				...typeof row.versionNumber === "number" ? { versionNumber: row.versionNumber } : {},
				...typeof row.parentVersionId === "string" ? { parentVersionId: row.parentVersionId } : {},
				...typeof row.contentSha256 === "string" ? { contentSha256: row.contentSha256 } : {},
				...typeof row.contentBytes === "number" ? { contentBytes: row.contentBytes } : {},
				...typeof row.changelog === "string" ? { changelog: row.changelog } : {},
				...typeof row.session === "string" ? { session: row.session } : {}
			};
			if (engine === "dil") {
				const dil = dilCompiledFrom(row.dil);
				if (dil === void 0) return void 0;
				return {
					...shared,
					dil
				};
			}
			if (typeof row.html !== "string") return void 0;
			return {
				...shared,
				html: row.html,
				render: row.render === "reconcile" ? "reconcile" : "reload",
				sizeBytes: typeof row.sizeBytes === "number" ? row.sizeBytes : row.html.length
			};
		}
		/**
		* Narrow a revision to the HTML path.
		* @param meta - a revision of either path.
		* @returns the revision with `html` guaranteed, or undefined on the DIL path.
		*/
		function asHtmlMeta(meta) {
			return meta.engine === "html" && typeof meta.html === "string" ? meta : void 0;
		}
		/**
		* Narrow a revision to the DIL path.
		* @param meta - a revision of either path.
		* @returns the revision with `dil` guaranteed, or undefined on the HTML path.
		*/
		function asDilMeta(meta) {
			return meta.engine === "dil" && meta.dil !== void 0 ? meta : void 0;
		}
		/**
		* Read one string field out of a possibly incomplete JSON argument stream.
		*
		* While the model is still emitting a tool call, the accumulated `argsRaw` is a
		* JSON document cut mid-flight, so this scans the named string and decodes its
		* escapes without ever parsing the whole object. Returns the decoded prefix.
		* @param raw - accumulated argument text, complete or not.
		* @param field - property name to read.
		* @returns the decoded value, or undefined when the field has not started.
		*/
		function partialStringField(raw, field) {
			if (raw === void 0 || raw.length === 0) return void 0;
			const match = new RegExp(`"${field}"\\s*:\\s*"`, "u").exec(raw);
			if (match === null) return void 0;
			let out = "";
			let index = match.index + match[0].length;
			while (index < raw.length) {
				const char = raw[index];
				if (char === "\"") return out;
				if (char !== "\\") {
					out += char;
					index += 1;
					continue;
				}
				const next = raw[index + 1];
				if (next === void 0) return out;
				if (next === "u") {
					const hex = raw.slice(index + 2, index + 6);
					if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/u.test(hex)) return out;
					out += String.fromCharCode(Number.parseInt(hex, 16));
					index += 6;
					continue;
				}
				out += unescapeOne(next);
				index += 2;
			}
			return out;
		}
		/** Decode one JSON string escape body. */
		function unescapeOne(char) {
			switch (char) {
				case "n": return "\n";
				case "t": return "	";
				case "r": return "\r";
				case "b": return "\b";
				case "f": return "\f";
				default: return char;
			}
		}
		/**
		* A provisional meta assembled from a streaming call, before it settles.
		*
		* The client renders this while the model is still writing, so only the fields
		* needed to draw something are read, and nothing here is trusted as final.
		* @param raw - accumulated argument text, complete or not.
		* @param engine - override the path; by default it is read from the stream.
		* @returns a provisional meta, or undefined before the payload has started.
		*/
		function streamingMetaFromArgs(raw, engine) {
			const requested = partialStringField(raw, "engine");
			const path = engine ?? (requested === "html" ? "html" : "dil");
			const title = partialStringField(raw, "title");
			const mode = partialStringField(raw, "mode");
			const shared = {
				kind: "artifact",
				engine: path,
				action: "create",
				id: partialStringField(raw, "id") ?? "streaming",
				title: title === void 0 || title.length === 0 ? "Artifact" : title,
				version: 1,
				mode: mode === "wide" ? "wide" : "inline",
				sizeBytes: 0
			};
			if (path === "html") {
				const css = partialStringField(raw, "css");
				const html = partialStringField(raw, "html");
				const style = css === void 0 || css.trim().length === 0 ? "" : `<style>\n${css}\n</style>\n`;
				if (html === void 0 || html.length === 0) return style.length === 0 ? void 0 : {
					...shared,
					html: style,
					render: "reload",
					sizeBytes: style.length
				};
				const combined = `${style}${html}`;
				return {
					...shared,
					html: combined,
					render: "reload",
					sizeBytes: combined.length
				};
			}
			const source = partialStringField(raw, "source");
			if (source === void 0 || source.length === 0) return void 0;
			return {
				...shared,
				dil: { source }
			};
		}
		//#endregion
		//#region src/client/frame.ts
		/** Per-width height ceiling: inline cards stay readable, wide cards get room. */
		const HEIGHT_CAP = {
			inline: 800,
			wide: 1200
		};
		/** Host design tokens bridged into the frame as `--viz-*` variables. */
		const TOKEN_BRIDGE = [
			["foreground", "--dsw-alias-label-primary"],
			["card", "--dsw-alias-bg-layer-1"],
			["muted-foreground", "--dsw-alias-label-caption"],
			["border", "--dsw-alias-border-l2"],
			["primary", "--dsw-alias-brand-primary-new-colorprimary-new-color"],
			["primary-foreground", "--dsw-alias-label-primary-inverted"]
		];
		/** Static asset origins the frame may load from; everything else is denied. */
		const RESOURCE_SOURCES = [
			"blob:",
			"data:",
			"https://cdnjs.cloudflare.com",
			"https://cdn.jsdelivr.net",
			"https://esm.sh",
			"https://fonts.bunny.net",
			"https://fonts.googleapis.com",
			"https://fonts.gstatic.com",
			"https://unpkg.com"
		].join(" ");
		/** The frame's Content-Security-Policy. Network access is denied by omission. */
		const FRAME_CSP = [
			"default-src 'none'",
			`script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${RESOURCE_SOURCES}`,
			`style-src 'unsafe-inline' ${RESOURCE_SOURCES}`,
			`img-src ${RESOURCE_SOURCES}`,
			`font-src ${RESOURCE_SOURCES}`,
			`media-src ${RESOURCE_SOURCES}`,
			"worker-src blob: data:",
			"connect-src blob: data:",
			"frame-src 'none'",
			"object-src 'none'",
			"base-uri 'none'",
			"form-action 'none'"
		].join("; ");
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
`;
		/** Drop a token value that could break out of the frame's stylesheet. */
		function sanitizeCssValue(value) {
			const trimmed = value.trim();
			return /[;{}<>]/u.test(trimmed) ? "" : trimmed;
		}
		/** Minimal HTML text escape for the frame title. */
		function escapeHtml(text) {
			return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
		}
		/**
		* Read the bridged palette and the host color scheme off the app's own body,
		* where the design tokens are mounted.
		* @returns the palette map and the scheme the frame must paint with.
		*/
		function resolveTheme() {
			const computed = getComputedStyle(document.body);
			const vars = {};
			for (const [frameName, hostToken] of TOKEN_BRIDGE) vars[frameName] = computed.getPropertyValue(hostToken);
			const scheme = computed.colorScheme;
			const dark = scheme.includes("dark") && !scheme.includes("light");
			const light = scheme.includes("light") && !scheme.includes("dark");
			return {
				vars,
				scheme: dark ? "dark" : light ? "light" : document.body.hasAttribute("data-ds-dark-theme") ? "dark" : typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
			};
		}
		/**
		* Assemble the complete `srcdoc` document for one artifact frame.
		* @param options - source, palette, and correlation token.
		* @returns the frame document.
		*/
		function buildFrameDoc(options) {
			const rootVars = Object.entries(options.theme.vars).map(([name, value]) => [name, sanitizeCssValue(value)]).filter(([, value]) => value.length > 0).map(([name, value]) => `--dsh-art-${name}: ${value};`).join(" ");
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
`;
		}
		/**
		* The frame-side bridge: storage shim, height report, interaction collector,
		* and the reconciler that adopts a patched revision in place.
		* @param token - correlation token echoed on every message.
		* @param seed - storage entries restored from the card's cache.
		* @returns the inline script body.
		*/
		function bridgeScript(token, seed) {
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
`;
		}
		//#endregion
		//#region src/client/store.ts
		/** Page-local registry keyed by artifact id. */
		var ArtifactStore = class {
			#states = /* @__PURE__ */ new Map();
			#listeners = /* @__PURE__ */ new Map();
			#global = /* @__PURE__ */ new Set();
			#focused = null;
			/**
			* Record one revision without notifying anyone. Older versions never
			* overwrite a newer one, so replay settles on the highest version no matter
			* how the transcript window is assembled.
			* @param meta - the revision as the tool result carried it.
			* @returns the state in force after the call.
			*/
			publishQuiet(meta) {
				const known = this.#states.get(meta.id);
				if (known !== void 0 && known.meta.version > meta.version) return known;
				const next = {
					meta,
					storage: known?.storage ?? {}
				};
				this.#states.set(meta.id, next);
				return next;
			}
			/**
			* Deliver one artifact's current state to its listeners and to the catalog.
			* @param id - artifact id.
			*/
			notify(id) {
				const state = this.#states.get(id);
				if (state === void 0) return;
				for (const listener of this.#listeners.get(id) ?? []) listener(state);
				for (const listener of this.#global) listener(state);
			}
			/** Record and deliver in one step, for callers outside a render pass. */
			publish(meta) {
				const state = this.publishQuiet(meta);
				this.notify(meta.id);
				return state;
			}
			/** The revision in force, or undefined when the page has not seen the artifact. */
			get(id) {
				return this.#states.get(id);
			}
			/** Every artifact the page knows, newest revision first. */
			list() {
				return [...this.#states.values()].sort((left, right) => right.meta.version - left.meta.version);
			}
			/** Subscribe to one artifact's revisions. */
			subscribe(id, listener) {
				let set = this.#listeners.get(id);
				if (set === void 0) {
					set = /* @__PURE__ */ new Set();
					this.#listeners.set(id, set);
				}
				set.add(listener);
				return () => {
					set.delete(listener);
					if (set.size === 0) this.#listeners.delete(id);
				};
			}
			/** Subscribe to any artifact's revisions, for a catalog view. */
			subscribeAll(listener) {
				this.#global.add(listener);
				return () => {
					this.#global.delete(listener);
				};
			}
			/**
			* Remember what one artifact's frame wrote to its storage, so a later reload
			* can replay it.
			* @param id - artifact id.
			* @param entries - the frame's full storage map.
			*/
			rememberStorage(id, entries) {
				const known = this.#states.get(id);
				if (known === void 0) return;
				known.storage = entries;
			}
			/**
			* Point the right column at one artifact.
			*
			* A frame inside the conversation and the column are two views of one
			* artifact, so opening the column from a frame also selects it there.
			* @param id - artifact id.
			*/
			focus(id) {
				this.#focused = id;
				for (const listener of this.#global) listener(this.#states.get(id));
			}
			/** The artifact the column was last pointed at, when any. */
			focused() {
				return this.#focused;
			}
			/** Forget one artifact (the model destroyed it). */
			forget(id) {
				this.#states.delete(id);
				for (const listener of this.#global) listener();
			}
		};
		/** The single page-local store every card and the panel share. */
		const artifactStore = new ArtifactStore();
		/**
		* The session input facade the tool view was rendered with.
		*
		* A frame mounted from a fence outside any slot has no slot props, so it reads
		* the facade from here instead; the tool view is always rendered in the same
		* session, and it records the facade as it renders.
		*/
		const sessionInput = { current: void 0 };
		/**
		* Opens one artifact in the right column, set by the browser half once the
		* sidebar services are known. A frame calls it when the reader asks to expand
		* the artifact it already sees inline.
		*/
		const panelOpener = { current: void 0 };
		//#endregion
		//#region src/client/ArtifactView.tsx
		/**
		* The `artifact` tool view: a live, sandboxed preview inside the conversation.
		*
		* One frame per card, never remounted. While the model is still writing the
		* call, the partial source is pumped into the running frame over postMessage, so
		* markup appears as it arrives instead of the frame reloading on every delta.
		* When the call settles, the frame reloads once so the artifact's scripts run
		* against the finished document; every later `patch` whose scripts are unchanged
		* is reconciled into the live document, keeping the artifact's DOM, its input
		* values, and its in-memory variables.
		*
		* Ownership. Exactly one card per artifact carries the frame — the one that
		* created it, or the first one the transcript window still holds. Later `patch`
		* cards publish through the shared store and render a compact update row, so a
		* patch reaches the live frame instead of spawning a second preview.
		* @module dsh-intelligent-ui/client/ArtifactView
		*/
		/** Minimum gap between streamed reconciler pushes, in milliseconds. */
		const PUMP_MS = 120;
		const HEADER = {
			display: "flex",
			alignItems: "baseline",
			gap: 8,
			flexWrap: "wrap",
			fontSize: 12,
			opacity: .75,
			margin: "2px 0 6px"
		};
		const ACTION = {
			font: "inherit",
			fontSize: 11,
			padding: "2px 8px",
			borderRadius: 6,
			border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
			background: "transparent",
			color: "inherit",
			cursor: "pointer"
		};
		const FRAME = {
			display: "block",
			width: "100%",
			border: 0,
			background: "transparent",
			colorScheme: "normal"
		};
		/** First line of a tool result's text content, for quiet rows. */
		function firstLine(block) {
			for (const part of block.content ?? []) if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
				const newline = part.text.indexOf("\n");
				return newline === -1 ? part.text : part.text.slice(0, newline);
			}
			return "artifact";
		}
		/** Whether the streamed arguments already say this call creates rather than patches. */
		function looksLikeCreate(raw) {
			const action = partialStringField(raw, "action");
			if (action !== void 0) return action === "create" || action.length === 0;
			return partialStringField(raw, "id") === void 0;
		}
		/**
		* The `artifact` row in the tool process.
		*
		* It renders the artifact itself only while the call is running — the turn is
		* open then, so the reader watches the markup arrive. Once the call settles the
		* row goes compact: the artifact's frame belongs to the marker the model writes
		* in its answer (see `fence.tsx`), and the row keeps a way to reach the same
		* artifact in the right column or to preview it here instead.
		* @param props - the tool-call seat's props.
		* @returns the row.
		*/
		function ArtifactView(props) {
			const partial = props.useToolCallArgumentsPartial === void 0 ? "" : props.useToolCallArgumentsPartial();
			const block = props.block;
			const isResult = props.phase === "result";
			const argsRaw = block.call?.argsRaw ?? block.argsRaw;
			const meta = isResult && block.isError !== true ? artifactMetaFrom(block.meta) ?? streamingMetaFromArgs(argsRaw) : void 0;
			(0, react.useEffect)(() => {
				if (props.inputActions !== void 0) sessionInput.current = props.inputActions;
			}, [props.inputActions]);
			(0, react.useEffect)(() => {
				if (isResult && meta !== void 0) artifactStore.publish(meta);
			}, [
				isResult,
				meta?.id,
				meta?.version,
				meta?.action
			]);
			if (isResult && (block.isError === true || meta === void 0)) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuietRow, { text: firstLine(block) });
			if (isResult && meta !== void 0) {
				const settled = asHtmlMeta(meta);
				return settled === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DilRow, { meta }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ArtifactRow, { meta: settled });
			}
			const provisional = props.phase === "preparing" ? streamingMetaFromArgs(partial) : streamingMetaFromArgs(argsRaw);
			const provisionalHtml = provisional === void 0 ? void 0 : asHtmlMeta(provisional);
			if (provisional !== void 0 && provisionalHtml === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuietRow, { text: "GenUI · 正在生成界面…" });
			if (provisionalHtml === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuietRow, { text: "Artifact · 生成中…" });
			if (!looksLikeCreate(argsRaw)) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuietRow, { text: "Artifact · 正在修改…" });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ArtifactFrame, {
				callId: props.callId,
				meta: void 0,
				pumpHtml: provisionalHtml.html,
				inputActions: props.inputActions
			});
		}
		/** A single quiet line, for failures and empty results. */
		function QuietRow({ text }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: HEADER,
				children: text
			});
		}
		/**
		* The settled row for a DIL revision: what the interface is, and where to open it.
		*
		* Unlike the HTML row there is nothing to preview inline: the compiled program's
		* interface is rendered at the marker the model wrote, and duplicating it here
		* would put two live copies of the same state on screen.
		* @param props - the revision this row reports.
		* @returns the row.
		*/
		function DilRow({ meta }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: HEADER,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { fontWeight: 500 },
						children: meta.title
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["v", meta.version] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
						"· ",
						meta.dil?.stateKeys.length ?? 0,
						" 个控件状态"
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { opacity: .55 },
						children: meta.id
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							marginLeft: "auto",
							display: "flex",
							gap: 6,
							alignItems: "center"
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: ACTION,
							onClick: () => panelOpener.current?.(meta.id),
							children: "在侧栏打开"
						})
					})
				]
			});
		}
		/**
		* The settled row: what the artifact is, and the two ways to open it.
		* @param props - the revision this row reports.
		* @returns the row.
		*/
		function ArtifactRow({ meta }) {
			const [preview, setPreview] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: HEADER,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { fontWeight: 500 },
						children: meta.title
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["v", meta.version] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
						"· ",
						meta.sizeBytes,
						" 字节"
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { opacity: .55 },
						children: meta.id
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: {
							marginLeft: "auto",
							display: "flex",
							gap: 6,
							alignItems: "center"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: ACTION,
							onClick: () => panelOpener.current?.(meta.id),
							children: "在侧栏打开"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: ACTION,
							onClick: () => setPreview((value) => !value),
							children: preview ? "收起预览" : "在此预览"
						})]
					})
				]
			}), preview && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ArtifactFrame, {
				callId: `row:${meta.id}`,
				meta,
				inputActions: sessionInput.current
			})] });
		}
		/**
		* One artifact frame: sandbox, stream pump, height bridge, storage, adoption.
		* Exported because the turn tail renders the same frame when the tool process is
		* folded — the in-place card is inside the fold and therefore out of sight.
		*/
		function ArtifactFrame({ callId, meta, pumpHtml, inputActions, onOpenPanel }) {
			const iframeRef = (0, react.useRef)(null);
			const storageRef = (0, react.useRef)(meta === void 0 ? {} : artifactStore.get(meta.id)?.storage ?? {});
			const adoptedRef = (0, react.useRef)(meta?.version ?? 0);
			const sourceRef = (0, react.useRef)(meta);
			const pendingRef = (0, react.useRef)(null);
			const loadedRef = (0, react.useRef)(false);
			const pumpTimerRef = (0, react.useRef)(null);
			const lastPumpRef = (0, react.useRef)(0);
			const [theme, setTheme] = (0, react.useState)(() => resolveTheme());
			const themeRef = (0, react.useRef)(theme);
			themeRef.current = theme;
			const [frame, setFrame] = (0, react.useState)(() => ({
				html: meta?.html ?? "",
				title: meta?.title ?? "Artifact",
				nonce: 0
			}));
			const doc = (0, react.useMemo)(() => buildFrameDoc({
				html: frame.html,
				title: frame.title,
				theme: themeRef.current,
				token: callId,
				seed: storageRef.current
			}), [frame.nonce, callId]);
			sourceRef.current = artifactStore.get(meta?.id ?? "")?.meta ?? meta;
			const pushToFrame = (0, react.useCallback)((message) => {
				const frameElement = iframeRef.current;
				if (frameElement?.contentWindow == null) return false;
				frameElement.contentWindow.postMessage(message, "*");
				return true;
			}, []);
			(0, react.useEffect)(() => {
				if (pumpHtml === void 0 || pumpHtml.length === 0) return;
				const send = () => {
					lastPumpRef.current = Date.now();
					pushToFrame({
						type: SYNC_MESSAGE,
						token: callId,
						html: pumpHtml
					});
				};
				const elapsed = Date.now() - lastPumpRef.current;
				if (elapsed >= PUMP_MS) {
					send();
					return;
				}
				if (pumpTimerRef.current !== null) clearTimeout(pumpTimerRef.current);
				pumpTimerRef.current = setTimeout(send, PUMP_MS - elapsed);
				return () => {
					if (pumpTimerRef.current !== null) clearTimeout(pumpTimerRef.current);
				};
			}, [
				pumpHtml,
				callId,
				pushToFrame
			]);
			(0, react.useEffect)(() => {
				const bump = () => setTheme(resolveTheme());
				const observer = new MutationObserver(bump);
				observer.observe(document.documentElement, { attributes: true });
				observer.observe(document.body, { attributes: true });
				const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : void 0;
				media?.addEventListener("change", bump);
				return () => {
					observer.disconnect();
					media?.removeEventListener("change", bump);
				};
			}, []);
			(0, react.useEffect)(() => {
				pushToFrame({
					type: THEME_MESSAGE,
					token: callId,
					vars: theme.vars,
					scheme: theme.scheme
				});
			}, [
				theme,
				callId,
				pushToFrame
			]);
			(0, react.useEffect)(() => {
				if (meta === void 0) return;
				return artifactStore.subscribe(meta.id, (state) => {
					if (state === void 0) return;
					if (state.meta.version <= adoptedRef.current) return;
					const settled = asHtmlMeta(state.meta);
					if (settled === void 0) return;
					adoptedRef.current = settled.version;
					if (settled.render === "reconcile" && loadedRef.current && pushToFrame({
						type: "dsh-artifacts:sync",
						token: callId,
						html: settled.html
					})) return;
					storageRef.current = artifactStore.get(settled.id)?.storage ?? storageRef.current;
					setFrame((current) => ({
						html: settled.html,
						title: settled.title,
						nonce: current.nonce + 1
					}));
				});
			}, [
				meta?.id,
				callId,
				pushToFrame
			]);
			(0, react.useEffect)(() => {
				const onMessage = (event) => {
					const frameElement = iframeRef.current;
					if (frameElement === null || event.source !== frameElement.contentWindow) return;
					const message = event.data;
					if (message === null || typeof message !== "object" || message.token !== callId) return;
					if (message.type === "dsh-artifacts:height") {
						if (typeof message.height !== "number" || !Number.isFinite(message.height)) return;
						loadedRef.current = true;
						const mode = sourceRef.current?.mode ?? "inline";
						setHeight(Math.max(48, Math.min(Math.ceil(message.height), HEIGHT_CAP[mode])));
						return;
					}
					if (message.type === "dsh-artifacts:storage") {
						if (message.store !== "local" || message.entries === void 0) return;
						storageRef.current = message.entries;
						const id = sourceRef.current?.id;
						if (id !== void 0) artifactStore.rememberStorage(id, message.entries);
						return;
					}
					if (message.type === "dsh-artifacts:data") {
						const resolve = pendingRef.current;
						pendingRef.current = null;
						if (resolve !== null) resolve(message.data);
					}
				};
				window.addEventListener("message", onMessage);
				return () => window.removeEventListener("message", onMessage);
			}, [callId]);
			const [height, setHeight] = (0, react.useState)(48);
			const [busy, setBusy] = (0, react.useState)(false);
			const [notice, setNotice] = (0, react.useState)(null);
			/** Ask the frame for the user's interaction and hand it to the session input. */
			const submitInteraction = (0, react.useCallback)(() => {
				const source = sourceRef.current;
				if (source === void 0) return;
				if (inputActions === void 0) {
					setNotice("这个会话没有可用的输入通道");
					return;
				}
				setBusy(true);
				setNotice(null);
				const timer = setTimeout(() => {
					if (pendingRef.current === null) return;
					pendingRef.current = null;
					setBusy(false);
					setNotice("artifact 未在 2 秒内响应采集请求");
				}, 2e3);
				pendingRef.current = (data) => {
					clearTimeout(timer);
					const span = inputActions.captureInsertion();
					if (!inputActions.insertText(interactionReport(source, data), span)) {
						setBusy(false);
						setNotice("插入被拒绝：草稿已变化，请重试");
						return;
					}
					inputActions.submit();
					setBusy(false);
					setNotice("已把交互数据发回会话");
				};
				if (!pushToFrame({
					type: "dsh-artifacts:collect",
					token: callId,
					id: source.id
				})) {
					clearTimeout(timer);
					pendingRef.current = null;
					setBusy(false);
					setNotice("预览还没准备好");
				}
			}, [
				inputActions,
				callId,
				pushToFrame
			]);
			/** Keep the rendered source for a user who wants it outside the app. */
			const exportHtml = (0, react.useCallback)(() => {
				const html = buildFrameDoc({
					html: sourceRef.current?.html ?? "",
					title: sourceRef.current?.title ?? "Artifact",
					theme: themeRef.current,
					token: callId,
					seed: storageRef.current
				});
				const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
				const anchor = document.createElement("a");
				anchor.href = url;
				anchor.download = `${(sourceRef.current?.title ?? "artifact").replaceAll(/[^\p{L}\p{N}_-]+/gu, "-").replaceAll(/^-|-$/gu, "") || "artifact"}.html`;
				anchor.click();
				setTimeout(() => {
					URL.revokeObjectURL(url);
				}, 1e4);
			}, [callId]);
			const copySource = (0, react.useCallback)(() => {
				navigator.clipboard.writeText(sourceRef.current?.html ?? "");
				setNotice("源码已复制");
			}, []);
			const title = sourceRef.current?.title ?? "Artifact";
			const id = sourceRef.current?.id;
			const version = sourceRef.current?.version;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: HEADER,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { fontWeight: 500 },
							children: title
						}),
						version !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: { opacity: .7 },
							children: ["v", version]
						}),
						id !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { opacity: .55 },
							children: id
						}),
						version === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { opacity: .7 },
							children: "生成中…"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: {
								marginLeft: "auto",
								display: "flex",
								gap: 6,
								alignItems: "center"
							},
							children: [
								onOpenPanel !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: ACTION,
									onClick: onOpenPanel,
									children: "在侧栏打开"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: ACTION,
									disabled: busy || version === void 0,
									onClick: submitInteraction,
									children: busy ? "提交中…" : "提交交互数据"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: ACTION,
									onClick: copySource,
									children: "复制源码"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: ACTION,
									onClick: exportHtml,
									children: "导出 HTML"
								})
							]
						})
					]
				}),
				notice !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						...HEADER,
						opacity: .65
					},
					children: notice
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("iframe", {
					ref: iframeRef,
					sandbox: "allow-scripts allow-modals",
					referrerPolicy: "no-referrer",
					title,
					srcDoc: doc,
					style: {
						...FRAME,
						height
					}
				})
			] });
		}
		/** The message a submitted interaction becomes in the conversation. */
		function interactionReport(meta, data) {
			const body = JSON.stringify(data ?? null, null, 2);
			return [
				`我在 artifact「${meta.title}」（${meta.id}，v${meta.version}）里的交互数据：`,
				"",
				"```json",
				body.length > 12e3 ? `${body.slice(0, 12e3)}\n… (截断)` : body,
				"```",
				"",
				"请据此继续。"
			].join("\n");
		}
		//#endregion
		//#region src/client/dil-state.ts
		/** Last published state, by artifact id. */
		const values = /* @__PURE__ */ new Map();
		/** Adoption points, by artifact id. */
		const listeners = /* @__PURE__ */ new Map();
		/**
		* The state an artifact is showing now, for a mount that is about to open.
		* @param id - artifact id.
		* @returns the last published state, or an empty object when nothing has published.
		*/
		function dilStateOf(id) {
			return values.get(id) ?? {};
		}
		/**
		* Whether two snapshots carry the same values.
		* @param a - one snapshot.
		* @param b - another.
		* @returns true when every key agrees.
		*/
		function sameValues(a, b) {
			const keys = Object.keys(a);
			if (keys.length !== Object.keys(b).length) return false;
			for (const key of keys) if (a[key] !== b[key]) return false;
			return true;
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
		function publishDilState(id, state, origin) {
			const previous = values.get(id);
			if (previous !== void 0 && sameValues(previous, state)) return;
			values.set(id, state);
			for (const listener of listeners.get(id) ?? []) {
				if (listener === origin) continue;
				try {
					listener(state);
				} catch {}
			}
		}
		/**
		* Adopt every later change to an artifact's state.
		* @param id - artifact id.
		* @param listener - called with each state another mount publishes.
		* @returns the disposer that stops the subscription.
		*/
		function subscribeDilState(id, listener) {
			const set = listeners.get(id) ?? /* @__PURE__ */ new Set();
			listeners.set(id, set);
			set.add(listener);
			return () => {
				set.delete(listener);
				if (set.size === 0) listeners.delete(id);
			};
		}
		//#endregion
		//#region src/client/dil/renderer/dom.ts
		let activeDocument;
		/** Point every factory at the document that owns the view being rendered. */
		function useDocument(next) {
			activeDocument = next;
		}
		/** The document new nodes are created in. */
		function currentDocument() {
			return activeDocument ?? globalThis.document;
		}
		/**
		* The window that owns the view.
		*
		* Constructors are per-realm: a `ResizeObserver` or `matchMedia` taken from the top
		* window and handed a node in another document throws or silently never fires.
		*/
		function currentWindow() {
			return activeDocument?.defaultView ?? globalThis;
		}
		function el(tag, className) {
			const node = currentDocument().createElement(tag);
			if (className) node.className = className;
			return node;
		}
		/** Escape the five characters that would otherwise become markup. */
		function esc(value) {
			return String(value == null ? "" : value).replace(/[&<>"]/gu, (char) => ({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				"\"": "&quot;"
			})[char] ?? char);
		}
		/** Numeric scale (`gap={2}`) and size tokens (`gap="lg"`) both resolve to px. */
		const SPACING = {
			0: 0,
			1: 4,
			2: 8,
			3: 12,
			4: 16,
			5: 20,
			6: 24,
			8: 32
		};
		const SPACING_TOKENS = {
			none: 0,
			xs: 4,
			sm: 8,
			md: 12,
			lg: 16,
			xl: 24,
			"2xl": 32
		};
		/** Resolve one spacing prop to a CSS length. */
		function space(value) {
			if (value == null || value === false) return "";
			if (typeof value === "number") return (SPACING[value] ?? value * 4) + "px";
			if (typeof value === "string") {
				if (/^\d+$/u.test(value)) return (SPACING[value] ?? Number(value) * 4) + "px";
				if (value in SPACING_TOKENS) return SPACING_TOKENS[value] + "px";
				return value;
			}
			return String(value);
		}
		/** Resolve one sizing prop (`height`, `width`) to a CSS length. */
		function length(value) {
			if (value == null || value === "") return "";
			return typeof value === "number" ? value + "px" : String(value);
		}
		/** `justify="space-between"` (CSS spelling) → the `between` token. */
		function justifyToken(value) {
			return String(value).replace(/^space-/u, "").replace(/^flex-/u, "");
		}
		/** Build a className from a base and `[condition, class]` pairs. */
		function cls(base, ...pairs) {
			let out = base;
			for (const [on, name] of pairs) if (on) out += " " + name;
			return out;
		}
		/** Applied to every component: the stable marker plus universal sizing props. */
		function applyCommon(node, props) {
			node.setAttribute("data-d-component", String(props.__tag));
			node.style.width = length(props.width);
			node.style.display = props.hidden ? "none" : "";
		}
		/**
		* The element the user is actually typing in.
		*
		* `document.activeElement` stops at the outermost shadow host, so walk down: each
		* host that has a focused node inside it is not the answer, its `shadowRoot.activeElement` is.
		* @returns the deepest focused element, or null.
		*/
		function activeElement() {
			try {
				let node = currentDocument().activeElement;
				while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
				return node;
			} catch {
				return null;
			}
		}
		/** Options as models write them: `[{label,value}]`, or bare strings. */
		function normalizeOptions(options) {
			if (!Array.isArray(options)) return [];
			return options.map((option) => option != null && typeof option === "object" ? {
				label: String(option.label ?? option.value ?? ""),
				value: option.value ?? option.label
			} : {
				label: String(option),
				value: option
			});
		}
		//#endregion
		//#region src/client/dil/renderer/components/charts.ts
		const PALETTE = [
			"var(--dil-chart-1)",
			"var(--dil-chart-2)",
			"var(--dil-chart-3)",
			"var(--dil-chart-4)",
			"var(--dil-chart-5)"
		];
		function fmtNumber(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return String(value ?? "");
			const abs = Math.abs(n);
			if (abs >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/u, "") + "亿";
			if (abs >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/u, "") + "万";
			return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
		}
		function fmtValue(value, series) {
			return (series.valuePrefix ?? "") + fmtNumber(value) + (series.valueSuffix ?? "");
		}
		/** "Nice" axis ticks: 4–6 steps of 1/2/2.5/5 × 10^k covering [lo, hi]. */
		function niceTicks(low, high) {
			const lo = low;
			let hi = high;
			if (lo === hi) hi = lo + 1;
			const raw = (hi - lo) / 4;
			const magnitude = 10 ** Math.floor(Math.log10(raw));
			const step = [
				1,
				2,
				2.5,
				5,
				10
			].map((multiple) => multiple * magnitude).find((candidate) => candidate >= raw) ?? raw;
			const start = Math.floor(lo / step) * step;
			const ticks = [];
			for (let tick = start; tick <= hi + step * 1e-9; tick += step) ticks.push(Number(tick.toFixed(10)));
			const last = ticks[ticks.length - 1];
			if (last !== void 0 && last < hi) ticks.push(last + step);
			return ticks;
		}
		function normalizeSeries(entry, fallbackType) {
			const source = entry ?? {};
			const dataKey = source.dataKey ?? source.key ?? "value";
			return {
				dataKey: String(dataKey),
				type: source.type === void 0 ? fallbackType === void 0 ? void 0 : String(fallbackType) : String(source.type),
				...source.label === void 0 ? {} : { label: String(source.label) },
				...source.valuePrefix === void 0 ? {} : { valuePrefix: String(source.valuePrefix) },
				...source.valueSuffix === void 0 ? {} : { valueSuffix: String(source.valueSuffix) }
			};
		}
		/** Normalize the two accepted data dialects into rows, series and the x key. */
		function model(props) {
			const rows = Array.isArray(props.data) ? props.data : [];
			const series = (Array.isArray(props.series) && props.series.length > 0 ? props.series : [{
				dataKey: "value",
				type: props.type || "bar"
			}]).map((entry) => normalizeSeries(entry, props.type || "bar"));
			let xKey = props.xAxis && typeof props.xAxis === "object" ? props.xAxis.dataKey : typeof props.xAxis === "string" ? props.xAxis : null;
			if (!xKey) xKey = rows[0] && rows[0].label != null ? "label" : "name";
			return {
				rows,
				series,
				xKey: String(xKey)
			};
		}
		function legend(series) {
			if (series.length < 2 && !series[0]?.label) return "";
			return `<div class="dil-chart-legend">${series.map((entry, index) => `<span><i style="background:${PALETTE[index % PALETTE.length]}"></i>${esc(entry.label ?? entry.dataKey)}</span>`).join("")}</div>`;
		}
		function cartesian(props, width) {
			const { rows, series, xKey } = model(props);
			const height = typeof props.height === "number" ? props.height : 220;
			const w = Math.max(240, width);
			const pad = {
				l: 48,
				r: 12,
				t: 12,
				b: 28
			};
			const plotW = w - pad.l - pad.r;
			const plotH = height - pad.t - pad.b;
			const values = rows.flatMap((row) => series.map((entry) => Number(row[entry.dataKey]))).filter(Number.isFinite);
			const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values, 1));
			const lo = ticks[0] ?? 0;
			const hi = ticks[ticks.length - 1] ?? 1;
			const y = (value) => pad.t + plotH - (value - lo) / (hi - lo || 1) * plotH;
			const band = plotW / Math.max(1, rows.length);
			const x = (index) => pad.l + band * index + band / 2;
			const out = [];
			for (const tick of ticks) {
				const yy = y(tick).toFixed(1);
				out.push(`<line x1="${pad.l}" x2="${w - pad.r}" y1="${yy}" y2="${yy}" class="dil-chart-grid${tick === 0 ? " dil-chart-zero" : ""}"/>`);
				out.push(`<text x="${pad.l - 8}" y="${yy}" class="dil-chart-axis" text-anchor="end" dominant-baseline="middle">${esc(fmtNumber(tick))}</text>`);
			}
			const stride = Math.max(1, Math.ceil(rows.length * 64 / plotW));
			rows.forEach((row, index) => {
				if (index % stride) return;
				out.push(`<text x="${x(index).toFixed(1)}" y="${height - 8}" class="dil-chart-axis" text-anchor="middle">${esc(row[xKey])}</text>`);
			});
			const bars = series.filter((entry) => (entry.type ?? "bar") === "bar");
			const barW = Math.max(4, Math.min(40, band * .64 / Math.max(1, bars.length)));
			series.forEach((entry, seriesIndex) => {
				const tone = PALETTE[seriesIndex % PALETTE.length];
				const tip = (row, value) => `<title>${esc(row[xKey])} · ${esc(entry.label ?? entry.dataKey)}：${esc(fmtValue(value, entry))}</title>`;
				if ((entry.type ?? "bar") === "line" || entry.type === "scatter") {
					const points = rows.map((row, index) => [x(index), y(Number(row[entry.dataKey]) || 0)]);
					if (entry.type !== "scatter") {
						const d = points.map(([px, py], index) => `${index ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join("");
						out.push(`<path d="${d}" fill="none" stroke="${tone}" class="dil-chart-line"/>`);
					}
					if (props.showDots !== false || entry.type === "scatter") rows.forEach((row, index) => {
						const point = points[index];
						out.push(`<circle cx="${point[0].toFixed(1)}" cy="${point[1].toFixed(1)}" r="3.5" fill="${tone}" class="dil-chart-dot">${tip(row, row[entry.dataKey])}</circle>`);
					});
					return;
				}
				const barIndex = bars.indexOf(entry);
				rows.forEach((row, index) => {
					const value = Number(row[entry.dataKey]) || 0;
					const bx = x(index) - barW * bars.length / 2 + barIndex * barW + 1;
					const top = y(Math.max(value, 0));
					const h = Math.max(1, y(Math.min(value, 0)) - top);
					out.push(`<rect x="${bx.toFixed(1)}" y="${top.toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${tone}" class="dil-chart-bar">${tip(row, value)}</rect>`);
				});
			});
			return legend(series) + `<svg class="dil-chart-svg" width="${w}" height="${height}" viewBox="0 0 ${w} ${height}" role="img">${out.join("")}</svg>`;
		}
		function pie(props) {
			const rows = Array.isArray(props.data) ? props.data : [];
			const valueKey = Array.isArray(props.series) && props.series[0]?.dataKey || "value";
			const nameKey = typeof props.xAxis === "string" ? props.xAxis : rows[0] && rows[0].label != null ? "label" : "name";
			const items = rows.map((row) => ({
				label: row[String(nameKey)] ?? row.label,
				value: Math.max(0, Number(row[String(valueKey)]) || 0)
			}));
			const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
			const radius = 70;
			const inner = 44;
			let angle = -Math.PI / 2;
			const arcs = items.map((item, index) => {
				const sweep = item.value / total * Math.PI * 2;
				const a0 = angle;
				const a1 = angle + Math.max(sweep - .012, .001);
				angle += sweep;
				const point = (rad, a) => `${(80 + rad * Math.cos(a)).toFixed(2)} ${(80 + rad * Math.sin(a)).toFixed(2)}`;
				const large = a1 - a0 > Math.PI ? 1 : 0;
				return `<path d="${sweep >= Math.PI * 2 - 1e-6 ? `M${point(radius, 0)}A${radius} ${radius} 0 1 1 ${point(radius, Math.PI)}A${radius} ${radius} 0 1 1 ${point(radius, 0)}M${point(inner, 0)}A${inner} ${inner} 0 1 0 ${point(inner, Math.PI)}A${inner} ${inner} 0 1 0 ${point(inner, 0)}Z` : `M${point(radius, a0)}A${radius} ${radius} 0 ${large} 1 ${point(radius, a1)}L${point(inner, a1)}A${inner} ${inner} 0 ${large} 0 ${point(inner, a0)}Z`}" fill="${PALETTE[index % PALETTE.length]}" fill-rule="evenodd" class="dil-chart-slice"><title>${esc(item.label)}：${esc(fmtNumber(item.value))}</title></path>`;
			});
			const legendRows = items.map((item, index) => `<div class="dil-pie-item"><i style="background:${PALETTE[index % PALETTE.length]}"></i><span>${esc(item.label)}</span><b>${esc(fmtNumber(item.value))}</b><em>${Math.round(item.value / total * 100)}%</em></div>`).join("");
			return `<div class="dil-pie"><svg viewBox="0 0 160 160" width="160" height="160" role="img">${arcs.join("")}</svg><div class="dil-pie-legend">${legendRows}</div></div>`;
		}
		function chartFactory(draw) {
			return (props, ctx) => {
				const node = el("div", "dil-chart");
				let sig = null;
				let latest = props;
				let width = 0;
				const redraw = () => {
					const next = JSON.stringify([
						latest.data,
						latest.series,
						latest.xAxis,
						latest.height,
						latest.type,
						width
					]);
					if (next === sig) return;
					sig = next;
					node.innerHTML = draw(latest, width);
				};
				function update(p) {
					applyCommon(node, p);
					latest = p;
					width = node.clientWidth || width || 560;
					redraw();
				}
				const Observer = currentWindow().ResizeObserver;
				if (typeof Observer === "function") {
					const observer = new Observer((entries) => {
						const entry = entries[0];
						if (!entry) return;
						const next = Math.round(entry.contentRect.width);
						if (next && Math.abs(next - width) > 2) {
							width = next;
							redraw();
						}
					});
					observer.observe(node);
					ctx?.onTeardown?.(() => observer.disconnect());
				}
				update(props);
				return {
					node,
					update
				};
			};
		}
		var charts_default = {
			chart: chartFactory(cartesian),
			"pie-chart": chartFactory(pie)
		};
		//#endregion
		//#region src/client/dil/renderer/components/data.ts
		var data_default = {
			table(props) {
				const node = el("div", "dil-table");
				node.setAttribute("role", "table");
				return {
					node,
					update: (p) => applyCommon(node, p)
				};
			},
			"table-row"(props) {
				const node = el("div");
				node.setAttribute("role", "row");
				function update(p) {
					applyCommon(node, p);
					node.className = cls("dil-table-row", [p.header, "dil-table-header"], [p.onClick, "dil-clickable"], [p.selected, "dil-selected"]);
				}
				update(props);
				return {
					node,
					update
				};
			},
			"table-cell"(props) {
				const node = el("div", "dil-table-cell");
				node.setAttribute("role", "cell");
				function update(p) {
					applyCommon(node, p);
					node.style.textAlign = p.align === "end" || p.align === "right" ? "right" : p.align === "center" ? "center" : "";
					node.style.alignItems = p.align === "end" || p.align === "right" ? "flex-end" : p.align === "center" ? "center" : "";
					node.style.flex = p.width ? `0 0 ${length(p.width)}` : "";
				}
				update(props);
				return {
					node,
					update
				};
			},
			list(props) {
				const node = el(props.marker === "number" ? "ol" : "ul");
				function update(p) {
					applyCommon(node, p);
					node.className = cls("dil-list", [p.marker === "number", "dil-list-number"], [p.marker === "none", "dil-list-none"]);
				}
				update(props);
				return {
					node,
					update
				};
			},
			"list-item"(props) {
				const node = el("li", "dil-list-item");
				return {
					node,
					update: (p) => applyCommon(node, p)
				};
			},
			progress(props) {
				const wrap = el("div", "dil-progress");
				const head = el("div", "dil-progress-head");
				const label = el("span");
				const pct = el("span", "dil-progress-pct");
				head.append(label, pct);
				const track = el("div", "dil-progress-track");
				const bar = el("div", "dil-progress-bar");
				track.append(bar);
				wrap.append(head, track);
				function update(p) {
					applyCommon(wrap, p);
					const max = Number(p.max ?? 100) || 100;
					const value = Number(p.value ?? 0);
					const ratio = Math.max(0, Math.min(1, value / max));
					bar.style.width = `${ratio * 100}%`;
					const tone = p.color || (ratio > .9 ? "danger" : ratio > .7 ? "warning" : "accent");
					bar.className = `dil-progress-bar dil-tone-${tone}`;
					label.textContent = p.label != null ? String(p.label) : "";
					pct.textContent = p.showValue ? `${Math.round(ratio * 100)}%` : "";
					head.style.display = p.label != null || p.showValue ? "" : "none";
				}
				update(props);
				return {
					node: wrap,
					update
				};
			}
		};
		//#endregion
		//#region src/client/dil/renderer/icons.ts
		/**
		* Icon set — Lucide-style 24px strokes, inlined so the renderer has no asset
		* requests. Names follow the ones models actually emit (the captured artifact uses
		* `layers-3`, `chart-no-axes-combined`, `receipt-text`, …). Unknown names fall back
		* to a neutral dot rather than a misleading glyph.
		*
		* Inlining is also what keeps the sandbox frame's `default-src 'none'` intact: no
		* icon font, no sprite sheet, no `img-src`.
		* @module dsh-intelligent-ui/client/dil/renderer/icons
		*/
		const PATHS = {
			activity: "<path d=\"M22 12h-4l-3 9L9 3l-3 9H2\"/>",
			"alert-triangle": "<path d=\"M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z\"/><path d=\"M12 9v4M12 17h.01\"/>",
			"arrow-down": "<path d=\"M12 5v14M6 13l6 6 6-6\"/>",
			"arrow-right": "<path d=\"M5 12h14M13 6l6 6-6 6\"/>",
			"arrow-up": "<path d=\"M12 19V5M6 11l6-6 6 6\"/>",
			beaker: "<path d=\"M9 3h6M10 3v6.5L5.2 17A2 2 0 0 0 7 20h10a2 2 0 0 0 1.8-3L14 9.5V3\"/>",
			bell: "<path d=\"M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9\"/><path d=\"M10.3 21a1.9 1.9 0 0 0 3.4 0\"/>",
			calendar: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M16 2v4M8 2v4M3 10h18\"/>",
			"chart-line": "<path d=\"M3 3v18h18\"/><path d=\"m19 9-5 5-4-4-3 3\"/>",
			"chart-no-axes-combined": "<path d=\"M12 16v5M16 14v7M20 10v11M22 3l-8.6 8.6a2 2 0 0 1-2.8 0L9.4 10.4a2 2 0 0 0-2.8 0L2 15M4 18v3M8 14v7\"/>",
			check: "<path d=\"M20 6 9 17l-5-5\"/>",
			"check-circle": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"m9 12 2 2 4-4\"/>",
			"chevron-down": "<path d=\"m6 9 6 6 6-6\"/>",
			"chevron-right": "<path d=\"m9 6 6 6-6 6\"/>",
			clock: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 7v5l3 2\"/>",
			copy: "<rect x=\"9\" y=\"9\" width=\"12\" height=\"12\" rx=\"2\"/><path d=\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\"/>",
			cpu: "<rect x=\"4\" y=\"4\" width=\"16\" height=\"16\" rx=\"2\"/><rect x=\"9\" y=\"9\" width=\"6\" height=\"6\"/><path d=\"M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2\"/>",
			database: "<ellipse cx=\"12\" cy=\"5\" rx=\"9\" ry=\"3\"/><path d=\"M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5\"/><path d=\"M3 12c0 1.7 4 3 9 3s9-1.3 9-3\"/>",
			dollar: "<path d=\"M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6\"/>",
			"external-link": "<path d=\"M15 3h6v6\"/><path d=\"M10 14 21 3\"/><path d=\"M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5\"/>",
			"file-search": "<path d=\"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h5\"/><path d=\"M14 2v6h6\"/><circle cx=\"16.5\" cy=\"16.5\" r=\"2.5\"/><path d=\"m21 21-2.7-2.7\"/>",
			heart: "<path d=\"M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z\"/>",
			home: "<path d=\"m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z\"/><path d=\"M9 22V12h6v10\"/>",
			info: "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 16v-4M12 8h.01\"/>",
			layers: "<path d=\"m12 2 9 5-9 5-9-5 9-5Z\"/><path d=\"m3 12 9 5 9-5\"/><path d=\"m3 17 9 5 9-5\"/>",
			"layers-3": "<path d=\"m12 2 9 5-9 5-9-5 9-5Z\"/><path d=\"m3 12 9 5 9-5\"/><path d=\"m3 17 9 5 9-5\"/>",
			loader: "<path d=\"M12 2v4M12 18v4M4.9 4.9l2.9 2.9M16.2 16.2l2.9 2.9M2 12h4M18 12h4M4.9 19.1l2.9-2.9M16.2 7.8l2.9-2.9\"/>",
			minus: "<path d=\"M5 12h14\"/>",
			"minus-circle": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M8 12h8\"/>",
			pause: "<rect x=\"6\" y=\"4\" width=\"4\" height=\"16\" rx=\"1\"/><rect x=\"14\" y=\"4\" width=\"4\" height=\"16\" rx=\"1\"/>",
			play: "<path d=\"m6 3 14 9-14 9V3Z\"/>",
			plus: "<path d=\"M12 5v14M5 12h14\"/>",
			"plus-circle": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M8 12h8M12 8v8\"/>",
			"receipt-text": "<path d=\"M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z\"/><path d=\"M14 8H8M16 12H8M13 16H8\"/>",
			"refresh-cw": "<path d=\"M21 12a9 9 0 0 1-15 6.7L3 16\"/><path d=\"M3 12a9 9 0 0 1 15-6.7L21 8\"/><path d=\"M21 3v5h-5M3 21v-5h5\"/>",
			"rotate-ccw": "<path d=\"M3 12a9 9 0 1 0 3-6.7L3 8\"/><path d=\"M3 3v5h5\"/>",
			search: "<circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m20 20-3.5-3.5\"/>",
			"search-x": "<circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m20 20-3.5-3.5M13.5 8.5l-5 5M8.5 8.5l5 5\"/>",
			settings: "<path d=\"M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
			shield: "<path d=\"M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z\"/>",
			sparkles: "<path d=\"M12 3 9.9 8.6 4 9.5l4.5 4-1.3 6L12 16.6 16.8 19.5l-1.3-6 4.5-4-5.9-.9Z\"/>",
			star: "<path d=\"m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1Z\"/>",
			timer: "<circle cx=\"12\" cy=\"14\" r=\"8\"/><path d=\"M12 10v4l2 2M10 2h4\"/>",
			trash: "<path d=\"M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6\"/>",
			"trending-down": "<path d=\"m22 17-8.5-8.5-5 5L2 7\"/><path d=\"M16 17h6v-6\"/>",
			"trending-up": "<path d=\"m22 7-8.5 8.5-5-5L2 17\"/><path d=\"M16 7h6v6\"/>",
			user: "<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21a8 8 0 0 1 16 0\"/>",
			wallet: "<path d=\"M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5\"/><path d=\"M16 12h.01\"/>",
			workflow: "<rect x=\"3\" y=\"3\" width=\"8\" height=\"8\" rx=\"2\"/><path d=\"M7 11v4a2 2 0 0 0 2 2h4\"/><rect x=\"13\" y=\"13\" width=\"8\" height=\"8\" rx=\"2\"/>",
			x: "<path d=\"M18 6 6 18M6 6l12 12\"/>",
			"x-circle": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"m15 9-6 6M9 9l6 6\"/>",
			zap: "<path d=\"M4 14h7l-1 8 9-12h-7l1-8-9 12Z\"/>"
		};
		const FALLBACK = "<circle cx=\"12\" cy=\"12\" r=\"3\"/>";
		const SIZES = {
			xs: 12,
			sm: 14,
			md: 16,
			lg: 20,
			xl: 24
		};
		/** SVG markup for an icon; `size` is a token or a pixel number. */
		function iconSvg(name, size) {
			const px = typeof size === "number" ? size : SIZES[String(size)] ?? 16;
			return "<svg viewBox=\"0 0 24 24\" width=\"" + px + "\" height=\"" + px + "\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\">" + (PATHS[String(name)] ?? FALLBACK) + "</svg>";
		}
		Object.keys(PATHS);
		//#endregion
		//#region src/client/dil/renderer/components/host.ts
		const HOST = { MemoryCite() {
			const node = el("span", "dil-memory-cite");
			node.innerHTML = iconSvg("sparkles", 12) + "<span>记忆</span>";
			node.title = "这段回答引用了已保存的记忆";
			node.setAttribute("role", "note");
			return {
				node,
				update() {}
			};
		} };
		/**
		* Mount a host tag, or the placeholder that says why it is not there.
		* @param tag - the PascalCase tag the tree asked for.
		* @param props - its props, including `__resolutionId`.
		* @param ctx - patcher context, carrying the compiler's `componentResults`.
		*/
		function createHostComponent(tag, props, ctx) {
			const id = props && props.__resolutionId;
			const result = id && ctx.componentResults ? ctx.componentResults[String(id)] : null;
			const factory = HOST[tag];
			if (factory && result && result.status === "resolved" && result.componentName === tag) {
				const handle = factory(props, result);
				handle.node.setAttribute("data-d-resolution", String(id));
				return handle;
			}
			ctx.onMissingComponent?.(tag, result);
			const node = el("div", "dil-widget dil-widget-unresolved");
			node.innerHTML = `<span class="dil-widget-icon">${iconSvg("layers", 16)}</span><span class="dil-widget-body"><b>${esc(tag)}</b><small>${result ? "组件状态：" + esc(result.status) : "宿主未提供该组件"}</small></span>`;
			return {
				node,
				update() {}
			};
		}
		//#endregion
		//#region src/client/dil/renderer/components/controls.ts
		function radioItem(name, value) {
			const node = el("label", "dil-radio");
			const input = el("input");
			input.type = "radio";
			input.name = name;
			const dot = el("span", "dil-radio-dot");
			const body = el("span", "dil-radio-body");
			node.append(input, dot, body);
			node.dilValue = value;
			return {
				node,
				input,
				body
			};
		}
		function syncRadio(item, group) {
			const on = String(item.dilValue) === group.dataset.value;
			const input = item.querySelector("input");
			if (input && input.checked !== on) input.checked = on;
			item.classList.toggle("dil-checked", on);
		}
		/** Set a value without fighting the user: skip while this element has focus. */
		function syncValue(input, next) {
			if (activeElement() === input) return;
			if (input.value !== next) input.value = next;
		}
		const controls = {
			button(props) {
				const node = el("button");
				node.type = "button";
				function update(p) {
					applyCommon(node, p);
					node.className = cls("dil-button", [true, `dil-variant-${p.variant || "solid"}`], [p.color, `dil-tone-${p.color}`], [p.size, `dil-size-${p.size}`], [p.block, "dil-block"]);
					node.disabled = !!p.disabled;
				}
				update(props);
				return {
					node,
					update
				};
			},
			input(props) {
				const node = el("input", "dil-input");
				function update(p) {
					applyCommon(node, p);
					node.type = [
						"number",
						"email",
						"search",
						"date",
						"time"
					].includes(p.type) ? p.type : "text";
					node.placeholder = p.placeholder || "";
					node.disabled = !!p.disabled;
					syncValue(node, p.value == null ? "" : String(p.value));
				}
				update(props);
				return {
					node,
					update,
					readValue: () => node.type === "number" ? Number(node.value) : node.value
				};
			},
			textarea(props) {
				const node = el("textarea", "dil-input dil-textarea");
				function update(p) {
					applyCommon(node, p);
					node.placeholder = p.placeholder || "";
					node.rows = Number(p.rows) || 3;
					node.disabled = !!p.disabled;
					syncValue(node, p.value == null ? "" : String(p.value));
				}
				update(props);
				return {
					node,
					update
				};
			},
			checkbox(props) {
				const wrap = el("label", "dil-checkbox");
				const input = el("input");
				input.type = "checkbox";
				const box = el("span", "dil-checkbox-box");
				box.innerHTML = iconSvg("check", 12);
				const body = el("span", "dil-checkbox-body");
				const fallbackLabel = el("span");
				wrap.append(input, box, body);
				function update(p) {
					applyCommon(wrap, p);
					const on = !!(p.checked !== void 0 ? p.checked : p.value);
					input.checked = on;
					input.disabled = !!p.disabled;
					wrap.className = cls("dil-checkbox", [on, "dil-checked"], [p.disabled, "dil-disabled"], [p.lineThrough && on, "dil-done"]);
					if (p.label != null) {
						fallbackLabel.textContent = String(p.label);
						if (!fallbackLabel.parentNode) body.append(fallbackLabel);
					} else fallbackLabel.remove();
				}
				update(props);
				return {
					node: wrap,
					childHost: body,
					update,
					events: { change: "onChange" },
					readValue: () => input.checked
				};
			},
			switch(props) {
				const made = controls.checkbox(props);
				const update = made.update;
				made.update = (p) => {
					update(p);
					made.node.classList.add("dil-switch");
				};
				made.update(props);
				return made;
			},
			select(props) {
				const wrap = el("div", "dil-select");
				const node = el("select");
				const chevron = el("span", "dil-select-chevron");
				chevron.innerHTML = iconSvg("chevron-down", 14);
				wrap.append(node, chevron);
				let sig = null;
				let options = [];
				function update(p) {
					applyCommon(wrap, p);
					options = normalizeOptions(p.options);
					const next = JSON.stringify(options);
					if (next !== sig) {
						sig = next;
						node.textContent = "";
						for (const option of options) {
							const item = el("option");
							item.value = String(option.value);
							item.textContent = option.label;
							node.append(item);
						}
					}
					node.disabled = !!p.disabled;
					const value = String(p.value ?? "");
					for (const option of Array.from(node.options)) if (option.selected !== (option.value === value)) option.selected = option.value === value;
				}
				update(props);
				const readValue = () => (options.find((option) => String(option.value) === node.value) ?? { value: node.value }).value;
				return {
					node: wrap,
					update,
					events: { change: "onChange" },
					readValue
				};
			},
			"segmented-control"(props) {
				const node = el("div");
				let sig = null;
				let options = [];
				function update(p) {
					applyCommon(node, p);
					node.className = cls("dil-segmented", [p.block, "dil-block"], [p.size, `dil-size-${p.size}`]);
					options = normalizeOptions(p.options);
					const next = JSON.stringify(options);
					if (next !== sig) {
						sig = next;
						node.textContent = "";
						options.forEach((option, index) => {
							const button = el("button", "dil-segmented-item");
							button.type = "button";
							button.textContent = option.label;
							button.dataset.index = String(index);
							node.append(button);
						});
					}
					const value = String(p.value ?? "");
					Array.from(node.querySelectorAll(".dil-segmented-item")).forEach((element, index) => {
						const button = element;
						const active = options[index] && String(options[index].value) === value;
						button.classList.toggle("dil-active", !!active);
						button.setAttribute("aria-pressed", active ? "true" : "false");
						button.disabled = !!p.disabled;
					});
				}
				update(props);
				const readValue = (event) => {
					const target = event.target;
					const button = target && typeof target.closest === "function" ? target.closest(".dil-segmented-item") : null;
					if (!button) return void 0;
					return options[Number(button.dataset.index)]?.value;
				};
				return {
					node,
					update,
					events: { click: "onChange" },
					readValue
				};
			},
			/**
			* Two dialects:
			*   options  `<radio-group options={[…]} value onChange/>`
			*   children `<radio-group value onChange><radio value="a">…</radio></radio-group>`
			*            (the captured artifact's form; each <radio> renders itself below)
			* Both end up as `.dil-radio` items with a real radio input, so one `change`
			* listener on the group reads the chosen item's original value.
			*/
			"radio-group"(props) {
				const node = el("div", "dil-radio-group");
				node.dataset.name = "dil-radio-" + Math.random().toString(36).slice(2, 8);
				const items = el("div", "dil-radio-items");
				const children = el("div", "dil-radio-items");
				node.append(items, children);
				let sig = null;
				function update(p) {
					applyCommon(node, p);
					node.classList.toggle("dil-row", p.direction === "row");
					node.dataset.value = String(p.value ?? "");
					node.dilValue = p.value;
					const options = normalizeOptions(p.options);
					const next = JSON.stringify(options);
					if (next !== sig) {
						sig = next;
						items.textContent = "";
						for (const option of options) {
							const item = radioItem(node.dataset.name, option.value);
							item.body.textContent = option.label;
							items.append(item.node);
						}
					}
					for (const item of Array.from(items.children)) syncRadio(item, node);
				}
				update(props);
				const readValue = (event) => {
					const target = event.target;
					return target && typeof target.closest === "function" ? target.closest(".dil-radio")?.dilValue : void 0;
				};
				return {
					node,
					childHost: children,
					update,
					events: { change: "onChange" },
					readValue
				};
			},
			radio(props) {
				const item = radioItem("", props.value);
				function update(p) {
					applyCommon(item.node, p);
					item.node.dilValue = p.value;
					const group = typeof item.node.closest === "function" ? item.node.closest(".dil-radio-group") : null;
					if (group) {
						item.input.name = group.dataset.name;
						syncRadio(item.node, group);
					} else {
						item.input.checked = !!p.checked;
						item.node.classList.toggle("dil-checked", !!p.checked);
					}
					item.input.disabled = !!p.disabled;
				}
				update(props);
				return {
					node: item.node,
					childHost: item.body,
					update
				};
			},
			slider(props) {
				const wrap = el("div", "dil-slider");
				const head = el("div", "dil-slider-head");
				const label = el("span", "dil-slider-label");
				const value = el("span", "dil-slider-value");
				head.append(label, value);
				const input = el("input");
				input.type = "range";
				wrap.append(head, input);
				function update(p) {
					applyCommon(wrap, p);
					const min = Number(p.min ?? 0);
					const max = Number(p.max ?? 100);
					const current = Number(p.value ?? min);
					input.min = String(min);
					input.max = String(max);
					input.step = String(p.step ?? 1);
					input.disabled = !!p.disabled;
					if (activeElement() !== input && Number(input.value) !== current) input.value = String(current);
					wrap.style.setProperty("--fill", `${max > min ? (current - min) / (max - min) * 100 : 0}%`);
					label.textContent = p.label != null ? String(p.label) : "";
					value.textContent = p.showValue === false ? "" : String(current);
					head.style.display = p.label != null ? "" : "none";
				}
				update(props);
				return {
					node: wrap,
					update,
					events: { input: "onChange" },
					readValue: () => Number(input.value)
				};
			}
		};
		//#endregion
		//#region src/client/dil/renderer/components/layout.ts
		/** The flex containers share one implementation; only the default direction differs. */
		function flexBox(direction) {
			return (props) => {
				const node = el("div");
				function update(p) {
					applyCommon(node, p);
					node.className = cls(`dil-box dil-${direction}`, [p.border, "dil-border"], [p.radius, `dil-radius-${p.radius}`], [p.background, `dil-bg-${p.background}`], [p.align, `dil-align-${p.align}`], [p.justify, `dil-justify-${justifyToken(p.justify)}`], [p.wrap, "dil-wrap"], [p.flex, "dil-flex"], [p.clip, "dil-clip"]);
					node.style.gap = space(p.gap);
					node.style.padding = space(p.padding);
					node.style.flex = p.flex && p.flex !== true ? String(p.flex) : "";
					node.style.height = length(p.height);
				}
				update(props);
				return {
					node,
					update
				};
			};
		}
		var layout_default = {
			box: flexBox("column"),
			column: flexBox("column"),
			row: flexBox("row"),
			grid(props) {
				const node = el("div", "dil-grid");
				function update(p) {
					applyCommon(node, p);
					const cols = Number(p.columns) || 2;
					node.style.gridTemplateColumns = `repeat(auto-fit, minmax(min(100%, max(160px, calc((100% - ${cols - 1} * var(--gap, 12px)) / ${cols}))), 1fr))`;
					node.style.setProperty("--gap", space(p.gap) || "12px");
					node.style.gap = space(p.gap) || "12px";
				}
				update(props);
				return {
					node,
					update
				};
			},
			"grid-item"(props) {
				const node = el("div", "dil-grid-item");
				function update(p) {
					applyCommon(node, p);
					node.style.gridColumn = p.span ? `span ${p.span}` : "";
				}
				update(props);
				return {
					node,
					update
				};
			},
			card(props) {
				const node = el("div");
				function update(p) {
					applyCommon(node, p);
					node.className = cls("dil-card", [p.background, `dil-bg-${p.background}`]);
					node.style.gap = space(p.gap);
					node.style.padding = space(p.padding);
				}
				update(props);
				return {
					node,
					update
				};
			},
			divider(props) {
				const node = el("hr");
				function update(p) {
					applyCommon(node, p);
					node.className = cls("dil-divider", [p.color === "subtle", "dil-divider-subtle"]);
				}
				update(props);
				return {
					node,
					update
				};
			},
			spacer(props) {
				const node = el("div", "dil-spacer");
				return {
					node,
					update: (p) => applyCommon(node, p)
				};
			}
		};
		//#endregion
		//#region src/client/dil/renderer/components/text.ts
		function textLike(tag, base) {
			return (props) => {
				const node = el(tag);
				function update(p) {
					applyCommon(node, p);
					node.className = cls(base, [p.size, `dil-size-${p.size}`], [p.color, `dil-color-${p.color}`], [p.weight, `dil-weight-${p.weight}`], [p.tabularNums, "dil-tabular"], [p.lineThrough, "dil-line-through"], [p.block, "dil-block"], [p.truncate, "dil-truncate"]);
					node.style.textAlign = p.textAlign || "";
				}
				update(props);
				return {
					node,
					update
				};
			};
		}
		var text_default = {
			text: textLike("span", "dil-text"),
			caption: textLike("span", "dil-text dil-caption"),
			label: textLike("span", "dil-text dil-label"),
			bold: textLike("strong", "dil-bold"),
			code: textLike("code", "dil-code"),
			title(props) {
				const node = el("div");
				function update(p) {
					applyCommon(node, p);
					node.className = cls("dil-title", [true, `dil-title-${p.size || "md"}`], [p.color, `dil-color-${p.color}`], [p.tabularNums, "dil-tabular"]);
					node.style.textAlign = p.textAlign || "";
				}
				update(props);
				return {
					node,
					update
				};
			},
			icon(props) {
				const node = el("span");
				let sig = null;
				function update(p) {
					applyCommon(node, p);
					node.className = cls("dil-icon", [p.inline, "dil-inline"], [p.color, `dil-color-${p.color}`]);
					const next = `${p.name}|${p.size}`;
					if (next !== sig) {
						sig = next;
						node.innerHTML = iconSvg(p.name, p.size);
					}
				}
				update(props);
				return {
					node,
					update
				};
			},
			badge(props) {
				const node = el("span");
				function update(p) {
					applyCommon(node, p);
					node.className = cls("dil-badge", [p.color, `dil-badge-${p.color}`], [p.size, `dil-size-${p.size}`]);
				}
				update(props);
				return {
					node,
					update
				};
			},
			link(props) {
				const node = el("a", "dil-link");
				node.target = "_blank";
				node.rel = "noreferrer noopener";
				function update(p) {
					applyCommon(node, p);
					if (p.href && /^https?:\/\//iu.test(p.href)) node.setAttribute("href", p.href);
					else node.removeAttribute("href");
				}
				update(props);
				return {
					node,
					update
				};
			},
			image(props) {
				const node = el("img", "dil-image");
				node.loading = "lazy";
				function update(p) {
					applyCommon(node, p);
					if (p.src && /^(https?:|data:image\/)/iu.test(p.src)) node.src = p.src;
					node.alt = p.alt || "";
					node.style.height = length(p.height) || "auto";
					node.style.borderRadius = p.radius === "full" ? "999px" : "";
				}
				update(props);
				return {
					node,
					update
				};
			},
			spinner(props) {
				const node = el("span", "dil-spinner");
				node.innerHTML = iconSvg("loader");
				return {
					node,
					update: (p) => applyCommon(node, p)
				};
			}
		};
		//#endregion
		//#region src/client/dil/renderer/patch.ts
		/** prop → default DOM event. `onChange` listens to `input` so typing updates live. */
		const EVENTS = {
			onClick: "click",
			onChange: "input",
			onInput: "input",
			onBlur: "blur",
			onFocus: "focus",
			onKeyDown: "keydown",
			onKeyUp: "keyup",
			onSubmit: "submit"
		};
		const isText = (node) => !!node && node.t === "#text";
		const isFragment = (node) => node.t === "#frag";
		/** Flatten `#frag` wrappers out of one child list, dropping empty nodes. */
		function flatten(nodes, out = []) {
			for (const node of nodes ?? []) {
				if (!node) continue;
				if (isFragment(node)) flatten(node.c, out);
				else out.push(node);
			}
			return out;
		}
		/**
		* Build a patcher over one factory table.
		* @param factories - tag → factory; unknown tags fall through to host components.
		* @param ctx - the context handed to every factory.
		*/
		function createPatcher(factories, ctx) {
			const bound = /* @__PURE__ */ new WeakMap();
			function createHandle(tag, props) {
				const withTag = {
					...props,
					__tag: tag
				};
				const factory = factories[tag];
				const handle = factory ? factory(withTag, ctx) : createHostComponent(tag, withTag, ctx);
				handle.node.setAttribute("data-d-component", tag);
				return handle;
			}
			/** Wire `on*` props to DOM listeners, reusing listeners whose fnId is unchanged. */
			function bindEvents(handle, props) {
				let boundProps = bound.get(handle);
				if (!boundProps) {
					boundProps = {};
					bound.set(handle, boundProps);
				}
				const override = {};
				for (const [domType, prop] of Object.entries(handle.events ?? {})) override[prop] = domType;
				for (const prop of Object.keys(EVENTS)) {
					const fnId = props[prop] && props[prop].__dilFn;
					const type = override[prop] ?? EVENTS[prop];
					const prev = boundProps[prop];
					if (prev && prev.fnId === fnId) continue;
					if (prev) handle.node.removeEventListener(prev.type, prev.listener);
					delete boundProps[prop];
					if (!fnId) continue;
					const listener = (event) => {
						const value = handle.readValue ? handle.readValue(event) : event.target && "value" in event.target ? event.target.value : void 0;
						if (handle.readValue && value === void 0 && type === "click" && prop === "onChange") return;
						ctx.onEvent(String(fnId), [value], {
							type: event.type,
							value
						});
					};
					handle.node.addEventListener(type, listener);
					boundProps[prop] = {
						fnId: String(fnId),
						type,
						listener
					};
				}
			}
			function create(entry) {
				if (isText(entry)) return {
					text: true,
					node: currentDocument().createTextNode(entry.v),
					children: []
				};
				const handle = createHandle(entry.t, entry.p ?? {});
				return {
					text: false,
					handle,
					node: handle.node,
					tag: entry.t,
					children: []
				};
			}
			function update(record, entry) {
				if (isText(entry)) {
					if (!record.text) return;
					if (record.node.nodeValue !== entry.v) record.node.nodeValue = entry.v;
					return;
				}
				if (record.text) return;
				const props = entry.p ?? {};
				record.handle.update({
					...props,
					__tag: record.tag
				});
				bindEvents(record.handle, props);
				patchChildren(record.handle.childHost ?? record.node, record.children, flatten(entry.c));
			}
			function sameShape(record, entry) {
				return isText(entry) ? record.text : !record.text && record.tag === entry.t;
			}
			function patchChildren(container, records, entries) {
				const next = [];
				entries.forEach((entry, index) => {
					const old = records[index];
					if (old && sameShape(old, entry)) {
						update(old, entry);
						next.push(old);
						return;
					}
					const made = create(entry);
					if (old) container.replaceChild(made.node, old.node);
					else container.appendChild(made.node);
					update(made, entry);
					next.push(made);
				});
				for (let index = entries.length; index < records.length; index += 1) container.removeChild(records[index].node);
				records.length = 0;
				records.push(...next);
			}
			return { patchChildren };
		}
		//#endregion
		//#region src/client/dil/renderer/index.ts
		/** The host's fixed vocabulary: tag → factory. The model cannot add to it. */
		const FACTORIES = {
			...layout_default,
			...text_default,
			...controls,
			...data_default,
			...charts_default
		};
		function componentResults(appData) {
			return (appData?.opGenui)?.componentResults ?? {};
		}
		/**
		* Mount a tree into one container and keep it patched.
		* @param container - where the tree renders; cleared by `destroy()`.
		* @param tree - the first tree, or null for an empty view.
		* @param options - event sink, appData, document.
		*/
		function mount(container, tree, options = {}) {
			useDocument(options.document ?? container.ownerDocument ?? globalThis.document);
			const teardowns = [];
			const ctx = {
				onEvent: (fnId, args, meta) => (options.onEvent ?? (() => {}))(fnId, args, meta),
				onMissingComponent: (tag, result) => options.onMissingComponent?.(tag, result),
				componentResults: componentResults(options.appData),
				onTeardown: (dispose) => teardowns.push(dispose)
			};
			const { patchChildren } = createPatcher(FACTORIES, ctx);
			const records = [];
			let current = null;
			const view = {
				update(nextTree) {
					current = nextTree;
					patchChildren(container, records, flatten(nextTree ? [nextTree] : []));
					container.setAttribute("data-dil-ready", "true");
				},
				setAppData(appData) {
					ctx.componentResults = componentResults(appData);
				},
				get tree() {
					return current;
				},
				destroy() {
					for (const dispose of teardowns.splice(0)) try {
						dispose();
					} catch {}
					container.textContent = "";
					records.length = 0;
				}
			};
			if (tree) view.update(tree);
			return view;
		}
		/** Base64 SHA-256 of {@link FRAME_SCRIPT}, as `script-src 'sha256-<hash>'`. */
		const FRAME_SCRIPT_SHA256 = "gwxZpFkWRS8JRs+C7QiXEDTrMMRfyEGblQ2WwREDGX4=";
		/** The runner's Content-Security-Policy. Hash-pinned, network-free. */
		const DIL_FRAME_CSP = [
			"default-src 'none'",
			`script-src 'sha256-${FRAME_SCRIPT_SHA256}' 'unsafe-eval'`,
			`worker-src blob: data:`,
			"base-uri 'none'",
			"form-action 'none'",
			"frame-src 'none'",
			"object-src 'none'"
		].join("; ");
		/** HTML-escape so the worker source survives a round-trip through `<template>`. */
		function escapeHtmlText(source) {
			return source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
		function buildRunnerHtml(options = {}) {
			const script = options.frameScript ?? "(function () {\n  'use strict';\n  var PROTOCOL = 1;\n  var RENDER_BUDGET_MS = 2500;\n  var MAX_RESPAWNS = 1;\n\n  var worker = null;\n  var workerUrl = null;\n  // Commands (setCompiledDil) travel on the data port, the same channel the worker\n  // listens on for them; the worker's global scope only handles lifecycle messages.\n  var dataPort = null;\n  var runnerMessage = null;\n  var renderTimer = null;\n  var respawns = 0;\n  var seq = 0;\n  var pending = new Map();\n\n  function post(msg) {\n    try { window.parent.postMessage(Object.assign({ __dilFrame: true, protocolVersion: PROTOCOL }, msg), '*'); } catch (e) {}\n  }\n\n  /**\n   * Diagnostics deliberately go over window.postMessage rather than the MessagePort.\n   * The port is the fast path for snapshots and acks, but it is also the thing most\n   * likely to be broken — and \"the channel you use to report that the channel is\n   * broken\" cannot be the channel itself.\n   */\n  function record(stage, phase, detail) {\n    try {\n      window.parent.postMessage(\n        { __dilFrame: true, kind: 'diagnostic', protocolVersion: PROTOCOL, stage: stage, phase: phase, detail: detail || null },\n        '*'\n      );\n    } catch (e) {}\n  }\n\n  function workerSource() {\n    var t = document.getElementById('dil-worker-source');\n    if (!t) return '';\n    // A <template>'s children live in .content — textContent on the element itself is\n    // always empty. Easy mistake, and it fails silently at exactly the wrong moment.\n    return t.content ? t.content.textContent : t.textContent;\n  }\n\n  function fail(stage, error) {\n    post({ __dilFrame: true, kind: 'failure', protocolVersion: PROTOCOL, stage: stage,\n           error: { name: (error && error.name) || 'Error', message: String((error && error.message) || error) } });\n  }\n\n  /**\n   * Spawn the sandbox Worker.\n   *\n   * Two transports, tried in order, because browser policy decides which one works:\n   *\n   *   blob:  - the normal path. Cheap, and the worker revokes its own URL on boot.\n   *   data:  - the fallback. A blob: Worker created from a document with an OPAQUE\n   *            origin (a sandboxed iframe without allow-same-origin) becomes\n   *            origin becomes blob:null/..., which some engines refuse to load, so the\n   *            worker script never evaluates. postMessage succeeds silently and nothing\n   *            ever comes back. Hence: the fallback is chosen by TIMEOUT, not by exception.\n   *\n   * Either way the worker announces itself with a ready message, so whether it booted is\n   * observable rather than assumed.\n   */\n  var WORKER_BOOT_TIMEOUT_MS = 1200;\n  var bootTimer = null;\n\n  function clearBootTimer() {\n    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }\n  }\n\n  function spawnWorker(attempt) {\n    attempt = attempt || 0;\n    var src = workerSource();\n    record('worker_create', 'begin', { attempt: attempt, bytes: src.length });\n    if (!src) { record('worker_create', 'reported_error', { reason: 'empty_worker_source' }); fail('worker_create', new Error('worker source is empty')); return; }\n\n    var transport;\n    try {\n      if (attempt === 0) {\n        var blob = new Blob(['(self.URL||self.webkitURL).revokeObjectURL(self.location.href);', src],\n                            { type: 'text/javascript;charset=utf-8' });\n        workerUrl = (window.URL || window.webkitURL).createObjectURL(blob);\n        worker = new Worker(workerUrl, { name: 'dil-sandbox' });\n        transport = 'blob';\n      } else {\n        worker = new Worker('data:text/javascript;charset=utf-8,' + encodeURIComponent(src), { name: 'dil-sandbox' });\n        transport = 'data';\n      }\n    } catch (e) {\n      record('worker_create', 'threw', { attempt: attempt, transport: transport || (attempt === 0 ? 'blob' : 'data'), message: String(e && e.message) });\n      if (attempt === 0) { spawnWorker(1); } else { fail('worker_create', e); }\n      return;\n    }\n\n    if (!worker) { fail('worker_create', new Error('Worker construction returned nothing')); return; }\n    record('worker_create', 'returned', { attempt: attempt, transport: transport });\n\n    // The boot ack is what tells us the transport actually works.\n    worker.onmessage = function (ev) {\n      var m = ev && ev.data;\n      if (m && m.__dilWorker === true && m.kind === 'ready') {\n        clearBootTimer();\n        record('worker_ready', 'received', { attempt: attempt, transport: transport, protocolVersion: m.protocolVersion });\n      }\n    };\n    worker.addEventListener('error', function (ev) {\n      record('worker_create', 'reported_error', { attempt: attempt, transport: transport, message: String((ev && ev.message) || '') });\n    });\n\n    clearBootTimer();\n    bootTimer = setTimeout(function () {\n      bootTimer = null;\n      record('worker_create', 'timeout', { attempt: attempt, transport: transport, budgetMs: WORKER_BOOT_TIMEOUT_MS });\n      try { if (worker) worker.terminate(); } catch (e) {}\n      worker = null;\n      if (attempt === 0) {\n        record('recovery', 'decision', { reason: 'blob_worker_never_booted', next: 'data_url' });\n        spawnWorker(1);\n      } else {\n        fail('worker_create', new Error('sandbox worker never booted on either transport'));\n      }\n    }, WORKER_BOOT_TIMEOUT_MS);\n\n    // control channel: health probes + diagnostics only\n    var ctrl = new MessageChannel();\n    ctrl.port1.onmessage = function (e) {\n      var m2 = e.data;\n      if (!m2) return;\n      if (m2.kind === 'healthy') record('health_probe', 'received', { stats: m2.stats || null });\n      else if (m2.kind === 'diagnostic') record(m2.stage, m2.phase, m2.detail);\n    };\n    ctrl.port1.start();\n    worker.postMessage({ __dilWorker: true, kind: 'initializeControl', protocolVersion: PROTOCOL }, [ctrl.port2]);\n\n    // data channel: compiled programs + snapshots\n    var data = new MessageChannel();\n    data.port1.onmessage = onWorkerMessage;\n    data.port1.start();\n    dataPort = data.port1;\n    var msg = Object.assign({}, runnerMessage, { __dilWorker: true, kind: 'createRunner', protocolVersion: PROTOCOL });\n    worker.postMessage(msg, [data.port2]);\n  }\n\n  function armWatchdog(stage) {\n    clearWatchdog();\n    renderTimer = setTimeout(function () {\n      renderTimer = null;\n      record('recovery', 'decision', { reason: 'render_budget_exceeded', stage: stage, budgetMs: RENDER_BUDGET_MS, respawns: respawns });\n      post({ __dilFrame: true, kind: 'timeout', protocolVersion: PROTOCOL, stage: stage });\n      if (respawns < MAX_RESPAWNS) {\n        respawns += 1;\n        recycle();\n      } else {\n        post({ __dilFrame: true, kind: 'quarantined', protocolVersion: PROTOCOL, reason: 'worker_unresponsive' });\n      }\n    }, RENDER_BUDGET_MS);\n  }\n\n  function clearWatchdog() { if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; } }\n\n  function recycle() {\n    clearBootTimer();\n    try { if (worker) worker.terminate(); } catch (e) {}\n    try { if (workerUrl) (self.URL || self.webkitURL).revokeObjectURL(workerUrl); } catch (e) {}\n    clearBootTimer();\n    worker = null;\n    workerUrl = null;\n    dataPort = null;\n    pending.clear();\n    spawnWorker(0);\n  }\n\n  function onWorkerMessage(e) {\n    var m = e.data;\n    if (!m || m.__dilWorker !== true) return;\n    switch (m.kind) {\n      case 'ready':\n        record('worker_ready', 'received', { protocolVersion: m.protocolVersion });\n        break;\n      case 'snapshot':\n        clearWatchdog();\n        record('snapshot_forward', 'sent', { version: m.version, reason: m.reason, hasError: !!m.error });\n        post({ __dilFrame: true, kind: 'snapshot', protocolVersion: PROTOCOL, runnerId: m.runnerId, tree: m.tree, version: m.version, error: m.error || null, stats: m.stats || null, reason: m.reason || null });\n        break;\n      case 'failure':\n        clearWatchdog();\n        post({ __dilFrame: true, kind: 'failure', protocolVersion: PROTOCOL, error: m.error, stage: m.stage });\n        break;\n      case 'response':\n        clearWatchdog();\n        if (m.id && pending.has(m.id)) { pending.delete(m.id); }\n        post({ __dilFrame: true, kind: 'ack', protocolVersion: PROTOCOL, id: m.id, ok: m.ok, error: m.error || null, stats: m.stats || null });\n        break;\n      case 'stateSnapshot':\n        post({ __dilFrame: true, kind: 'stateSnapshot', protocolVersion: PROTOCOL, state: m.state });\n        break;\n      case 'stateChanged':\n        // Remember the latest keyed state: if the watchdog recycles the worker, the\n        // respawned runner is seeded with it instead of snapping back to initial values.\n        if (runnerMessage) runnerMessage.initialState = m.state;\n        post({ __dilFrame: true, kind: 'stateChanged', protocolVersion: PROTOCOL, scope: m.scope, state: m.state, reason: m.reason });\n        break;\n    }\n  }\n\n  function onHostMessage(e) {\n    try { handleHostMessage(e); }\n    catch (err) {\n      // Anything thrown out of a message handler disappears into the event loop. If\n      // the frame cannot act on a command, the host must hear about it.\n      record('command', 'threw', { message: String((err && err.message) || err) });\n      post({ __dilFrame: true, kind: 'failure', protocolVersion: PROTOCOL, stage: 'command',\n             error: { name: (err && err.name) || 'Error', message: String((err && err.message) || err) } });\n    }\n  }\n\n  function handleHostMessage(e) {\n    var m = e.data;\n    record('frame_msg', 'received', { kind: (m && m.kind) || null, hasFrameFlag: !!(m && m.__dilFrame === true) });\n    if (!m || m.__dilFrame !== true) return;\n    switch (m.kind) {\n      case 'createRunner':\n        if (m.protocolVersion !== PROTOCOL) { record('runner_create', 'rejected', { reason: 'protocol_mismatch' }); return; }\n        record('runner_create', 'host_received', { runnerId: m.runnerId });\n        runnerMessage = { runnerId: m.runnerId, compiledDil: m.compiledDil, constants: m.constants || {}, appData: m.appData || {}, initialState: m.initialState || null };\n        record('runner_create', 'received', { runnerId: m.runnerId, bytes: (m.compiledDil || '').length });\n        if (worker) { recycle(); } else { spawnWorker(0); }\n        break;\n      case 'setCompiledDil':\n        if (!runnerMessage) return;\n        runnerMessage.compiledDil = m.compiledDil;\n        if (m.constants) runnerMessage.constants = m.constants;\n        if (m.appData) runnerMessage.appData = m.appData;\n        if (!worker) { spawnWorker(0); return; }\n        var id = 'c' + ++seq;\n        pending.set(id, true);\n        (dataPort || worker).postMessage({ __dilWorker: true, kind: 'command', command: 'setCompiledDil', id: id,\n                             data: { compiledDil: m.compiledDil, constants: runnerMessage.constants, appData: runnerMessage.appData } });\n        armWatchdog('setCompiledDil');\n        break;\n      case 'trigger':\n        if (!worker) return;\n        worker.postMessage({ __dilWorker: true, kind: 'trigger', fnId: m.fnId, args: m.args || [] });\n        armWatchdog('trigger');\n        break;\n      case 'stateSnapshotRequest':\n        if (worker) worker.postMessage({ __dilWorker: true, kind: 'stateSnapshotRequest' });\n        break;\n      case 'dispose':\n        clearWatchdog();\n        clearBootTimer();\n        try { if (worker) worker.postMessage({ __dilWorker: true, kind: 'dispose' }); } catch (e) {}\n        try { if (worker) worker.terminate(); } catch (e) {}\n        worker = null;\n        break;\n    }\n  }\n\n  // Transport note\n  // --------------\n  // The real DIL runner hands the host one end of a MessageChannel on its ready\n  // message, and does all business traffic over that port. The replica uses\n  // window.postMessage throughout instead: it is the same structured-clone channel, it\n  // works from an opaque-origin frame, and unlike a port the traffic is visible in\n  // DevTools and to the host, which matters a great deal when the sandbox misbehaves.\n  window.addEventListener('message', function (e) {\n    var m = e.data;\n    record('frame_window_msg', 'received', {\n      hasSource: !!e.source,\n      sourceIsParent: e.source === window.parent,\n      kind: (m && m.kind) || null,\n      frameFlag: !!(m && m.__dilFrame === true),\n    });\n    if (e.source !== window.parent) return;\n    if (!m || m.__dilFrame !== true) return;\n    if (m.kind === 'probe') { record('frame_probe', 'received', { readyState: document.readyState }); return; }\n    onHostMessage(e);\n  });\n\n  window.addEventListener('pagehide', function (e) {\n    if (e.persisted) return;\n    clearWatchdog();\n    clearBootTimer();\n    try { if (worker) worker.terminate(); } catch (err) {}\n    worker = null;\n  });\n\n  // Hand the host one end of our port. After this the host never needs\n  // window.postMessage again.\n  record('frame_boot', 'done', { readyState: document.readyState });\n  post({ kind: 'ready' });\n})();";
			const worker = options.workerSource ?? "/* eslint-disable */\n/**\n * DIL sandbox worker.\n *\n * This file is NOT imported as a module. The server inlines its text into\n * /sandbox/runner.html, which turns it into a `blob:` URL and spawns it as a Worker\n * (with a `data:` URL fallback). That is why it is written as a plain, dependency-free\n * script that talks over `self.onmessage` — and it is also why the runner's CSP needs\n * `worker-src blob: data:` and `script-src 'unsafe-eval'`.\n *\n * What lives here:\n *   • a tiny React-like runtime (useState / useRef / useMemo / useEffect)\n *   • `DIL.*` — the API surface the compiled code is allowed to call\n *   • `eval` of the compiled program, and serialization of the resulting element tree\n *\n * What deliberately does NOT live here: any DOM. The worker's output is a plain\n * JSON-serializable tree; the host turns it into DOM. Model code can therefore never\n * touch the page, only describe it.\n */\n(function () {\n  'use strict';\n\n  var PROTOCOL_VERSION = 1;\n\n  // ---------------------------------------------------------------------------\n  // runtime\n  // ---------------------------------------------------------------------------\n\n  function createRuntime(emitDiagnostic, initialState, onStateChange) {\n    var stateSlots = new Map(); // semantic key -> current value\n    // A saved view state (from a previous session's `/dil/view_state`) seeds keyed\n    // slots before the first render, so a reload lands where the user left off.\n    // Only keyed state can be restored — positional slots have no stable address.\n    var seeded = initialState && typeof initialState === 'object' ? initialState : {};\n    var stateOrder = []; // for reporting / debugging\n    var fnTable = new Map();\n    var fnSeq = 0;\n    var version = 0;\n    var program = null; // compiled JS\n    var constants = {};\n    var appData = {};\n    var hooks = null;\n    var root = null;\n    var lastGoodTree = null;\n    var scheduled = false;\n    var renderCount = 0;\n\n    var FRAGMENT = { __dilFragment: true };\n    var stateDirty = false;\n\n    /** After a render, report keyed state once if anything keyed changed. */\n    var stateReported = false;\n    function flushStateChange() {\n      if (!stateDirty || !onStateChange) return;\n      stateDirty = false;\n      onStateChange(api.stateSnapshot(), stateReported ? 'event' : 'initial');\n      stateReported = true;\n    }\n\n    function scheduleRender(reason) {\n      if (scheduled) return;\n      scheduled = true;\n      Promise.resolve().then(function () {\n        scheduled = false;\n        try {\n          var tree = renderPass();\n          lastGoodTree = tree;\n          version += 1;\n          emitSnapshot({ tree: tree, version: version, reason: reason || 'state' });\n          flushStateChange();\n        } catch (err) {\n          emitSnapshot({ tree: lastGoodTree, version: version, error: describeError(err), reason: 'error' });\n        }\n      });\n    }\n\n    // -- hooks -----------------------------------------------------------------\n\n    function currentKey(opts, index) {\n      return opts && typeof opts.key === 'string' ? 'k:' + opts.key : 'i:' + index;\n    }\n\n    function useState(initial, opts) {\n      var index = hooks.index++;\n      var key = currentKey(opts, index);\n      if (!stateSlots.has(key)) {\n        var plain = key.slice(0, 2) === 'k:' ? key.slice(2) : null;\n        var v = plain !== null && Object.prototype.hasOwnProperty.call(seeded, plain)\n          ? seeded[plain]\n          : typeof initial === 'function' ? initial() : initial;\n        stateSlots.set(key, v);\n        stateOrder.push(key);\n        // A key that appears mid-stream extends the reported state shape.\n        if (plain !== null) stateDirty = true;\n      }\n      var setter = function (next) {\n        var prev = stateSlots.get(key);\n        var value = typeof next === 'function' ? next(prev) : next;\n        if (Object.is(value, prev)) return;\n        stateSlots.set(key, value);\n        emitDiagnostic && emitDiagnostic('state', 'changed', { key: key });\n        if (key.slice(0, 2) === 'k:') stateDirty = true;\n        scheduleRender('setState');\n      };\n      return [stateSlots.get(key), setter];\n    }\n\n    function useRef(initial) {\n      var index = hooks.index++;\n      var key = 'r:' + index;\n      if (!stateSlots.has(key)) stateSlots.set(key, { current: initial });\n      return stateSlots.get(key);\n    }\n\n    function useMemo(factory, deps) {\n      var index = hooks.index++;\n      var key = 'm:' + index;\n      var prev = stateSlots.get(key);\n      var same = prev && Array.isArray(deps) && Array.isArray(prev.deps) && deps.length === prev.deps.length && deps.every(function (d, i) { return Object.is(d, prev.deps[i]); });\n      if (same) return prev.value;\n      var value = factory();\n      stateSlots.set(key, { deps: deps, value: value });\n      return value;\n    }\n\n    function useCallback(fn, deps) {\n      return useMemo(function () { return fn; }, deps || []);\n    }\n\n    var pendingEffects = [];\n    function useEffect(effect, deps) {\n      var index = hooks.index++;\n      var key = 'e:' + index;\n      var prev = stateSlots.get(key);\n      var same = prev && Array.isArray(deps) && Array.isArray(prev.deps) && deps.length === prev.deps.length && deps.every(function (d, i) { return Object.is(d, prev.deps[i]); });\n      if (same) return;\n      stateSlots.set(key, { deps: deps });\n      pendingEffects.push(effect);\n    }\n\n    function useConstants() {\n      return hooks.constants;\n    }\n\n    function useAppData(selector) {\n      var data = hooks.appData;\n      return typeof selector === 'function' ? selector(data) : data;\n    }\n\n    function useNow(intervalMs) {\n      // Deliberately inert in the replica: a real clock would make renders\n      // non-deterministic during streaming. Exposed so the dialect is complete.\n      return hooks.fixedNow;\n    }\n\n    var DIL = {\n      Fragment: FRAGMENT,\n      jsx: function (type, props) {\n        var children = [];\n        for (var i = 2; i < arguments.length; i++) children.push(arguments[i]);\n        return { __dilEl: true, type: type, props: props || {}, children: children };\n      },\n      render: function (el) {\n        root = el;\n      },\n      useState: useState,\n      useRef: useRef,\n      useMemo: useMemo,\n      useCallback: useCallback,\n      useEffect: useEffect,\n      useConstants: useConstants,\n      useAppData: useAppData,\n      useNow: useNow,\n    };\n\n    // Compiled programs reference two separate namespaces, mirroring the real\n    // artifact: `__dil` is the JSX runtime, `DIL` is the hook/API surface. Keeping\n    // them apart means the codegen can emit `__dil.jsx(...)` without granting the\n    // generated tree access to `useState`.\n    var __dil = {\n      Fragment: FRAGMENT,\n      jsx: DIL.jsx,\n    };\n\n    // -- serialization ---------------------------------------------------------\n\n    function serialize(node, depth) {\n      if (depth > 64) return null;\n      if (node == null || node === false || node === true) return null;\n      var t = typeof node;\n      if (t === 'string' || t === 'number') {\n        var s = String(node);\n        return s === '' ? null : { t: '#text', v: s };\n      }\n      if (Array.isArray(node)) {\n        var arr = [];\n        for (var i = 0; i < node.length; i++) {\n          var c = serialize(node[i], depth + 1);\n          if (c) arr.push(c);\n        }\n        return arr.length ? { t: '#frag', c: arr } : null;\n      }\n      if (t !== 'object' || !node.__dilEl) return null;\n\n      var type = node.type;\n      if (type === FRAGMENT) {\n        var kids = [];\n        for (var j = 0; j < node.children.length; j++) {\n          var k = serialize(node.children[j], depth + 1);\n          if (k) kids.push(k);\n        }\n        return kids.length ? { t: '#frag', c: kids } : null;\n      }\n      if (typeof type === 'function') {\n        // Locally-defined function components are inlined: the sandbox evaluates them,\n        // the host never sees a function.\n        return serialize(type(node.props), depth + 1);\n      }\n\n      var props = {};\n      var src = node.props || {};\n      for (var key in src) {\n        if (!Object.prototype.hasOwnProperty.call(src, key)) continue;\n        var v = src[key];\n        if (typeof v === 'function') {\n          var id = 'fn' + ++fnSeq;\n          fnTable.set(id, v);\n          props[key] = { __dilFn: id };\n        } else if (typeof v === 'symbol' || typeof v === 'undefined') {\n          continue;\n        } else {\n          props[key] = v;\n        }\n      }\n\n      var out = [];\n      for (var m = 0; m < node.children.length; m++) {\n        var child = serialize(node.children[m], depth + 1);\n        if (child) out.push(child);\n      }\n      return { t: String(type), p: props, c: out };\n    }\n\n    // -- render pass -----------------------------------------------------------\n\n    function renderPass() {\n      if (!program) return null;\n      hooks = { index: 0, constants: constants, appData: appData, fixedNow: 0 };\n      root = null;\n      pendingEffects = [];\n      fnTable = new Map();\n      fnSeq = 0;\n      renderCount += 1;\n\n      // The whole program is a single expression + a `render()` call. Evaluating it\n      // is the one place untrusted code runs; everything it can reach is the two\n      // objects we hand it and nothing else.\n      var factory = new Function('DIL', '__dil', '\"use strict\";\\n' + program);\n      factory(DIL, __dil);\n\n      var tree = serialize(root, 0);\n\n      if (pendingEffects.length) {\n        var effects = pendingEffects;\n        pendingEffects = [];\n        Promise.resolve().then(function () {\n          for (var i = 0; i < effects.length; i++) {\n            try { effects[i](); } catch (err) { emitDiagnostic && emitDiagnostic('effect', 'threw', { message: String(err && err.message) }); }\n          }\n        });\n      }\n      return tree;\n    }\n\n    // -- public API ------------------------------------------------------------\n\n    var api = {\n      setProgram: function (nextProgram, nextConstants, nextAppData, keepState) {\n        program = nextProgram;\n        constants = nextConstants || {};\n        appData = nextAppData || {};\n        if (!keepState) {\n          // A new artifact may have a different state shape; the real system keeps\n          // state and lets the program read whatever it needs. We keep it too, so\n          // streaming recompiles don't reset the UI on every chunk.\n        }\n        var tree = renderPass();\n        lastGoodTree = tree;\n        version += 1;\n        // the caller emits the tree snapshot; schedule the state report after it\n        if (stateDirty) Promise.resolve().then(flushStateChange);\n        return { tree: tree, version: version, renderCount: renderCount };\n      },\n      invoke: function (fnId, args) {\n        var fn = fnTable.get(fnId);\n        if (!fn) return { ok: false, error: 'unknown handler ' + fnId };\n        try {\n          fn.apply(null, args || []);\n          var tree = renderPass();\n          lastGoodTree = tree;\n          version += 1;\n          emitSnapshot({ tree: tree, version: version, reason: 'event' });\n          flushStateChange();\n          return { ok: true };\n        } catch (err) {\n          return { ok: false, error: describeError(err) };\n        }\n      },\n      snapshot: function () {\n        return { tree: lastGoodTree, version: version };\n      },\n      stateSnapshot: function () {\n        var out = {};\n        stateSlots.forEach(function (v, key) {\n          if (key.slice(0, 2) === 'k:') out[key.slice(2)] = safe(v);\n        });\n        return out;\n      },\n      stats: function () {\n        return { version: version, renderCount: renderCount, handlers: fnTable.size, states: stateOrder.length };\n      },\n    };\n    return api;\n\n    function safe(v) {\n      try {\n        return JSON.parse(JSON.stringify(v));\n      } catch {\n        return null;\n      }\n    }\n  }\n\n  function describeError(err) {\n    if (!err) return { name: 'Error', message: 'unknown' };\n    return {\n      name: String((err && err.name) || 'Error'),\n      message: String((err && err.message) || err),\n      stack: typeof err.stack === 'string' ? err.stack.split('\\n').slice(0, 4).join('\\n') : undefined,\n    };\n  }\n\n  // ---------------------------------------------------------------------------\n  // worker protocol\n  // ---------------------------------------------------------------------------\n\n  var runtime = null;\n  var dataPort = null;\n  var controlPort = null;\n  var currentRunnerId = null;\n\n  function emitSnapshot(payload) {\n    if (!dataPort) return;\n    dataPort.postMessage({\n      __dilWorker: true,\n      kind: 'snapshot',\n      runnerId: currentRunnerId,\n      tree: payload.tree,\n      version: payload.version,\n      error: payload.error || null,\n      reason: payload.reason || null,\n      stats: runtime ? runtime.stats() : null,\n    });\n  }\n\n  function emitStateChanged(state, reason) {\n    if (!dataPort) return;\n    dataPort.postMessage({ __dilWorker: true, kind: 'stateChanged', runnerId: currentRunnerId, scope: 'root', state: state, reason: reason || 'event' });\n  }\n\n  function emitDiagnostic(stage, phase, detail) {\n    if (!controlPort) return;\n    try {\n      controlPort.postMessage({ __dilWorker: true, kind: 'diagnostic', stage: stage, phase: phase, detail: detail || null });\n    } catch {}\n  }\n\n  self.onmessage = function (event) {\n    var msg = event.data;\n    if (!msg || msg.__dilWorker !== true) return;\n\n    switch (msg.kind) {\n      case 'initializeControl': {\n        controlPort = event.ports && event.ports[0];\n        if (controlPort) {\n          controlPort.onmessage = function (e) {\n            var m = e.data;\n            if (m && m.__dilWorker === true && m.kind === 'healthCheck') {\n              controlPort.postMessage({ __dilWorker: true, kind: 'healthy', requestId: m.requestId, stats: runtime ? runtime.stats() : null });\n            }\n          };\n          controlPort.start && controlPort.start();\n        }\n        emitDiagnostic('worker_module', 'returned', { protocolVersion: PROTOCOL_VERSION });\n        break;\n      }\n\n      case 'createRunner': {\n        if (msg.protocolVersion !== PROTOCOL_VERSION) {\n          emitDiagnostic('runner_create', 'rejected', { reason: 'protocol_mismatch', got: msg.protocolVersion });\n          return;\n        }\n        dataPort = event.ports && event.ports[0];\n        if (dataPort) {\n          dataPort.onmessage = function (e) {\n            var m = e.data;\n            if (m && m.__dilWorker === true) handleCommand(m);\n          };\n          dataPort.start && dataPort.start();\n        }\n        currentRunnerId = msg.runnerId;\n        runtime = createRuntime(emitDiagnostic, msg.initialState, emitStateChanged);\n        emitDiagnostic('runner_create', 'begin', { runnerId: msg.runnerId });\n        try {\n          var r = runtime.setProgram(msg.compiledDil, msg.constants, msg.appData);\n          dataPort.postMessage({ __dilWorker: true, kind: 'ready', protocolVersion: PROTOCOL_VERSION, runnerId: currentRunnerId, version: r.version, stats: runtime.stats() });\n          emitSnapshot({ tree: r.tree, version: r.version, reason: 'initial' });\n          // The real client POSTs the full initial state right after the first render\n          // (captured record 421: all 15 keys at their initial values). setProgram has\n          // already queued that report; it fires once the snapshot above is out.\n          emitDiagnostic('worker_ready', 'sent', { runnerId: msg.runnerId });\n        } catch (err) {\n          dataPort.postMessage({ __dilWorker: true, kind: 'failure', runnerId: currentRunnerId, error: describeError(err), stage: 'evaluate' });\n        }\n        break;\n      }\n\n      case 'trigger': {\n        if (!runtime) return;\n        var res = runtime.invoke(msg.fnId, msg.args);\n        if (!res.ok) {\n          dataPort && dataPort.postMessage({ __dilWorker: true, kind: 'failure', runnerId: currentRunnerId, error: { name: 'HandlerError', message: res.error }, stage: 'event' });\n        }\n        break;\n      }\n\n      case 'stateSnapshotRequest': {\n        dataPort && dataPort.postMessage({ __dilWorker: true, kind: 'stateSnapshot', runnerId: currentRunnerId, state: runtime ? runtime.stateSnapshot() : {} });\n        break;\n      }\n\n      case 'dispose': {\n        if (dataPort) { dataPort.close && dataPort.close(); dataPort = null; }\n        if (controlPort) { controlPort.close && controlPort.close(); controlPort = null; }\n        runtime = null;\n        currentRunnerId = null;\n        self.close && self.close();\n        break;\n      }\n    }\n  };\n\n  function handleCommand(msg) {\n    if (!runtime) return;\n    switch (msg.command) {\n      case 'setCompiledDil': {\n        var changed = msg.data.compiledDil !== undefined;\n        try {\n          var r = runtime.setProgram(msg.data.compiledDil, msg.data.constants, msg.data.appData);\n          dataPort.postMessage({ __dilWorker: true, kind: 'response', id: msg.id, ok: true, version: r.version, stats: runtime.stats() });\n          if (changed) emitSnapshot({ tree: r.tree, version: r.version, reason: 'source' });\n        } catch (err) {\n          dataPort.postMessage({ __dilWorker: true, kind: 'response', id: msg.id, ok: false, error: describeError(err) });\n          dataPort.postMessage({ __dilWorker: true, kind: 'failure', runnerId: currentRunnerId, error: describeError(err), stage: 'evaluate' });\n        }\n        break;\n      }\n      case 'setData': {\n        try {\n          var r2 = runtime.setProgram(msg.data.compiledDil, msg.data.constants, msg.data.appData);\n          dataPort.postMessage({ __dilWorker: true, kind: 'response', id: msg.id, ok: true, version: r2.version });\n          emitSnapshot({ tree: r2.tree, version: r2.version, reason: 'data' });\n        } catch (err) {\n          dataPort.postMessage({ __dilWorker: true, kind: 'response', id: msg.id, ok: false, error: describeError(err) });\n        }\n        break;\n      }\n      case 'snapshot': {\n        dataPort.postMessage({ __dilWorker: true, kind: 'response', id: msg.id, ok: true, snapshot: runtime.snapshot() });\n        break;\n      }\n      default:\n        dataPort.postMessage({ __dilWorker: true, kind: 'response', id: msg.id, ok: false, error: 'unknown command ' + msg.command });\n    }\n  }\n\n  // tell whoever spawned us that the module evaluated\n  try {\n    self.postMessage({ __dilWorker: true, kind: 'ready', protocolVersion: PROTOCOL_VERSION });\n  } catch {}\n})();\n";
			if (options.csp === void 0 && script !== "(function () {\n  'use strict';\n  var PROTOCOL = 1;\n  var RENDER_BUDGET_MS = 2500;\n  var MAX_RESPAWNS = 1;\n\n  var worker = null;\n  var workerUrl = null;\n  // Commands (setCompiledDil) travel on the data port, the same channel the worker\n  // listens on for them; the worker's global scope only handles lifecycle messages.\n  var dataPort = null;\n  var runnerMessage = null;\n  var renderTimer = null;\n  var respawns = 0;\n  var seq = 0;\n  var pending = new Map();\n\n  function post(msg) {\n    try { window.parent.postMessage(Object.assign({ __dilFrame: true, protocolVersion: PROTOCOL }, msg), '*'); } catch (e) {}\n  }\n\n  /**\n   * Diagnostics deliberately go over window.postMessage rather than the MessagePort.\n   * The port is the fast path for snapshots and acks, but it is also the thing most\n   * likely to be broken — and \"the channel you use to report that the channel is\n   * broken\" cannot be the channel itself.\n   */\n  function record(stage, phase, detail) {\n    try {\n      window.parent.postMessage(\n        { __dilFrame: true, kind: 'diagnostic', protocolVersion: PROTOCOL, stage: stage, phase: phase, detail: detail || null },\n        '*'\n      );\n    } catch (e) {}\n  }\n\n  function workerSource() {\n    var t = document.getElementById('dil-worker-source');\n    if (!t) return '';\n    // A <template>'s children live in .content — textContent on the element itself is\n    // always empty. Easy mistake, and it fails silently at exactly the wrong moment.\n    return t.content ? t.content.textContent : t.textContent;\n  }\n\n  function fail(stage, error) {\n    post({ __dilFrame: true, kind: 'failure', protocolVersion: PROTOCOL, stage: stage,\n           error: { name: (error && error.name) || 'Error', message: String((error && error.message) || error) } });\n  }\n\n  /**\n   * Spawn the sandbox Worker.\n   *\n   * Two transports, tried in order, because browser policy decides which one works:\n   *\n   *   blob:  - the normal path. Cheap, and the worker revokes its own URL on boot.\n   *   data:  - the fallback. A blob: Worker created from a document with an OPAQUE\n   *            origin (a sandboxed iframe without allow-same-origin) becomes\n   *            origin becomes blob:null/..., which some engines refuse to load, so the\n   *            worker script never evaluates. postMessage succeeds silently and nothing\n   *            ever comes back. Hence: the fallback is chosen by TIMEOUT, not by exception.\n   *\n   * Either way the worker announces itself with a ready message, so whether it booted is\n   * observable rather than assumed.\n   */\n  var WORKER_BOOT_TIMEOUT_MS = 1200;\n  var bootTimer = null;\n\n  function clearBootTimer() {\n    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }\n  }\n\n  function spawnWorker(attempt) {\n    attempt = attempt || 0;\n    var src = workerSource();\n    record('worker_create', 'begin', { attempt: attempt, bytes: src.length });\n    if (!src) { record('worker_create', 'reported_error', { reason: 'empty_worker_source' }); fail('worker_create', new Error('worker source is empty')); return; }\n\n    var transport;\n    try {\n      if (attempt === 0) {\n        var blob = new Blob(['(self.URL||self.webkitURL).revokeObjectURL(self.location.href);', src],\n                            { type: 'text/javascript;charset=utf-8' });\n        workerUrl = (window.URL || window.webkitURL).createObjectURL(blob);\n        worker = new Worker(workerUrl, { name: 'dil-sandbox' });\n        transport = 'blob';\n      } else {\n        worker = new Worker('data:text/javascript;charset=utf-8,' + encodeURIComponent(src), { name: 'dil-sandbox' });\n        transport = 'data';\n      }\n    } catch (e) {\n      record('worker_create', 'threw', { attempt: attempt, transport: transport || (attempt === 0 ? 'blob' : 'data'), message: String(e && e.message) });\n      if (attempt === 0) { spawnWorker(1); } else { fail('worker_create', e); }\n      return;\n    }\n\n    if (!worker) { fail('worker_create', new Error('Worker construction returned nothing')); return; }\n    record('worker_create', 'returned', { attempt: attempt, transport: transport });\n\n    // The boot ack is what tells us the transport actually works.\n    worker.onmessage = function (ev) {\n      var m = ev && ev.data;\n      if (m && m.__dilWorker === true && m.kind === 'ready') {\n        clearBootTimer();\n        record('worker_ready', 'received', { attempt: attempt, transport: transport, protocolVersion: m.protocolVersion });\n      }\n    };\n    worker.addEventListener('error', function (ev) {\n      record('worker_create', 'reported_error', { attempt: attempt, transport: transport, message: String((ev && ev.message) || '') });\n    });\n\n    clearBootTimer();\n    bootTimer = setTimeout(function () {\n      bootTimer = null;\n      record('worker_create', 'timeout', { attempt: attempt, transport: transport, budgetMs: WORKER_BOOT_TIMEOUT_MS });\n      try { if (worker) worker.terminate(); } catch (e) {}\n      worker = null;\n      if (attempt === 0) {\n        record('recovery', 'decision', { reason: 'blob_worker_never_booted', next: 'data_url' });\n        spawnWorker(1);\n      } else {\n        fail('worker_create', new Error('sandbox worker never booted on either transport'));\n      }\n    }, WORKER_BOOT_TIMEOUT_MS);\n\n    // control channel: health probes + diagnostics only\n    var ctrl = new MessageChannel();\n    ctrl.port1.onmessage = function (e) {\n      var m2 = e.data;\n      if (!m2) return;\n      if (m2.kind === 'healthy') record('health_probe', 'received', { stats: m2.stats || null });\n      else if (m2.kind === 'diagnostic') record(m2.stage, m2.phase, m2.detail);\n    };\n    ctrl.port1.start();\n    worker.postMessage({ __dilWorker: true, kind: 'initializeControl', protocolVersion: PROTOCOL }, [ctrl.port2]);\n\n    // data channel: compiled programs + snapshots\n    var data = new MessageChannel();\n    data.port1.onmessage = onWorkerMessage;\n    data.port1.start();\n    dataPort = data.port1;\n    var msg = Object.assign({}, runnerMessage, { __dilWorker: true, kind: 'createRunner', protocolVersion: PROTOCOL });\n    worker.postMessage(msg, [data.port2]);\n  }\n\n  function armWatchdog(stage) {\n    clearWatchdog();\n    renderTimer = setTimeout(function () {\n      renderTimer = null;\n      record('recovery', 'decision', { reason: 'render_budget_exceeded', stage: stage, budgetMs: RENDER_BUDGET_MS, respawns: respawns });\n      post({ __dilFrame: true, kind: 'timeout', protocolVersion: PROTOCOL, stage: stage });\n      if (respawns < MAX_RESPAWNS) {\n        respawns += 1;\n        recycle();\n      } else {\n        post({ __dilFrame: true, kind: 'quarantined', protocolVersion: PROTOCOL, reason: 'worker_unresponsive' });\n      }\n    }, RENDER_BUDGET_MS);\n  }\n\n  function clearWatchdog() { if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; } }\n\n  function recycle() {\n    clearBootTimer();\n    try { if (worker) worker.terminate(); } catch (e) {}\n    try { if (workerUrl) (self.URL || self.webkitURL).revokeObjectURL(workerUrl); } catch (e) {}\n    clearBootTimer();\n    worker = null;\n    workerUrl = null;\n    dataPort = null;\n    pending.clear();\n    spawnWorker(0);\n  }\n\n  function onWorkerMessage(e) {\n    var m = e.data;\n    if (!m || m.__dilWorker !== true) return;\n    switch (m.kind) {\n      case 'ready':\n        record('worker_ready', 'received', { protocolVersion: m.protocolVersion });\n        break;\n      case 'snapshot':\n        clearWatchdog();\n        record('snapshot_forward', 'sent', { version: m.version, reason: m.reason, hasError: !!m.error });\n        post({ __dilFrame: true, kind: 'snapshot', protocolVersion: PROTOCOL, runnerId: m.runnerId, tree: m.tree, version: m.version, error: m.error || null, stats: m.stats || null, reason: m.reason || null });\n        break;\n      case 'failure':\n        clearWatchdog();\n        post({ __dilFrame: true, kind: 'failure', protocolVersion: PROTOCOL, error: m.error, stage: m.stage });\n        break;\n      case 'response':\n        clearWatchdog();\n        if (m.id && pending.has(m.id)) { pending.delete(m.id); }\n        post({ __dilFrame: true, kind: 'ack', protocolVersion: PROTOCOL, id: m.id, ok: m.ok, error: m.error || null, stats: m.stats || null });\n        break;\n      case 'stateSnapshot':\n        post({ __dilFrame: true, kind: 'stateSnapshot', protocolVersion: PROTOCOL, state: m.state });\n        break;\n      case 'stateChanged':\n        // Remember the latest keyed state: if the watchdog recycles the worker, the\n        // respawned runner is seeded with it instead of snapping back to initial values.\n        if (runnerMessage) runnerMessage.initialState = m.state;\n        post({ __dilFrame: true, kind: 'stateChanged', protocolVersion: PROTOCOL, scope: m.scope, state: m.state, reason: m.reason });\n        break;\n    }\n  }\n\n  function onHostMessage(e) {\n    try { handleHostMessage(e); }\n    catch (err) {\n      // Anything thrown out of a message handler disappears into the event loop. If\n      // the frame cannot act on a command, the host must hear about it.\n      record('command', 'threw', { message: String((err && err.message) || err) });\n      post({ __dilFrame: true, kind: 'failure', protocolVersion: PROTOCOL, stage: 'command',\n             error: { name: (err && err.name) || 'Error', message: String((err && err.message) || err) } });\n    }\n  }\n\n  function handleHostMessage(e) {\n    var m = e.data;\n    record('frame_msg', 'received', { kind: (m && m.kind) || null, hasFrameFlag: !!(m && m.__dilFrame === true) });\n    if (!m || m.__dilFrame !== true) return;\n    switch (m.kind) {\n      case 'createRunner':\n        if (m.protocolVersion !== PROTOCOL) { record('runner_create', 'rejected', { reason: 'protocol_mismatch' }); return; }\n        record('runner_create', 'host_received', { runnerId: m.runnerId });\n        runnerMessage = { runnerId: m.runnerId, compiledDil: m.compiledDil, constants: m.constants || {}, appData: m.appData || {}, initialState: m.initialState || null };\n        record('runner_create', 'received', { runnerId: m.runnerId, bytes: (m.compiledDil || '').length });\n        if (worker) { recycle(); } else { spawnWorker(0); }\n        break;\n      case 'setCompiledDil':\n        if (!runnerMessage) return;\n        runnerMessage.compiledDil = m.compiledDil;\n        if (m.constants) runnerMessage.constants = m.constants;\n        if (m.appData) runnerMessage.appData = m.appData;\n        if (!worker) { spawnWorker(0); return; }\n        var id = 'c' + ++seq;\n        pending.set(id, true);\n        (dataPort || worker).postMessage({ __dilWorker: true, kind: 'command', command: 'setCompiledDil', id: id,\n                             data: { compiledDil: m.compiledDil, constants: runnerMessage.constants, appData: runnerMessage.appData } });\n        armWatchdog('setCompiledDil');\n        break;\n      case 'trigger':\n        if (!worker) return;\n        worker.postMessage({ __dilWorker: true, kind: 'trigger', fnId: m.fnId, args: m.args || [] });\n        armWatchdog('trigger');\n        break;\n      case 'stateSnapshotRequest':\n        if (worker) worker.postMessage({ __dilWorker: true, kind: 'stateSnapshotRequest' });\n        break;\n      case 'dispose':\n        clearWatchdog();\n        clearBootTimer();\n        try { if (worker) worker.postMessage({ __dilWorker: true, kind: 'dispose' }); } catch (e) {}\n        try { if (worker) worker.terminate(); } catch (e) {}\n        worker = null;\n        break;\n    }\n  }\n\n  // Transport note\n  // --------------\n  // The real DIL runner hands the host one end of a MessageChannel on its ready\n  // message, and does all business traffic over that port. The replica uses\n  // window.postMessage throughout instead: it is the same structured-clone channel, it\n  // works from an opaque-origin frame, and unlike a port the traffic is visible in\n  // DevTools and to the host, which matters a great deal when the sandbox misbehaves.\n  window.addEventListener('message', function (e) {\n    var m = e.data;\n    record('frame_window_msg', 'received', {\n      hasSource: !!e.source,\n      sourceIsParent: e.source === window.parent,\n      kind: (m && m.kind) || null,\n      frameFlag: !!(m && m.__dilFrame === true),\n    });\n    if (e.source !== window.parent) return;\n    if (!m || m.__dilFrame !== true) return;\n    if (m.kind === 'probe') { record('frame_probe', 'received', { readyState: document.readyState }); return; }\n    onHostMessage(e);\n  });\n\n  window.addEventListener('pagehide', function (e) {\n    if (e.persisted) return;\n    clearWatchdog();\n    clearBootTimer();\n    try { if (worker) worker.terminate(); } catch (err) {}\n    worker = null;\n  });\n\n  // Hand the host one end of our port. After this the host never needs\n  // window.postMessage again.\n  record('frame_boot', 'done', { readyState: document.readyState });\n  post({ kind: 'ready' });\n})();") throw new Error(`client/dil/frame: a replacement frameScript needs a matching csp — the pinned hash ${FRAME_SCRIPT_SHA256} only covers the vendored bootstrap`);
			return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${options.csp ?? DIL_FRAME_CSP}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtmlText(options.title ?? "DIL Runner")}</title>
    <script>${script}<\/script>
  </head>
  <body>
    <!-- Inert: never executed, never blocked by script-src, read via textContent. -->
    <template id="dil-worker-source">${escapeHtmlText(worker)}</template>
  </body>
</html>`;
		}
		/** True when `value` is a message this half is willing to act on. */
		function isFrameMessage(value) {
			return typeof value === "object" && value !== null && value.__dilFrame === true;
		}
		/** True when the frame is the exact version this host speaks. */
		function acceptsVersion(message) {
			return message.protocolVersion === void 0 || message.protocolVersion === 1;
		}
		//#endregion
		//#region src/client/dil/sandbox.ts
		/**
		* Sandbox host — the browser side of the iframe contract.
		*
		*   host ──postMessage──► sandboxed iframe (opaque origin, CSP default-src 'none')
		*                              └──► blob: Worker that runs the compiled program
		*
		* Creates the invisible iframe, waits for `ready`, pushes compiled revisions in and
		* receives element-tree snapshots and keyed-state reports out. It knows nothing about
		* rendering: pair it with `mount()` from the renderer.
		*
		* The frame is headless. It is never the display container: it measures nothing, paints
		* nothing, and its only output is the serialized tree the host renders into its own DOM.
		* @module dsh-intelligent-ui/client/dil/sandbox
		*/
		/** How long the frame gets to announce itself before the host gives up on it. */
		const BOOT_TIMEOUT_MS = 5e3;
		const noop = () => {};
		/** The host's end of the iframe contract. */
		var DilSandbox = class {
			frameUrl;
			container;
			frame = null;
			connected = false;
			runnerId = null;
			options;
			doc;
			ready = null;
			onWindowMessage = null;
			constructor(options = {}) {
				this.options = options;
				this.frameUrl = options.frameUrl;
				this.container = options.container ?? null;
				this.doc = options.document ?? globalThis.document;
			}
			/** The window the frame will post to, and the one that delivers its messages. */
			get view() {
				return this.doc.defaultView ?? globalThis;
			}
			/**
			* Create the frame and wait for its `ready`.
			* @returns this sandbox, once the frame speaks the protocol.
			*/
			connect() {
				if (this.ready) return this.ready;
				this.ready = new Promise((resolve, reject) => {
					const frame = this.doc.createElement("iframe");
					if (this.frameUrl) frame.src = this.frameUrl;
					else frame.srcdoc = this.options.srcdoc ?? buildRunnerHtml();
					frame.setAttribute("sandbox", "allow-scripts");
					frame.setAttribute("referrerpolicy", "no-referrer");
					frame.setAttribute("aria-hidden", "true");
					frame.setAttribute("data-dil-sandbox", "true");
					frame.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
					this.frame = frame;
					const timer = setTimeout(() => {
						this.log("frame", "boot_timeout", { ms: this.options.bootTimeoutMs ?? BOOT_TIMEOUT_MS });
						frame.remove();
						this.frame = null;
						reject(/* @__PURE__ */ new Error("sandbox frame did not become ready"));
					}, this.options.bootTimeoutMs ?? BOOT_TIMEOUT_MS);
					this.onWindowMessage = (event) => {
						if (event.source !== frame.contentWindow) return;
						const message = event.data;
						if (!isFrameMessage(message)) return;
						if (!acceptsVersion(message)) {
							this.log("frame", "protocol_mismatch", { got: message.protocolVersion });
							return;
						}
						if (message.kind === "ready") {
							if (this.connected) return;
							this.connected = true;
							clearTimeout(timer);
							this.log("frame", "ready", { protocolVersion: message.protocolVersion });
							resolve(this);
							return;
						}
						this.handle(message);
					};
					this.view.addEventListener("message", this.onWindowMessage);
					(this.container ?? this.doc.body).appendChild(frame);
				});
				return this.ready;
			}
			/** Record one boundary crossing. */
			log(dir, kind, detail) {
				(this.options.onProtocol ?? noop)({
					dir,
					kind,
					detail,
					at: Date.now()
				});
			}
			/** A message the frame may report the state of, and where it may come from. */
			handle(message) {
				switch (message.kind) {
					case "diagnostic":
						this.log("frame:diag", `${message.stage}:${message.phase}`, message.detail);
						break;
					case "snapshot":
						this.log("frame→host", "snapshot", {
							version: message.version,
							reason: message.reason,
							hasError: !!message.error
						});
						(this.options.onSnapshot ?? noop)({
							tree: message.tree ?? null,
							version: typeof message.version === "number" ? message.version : 0,
							reason: message.reason ?? null,
							error: message.error ?? null,
							stats: message.stats ?? null
						});
						break;
					case "stateChanged": {
						const state = message.state ?? {};
						this.log("frame→host", "stateChanged", {
							reason: message.reason,
							keys: Object.keys(state).length
						});
						(this.options.onStateChange ?? noop)(state, message.scope ?? "root", message.reason);
						break;
					}
					case "failure":
						this.log("frame→host", "failure", {
							stage: message.stage,
							message: message.error?.message
						});
						(this.options.onFailure ?? noop)(message.error ?? {
							name: "Error",
							message: "unknown failure"
						}, message.stage ?? "unknown");
						break;
					case "timeout":
						this.log("frame→host", "timeout", { stage: message.stage });
						(this.options.onFailure ?? noop)({
							name: "Timeout",
							message: `sandbox exceeded its render budget (${message.stage})`
						}, "timeout");
						break;
					case "quarantined":
						this.log("frame→host", "quarantined", { reason: message.reason });
						(this.options.onFailure ?? noop)({
							name: "Quarantined",
							message: String(message.reason)
						}, "quarantine");
						break;
					case "ack": this.log("frame→host", "ack", {
						id: message.id,
						ok: message.ok
					});
				}
			}
			/** Post one message into the frame. Returns whether it went anywhere. */
			send(message) {
				const target = this.frame?.contentWindow;
				if (!target) return false;
				target.postMessage({
					__dilFrame: true,
					protocolVersion: 1,
					...message
				}, "*");
				return true;
			}
			/** First program for a message: spawns the worker. */
			createRunner(runnerId, payload) {
				this.runnerId = runnerId;
				this.log("host→frame", "createRunner", {
					runnerId,
					bytes: payload.compiledDil.length
				});
				this.send({
					kind: "createRunner",
					runnerId,
					compiledDil: payload.compiledDil,
					constants: payload.constants ?? {},
					appData: payload.appData ?? {},
					initialState: payload.initialState ?? null
				});
			}
			/** Later revisions while streaming: state is kept, only the program changes. */
			setCompiledDil(payload) {
				this.log("host→frame", "setCompiledDil", { bytes: payload.compiledDil.length });
				this.send({
					kind: "setCompiledDil",
					compiledDil: payload.compiledDil,
					constants: payload.constants ?? {},
					appData: payload.appData ?? {}
				});
			}
			/** Run one handler inside the sandbox; the tree it produces comes back as a snapshot. */
			trigger(fnId, args = []) {
				this.log("host→frame", "trigger", { fnId });
				this.send({
					kind: "trigger",
					fnId,
					args: [...args]
				});
			}
			/** Ask the worker for its keyed state. */
			requestState() {
				this.send({ kind: "stateSnapshotRequest" });
			}
			/** Tear the frame down and forget it. */
			dispose() {
				this.send({ kind: "dispose" });
				if (this.onWindowMessage) this.view.removeEventListener("message", this.onWindowMessage);
				this.onWindowMessage = null;
				this.frame?.remove();
				this.frame = null;
				this.connected = false;
				this.ready = null;
			}
		};
		//#endregion
		//#region src/client/dil/generated/theme-css.ts
		/**
		* GENERATED — do not edit.
		*
		* The verbatim text of `src/client/dil/theme.css`, serialized as a string constant so
		* the renderer can inject it into a shadow root without a bundler-specific CSS import.
		*
		* `tests/client/theme.spec.ts` re-reads the stylesheet and fails if the two diverge.
		* @module dsh-intelligent-ui/client/dil/generated/theme-css
		*/
		/** The DIL component library, on DSH theme tokens. */
		const THEME_CSS = "/* =============================================================================\n   DIL component library — the host's rendering vocabulary.\n\n   The sandbox cannot style anything: it emits tags and props, and every visual\n   decision is made here, by the host, in the host's own DOM. Upstream's palette is\n   replaced by the DSH design tokens so a generated interface reads as part of the\n   product instead of as a guest. Spacing, radii, type scale and shadows stay as\n   upstream shipped them.\n\n   Where each variable comes from:\n     * `--dsw-alias-*` / `--dsw-specific-*` — DSH tokens, set on `document.body` or\n       `:root` by the app. Custom properties inherit into a shadow tree, so the\n       renderer resolves them from whatever element hosts the view.\n     * `--dil-fb-*` — the token's DSH-less fallback (upstream's value), so the\n       library still looks right in a test page, a storybook or a preview frame.\n   The dark block is keyed on `data-dil-theme`, which `mountDilView` mirrors from\n   the document, plus `:host([data-ds-dark-theme])` for a host that carries it, plus\n   `prefers-color-scheme` for a page that sets neither.\n   ============================================================================= */\n\n:host { display: block; min-width: 0; }\n\n.dil-root {\n  --dil-fb-bg: #ffffff;\n  --dil-fb-surface: #ffffff;\n  --dil-fb-surface-2: #f9f9f9;\n  --dil-fb-sunken: #f4f4f4;\n  --dil-fb-overlay: #ffffff;\n  --dil-fb-hover: #ececec;\n  --dil-fb-border: #e5e5e5;\n  --dil-fb-border-strong: #d0d0d0;\n  --dil-fb-text: #0d0d0d;\n  --dil-fb-text-secondary: #5d5d5d;\n  --dil-fb-text-tertiary: #8f8f8f;\n  --dil-fb-accent: #0d0d0d;\n  --dil-fb-accent-fg: #ffffff;\n  --dil-fb-link: #2964aa;\n  --dil-fb-success: #0f9d58;\n  --dil-fb-warning: #b26a00;\n  --dil-fb-danger: #d93025;\n  --dil-fb-info: #2964aa;\n  --dil-fb-idle: #8f8f8f;\n  --dil-fb-sidebar: #f9f9f9;\n  --dil-fb-thumb: #ffffff;\n\n  --dil-bg: var(--dsw-alias-bg-base, var(--dil-fb-bg));\n  --dil-surface: var(--dsw-alias-bg-layer-1, var(--dil-fb-surface));\n  --dil-surface-2: var(--dsw-alias-bg-layer-2, var(--dil-fb-surface-2));\n  --dil-sunken: var(--dsw-alias-bg-layer-3, var(--dil-fb-sunken));\n  --dil-overlay: var(--dsw-alias-bg-overlay, var(--dil-fb-overlay));\n  --dil-hover: var(--dsw-alias-interactive-bg-hover, var(--dil-fb-hover));\n  --dil-border: var(--dsw-alias-border-l2, var(--dil-fb-border));\n  --dil-border-strong: var(--dsw-alias-border-l3, var(--dil-fb-border-strong));\n  --dil-text: var(--dsw-alias-label-primary, var(--dil-fb-text));\n  --dil-text-secondary: var(--dsw-alias-label-secondary, var(--dil-fb-text-secondary));\n  --dil-text-tertiary: var(--dsw-alias-label-tertiary, var(--dil-fb-text-tertiary));\n  --dil-accent: var(--dsw-alias-brand-primary, var(--dil-fb-accent));\n  --dil-accent-fg: var(--dsw-alias-label-primary-inverted, var(--dil-fb-accent-fg));\n  --dil-link: var(--dsw-alias-link, var(--dil-fb-link));\n  --dil-success: var(--dsw-alias-state-success-primary, var(--dil-fb-success));\n  --dil-warning: var(--dsw-alias-state-warn-primary, var(--dil-fb-warning));\n  --dil-danger: var(--dsw-alias-state-error-primary, var(--dil-fb-danger));\n  --dil-info: var(--dsw-alias-state-business-primary, var(--dil-fb-info));\n  --dil-idle: var(--dsw-alias-state-idle-primary, var(--dil-fb-idle));\n  --dil-sidebar: var(--dsw-specific-sidebar-fill, var(--dil-fb-sidebar));\n  --dil-thumb: var(--dsw-alias-switch-thumb, var(--dil-fb-thumb));\n\n  --dil-chart-1: var(--dsw-alias-brand-primary, #3b82f6);\n  --dil-chart-2: var(--dsw-alias-state-success-primary, #10a37f);\n  --dil-chart-3: var(--dsw-alias-state-warn-primary, #f59e0b);\n  --dil-chart-4: var(--dsw-alias-state-error-primary, #ef4444);\n  --dil-chart-5: var(--dsw-alias-state-business-primary, #8b5cf6);\n\n  --dil-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 2px 8px rgba(0, 0, 0, 0.04);\n  --dil-focus: 0 0 0 3px color-mix(in srgb, var(--dil-accent) 14%, transparent);\n\n  color-scheme: light;\n  color: var(--dil-text);\n  /* Fonts cross a shadow boundary by inheritance, and a face declared in the document\n     is usable inside it — so there is nothing to load and nothing to copy here. The\n     stack is upstream's, and `--dil-font` lets the host hand in its own family list\n     (setting it to an invalid value drops only the second declaration). */\n  font: 400 15px/1.65 ui-sans-serif, -apple-system, system-ui, \"Segoe UI\", \"PingFang SC\",\n    \"Hiragino Sans GB\", \"Microsoft YaHei\", sans-serif;\n  font-family: var(--dil-font, ui-sans-serif, -apple-system, system-ui, \"Segoe UI\", \"PingFang SC\",\n    \"Hiragino Sans GB\", \"Microsoft YaHei\", sans-serif);\n  -webkit-font-smoothing: antialiased;\n}\n\n.dil-root[data-dil-theme='dark'],\n:host([data-ds-dark-theme]) .dil-root {\n  --dil-fb-bg: #212121;\n  --dil-fb-surface: #2a2a2a;\n  --dil-fb-surface-2: #262626;\n  --dil-fb-sunken: #1b1b1b;\n  --dil-fb-overlay: #2f2f2f;\n  --dil-fb-hover: #353535;\n  --dil-fb-border: #383838;\n  --dil-fb-border-strong: #4a4a4a;\n  --dil-fb-text: #ececec;\n  --dil-fb-text-secondary: #b4b4b4;\n  --dil-fb-text-tertiary: #8a8a8a;\n  --dil-fb-accent: #ececec;\n  --dil-fb-accent-fg: #0d0d0d;\n  --dil-fb-link: #7ab7ff;\n  --dil-fb-success: #3ecf8e;\n  --dil-fb-warning: #f2b04c;\n  --dil-fb-danger: #ff6b6b;\n  --dil-fb-info: #7ab7ff;\n  --dil-fb-idle: #8a8a8a;\n  --dil-fb-sidebar: #262626;\n  --dil-fb-thumb: #ffffff;\n\n  --dil-chart-1: var(--dsw-alias-brand-primary, #60a5fa);\n  --dil-chart-2: var(--dsw-alias-state-success-primary, #34d399);\n  --dil-chart-3: var(--dsw-alias-state-warn-primary, #fbbf24);\n  --dil-chart-4: var(--dsw-alias-state-error-primary, #f87171);\n  --dil-chart-5: var(--dsw-alias-state-business-primary, #a78bfa);\n\n  --dil-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);\n  color-scheme: dark;\n}\n\n@media (prefers-color-scheme: dark) {\n  .dil-root:not([data-dil-theme]) {\n    --dil-fb-bg: #212121;\n    --dil-fb-surface: #2a2a2a;\n    --dil-fb-surface-2: #262626;\n    --dil-fb-sunken: #1b1b1b;\n    --dil-fb-overlay: #2f2f2f;\n    --dil-fb-hover: #353535;\n    --dil-fb-border: #383838;\n    --dil-fb-border-strong: #4a4a4a;\n    --dil-fb-text: #ececec;\n    --dil-fb-text-secondary: #b4b4b4;\n    --dil-fb-text-tertiary: #8a8a8a;\n    --dil-fb-accent: #ececec;\n    --dil-fb-accent-fg: #0d0d0d;\n    --dil-fb-link: #7ab7ff;\n    --dil-fb-success: #3ecf8e;\n    --dil-fb-warning: #f2b04c;\n    --dil-fb-danger: #ff6b6b;\n    --dil-fb-info: #7ab7ff;\n    --dil-fb-idle: #8a8a8a;\n    --dil-fb-sidebar: #262626;\n    --dil-fb-thumb: #ffffff;\n    --dil-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);\n    color-scheme: dark;\n  }\n}\n\n.dil-root *,\n.dil-root *::before,\n.dil-root *::after { box-sizing: border-box; }\n.dil-root > * + * { margin-top: 12px; }\n\n/* -- typography ------------------------------------------------------------ */\n\n.dil-text { display: block; overflow-wrap: anywhere; }\n.dil-text .dil-text,\n.dil-title .dil-text,\n.dil-button .dil-text,\n.dil-badge .dil-text,\n.dil-checkbox .dil-text,\n.dil-row > .dil-text { display: inline; }\n.dil-caption { display: block; font-size: 13px; color: var(--dil-text-secondary); }\n.dil-label { font-size: 13px; font-weight: 500; color: var(--dil-text-secondary); }\n.dil-bold { font-weight: 600; }\n.dil-code {\n  font: 500 0.88em/1.4 ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, monospace;\n  background: var(--dil-sunken);\n  border-radius: 6px;\n  padding: 0.12em 0.4em;\n}\n\n.dil-title { font-weight: 600; letter-spacing: -0.012em; line-height: 1.3; overflow-wrap: anywhere; }\n.dil-title-xs { font-size: 14px; }\n.dil-title-sm { font-size: 15px; }\n.dil-title-md { font-size: 17px; }\n.dil-title-lg { font-size: 20px; }\n.dil-title-xl { font-size: 28px; letter-spacing: -0.02em; }\n.dil-title-2xl { font-size: 34px; letter-spacing: -0.025em; }\n\n.dil-size-xs { font-size: 12px; }\n.dil-size-sm { font-size: 13.5px; }\n.dil-size-md { font-size: 15px; }\n.dil-size-lg { font-size: 17px; }\n.dil-size-xl { font-size: 22px; }\n\n.dil-weight-regular { font-weight: 400; }\n.dil-weight-medium { font-weight: 500; }\n.dil-weight-semibold { font-weight: 600; }\n.dil-weight-bold { font-weight: 700; }\n\n.dil-color-default { color: var(--dil-text); }\n.dil-color-secondary { color: var(--dil-text-secondary); }\n.dil-color-tertiary { color: var(--dil-text-tertiary); }\n.dil-color-accent, .dil-color-info { color: var(--dil-info); }\n.dil-color-success { color: var(--dil-success); }\n.dil-color-warning { color: var(--dil-warning); }\n.dil-color-danger { color: var(--dil-danger); }\n\n.dil-tabular { font-variant-numeric: tabular-nums; }\n.dil-block { display: block; width: 100%; }\n.dil-line-through { text-decoration: line-through; color: var(--dil-text-tertiary); }\n.dil-truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n\n/* -- layout ---------------------------------------------------------------- */\n\n.dil-box { display: flex; flex-direction: column; min-width: 0; }\n.dil-row { flex-direction: row; align-items: center; }\n.dil-column { flex-direction: column; }\n.dil-box > * + *, .dil-card > * + * { margin-top: 0; }\n.dil-box:not([style*=\"gap\"]):not(.dil-row) { gap: 8px; }\n.dil-row:not([style*=\"gap\"]) { gap: 8px; }\n.dil-wrap { flex-wrap: wrap; }\n.dil-flex { flex: 1 1 0%; min-width: 0; }\n.dil-clip { overflow: hidden; }\n\n.dil-border { border: 1px solid var(--dil-border); }\n.dil-radius-sm { border-radius: 8px; }\n.dil-radius-md { border-radius: 12px; }\n.dil-radius-lg { border-radius: 16px; }\n.dil-radius-xl { border-radius: 20px; }\n.dil-radius-2xl { border-radius: 24px; }\n.dil-radius-full { border-radius: 999px; }\n\n.dil-bg-surface { background: var(--dil-surface-2); }\n.dil-bg-raised { background: var(--dil-surface); box-shadow: var(--dil-shadow); }\n.dil-bg-overlay { background: var(--dil-overlay); box-shadow: var(--dil-shadow); }\n.dil-bg-sunken, .dil-bg-surface-secondary { background: var(--dil-sunken); }\n\n.dil-align-center { align-items: center; }\n.dil-align-start { align-items: flex-start; }\n.dil-align-end { align-items: flex-end; }\n.dil-align-stretch { align-items: stretch; }\n.dil-align-baseline { align-items: baseline; }\n.dil-justify-between { justify-content: space-between; }\n.dil-justify-around { justify-content: space-around; }\n.dil-justify-center { justify-content: center; }\n.dil-justify-end { justify-content: flex-end; }\n.dil-justify-start { justify-content: flex-start; }\n\n.dil-grid { display: grid; align-items: stretch; }\n.dil-grid-item { min-width: 0; display: flex; flex-direction: column; }\n.dil-grid-item > * { flex: 1 1 auto; }\n\n.dil-card {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  min-width: 0;\n  padding: 16px;\n  background: var(--dil-surface);\n  border: 1px solid var(--dil-border);\n  border-radius: 16px;\n}\n.dil-card.dil-bg-surface { background: var(--dil-surface-2); }\n.dil-card.dil-bg-sunken { background: var(--dil-sunken); border-color: transparent; }\n\n.dil-divider { border: 0; height: 1px; width: 100%; margin: 4px 0; background: var(--dil-border); flex: 0 0 auto; }\n.dil-divider-subtle { opacity: 0.6; }\n.dil-spacer { flex: 1 1 auto; }\n\n/* -- chrome ---------------------------------------------------------------- */\n\n.dil-icon { display: inline-flex; align-items: center; justify-content: center; color: var(--dil-text-secondary); flex: 0 0 auto; }\n.dil-icon.dil-inline { vertical-align: -0.15em; margin-right: 4px; }\n\n.dil-badge {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  width: fit-content;\n  border-radius: 999px;\n  padding: 2px 9px;\n  font-size: 12px;\n  font-weight: 500;\n  line-height: 1.6;\n  white-space: nowrap;\n  background: var(--dil-sunken);\n  color: var(--dil-text-secondary);\n}\n.dil-badge-success { background: color-mix(in srgb, var(--dil-success) 14%, transparent); color: var(--dil-success); }\n.dil-badge-warning { background: color-mix(in srgb, var(--dil-warning) 16%, transparent); color: var(--dil-warning); }\n.dil-badge-danger { background: color-mix(in srgb, var(--dil-danger) 13%, transparent); color: var(--dil-danger); }\n.dil-badge-accent, .dil-badge-info { background: color-mix(in srgb, var(--dil-info) 13%, transparent); color: var(--dil-info); }\n\n.dil-button {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  width: fit-content;\n  min-height: 36px;\n  padding: 0 14px;\n  border: 1px solid transparent;\n  border-radius: 999px;\n  font: inherit;\n  font-size: 14px;\n  font-weight: 500;\n  white-space: nowrap;\n  cursor: pointer;\n  transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;\n}\n.dil-button .dil-icon { color: inherit; }\n.dil-button:focus-visible { outline: none; box-shadow: var(--dil-focus); }\n.dil-button:disabled { opacity: 0.4; cursor: not-allowed; }\n.dil-variant-solid { background: var(--dil-accent); color: var(--dil-accent-fg); }\n.dil-variant-solid:hover:not(:disabled) { opacity: 0.85; }\n.dil-variant-outline, .dil-variant-secondary, .dil-variant-soft { background: var(--dil-surface); color: var(--dil-text); border-color: var(--dil-border-strong); }\n.dil-variant-outline:hover:not(:disabled), .dil-variant-secondary:hover:not(:disabled), .dil-variant-soft:hover:not(:disabled) { background: var(--dil-sunken); }\n.dil-variant-ghost { background: transparent; color: var(--dil-text-secondary); }\n.dil-variant-ghost:hover:not(:disabled) { background: var(--dil-hover); color: var(--dil-text); }\n.dil-variant-solid.dil-tone-danger { background: var(--dil-danger); color: var(--dil-accent-fg); }\n.dil-variant-solid.dil-tone-success { background: var(--dil-success); color: var(--dil-accent-fg); }\n.dil-variant-outline.dil-tone-danger, .dil-variant-ghost.dil-tone-danger { color: var(--dil-danger); }\n.dil-button.dil-size-xs { min-height: 26px; padding: 0 10px; font-size: 12px; }\n.dil-button.dil-size-sm { min-height: 30px; padding: 0 12px; font-size: 13px; }\n.dil-button.dil-size-lg { min-height: 44px; padding: 0 20px; font-size: 15px; }\n.dil-button.dil-block { width: 100%; }\n\n/* -- form controls --------------------------------------------------------- */\n\n.dil-input {\n  width: 100%;\n  min-height: 40px;\n  padding: 8px 12px;\n  background: var(--dil-surface);\n  border: 1px solid var(--dil-border-strong);\n  border-radius: 12px;\n  color: var(--dil-text);\n  font: inherit;\n  font-size: 14px;\n  outline: none;\n  transition: border-color 120ms ease, box-shadow 120ms ease;\n}\n.dil-input:focus { border-color: var(--dil-text-tertiary); box-shadow: var(--dil-focus); }\n.dil-input::placeholder { color: var(--dil-text-tertiary); }\n.dil-textarea { resize: vertical; line-height: 1.55; }\n\n.dil-checkbox {\n  position: relative;\n  display: inline-flex;\n  align-items: flex-start;\n  gap: 10px;\n  font-size: 14px;\n  cursor: pointer;\n  user-select: none;\n}\n.dil-checkbox input { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; }\n.dil-checkbox-box {\n  flex: 0 0 auto;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 18px;\n  height: 18px;\n  margin-top: 2.5px;\n  border-radius: 6px;\n  border: 1.5px solid var(--dil-border-strong);\n  background: var(--dil-surface);\n  color: transparent;\n  transition: background 120ms ease, border-color 120ms ease;\n}\n.dil-checkbox:hover .dil-checkbox-box { border-color: var(--dil-text-tertiary); }\n.dil-checkbox input:focus-visible + .dil-checkbox-box { box-shadow: var(--dil-focus); }\n.dil-checked .dil-checkbox-box { background: var(--dil-accent); border-color: var(--dil-accent); color: var(--dil-accent-fg); }\n.dil-checkbox-body { min-width: 0; }\n.dil-checkbox.dil-done .dil-checkbox-body { text-decoration: line-through; color: var(--dil-text-tertiary); }\n.dil-disabled { opacity: 0.5; cursor: not-allowed; }\n\n/* switch: same element, pill styling */\n.dil-switch .dil-checkbox-box { width: 34px; height: 20px; border-radius: 999px; margin-top: 1px; justify-content: flex-start; padding: 2px; border: 0; background: var(--dil-border-strong); }\n.dil-switch .dil-checkbox-box svg { display: none; }\n.dil-switch .dil-checkbox-box::after { content: ''; width: 16px; height: 16px; border-radius: 50%; background: var(--dil-thumb); box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: transform 160ms ease; }\n.dil-switch.dil-checked .dil-checkbox-box { background: var(--dil-success); }\n.dil-switch.dil-checked .dil-checkbox-box::after { transform: translateX(14px); }\n\n.dil-radio-group, .dil-radio-items { display: flex; flex-direction: column; gap: 10px; }\n.dil-radio-items:empty { display: none; }\n.dil-radio-group.dil-row, .dil-radio-group.dil-row .dil-radio-items { flex-direction: row; flex-wrap: wrap; gap: 16px; }\n.dil-radio { position: relative; display: flex; align-items: center; gap: 10px; font-size: 14px; cursor: pointer; }\n.dil-radio-body { flex: 1 1 auto; min-width: 0; }\n.dil-radio-dot { flex: 0 0 auto; }\n.dil-radio input { position: absolute; opacity: 0; pointer-events: none; }\n.dil-radio-dot { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid var(--dil-border-strong); display: inline-flex; align-items: center; justify-content: center; }\n.dil-radio.dil-checked .dil-radio-dot { border-color: var(--dil-accent); }\n.dil-radio.dil-checked .dil-radio-dot::after { content: ''; width: 9px; height: 9px; border-radius: 50%; background: var(--dil-accent); }\n\n.dil-select { position: relative; display: inline-flex; align-items: center; min-width: 140px; }\n.dil-select select {\n  appearance: none;\n  width: 100%;\n  min-height: 38px;\n  padding: 0 34px 0 12px;\n  background: var(--dil-surface);\n  border: 1px solid var(--dil-border-strong);\n  border-radius: 12px;\n  color: var(--dil-text);\n  font: inherit;\n  font-size: 14px;\n  cursor: pointer;\n  outline: none;\n}\n.dil-select select:focus { box-shadow: var(--dil-focus); }\n.dil-select-chevron { position: absolute; right: 12px; pointer-events: none; display: inline-flex; color: var(--dil-text-tertiary); }\n\n.dil-segmented {\n  display: inline-flex;\n  width: fit-content;\n  max-width: 100%;\n  gap: 2px;\n  padding: 3px;\n  overflow-x: auto;\n  background: var(--dil-sidebar);\n  border-radius: 999px;\n  scrollbar-width: none;\n}\n.dil-segmented-item {\n  flex: 0 0 auto;\n  border: 0;\n  background: transparent;\n  color: var(--dil-text-secondary);\n  font: inherit;\n  font-size: 13.5px;\n  font-weight: 500;\n  padding: 6px 14px;\n  border-radius: 999px;\n  cursor: pointer;\n  white-space: nowrap;\n  transition: background 140ms ease, color 140ms ease, box-shadow 140ms ease;\n}\n.dil-segmented-item:hover { color: var(--dil-text); }\n.dil-segmented-item.dil-active { background: var(--dil-surface); color: var(--dil-text); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12); }\n.dil-segmented.dil-block { display: flex; width: 100%; }\n.dil-segmented.dil-block .dil-segmented-item { flex: 1 1 0; }\n.dil-segmented.dil-size-lg .dil-segmented-item { padding: 8px 18px; font-size: 14.5px; }\n.dil-segmented.dil-size-sm .dil-segmented-item { padding: 4px 10px; font-size: 12.5px; }\n\n.dil-slider { display: flex; flex-direction: column; gap: 6px; width: 100%; --fill: 0%; }\n.dil-slider-head { display: flex; justify-content: space-between; font-size: 13px; }\n.dil-slider-label { color: var(--dil-text-secondary); }\n.dil-slider-value { font-variant-numeric: tabular-nums; font-weight: 500; }\n.dil-slider input {\n  appearance: none;\n  width: 100%;\n  height: 20px;\n  margin: 0;\n  background: transparent;\n  cursor: pointer;\n}\n.dil-slider input::-webkit-slider-runnable-track {\n  height: 4px;\n  border-radius: 999px;\n  background: linear-gradient(to right, var(--dil-accent) var(--fill), var(--dil-border) var(--fill));\n}\n.dil-slider input::-moz-range-track { height: 4px; border-radius: 999px; background: var(--dil-border); }\n.dil-slider input::-moz-range-progress { height: 4px; border-radius: 999px; background: var(--dil-accent); }\n.dil-slider input::-webkit-slider-thumb {\n  appearance: none;\n  width: 18px;\n  height: 18px;\n  margin-top: -7px;\n  border-radius: 50%;\n  background: var(--dil-surface);\n  border: 1px solid var(--dil-border-strong);\n  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);\n  transition: transform 120ms ease;\n}\n.dil-slider input::-moz-range-thumb { width: 18px; height: 18px; border-radius: 50%; background: var(--dil-surface); border: 1px solid var(--dil-border-strong); }\n.dil-slider input:active::-webkit-slider-thumb { transform: scale(1.12); }\n.dil-slider input:focus-visible::-webkit-slider-thumb { box-shadow: var(--dil-focus); }\n\n.dil-progress { display: flex; flex-direction: column; gap: 6px; width: 100%; }\n.dil-progress-head { display: flex; justify-content: space-between; font-size: 13px; color: var(--dil-text-secondary); }\n.dil-progress-pct { font-variant-numeric: tabular-nums; }\n.dil-progress-track { height: 6px; border-radius: 999px; background: var(--dil-sunken); overflow: hidden; }\n.dil-progress-bar { height: 100%; border-radius: inherit; width: 0; transition: width 360ms cubic-bezier(0.22, 1, 0.36, 1); background: var(--dil-text); }\n.dil-progress-bar.dil-tone-success { background: var(--dil-success); }\n.dil-progress-bar.dil-tone-warning { background: var(--dil-warning); }\n.dil-progress-bar.dil-tone-danger { background: var(--dil-danger); }\n.dil-progress-bar.dil-tone-info, .dil-progress-bar.dil-tone-accent { background: var(--dil-chart-1); }\n\n/* -- data ------------------------------------------------------------------ */\n\n.dil-table { display: flex; flex-direction: column; width: 100%; font-size: 14px; }\n.dil-table-row {\n  display: flex;\n  gap: 12px;\n  padding: 10px 4px;\n  border-bottom: 1px solid var(--dil-border);\n  align-items: center;\n}\n.dil-table-row:last-child { border-bottom: 0; }\n.dil-table-header { font-size: 12.5px; font-weight: 500; color: var(--dil-text-tertiary); padding-top: 4px; }\n.dil-table-row.dil-clickable { cursor: pointer; border-radius: 10px; }\n.dil-table-row.dil-clickable:hover, .dil-table-row.dil-selected { background: var(--dil-sunken); }\n.dil-table-cell { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\n\n.dil-list { margin: 0; padding-left: 1.4em; display: flex; flex-direction: column; gap: 6px; }\n.dil-list-none { list-style: none; padding-left: 0; }\n.dil-list-item { padding-left: 2px; }\n.dil-list-item::marker { color: var(--dil-text-tertiary); }\n\n/* -- charts ---------------------------------------------------------------- */\n\n.dil-chart { width: 100%; min-width: 0; display: flex; flex-direction: column; gap: 10px; }\n.dil-chart-svg { display: block; max-width: 100%; overflow: visible; }\n.dil-chart-grid { stroke: var(--dil-border); stroke-width: 1; stroke-dasharray: 3 3; }\n.dil-chart-zero { stroke-dasharray: none; stroke: var(--dil-border-strong); }\n.dil-chart-axis { font-size: 11.5px; fill: var(--dil-text-tertiary); font-variant-numeric: tabular-nums; }\n.dil-chart-line { stroke-width: 2.25; stroke-linejoin: round; stroke-linecap: round; }\n.dil-chart-dot { stroke: var(--dil-bg); stroke-width: 1.5; }\n.dil-chart-bar { transform-box: fill-box; transform-origin: bottom; animation: dil-grow 480ms cubic-bezier(0.22, 1, 0.36, 1) both; }\n.dil-chart-bar:hover, .dil-chart-slice:hover { opacity: 0.8; }\n@keyframes dil-grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }\n.dil-chart-legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12.5px; color: var(--dil-text-secondary); }\n.dil-chart-legend span { display: inline-flex; align-items: center; gap: 6px; }\n.dil-chart-legend i, .dil-pie-item i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: 0 0 auto; }\n\n.dil-pie { display: flex; align-items: center; gap: 28px; flex-wrap: wrap; justify-content: center; }\n.dil-pie svg { flex: 0 0 auto; }\n.dil-pie-legend { display: flex; flex-direction: column; gap: 8px; min-width: 160px; flex: 1 1 160px; max-width: 320px; }\n.dil-pie-item { display: flex; align-items: center; gap: 8px; font-size: 13.5px; }\n.dil-pie-item span { color: var(--dil-text-secondary); flex: 1 1 auto; }\n.dil-pie-item b { font-weight: 600; font-variant-numeric: tabular-nums; }\n.dil-pie-item em { font-style: normal; color: var(--dil-text-tertiary); font-variant-numeric: tabular-nums; width: 3.2em; text-align: right; }\n\n/* -- misc ------------------------------------------------------------------ */\n\n.dil-image { max-width: 100%; border-radius: 12px; display: block; object-fit: cover; }\n.dil-link { color: var(--dil-link); text-decoration: underline; text-underline-offset: 2px; text-decoration-color: color-mix(in srgb, currentColor 35%, transparent); }\n.dil-link:hover { text-decoration-color: currentColor; }\n.dil-spinner { display: inline-flex; animation: dil-spin 900ms linear infinite; color: var(--dil-idle); }\n@keyframes dil-spin { to { transform: rotate(360deg); } }\n\n/* -- host components ------------------------------------------------------- */\n\n.dil-widget {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 10px 14px;\n  border: 1px dashed var(--dil-border-strong);\n  border-radius: 12px;\n  color: var(--dil-text-secondary);\n}\n.dil-widget-icon { display: inline-flex; color: var(--dil-text-tertiary); }\n.dil-widget-body { display: flex; flex-direction: column; line-height: 1.4; }\n.dil-widget-body b { font-weight: 600; font-size: 13.5px; color: var(--dil-text); }\n.dil-widget-body small { font-size: 12px; color: var(--dil-text-tertiary); }\n\n.dil-memory-cite {\n  display: inline-flex;\n  align-items: center;\n  gap: 3px;\n  margin-left: 6px;\n  padding: 1px 8px;\n  border-radius: 999px;\n  font-size: 12px;\n  line-height: 1.6;\n  vertical-align: 0.1em;\n  color: var(--dil-text-secondary);\n  background: var(--dil-sunken);\n  cursor: help;\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .dil-root * { animation: none !important; transition: none !important; }\n}\n";
		//#endregion
		//#region src/client/dil/theme.ts
		/**
		* Theme plumbing for the DIL view: the stylesheet, the scheme, and the host element
		* that carries both.
		*
		* A `ShadowRoot` is a style boundary, and three consequences shape this module:
		*
		*   • A page stylesheet cannot reach inside, so the library ships as text and is
		*     injected as one `<style>` in the shadow root. Injection is idempotent: the
		*     first mount in a root installs it, every later one reuses the element.
		*   • Custom properties *do* cross the boundary, so `--dsw-alias-*` on `body` resolves
		*     for the tree without any copy step. Only the token's fallback needs a dark
		*     variant, which `theme.css` keys on `data-dil-theme`.
		*   • `prefers-color-scheme` inside a shadow root answers for the OS, not for the app.
		*     DSH paints dark by putting `data-ds-dark-theme` on the document, and no selector
		*     written inside a shadow root can see that attribute on an ancestor — so the
		*     scheme is resolved here and mirrored onto the view element, and it is kept in
		*     step with a MutationObserver plus the media query.
		* @module dsh-intelligent-ui/client/dil/theme
		*/
		/** Attribute marking the injected stylesheet, so mounts share one. */
		const STYLE_ATTRIBUTE = "data-dil-styles";
		/** Attribute carrying the resolved scheme on the view element. */
		const THEME_ATTRIBUTE = "data-dil-theme";
		/**
		* Inject the library stylesheet into a shadow root, once.
		* @param root - the shadow root the view renders in.
		* @returns the style element, existing or new.
		*/
		function installDilStyles(root) {
			const existing = root.querySelector(`style[${STYLE_ATTRIBUTE}]`);
			if (existing) return existing;
			const style = (root.ownerDocument ?? globalThis.document).createElement("style");
			style.setAttribute(STYLE_ATTRIBUTE, "");
			style.textContent = THEME_CSS;
			root.insertBefore(style, root.firstChild);
			return style;
		}
		/**
		* The scheme the app is painting with.
		*
		* Read in the same order the artifact frame uses — the host's declared `color-scheme`
		* first, because it is the one the app itself computed and it covers a host that
		* follows neither the attribute nor the OS.
		* @param document - the document the view lives in.
		* @param view - its window, for `getComputedStyle` and `matchMedia`.
		* @returns the scheme the view should paint with.
		*/
		function resolveScheme(document, view) {
			const body = document.body;
			if (view && body) {
				const declared = view.getComputedStyle(body).colorScheme ?? "";
				const dark = declared.includes("dark") && !declared.includes("light");
				const light = declared.includes("light") && !declared.includes("dark");
				if (dark) return "dark";
				if (light) return "light";
			}
			if (body?.hasAttribute("data-ds-dark-theme") || document.documentElement.hasAttribute("data-ds-dark-theme")) return "dark";
			if (view && typeof view.matchMedia === "function") try {
				if (view.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
			} catch {}
			return "light";
		}
		/**
		* Watch for a scheme change: an attribute flip on the document, or the OS preference.
		* @param document - the document to observe.
		* @param view - its window.
		* @param onChange - called only when the resolved scheme actually changes.
		* @returns stop watching.
		*/
		function watchScheme(document, view, onChange) {
			let last = resolveScheme(document, view);
			const check = () => {
				const next = resolveScheme(document, view);
				if (next === last) return;
				last = next;
				onChange(next);
			};
			const Observer = view?.MutationObserver ?? globalThis.MutationObserver;
			const observer = typeof Observer === "function" ? new Observer(check) : null;
			observer?.observe(document.documentElement, { attributes: true });
			if (document.body) observer?.observe(document.body, { attributes: true });
			let media = null;
			if (view && typeof view.matchMedia === "function") try {
				media = view.matchMedia("(prefers-color-scheme: dark)");
				media.addEventListener("change", check);
			} catch {
				media = null;
			}
			return () => {
				observer?.disconnect();
				media?.removeEventListener("change", check);
			};
		}
		//#endregion
		//#region src/client/dil/view-state.ts
		/** One RFC 4122 v4 id, from the platform generator when there is one. */
		function uuid() {
			const source = globalThis.crypto;
			if (typeof source?.randomUUID === "function") return source.randomUUID();
			return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/gu, (char) => {
				const random = Math.random() * 16 | 0;
				return (char === "x" ? random : random & 3 | 8).toString(16);
			});
		}
		/** One id per page load, like the captured `client_session_id`. */
		const CLIENT_SESSION_ID = uuid();
		/**
		* Build a reporter.
		* @param options - the sink, the readiness gate, and the window.
		*/
		function createStateReporter(options) {
			const delayMs = options.delayMs ?? 600;
			let pending = null;
			let timer = null;
			function flush() {
				if (timer !== null) {
					clearTimeout(timer);
					timer = null;
				}
				if (!pending) return false;
				if (options.ready && !options.ready()) return false;
				const { scope, state } = pending;
				pending = null;
				try {
					options.send({
						client_session_id: CLIENT_SESSION_ID,
						updates: [{
							scope,
							state,
							client_update_id: uuid()
						}]
					});
					return true;
				} catch (error) {
					options.onError?.(error);
					return false;
				}
			}
			return {
				queue(state, scope = "root") {
					pending = {
						scope,
						state
					};
					if (timer === null) timer = setTimeout(() => void flush(), delayMs);
				},
				flush,
				get hasPending() {
					return pending !== null;
				},
				cancel() {
					if (timer !== null) {
						clearTimeout(timer);
						timer = null;
					}
					pending = null;
				}
			};
		}
		//#endregion
		//#region src/client/dil/mount.ts
		/**
		* `mountDilView` — the one entry point the host half calls.
		*
		*   update(DilCompiled) ─► sandbox(frame ─► worker) ─► tree ─► renderer ─► shadow DOM
		*                                     ▲                              │
		*                                     └──── trigger(fnId, args) ◄────┘ DOM event
		*
		* What this function owns: the stylesheet and the view element in the given shadow
		* root, the frame, the patched-up DOM tree, the coalesced keyed-state report, and the
		* teardown of all four. What it deliberately does not own: the card chrome (React, the
		* host half), the streaming (the host half), and the fallback markdown for a client
		* without a sandbox (the host half).
		*
		* The tree itself is rendered with the plain DOM renderer, never React: the sandbox
		* emits data, the patcher keeps node identity across revisions (an `<input>` keeps
		* focus while the model streams its own next revision), and a React tree would re-own
		* the very nodes that identity depends on.
		* @module dsh-intelligent-ui/client/dil/mount
		*/
		/** Class on the element the tree renders into; the stylesheet is keyed on it. */
		const VIEW_CLASS = "dil-root";
		/** Marker on the element this module created, so a host can find it again. */
		const VIEW_ATTRIBUTE = "data-dil-view";
		/** Marker on the hidden element that hosts the frame. */
		const FRAME_HOST_ATTRIBUTE = "data-dil-frame-host";
		/** Merge the compiled revision's appData under the embedder's, as upstream does. */
		function mergeAppData(compiled, local) {
			const server = compiled ?? {};
			const embedder = local ?? {};
			return {
				...server,
				...embedder,
				opGenui: {
					...server.opGenui ?? {},
					...embedder.opGenui ?? {}
				}
			};
		}
		/**
		* Mount a DIL view, and keep the internals reachable for tests and diagnostics.
		* @param root - the shadow root to render in; a style element and the view element are added to it.
		* @param opts - state sink, event sink, embedder appData, optional frame URL.
		* @returns the handle plus the parts the frozen contract does not expose.
		*/
		function mountDilViewInternal(root, opts) {
			const document = root.ownerDocument ?? globalThis.document;
			const view = document.defaultView ?? globalThis;
			installDilStyles(root);
			const element = document.createElement("div");
			element.className = VIEW_CLASS;
			element.setAttribute(VIEW_ATTRIBUTE, "");
			element.setAttribute(THEME_ATTRIBUTE, resolveScheme(document, view));
			root.appendChild(element);
			const frameHost = document.createElement("div");
			frameHost.setAttribute(FRAME_HOST_ATTRIBUTE, "");
			frameHost.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
			root.appendChild(frameHost);
			const protocol = [];
			const snapshotLog = [];
			const failures = [];
			const stopWatching = watchScheme(document, view, (scheme) => element.setAttribute(THEME_ATTRIBUTE, scheme));
			const runnerId = "dil_" + Math.random().toString(36).slice(2, 10);
			let state = {};
			let program = null;
			let pendingProgram = null;
			let runnerCreated = false;
			let destroyed = false;
			const reporter = createStateReporter({
				delayMs: 600,
				send: (report) => {
					const update = report.updates[0];
					if (update) opts.onStateChange(update.state, update.scope);
				}
			});
			let renderer = null;
			const sandbox = new DilSandbox({
				frameUrl: opts.frameUrl,
				container: frameHost,
				document,
				onProtocol: (entry) => protocol.push(entry),
				onSnapshot: (snapshot) => {
					snapshotLog.push(snapshot);
					if (snapshot.error) {
						failures.push({
							error: snapshot.error,
							stage: "render"
						});
						return;
					}
					if (!snapshot.tree) return;
					renderer?.update(snapshot.tree);
				},
				onStateChange: (next, scope) => {
					if (!destroyed) reporter.queue(next, scope);
				},
				onFailure: (error, stage) => {
					failures.push({
						error,
						stage
					});
				}
			});
			renderer = mount(element, null, {
				appData: opts.appData,
				document,
				onEvent: (fnId, args) => {
					if (destroyed) return;
					sandbox.trigger(fnId, args);
					opts.onEvent(fnId, args);
				}
			});
			function payloadOf(compiled, seed) {
				return {
					compiledDil: compiled.code,
					constants: compiled.constants ?? {},
					appData: mergeAppData(compiled.appData, opts.appData),
					initialState: seed
				};
			}
			/** Push the current program, spawning the worker on the first delivery. */
			function push(payload, restart) {
				if (!sandbox.connected) {
					pendingProgram = payload;
					return;
				}
				if (!runnerCreated || restart) {
					runnerCreated = true;
					sandbox.createRunner(runnerId, payload);
					return;
				}
				sandbox.setCompiledDil({
					compiledDil: payload.compiledDil,
					constants: payload.constants,
					appData: payload.appData
				});
			}
			sandbox.connect().then(() => {
				if (destroyed) return;
				if (pendingProgram) {
					const payload = pendingProgram;
					pendingProgram = null;
					push(payload, false);
				}
			}, (error) => {
				failures.push({
					error: {
						name: "SandboxError",
						message: error instanceof Error ? error.message : String(error)
					},
					stage: "connect"
				});
			});
			return {
				handle: {
					update(compiled) {
						if (destroyed) return;
						program = compiled;
						if (compiled.appData !== void 0) renderer?.setAppData(mergeAppData(compiled.appData, opts.appData));
						push(payloadOf(compiled, state), false);
					},
					setState(next) {
						if (destroyed) return;
						state = {
							...state,
							...next
						};
						if (!program || !runnerCreated) {
							if (pendingProgram) pendingProgram = {
								...pendingProgram,
								initialState: state
							};
							return;
						}
						push(payloadOf(program, state), true);
					},
					destroy() {
						if (destroyed) return;
						destroyed = true;
						reporter.flush();
						stopWatching();
						sandbox.dispose();
						renderer?.destroy();
						element.remove();
						frameHost.remove();
					}
				},
				element,
				sandbox,
				protocol,
				snapshots: () => snapshotLog,
				failures: () => failures
			};
		}
		/**
		* Mount a DIL view into a shadow root.
		* @param root - the shadow root to render in.
		* @param opts - state sink, event sink, embedder appData, optional frame URL.
		* @returns the handle the host half drives: `update` per revision, `setState` to seed, `destroy` to tear down.
		*/
		function mountDilView(root, opts) {
			return mountDilViewInternal(root, opts).handle;
		}
		//#endregion
		//#region src/client/Panel.tsx
		/**
		* The right-column Artifacts panel: every artifact this session has produced,
		* with the selected one rendered live. It is the persistent home an artifact
		* keeps after its card has scrolled away, and it adopts later revisions through
		* the same shared store the cards use.
		* @module dsh-intelligent-ui/client/Panel
		*/
		/** Ceiling for the panel preview, which lives in a full-height column. */
		const PANEL_MAX_HEIGHT = 4e3;
		/** The artifact catalog and its live preview. */
		function ArtifactPanel(props) {
			const [, setTick] = (0, react.useState)(0);
			const [selected, setSelected] = (0, react.useState)(null);
			(0, react.useEffect)(() => artifactStore.subscribeAll(() => {
				setTick((value) => value + 1);
			}), []);
			const rows = (0, react.useMemo)(() => {
				const all = artifactStore.list();
				if (props.sessionId === void 0) return all;
				return all.filter((state) => state.meta.session === void 0 || state.meta.session === props.sessionId);
			}, [
				props.sessionId,
				artifactStore.list().length,
				selected
			]);
			const active = rows.find((state) => state.meta.id === (selected ?? artifactStore.focused())) ?? rows[0];
			if (rows.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: "14px 12px",
					fontSize: 12,
					opacity: .6,
					lineHeight: 1.6
				},
				children: [
					"这个会话还没有 artifact。",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}),
					"让模型做一个可交互的页面、图表或模拟器，它就会出现在这里，并随每次修改原地更新。"
				]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 8,
					padding: "8px 10px 12px"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						display: "flex",
						flexWrap: "wrap",
						gap: 6
					},
					children: rows.map((state) => {
						const current = state.meta.id === active?.meta.id;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							onClick: () => setSelected(state.meta.id),
							style: {
								font: "inherit",
								fontSize: 11,
								padding: "3px 8px",
								borderRadius: 6,
								cursor: "pointer",
								border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
								background: current ? "var(--dsw-alias-bg-layer-1, rgba(128,128,128,.14))" : "transparent",
								color: "inherit",
								maxWidth: 200,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap"
							},
							title: `${state.meta.title} · ${state.meta.id}`,
							children: [
								state.meta.title,
								" · v",
								state.meta.version
							]
						}, state.meta.id);
					})
				}), active !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PanelSlot, { state: active })]
			});
		}
		/** The panel's preview area: a live frame for an HTML revision, a live interface for a DIL one. */
		function PanelSlot({ state }) {
			const html = asHtmlMeta(state.meta);
			if (html !== void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PanelFrame, { state: {
				...state,
				meta: html
			} }, state.meta.id);
			const compiled = asDilMeta(state.meta)?.dil;
			if (compiled === void 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PanelDil, {
				id: state.meta.id,
				compiled
			}, state.meta.id);
		}
		/**
		* One live DIL interface inside the panel.
		*
		* This is the column's copy of what the conversation card is showing, and it holds
		* the same state: a control moved here moves there. The two are views of one
		* interface rather than two interfaces, which is the whole claim of giving a
		* generated surface a home in a column.
		* @param props - the artifact to mount and its compiled program.
		* @returns the host element the interface renders into.
		*/
		function PanelDil({ id, compiled }) {
			const hostRef = (0, react.useRef)(null);
			const handleRef = (0, react.useRef)(null);
			const ready = compiled.code.length > 0;
			(0, react.useEffect)(() => {
				const host = hostRef.current;
				if (host === null || !ready) return;
				const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
				const adopt = (next) => {
					handleRef.current?.setState(next);
				};
				const handle = mountDilView(shadow, {
					onStateChange: (next) => {
						publishDilState(id, next, adopt);
					},
					onEvent: () => {},
					appData: compiled.appData
				});
				handleRef.current = handle;
				const unsubscribe = subscribeDilState(id, adopt);
				const opening = dilStateOf(id);
				if (Object.keys(opening).length > 0) handle.setState(opening);
				return () => {
					unsubscribe();
					handle.destroy();
					handleRef.current = null;
				};
			}, [id, ready]);
			(0, react.useEffect)(() => {
				if (ready) handleRef.current?.update(compiled);
			}, [compiled, ready]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				ref: hostRef,
				style: { minHeight: 160 }
			});
		}
		/** One live HTML artifact preview inside the panel. */
		function PanelFrame({ state }) {
			const iframeRef = (0, react.useRef)(null);
			const storageRef = (0, react.useRef)(state.storage);
			const adoptedRef = (0, react.useRef)(state.meta.version);
			const sourceRef = (0, react.useRef)(state.meta);
			const [theme, setTheme] = (0, react.useState)(() => resolveTheme());
			const [generation, setGeneration] = (0, react.useState)(0);
			const [height, setHeight] = (0, react.useState)(240);
			sourceRef.current = asHtmlMeta(artifactStore.get(state.meta.id)?.meta ?? state.meta) ?? sourceRef.current;
			const themeRef = (0, react.useRef)(theme);
			themeRef.current = theme;
			const doc = (0, react.useMemo)(() => buildFrameDoc({
				html: sourceRef.current.html,
				title: sourceRef.current.title,
				theme: themeRef.current,
				token: sourceRef.current.id,
				seed: storageRef.current
			}), [generation, state.meta.id]);
			(0, react.useEffect)(() => {
				const bump = () => setTheme(resolveTheme());
				const observer = new MutationObserver(bump);
				observer.observe(document.documentElement, { attributes: true });
				observer.observe(document.body, { attributes: true });
				return () => observer.disconnect();
			}, []);
			(0, react.useEffect)(() => artifactStore.subscribe(state.meta.id, (next) => {
				if (next === void 0) return;
				if (next.meta.version <= adoptedRef.current) return;
				adoptedRef.current = next.meta.version;
				storageRef.current = artifactStore.get(state.meta.id)?.storage ?? storageRef.current;
				setGeneration((value) => value + 1);
			}), [state.meta.id]);
			(0, react.useEffect)(() => {
				const onMessage = (event) => {
					const frame = iframeRef.current;
					if (frame === null || event.source !== frame.contentWindow) return;
					const message = event.data;
					if (message === null || typeof message !== "object" || message.token !== sourceRef.current.id) return;
					if (message.type === "dsh-artifacts:height" && typeof message.height === "number" && Number.isFinite(message.height)) {
						setHeight(Math.max(120, Math.min(Math.ceil(message.height), PANEL_MAX_HEIGHT)));
						return;
					}
					if (message.type === "dsh-artifacts:storage" && message.store === "local" && message.entries !== void 0) {
						storageRef.current = message.entries;
						artifactStore.rememberStorage(sourceRef.current.id, message.entries);
					}
				};
				window.addEventListener("message", onMessage);
				return () => window.removeEventListener("message", onMessage);
			}, []);
			const openSource = (0, react.useCallback)(() => {
				navigator.clipboard.writeText(sourceRef.current.html);
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 6
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "baseline",
						gap: 8,
						fontSize: 11,
						opacity: .7,
						flexWrap: "wrap"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { fontWeight: 500 },
							children: state.meta.title
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["v", state.meta.version] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: { opacity: .7 },
							children: [state.meta.sizeBytes, " 字节"]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: openSource,
							style: {
								marginLeft: "auto",
								font: "inherit",
								fontSize: 11,
								padding: "2px 8px",
								borderRadius: 6,
								cursor: "pointer",
								border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
								background: "transparent",
								color: "inherit"
							},
							children: "复制源码"
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("iframe", {
					ref: iframeRef,
					sandbox: "allow-scripts allow-modals",
					referrerPolicy: "no-referrer",
					title: state.meta.title,
					srcDoc: doc,
					style: {
						display: "block",
						width: "100%",
						border: 0,
						background: "transparent",
						colorScheme: "normal",
						height
					}
				})]
			});
		}
		/** Marker-shaped id: what the tool hands out. */
		const ARTIFACT_ID = /^art-[a-z0-9]{4,}$/u;
		/** The platform's code-block surface, stable across the shipped renderers. */
		const CODE_BLOCK = "div.md-code-block";
		/**
		* Read the fence language and body out of one rendered code block.
		* @param block - a rendered code block element.
		* @returns the info string and the block's source text.
		*/
		function readFence(block) {
			const info = block.querySelector("[data-code-block-banner]")?.textContent ?? "";
			const pre = block.querySelector("pre");
			return {
				lang: info.trim().split("\n")[0]?.trim() ?? "",
				body: pre?.textContent ?? ""
			};
		}
		/**
		* The artifact id a code block claims, or undefined when it is not a marker.
		*
		* Three shapes are accepted, in falling order of explicitness:
		*
		* 1. the block's fence language is the artifact fence;
		* 2. the block's first line names the fence — `dsh-artifact art-xxxxxxxx`;
		* 3. the block's first line **is** a marker-shaped id.
		*
		* (3) is what this build needs: its markdown renderer maps every language it does
		* not know to a localized label, so `dsh-artifact` never reaches the DOM and the
		* info string carries no information at all. Shape alone is weak, so a caller
		* must still find the id among known artifacts before claiming the block — which
		* also leaves the protocol's own examples rendering as code.
		* @param lang - the block's fence language, when the host publishes one.
		* @param body - the block's source text.
		* @returns the claimed artifact id, when there is one.
		*/
		function markerIdOf(lang, body) {
			const first = body.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
			const head = first.split(/\s+/u)[0] ?? "";
			if (lang.toLowerCase() === "dsh-artifact") return ARTIFACT_ID.test(head) ? head : void 0;
			if (head === "dsh-artifact") {
				const claimed = first.split(/\s+/u)[1];
				return claimed !== void 0 && ARTIFACT_ID.test(claimed) ? claimed : void 0;
			}
			return ARTIFACT_ID.test(head) ? head : void 0;
		}
		/** The artifact id a rendered code block claims. */
		function markedId(block) {
			const { lang, body } = readFence(block);
			return markerIdOf(lang, body);
		}
		/** One artifact frame mounted in place of a marker block. */
		function FenceCard({ id }) {
			const [meta, setMeta] = (0, react.useState)(() => artifactStore.get(id)?.meta);
			(0, react.useEffect)(() => {
				const current = artifactStore.get(id);
				if (current !== void 0) setMeta(current.meta);
				return artifactStore.subscribe(id, (state) => {
					if (state !== void 0) setMeta(state.meta);
				});
			}, [id]);
			const html = meta === void 0 ? void 0 : asHtmlMeta(meta);
			const dil = meta === void 0 ? void 0 : asDilMeta(meta);
			if (dil !== void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DilFence, {
				id,
				meta: dil
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ArtifactFrame, {
				callId: `fence:${id}`,
				meta: html,
				inputActions: sessionInput.current,
				onOpenPanel: panelOpener.current === void 0 ? void 0 : () => panelOpener.current?.(id)
			});
		}
		const DIL_HEADER = {
			display: "flex",
			alignItems: "baseline",
			gap: 8,
			flexWrap: "wrap",
			fontSize: 12,
			opacity: .75,
			marginBottom: 6
		};
		const DIL_ACTION = {
			border: "1px solid var(--dsw-alias-border-l2, #ccc)",
			background: "transparent",
			color: "inherit",
			borderRadius: 6,
			padding: "2px 8px",
			font: "inherit",
			fontSize: 11,
			cursor: "pointer"
		};
		/**
		* The compiled interface, mounted at its marker.
		*
		* The program is pushed into one long-lived runtime rather than remounted per
		* revision: the sandbox, the render tree and the user's control state all
		* survive a patch, which is the whole reason this path is compiled rather than
		* framed. The chrome is React; the interface itself is drawn by the DIL renderer
		* as plain DOM inside a shadow root, so host styles cannot reach it and the
		* theme tokens still cross the boundary.
		*
		* @param props - the revision to mount and the id its marker claimed.
		* @returns the card.
		*/
		function DilFence({ id, meta }) {
			const hostRef = (0, react.useRef)(null);
			const handleRef = (0, react.useRef)(null);
			const stateRef = (0, react.useRef)(dilStateOf(id));
			const [stateCount, setStateCount] = (0, react.useState)(() => Object.keys(stateRef.current).length);
			const [notice, setNotice] = (0, react.useState)(null);
			const compiled = meta.dil;
			const ready = compiled.code.length > 0;
			const adopt = (0, react.useRef)((next) => {
				stateRef.current = next;
				handleRef.current?.setState(next);
				setStateCount(Object.keys(next).length);
			}).current;
			(0, react.useEffect)(() => subscribeDilState(id, adopt), [id, adopt]);
			(0, react.useEffect)(() => {
				const host = hostRef.current;
				if (host === null || !ready) return;
				const handle = mountDilView(host.shadowRoot ?? host.attachShadow({ mode: "open" }), {
					onStateChange: (state) => {
						stateRef.current = state;
						setStateCount(Object.keys(state).length);
						publishDilState(id, state, adopt);
					},
					onEvent: () => {},
					appData: compiled.appData
				});
				handleRef.current = handle;
				if (Object.keys(stateRef.current).length > 0) handle.setState(stateRef.current);
				return () => {
					handle.destroy();
					handleRef.current = null;
				};
			}, [id, ready]);
			(0, react.useEffect)(() => {
				if (!ready) return;
				handleRef.current?.update(compiled);
			}, [compiled, ready]);
			const submit = (0, react.useCallback)(() => {
				const inputActions = sessionInput.current;
				if (inputActions === void 0) {
					setNotice("当前会话没有可用的回注通道");
					return;
				}
				const span = inputActions.captureInsertion();
				if (!inputActions.insertText(interactionReport(meta, stateRef.current), span)) {
					setNotice("插入被拒绝：草稿已变化，请重试");
					return;
				}
				inputActions.submit();
				setNotice("已把当前设置发回会话");
			}, [meta]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: DIL_HEADER,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { fontWeight: 500 },
							children: meta.title
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["v", meta.version] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { opacity: .55 },
							children: id
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: {
								marginLeft: "auto",
								display: "flex",
								gap: 6,
								alignItems: "center"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: DIL_ACTION,
								onClick: submit,
								disabled: stateCount === 0,
								children: "把当前设置交回对话"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: DIL_ACTION,
								onClick: () => panelOpener.current?.(id),
								children: "在侧栏打开"
							})]
						})
					]
				}),
				ready ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { ref: hostRef }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						fontSize: 12,
						opacity: .6
					},
					children: "正在编译界面…"
				}),
				notice !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						fontSize: 11,
						opacity: .6,
						marginTop: 4
					},
					children: notice
				})
			] });
		}
		/** Mount a live React frame in the host element. */
		const reactFenceMount = (host, id) => {
			const root = (0, react_dom_client.createRoot)(host);
			root.render(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(FenceCard, { id }));
			return () => {
				root.unmount();
			};
		};
		/**
		* Watches the rendered transcript for artifact markers and mounts each one's
		* frame in place of its block.
		*/
		var FenceChannel = class {
			#claims = /* @__PURE__ */ new Map();
			#mount;
			#observe;
			#observer = null;
			#unsubscribe;
			#scheduled = false;
			#poll = null;
			/**
			* @param mount - how a claimed block becomes a frame.
			* @param observe - subtree to watch; the whole document by default.
			*/
			constructor(mount = reactFenceMount, observe = document) {
				this.#mount = mount;
				this.#observe = observe;
			}
			/** Claim every marker currently rendered and follow later ones. */
			start() {
				this.scan();
				this.#unsubscribe = artifactStore.subscribeAll(() => {
					this.scan();
				});
				const target = this.#observe === document ? document.body : this.#observe;
				if (target === null) {
					document.addEventListener("DOMContentLoaded", () => {
						this.start();
					}, { once: true });
					return;
				}
				this.#observer = new MutationObserver(() => {
					if (this.#scheduled) return;
					this.#scheduled = true;
					const run = () => {
						this.#scheduled = false;
						this.scan();
					};
					if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
					else setTimeout(run, 16);
				});
				this.#observer.observe(target, {
					childList: true,
					subtree: true
				});
				this.#poll = setInterval(() => {
					if (document.visibilityState === "hidden") return;
					this.scan();
				}, 1e3);
			}
			/** Release every frame and stop watching. */
			stop() {
				if (this.#poll !== null) clearInterval(this.#poll);
				this.#poll = null;
				this.#unsubscribe?.();
				this.#unsubscribe = void 0;
				this.#observer?.disconnect();
				this.#observer = null;
				for (const claim of this.#claims.values()) claim.dispose();
				this.#claims.clear();
			}
			/** How many markers are currently claimed, for diagnostics and tests. */
			get claimed() {
				return this.#claims.size;
			}
			/**
			* Claim newly rendered markers and forget blocks the transcript dropped.
			*
			* A block is claimed only once the artifact is known, so a marker for an id
			* this page has not seen — a transcript replayed without its tool results —
			* keeps rendering as code instead of claiming an empty frame.
			*/
			scan() {
				for (const [block, claim] of this.#claims) {
					if (claim.host.isConnected && block.isConnected) continue;
					claim.dispose();
					this.#claims.delete(block);
				}
				for (const block of this.#observe.querySelectorAll(CODE_BLOCK)) {
					if (this.#claims.has(block)) continue;
					const id = markedId(block);
					if (id === void 0 || artifactStore.get(id) === void 0) continue;
					const host = block.ownerDocument.createElement("div");
					host.setAttribute("data-dsh-artifact", id);
					block.parentNode?.insertBefore(host, block);
					if (block instanceof HTMLElement) block.style.display = "none";
					this.#claims.set(block, {
						host,
						id,
						dispose: this.#mount(host, id)
					});
				}
			}
		};
		//#endregion
		//#region src/client/index.tsx
		const name = PLUGIN_ID;
		/** Slot access is the one hard dependency of this half. */
		const inject = ["slots"];
		/** Page-type discriminator for `ctx.sidebarRight.openTab`. */
		const PANEL_KIND = "dsh-intelligent-ui";
		/** Registration identity; also the key the body and chip register under. */
		const PANEL_DEFINITION = `${PLUGIN_ID}:panel`;
		/** Name one failure for the console without throwing. */
		function describeFailure(error) {
			return error instanceof Error ? error.message : String(error);
		}
		/**
		* Wire one seat on a context.
		*
		* A method call, deliberately: see the module note above.
		* @param target - the context that owns the registration.
		* @param label - name used in the diagnostic.
		* @param seat - slot key.
		* @param options - registration options for that seat.
		* @param component - the component to register.
		*/
		function wireOn(target, label, seat, options, component) {
			const register = (o, c) => target.slots.register(o, c);
			try {
				target.slots.inject(seat, () => {
					try {
						return register(options, component);
					} catch (error) {
						console.warn(`[${PLUGIN_ID}] seat "${label}" was refused`, describeFailure(error));
						return () => void 0;
					}
				});
			} catch (error) {
				console.warn(`[${PLUGIN_ID}] seat "${label}" could not be armed`, describeFailure(error));
			}
		}
		/**
		* Read a service off a context, whichever way this runtime exposes it.
		*
		* The framework resolves an injected dependency through the context proxy, so
		* \`scope.sidebarRight\` is the idiom. The store read (\`ctx.get\`) is what this half
		* used before and is proven to work against the real client runtime. Reading both
		* costs nothing and survives either mechanism.
		* @param scope - the context to read from.
		* @param name - the service name.
		* @returns the service value, or undefined when it is not provided.
		*/
		function readService(scope, name) {
			const lookup = scope.get;
			if (typeof lookup === "function") {
				const value = lookup.call(scope, name);
				if (value !== void 0) return value;
			}
			return scope[name];
		}
		/**
		* Register the browser half.
		* @param ctx - registrant context.
		*/
		function apply(ctx) {
			wireOn(ctx, "tool view", "tool.call.toolview", {
				name: "tool.call.toolview",
				key: ARTIFACT_TOOL_NAME
			}, ArtifactView);
			const channel = new FenceChannel();
			const effect = ctx.effect;
			try {
				if (typeof effect === "function") effect.call(ctx, () => {
					channel.start();
					return () => {
						channel.stop();
					};
				});
				else channel.start();
			} catch (error) {}
			let openColumn;
			let revealed = false;
			artifactStore.subscribeAll(() => {
				if (revealed || openColumn === void 0 || artifactStore.list().length === 0) return;
				revealed = true;
				openColumn();
			});
			const injectable = ctx.inject;
			if (typeof injectable !== "function") return;
			injectable.call(ctx, ["sidebarRightTabs", "sidebarRight"], (scope) => {
				const tabs = readService(scope, "sidebarRightTabs");
				const sidebar = readService(scope, "sidebarRight");
				if (tabs === void 0 || sidebar === void 0) return;
				try {
					tabs.register({
						id: PANEL_DEFINITION,
						kind: PANEL_KIND,
						title: () => "产物",
						guide: [{
							id: `${PANEL_DEFINITION}:entry`,
							order: 42,
							title: () => "产物",
							description: () => "本会话里的 artifact 与实时预览"
						}]
					});
				} catch (error) {
					console.warn(`[${PLUGIN_ID}] artifacts page type not registered`, describeFailure(error));
				}
				wireOn(scope, "panel body", "sidebar.right.pane.tab", {
					name: "sidebar.right.pane.tab",
					key: PANEL_DEFINITION
				}, ArtifactPanel);
				wireOn(scope, "panel title", "sidebar.right.pane.tab.title", {
					name: "sidebar.right.pane.tab.title",
					key: PANEL_DEFINITION
				}, (() => "产物"));
				openColumn = (id) => {
					if (id !== void 0) artifactStore.focus(id);
					try {
						sidebar.openTab(PANEL_KIND);
					} catch (error) {
						console.warn(`[${PLUGIN_ID}] could not open the artifacts column`, describeFailure(error));
					}
				};
				panelOpener.current = (id) => openColumn?.(id);
				if (!revealed && artifactStore.list().length > 0) openColumn();
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
