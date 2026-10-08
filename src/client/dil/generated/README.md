# generated

Three modules in this directory carry vendored or authored *text* that the browser
bundle must ship verbatim. Each is produced from one source file; nothing here is
edited by hand.

| module | source of truth | produced by |
| --- | --- | --- |
| `worker-source.ts` | `vendor/dil-replica/replica/sandbox/worker.js` | `createRequire(...)('…/server/sandbox/frame.js').WORKER_SOURCE` |
| `frame-script.ts` | `vendor/dil-replica/replica/server/sandbox/frame.js` → `FRAME_SCRIPT`, hashed with SHA-256/base64 | same `require` |
| `theme-css.ts` | `src/client/dil/theme.css` | `JSON.stringify(readFileSync(theme.css))` |

Regenerate from the project root:

```bash
node --input-type=module -e "
import { createRequire } from 'node:module'
const require = createRequire(process.cwd() + '/')
const frame = require('./vendor/dil-replica/replica/server/sandbox/frame.js')
console.log(frame.WORKER_SOURCE.length, frame.FRAME_SCRIPT.length)
"
```

Then serialize each string with `JSON.stringify` into `export const NAME: string = …`,
and put the base64 SHA-256 of `FRAME_SCRIPT` into `FRAME_SCRIPT_SHA256`.

`tests/client/frame.spec.ts` and `tests/client/theme.spec.ts` re-read both source
files and fail on any divergence, so drift is caught by `pnpm run test` rather than
in the browser.
