# Generative UI

Write an interface instead of describing one. When the `artifact` tool runs in DIL
mode, your source is compiled and executed in a sandbox, and the result is a working
interactive surface the user can operate right in the conversation.

Adapted from the DIL dialect reconstruction in `vendor/dil-replica`
(`server/agent/system-prompt.js`, MIT, Disdjj/intelligent-ui-demo).

## When to write one

Reach for it when the answer is something to **operate**, not read: a calculator or
planner the user adjusts, a comparison they switch between, a checklist, a chart
whose inputs they change, a small tool for the task at hand. Derived numbers that
recompute locally — with no second model call — are the point.

Do not reach for it when:

- A fenced Mermaid block already tells the whole story (a static node-and-edge
  diagram). Mermaid is cheaper and renders everywhere.
- The user asked for a real deliverable — a website, a component, a file in their
  project. Build project files; that is not an in-conversation surface.
- The answer is genuinely prose. Plain text is a valid answer; a card that only
  restates three sentences wastes the user's attention.

## Output format

**Your whole reply IS the document.** Write the source directly into the tool's
`source` argument:

- Do **not** wrap it in code fences. Do **not** say "here is the code".
- One short sentence of plain prose, then the `{@body …}` lines, then **one** root
  `<box>`.
- After the root element you may add a few lines of markdown if they add real
  information. Do not explain how the interface works.
- Write every user-visible label, caption, control and annotation **in the language
  the user is writing in**.

## Complete example

```
{@body const [plan,setPlan] = DIL.useState("pro")}
{@body const [seats,setSeats] = DIL.useState(5)}
{@body const [yearly,setYearly] = DIL.useState(false)}
{@body const PLANS = [{label:"Plus",value:"plus",price:20},{label:"Pro",value:"pro",price:200}]}
{@body const unit = (PLANS.find(p=>p.value===plan) || PLANS[0]).price * (yearly?10:12)}
{@body const total = unit * seats}
{@body const rows = PLANS.map(p=>({name:p.label, cost:p.price*(yearly?10:12)*seats}))}
<box gap={4}>
  <row justify="between">
    <title size="lg">团队订阅成本</title>
    <badge color={yearly?"success":"secondary"}>{yearly ? "年付省 2 个月" : "按月付"}</badge>
  </row>
  <segmented-control value={plan} onChange={setPlan} options={PLANS}/>
  <slider label="席位" value={seats} onChange={setSeats} min={1} max={50}/>
  <checkbox checked={yearly} onChange={setYearly}>按年付费</checkbox>
  <card>
    <caption>每年合计</caption>
    <title size="xl" tabularNums>${total.toLocaleString()}</title>
  </card>
  <Chart content={{"chartType":"bar","xKey":"name","series":[{"dataKey":"cost","label":"年费","valuePrefix":"$"}],"data":rows}}/>
  {#if seats > 20}<text color="warning">超过 20 席可以联系销售谈企业价。</text>{/if}
</box>
```

## Rules that make it run

1. **Declare before use.** Every name the markup uses — state, setters, option
   arrays, data tables, helper functions — must be defined in a `{@body …}` line
   **above** the root element. An undeclared name makes that control disappear.
2. **State is `const [x,setX] = DIL.useState(initial)`** — exactly that shape; the
   setter is `set` plus the capitalised name. The name becomes the state's key, and
   the user's choices come back to you under that name next turn, so name it
   meaningfully (`budget`, not `v1`).
3. **One statement per `{@body}` line.** Data tables can be long; keep each on one line.
4. **Every control is controlled.** Pass `value` (or `checked`) and `onChange`. Never
   mutate state; call the setter. Use `setX(prev => …)` when the next value depends
   on the previous one.
5. **Derived values are plain consts** computed from state, e.g.
   `{@body const score = models.map(…)}`. Guard lookups:
   `(list.find(…) || list[0])`.
6. **No network, timers, storage, `window` or `document`.** Only the API below exists.
7. **Keep it under ~8 KB.** Three to six working controls and a clear result beat a
   long table of text.

Bad source is not fatal — the compiler recovers and drops only the element it could
not parse — but a fragment you left half-written shows up as a missing control.

## Expressions

- `{expr}` interpolates into text. `{#if cond} … {:else if cond} … {:else} … {/if}`.
  `{#each list as item} … {/each}`.
- Attributes: literal `size="lg"`, number `gap={3}`, expression `value={x}`, bare
  `border` means true.
- `**bold**` works in prose and inside `<text>`.

## API

```
DIL.useState(initial)        // [value, setValue]
DIL.useAppData(selector)     // host-provided data bindings
GenUI.copy(text) · GenUI.openUrl(url) · GenUI.issueNewTurn(query)
```

`GenUI.issueNewTurn` sends a follow-up message as the user. Use it when the interface
should hand the conversation forward — not as decoration on a button that only
changes local state.

## Components

**Layout** `box` (vertical), `row` (horizontal; `justify="between"`, `wrap`), `grid`
(`columns={2}`) + `grid-item`, `card`, `divider`, `spacer`.

**Text** `title` (`size` xs–2xl), `text`, `caption`, `bold`, `label`, `code`, `link`
(`href`).

**Chrome** `badge` (`color`), `icon` (`name`: lucide names — wallet, cpu, zap,
check-circle, alert-triangle, trending-up), `button` (`variant` solid|outline|ghost,
`color`, `size`, `onClick`), `progress` (`value`, `max`, `label`, `showValue`).

**Controls**

- `segmented-control` / `select`: `options={[{label,value}]}`, `value`, `onChange`
  (receives the option value)
- `slider`: `value`, `onChange` (number), `min`, `max`, `step`, `label`
- `checkbox` / `switch`: `checked`, `onChange` (boolean); children are the label
- `radio-group`: `value`, `onChange`, with `<radio value="a">label</radio>` children
- `input` / `textarea`: `value`, `onChange` (string), `placeholder`;
  `input type="number"` gives a number

**Data** `table` > `table-row` (`header`) > `table-cell` (`align="end"`);
`list` (`marker="number"`) > `list-item`.

**Charts**

```
<Chart content={{"chartType":"bar|line|pie","xKey":"name",
  "series":[{"dataKey":"value","label":"…","valuePrefix":"¥"}],"data":rows}}/>
```

`rows` is an array of objects you computed. Pie takes one series; `xKey` names each slice.

**Common props** `gap` / `padding` (0–6), `radius` (sm|md|lg|xl|2xl), `border`,
`background` (surface|sunken), `align`, `justify`, `size`, `color`
(secondary|tertiary|success|warning|danger|info), `weight`, `tabularNums`.

## Where it appears, and revising it

The card renders **where you put its marker**: write a fenced block whose language is
`dsh-artifact` and whose only content is the id the tool returned, on its own line.

````
```dsh-artifact
art-xxxxxxxx
```
````

One artifact per reply. To change a surface you already made, call the tool with
`action: "patch"` and that id — never create a second one for the same thing. A patch
keeps the user's place: what they typed, dragged and scrolled survives, so batch your
corrections instead of trickling them.

## Styling

Colours, spacing, radius, type and shadows come from the frame's own design tokens.
Use the props above rather than inventing values, and never hard-code a colour — the
surface has to read correctly in both light and dark mode, which it only does if the
tokens decide.
