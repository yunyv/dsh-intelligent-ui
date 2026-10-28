# Offline math renderer: third-party notices

The plugin's own licence remains MIT. That licence does not replace the licences
or notices of the code and glyph data bundled in the dedicated math Worker.

## What is bundled

- `@mathjax/src@4.1.3`, Apache-2.0.
  Upstream: https://github.com/mathjax/MathJax-src/tree/4.1.3
  Archive: https://registry.npmjs.org/@mathjax/src/-/src-4.1.3.tgz
- `@mathjax/mathjax-newcm-font@4.1.3`, declared Apache-2.0. It supplies MathJax's
  adaptation of New Computer Modern glyphs; all 40 SVG data shards are listed in
  `src/client/dil/math/newcm.ts`.
  Archive: https://registry.npmjs.org/@mathjax/mathjax-newcm-font/-/mathjax-newcm-font-4.1.3.tgz

Both archives are pinned by integrity in `pnpm-lock.yaml`. The published output
is redistributed as-is: no glyph outline is regenerated or modified, and the
packages' original OTF/WOFF2 font files are not shipped, only the SVG glyph
paths. MathJax core also embeds one small helper font (`mjx-lm-zero`); it is part
of the pinned core source and covered by the same Apache-2.0 text.

## MathJax core copyright notices

Retained verbatim from the leading notices of the core package's TypeScript
sources. Different years belong to different files, so the lines are not merged
into one statement. The generated Worker banner carries the same ten lines.

> Copyright (c) 2009-2026 The MathJax Consortium
> Copyright (c) 2017-2026 The MathJax Consortium
> Copyright (c) 2018-2026 The MathJax Consortium
> Copyright (c) 2019-2026 The MathJax Consortium
> Copyright (c) 2020-2026 The MathJax Consortium
> Copyright (c) 2021-2026 The MathJax Consortium
> Copyright (c) 2022-2026 The MathJax Consortium
> Copyright (c) 2023-2026 The MathJax Consortium
> Copyright (c) 2024-2026 The MathJax Consortium
> Copyright (c) 2026 The MathJax Consortium

## Font attribution

The font package identifies the original New Computer Modern material with:

> (C) 2019-2021 Antonis Tsolomitis.

and, for some derived font records, with:

> Copyright (c) 2024 MathJax, Inc. (www.mathjax.org)

Its font records declare the GUST Font License, which refers to LPPL 1.3c or
later. This directory includes these unmodified licence texts:

- `APACHE-2.0.txt`: copied from the pinned MathJax core package's `LICENSE`.
- `GUST-FONT-LICENSE.txt`: https://www.gust.org.pl/projects/e-foundry/licenses/GUST-FONT-LICENSE.txt
- `LPPL-1.3c.txt`: https://www.latex-project.org/lppl/lppl-1-3c.txt

No endorsement, maintenance or support by the original font authors or the
MathJax maintainers is claimed for this plugin or its host-side adaptations.

## Local integration and changes

Original npm package files are not edited. Adaptations are in our own source:

- direct ESM TeX/SVG modules and a `liteAdaptor`, with all NewCM shards statically
  registered on the actual font instance;
- a pre-allocation bound replacing the `ColumnParser.repeat` method at runtime
  inside the private Worker (the original package is unchanged);
- per-request TeX state, restrictive SafeHandler options, local input/output and
  geometry budgets, and no component/font/network loader;
- a single SVG result; root `ex` dimensions and baseline are converted back to
  `em` using the actual NewCM font parameter, without changing glyph paths;
- request-local SVG wrapper mappings preserve intrinsic widths, tag padding and
  explicit line leading; only recognized, consumed layout residue and empty
  paint attributes are normalized before the restricted SVG validator;
- host scheduling, cancellation, timeout, inert SVG validation and DIL lifecycle
  handling, all outside the vendored DIL replica.

`scripts/build-math-worker.mjs` creates one minified IIFE and serializes it as
`src/client/dil/math/generated/worker-source.ts`; `tsdown` includes that string in
`lib/client.js`. Neither the original DIL sandbox nor the model can import the
math engine.
