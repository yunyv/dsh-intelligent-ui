# DSH 插件 API 实测用法（0.2.0-rc.2）

环境：DSH 桌面版 0.2.0-rc.2，profile `~/.dsh/profiles/desktop`，宿主实测源为 app.asar 内的 `dsh/node_modules/@deepseek-ai/*`。
读取方式：`python3 /tmp/asar.py cat <asar内路径>`、`python3 /tmp/asar.py save <asar内路径> <out>`；`asar.py ls/cat/save` 的路径参数是 asar 内部路径（不是 .asar 文件路径）。

来源简写：

| 简写 | 含义 |
|---|---|
| R1 | `lehhair/dsh-html-artifact@master`（`https://raw.githubusercontent.com/lehhair/dsh-html-artifact/master/<path>`） |
| R2 | `Nagi-ovo/dsh-visualize@main` |
| R3 | `omdsh-dev/dsh-genui@main` |
| R4 | `wang-junjian/dsh-artifact-viewer@main` |
| `asar:<path>` | app.asar 内部路径，行号按 `asar.py cat` 输出 |
| 实测插件包 | `~/.dsh/profiles/desktop/node_modules/@nagi-ovo/dsh-visualize/`（本机已安装并在跑） |

三条先决结论（直接改变实现方式，理由在对应章节）：

1. **渲染载荷必须走 `output.presentationMeta` → 客户端读 `block.meta`**。0.2.0-rc.2 的 Web 客户端**不消费** `presentCall`/`presentResult`：全 asar 无 `resultView`，客户端无 `presentResult` 调用点（R1 的 `card:'artifact'` 走不通）。
2. **客户端 bundle 只能 `require()` 9 个种子模块**；`@deepseek-ai/dsh-client-runtime/client` 在 0.2.0-rc.2 **不存在**，值导入会 `require` 失败（R1、R4 各有一处值导入踩坑）。
3. **`ctx.sidebarRight` / `ctx.sidebarRightTabs` 真实存在**（asar 内 `ctx.reflect.provide` 实证），`ctx.sidebarRight.openTab(kind, options)` 是真的；`ctx.sidebarRight.openTab` 不是客户端 slot 而是 Service 方法。

另外两个环境事实：

- asar 内**没有任何 `.d.ts`**（9941 个文件中 0 命中）。要类型声明读 `asar:dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`——它把 host 侧 `.d.ts` 原文以字符串常量编进 JS（8187 行），是 0.2.0-rc.2 的签名权威。
- 客户端 slot 目录同理编在 `asar:dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js`（`key: "<slot>"` 条目，含 `kind`/`scope`/`registerOptions`/`ownerProps`/`slotInject`/`declaredBy`/`occupants`/`example`）。

---

## 1. 宿主半工具注册

**结论**

- `ctx.tools.register(definition)` 接受两种 definition：`defineTool({...})` 的糖（`parameters` 是逐属性 map，`output.schema` 是值 schema 糖），或**手写裸 `ToolDefinition`**（`parameters` 是原始 JSON Schema，`output.schema` 是 `JsonSchemaNode`）。R3 用后者，可完全不 import `dsh-tools` 运行时代码。
- 注册时只校验：`output` 是对象且 `render` 是函数、`output.presentationMeta` 若存在必须是函数、`output.schema` 通过 `assertSupportedJsonSchema`、`timeoutMs` 正有限、`name !== 'run_code'`。`parameters` 在注册期不校验。
- `presentationMeta(args, value)` **仅在根调用（`exec.parent === undefined`）时投影**，结果进 `result.meta`；返回值必须是无损 JSON（返回 `undefined` 会抛 `ToolOutputError`，返回 `null` 合法）。
- 回放可恢复的正确做法：`presentationMeta` 里塞**完整快照**（R1 塞整份 html，R2 塞整份 fragment），客户端只用 `meta` 渲染，日志重放即恢复。
- `presentResult(args, result): ToolResultView | undefined`：`result` = `{ content, isError, meta? }`；`meta` 就是 `presentationMeta` 的投影结果。**Web GUI 不消费它**，只给 host-local 消费方（CLI/ACP/TUI）用。`card:'artifact'` 必须 `as unknown as ToolResultView` 强转，因为 `ToolResultView` 只有 6 个成员。
- `defineTool` 还会在 `presentCall`/`presentResult` 外层套一层参数校验：args 不合法直接返回 `undefined`。

```ts
// 糖写法（R1 src/index.ts:137）
ctx.tools.register(defineTool({
  name: 'artifact',
  description: '...',
  parameters: { op: { type: 'string', required: true, enum: ['create','patch','read','destroy','list'] },
                title: { type: 'string' }, html: { type: 'string' }, id: { type: 'string' },
                old_string: { type: 'string' }, new_string: { type: 'string' },
                replace_all: { type: 'boolean' } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { op: { type:'string', required:true, enum:[...] }, id:{type:'string'}, revision:{type:'integer'}, html:{type:'string'}, /* ... */ } },
    // 模型可见文本；可多条 text 块
    render: (_args, value) => [{ type: 'text', text: `Created HTML artifact ${value.id} ...` }],
    // 唯一能到达浏览器的载荷通道：返回无损 JSON，null 合法，undefined 会抛
    presentationMeta: (_args, value): JsonValue => {
      if (!isArtifactValue(value)) return null
      return { op: 'create', id: value.id, revision: value.revision, html: value.html }
    },
  },
  execute(args, exec) { /* exec.agent 是宿主 Agent；用 WeakMap<Agent, Store> 做每会话状态 */ },
  presentCall(args) { return { card: 'generic', title: 'Create HTML artifact', kind: 'other' } },
  presentResult(_args, result): ToolResultView | undefined {
    if (result.isError) return undefined
    const candidate = result.meta as Record<string, unknown> | null
    if (candidate === null || typeof candidate.op !== 'string') return undefined
    return { card: 'artifact', op: candidate.op, /* ... */ } as unknown as ToolResultView
  },
}))

// 裸 definition 写法（R3 src/plugin/tool.ts:197）——零 harness 运行时依赖
export function createRenderUiTool(): ToolDefinition {
  return {
    name: 'render_ui',
    description: '...',
    parameters: { type: 'object', properties: { spec: { type: 'object', /* ... */ } }, required: ['spec'], additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: String(value) }] },
      presentationMeta(args) { /* 返回 spec 对象或 null */ },
    },
    async execute(args) { /* 返回 JsonValue */ },
  }
}
```

签名权威：

```ts
// asar:.../dsh-tool-cordis/lib/types/api-catalog.js:7532 / 7588 / 7615 /
export interface ToolDefinition extends ToolSchema {
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    timeoutMs?: number;
    isConcurrencySafe?(args: unknown): boolean;
    presentCall?(args: unknown): ToolCallView | undefined;
    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
export interface ToolOutputDefinition { readonly schema: JsonSchemaNode; render(args: unknown, value: JsonValue): ContentBlock[]; presentationMeta?(args: unknown, value: JsonValue): JsonValue }
export type ToolResultView = GenericResultView | TerminalResultView | DiffResultView | SearchResultView | ReadResultView | WebResultView;
export interface GenericResultView { card: 'generic'; title?: string; content?: ContentBlock[] }
export interface GenericCallView { card: 'generic'; title: string; kind?: ToolCallKind; rawInput?: unknown; content?: ContentBlock[]; locations?: FileLocation[] }
export interface ToolResult { content: ContentBlock[]; isError: boolean; meta?: JsonValue }
export interface ToolRunContext extends ToolExecution { deferContext(context: UserMessage): void; concludeTurn(): void }
// tools 服务：register(definition: ToolDefinition): () => void；另有 presentAs/restrict/guard/get/schemas/executionMode/execute
```

来源：R1 `src/index.ts:137-345`（工具本体）、`:156-197`（parameters/output）、`:233-247`（presentationMeta）、`:307-344`（presentResult + 强转）、`src/registry.ts:145-214`（每 Agent store）；R3 `src/plugin/tool.ts:45-79,197-246`（裸 definition）；`asar:dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js:838-885`（defineTool）、`:2878-2887`（register 校验）、`:3541-3572`（成功结果 + `exec.parent === void 0` 才投影 meta）；`asar:dsh/node_modules/@deepseek-ai/dsh-tools/README.md:91`（"内置 Web Client 不消费这些值"）；host `cordis_inspect_query Service.listService {service:"tools"}`（活体确认 signature）。

---

## 2. 客户端半注册

**结论**

- 入口：`export const inject = ['slots', ...]` + `export function apply(ctx)`。`inject` 是 cordis **硬依赖门**——声明了但没被 provide 的服务会让 fiber 永久等待、`apply` 不跑。可选服务用 `ctx.inject([...], cb)`（R3 的 `inputTriggers` 就这么干）。`ctx.inject` 返回的 disposer 可 `push` 进数组，最后统一返回，或直接 `ctx.effect(...)`。
- 注册形状：`ctx.slots.inject(slotKey, callback)`，callback **返回一个 disposer 或一个 disposer 可迭代**；`function*(){ yield ctx.slots.register(...) }` 生成器即"可迭代"，事务性安装、逆序释放。`ctx.slots.register(options, Component)` 返回 disposer。
- `register` 的必填项按 slot 的 `kind` 决定：`single` 无 key、`keyed` 必须 `key`、`list` 必须 `id`、`chain` 必须 `select`；同一 key/id 在**同一 priority** 下重复即抛错（不同 priority 可 shadow，最低者渲染）。
- `tool.call.toolview` 是 **keyed / scope session**，key = 模型侧工具名（wire name）。未注册的 key 走通用卡片。
- 组件 props = `{...kit, ...entryInject, ...slotInjectProps, ...contextualHooks, ...ownerProps}`（ownerProps 最后覆盖）。`tool.call.toolview` 的 ownerProps 实测为：

```ts
// asar:.../dsh-client-ui-tool/lib/client.js:1822-1843（owner 对象的实际构造）
{ callId, toolName, phase: 'preparing'|'start'|'result', block, openFile, cwd, home, loadImage, useDisclosure,
  inspect?: () => void }
// 声明（api-catalog 内嵌 .d.ts，ownerProps 字段）
export type ToolCallOwnerProps = ToolCallCommonProps & ToolCallPhaseProps
export type ToolCallPhaseProps =
  | { readonly phase: 'preparing'; readonly block: PreparingToolCall }
  | { readonly phase: 'start'; readonly block: StartedToolCall }
  | { readonly phase: 'result'; readonly block: ToolResultNode }
```

- 拿得到入参和结果：`phase==='result'` 时 `block.call?.argsRaw`（JSON 串）+ `block.meta`（presentationMeta 投影）+ `block.content` + `block.isError`；运行期 `block.argsRaw`。
- 流式期间：`phase==='preparing'` 的 block 没有 argsRaw，用 slot 级注入的 `useToolCallArgumentsPartial()` hook（`tool.call.toolview` 的 slotInject）拿该 call 的原始参数前缀（`""` 表示还没有）。**这个 hook 只对根原子调用有效**。
- 标准 kit props（按 scope 提供）含 `useSessions`、`useChat`、`useConversation`、`useInput`、`inputActions`、`useSession`、`sessionId`、`useProjection`、`useTrajectory`、`useResource`、`usePanelInfo`、`renderFactorySlot`；声明了 `locale` 多一个 `t`，声明了 `store` 多 `useStore`/`actions`，声明了 children 多 `renderSlot`。
- entry 级 `inject` 的调用实参是 `(key?, actions?)`：session/`session-maybe` 作用域的 slot 传 `binding.key`（即 sessionId），root 作用域不传 key；`actions` 是声明了 `store` 时的 store actions。返回对象里的 `hooks: {x}` 会变成 props 的 `useX`（`keyedHooks` 变 `useX(key)`），返回对象的其它字段原样成为 props。所以取当前会话 id 写 `inject: (sessionId) => ({...})`。
- 只读 `block.meta` 的正确判别：settled 节点有 `kind` 属性；运行节点没有。

```tsx
// 客户端入口（R2 src/client/index.tsx:70-73 的最简形；R1 用生成器写法，两者等价）
export const inject = ['slots']
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'artifact' },   // key = 工具名
    ArtifactRow,
  ))
}

// 组件：toolview（R2 src/client/VisualizeCard.tsx:130-147 的判别骨架）
export function ArtifactRow({ callId, toolName, block, cwd, home, openFile, inspect }: ToolCallOwnerProps) {
  const argsRaw = 'kind' in block ? block.call?.argsRaw : 'argsRaw' in block ? block.argsRaw : undefined
  if (!('kind' in block)) return <div>rendering…</div>          // 运行期
  if (block.isError) return <div>{firstResultLine(block.content)}</div>
  const meta = artifactMetaFrom(block.meta)                     // ← 唯一可靠载荷
  if (meta === undefined) return <div>{firstResultLine(block.content)}</div>
  return <ArtifactFrame meta={meta} callId={callId} />           // callId 做消息关联 token
}

// 流式渲染（R3 src/client/index.tsx:170-173 注册 + src/client/toolview.tsx:29-50 读 meta）
ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
  { name: 'tool.call.toolview', key: 'render_ui' }, GenuiToolView))
function GenuiToolView({ toolName, block, sessionId }: ToolCallViewProps) {
  const meta = 'meta' in block ? block.meta : undefined
  const spec = useMemo(() => (meta === undefined ? null : repairGenuiSpec(meta)), [meta])
  ...
}
```

- 流式独立通道（R1）：自定义 Conversation Definition 折叠 `assistant/chunk` 的 `tool-call-delta`，再注册一个 chat node 渲染它。Definition 契约：`{kind, target?, match(event), start(ctx,match), update(ctx,match), publication?(match), buildViewNode?(ctx), buildLocationData?(ctx,scope,prev)}`；`target` 与 `buildViewNode` **必须同时出现**（否则抛错）。注册服务在 0.2.0-rc.2 叫 `uiConversation`（`ctx.uiConversation.events.register(definition)`），**没有** `conversationEvents` 这个服务（全 asar 0 命中）。

```ts
// R1 src/client/stream/draft.ts:158-228（Definition 骨架，节选）
export const artifactDraftDefinition: ConversationNodeDefinition<ArtifactDraftState> = {
  kind: 'artifact-draft',
  target: 'chat',
  match(event) {
    if (event.type === 'step/start') return { id: stepId(event), role: 'start' }
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk
      if (chunk.type === 'tool-call-delta' && chunk.name === 'artifact') return { id: stepId(event), role: 'update' }
      if (chunk.type === 'block-end' && asArtifactToolCall(chunk.block) !== null) return { id: stepId(event), role: 'update' }
      return null
    }
    if (event.type === 'tool/call' && event.data.name === 'artifact') return { id: stepId(event), role: 'update' }
    if (event.type === 'tool/result') return { id: stepId(event), role: 'update' }
    return null
  },
  start: (_c, match) => initialState(match.event.data.turn, match.event.data.step),
  update: (context, match) => updateDraftState(context.state, match),
  publication: (match) => match.event.type === 'assistant/chunk' && match.event.data.chunk.type === 'tool-call-delta' ? 'animation-frame' : 'immediate',
  buildViewNode(context) {
    // 引擎禁止撤回已物化的 target：无内容时保留同一 key，visibility:'hidden'
    return { key: conversationContextKey('artifact-draft', context.id), kind: 'artifact-draft', id: context.id,
             target: 'chat', anchorSeq, location: ..., visibility: 'visible', data: { callId, html, title } }
  },
}
// R1 src/client/index.tsx:26-48 注册（生成器写法可 yield 多个 register）
```

来源：R1 `src/client/index.tsx:19-48`、`src/client/contract.ts:14-34`（owner props 本地声明 + `declare module SlotMap`）、`src/client/stream/draft.ts:57-62,158-228`、`src/client/stream/DraftSurface.tsx:72-97`；R2 `src/client/index.tsx:24,69-89`、`src/client/VisualizeCard.tsx:130-147`；R3 `src/client/index.tsx:142-223`、`src/client/toolview.tsx:29-50`；`asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js:163-200`（register 校验）、`:7`（`standardHookPropName`）；`asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js:1343`（slots.inject）、`:424-470`（hooks→`use*`）、`:471-478`（slot hook 工厂）、`:752-768`（props 装配顺序）；`asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-tool/lib/client.js:4561`（slot 声明 `{kind:'keyed',scope:'session',inject:{hooks:{toolCallArgumentsPartial}}}`）、`:1822-1863`（owner + dispatch）、`:1938-1948`（`useToolCallArgumentsPartial` 实现）；`asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:3043`（服务名 uiConversation）、`:2638-2658`（events.register）、`:1122`（`conversationContextKey`，内部函数未导出）。

---

## 3. 沙箱实现

**结论**

- iframe：`sandbox="allow-scripts"`（不加 allow-same-origin ⇒ opaque origin，父文档读不到子文档 DOM）、`referrerPolicy="no-referrer"`、`srcDoc`。
- CSP 有两套现成策略，按需要选：R1 允许 `connect-src https: http:`（artifact 能联网 fetch），R2 的 `connect-src blob: data:` + CDN 白名单（更严）。
- 主题：**读宿主 CSS 变量再注入子文档 `:root`**（正确做法），或硬编码一套调色板 + postMessage 切主题（R1）。宿主变量读点是 `document.body` 的 computed style（token 定义在 body 上，`--dsw-alias-*`；dark 覆盖挂在 `body[data-ds-dark-theme]`）。子文档里的 `:root` 变量**不会**被父文档继承——必须字符串注入或 postMessage。
- 高度自适应：iframe 内 `postMessage({type, id/token, height})` → 父层 `window.addEventListener('message')` 校验 `event.source === frame.contentWindow` + token 后 `setHeight(clamp(...))`；子侧用 `ResizeObserver(document.body/documentElement)` + `load` + 首帧 `postMessage`。**必须做 max 上限**（R1 `min(4000, max(120, h))`）。
- storage shim：opaque origin 下 `localStorage` 访问会抛异常，R1 在内嵌脚本里探测并 `Object.defineProperty` 一个内存 Map 实现（长度/key/getItem/setItem/removeItem/clear）。
- 源码拼装用 `DOMParser` 解析后 `insertAdjacentHTML`，避免 artifact 源码里的 `</body>` 逃逸包装结构。

```ts
// CSP 原文（R1 src/client/sandbox.ts:19）
export const ARTIFACT_CSP = `default-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; img-src https: http: data: blob:; media-src https: http: data: blob:; font-src https: http: data:; style-src 'unsafe-inline' https: http:; script-src 'unsafe-inline' 'unsafe-eval' https: http: blob:; connect-src https: http:`

// CSP 原文（R2 src/shell.ts:33-46，严格 + CDN 白名单）
export const RESOURCE_ORIGINS = ['https://cdnjs.cloudflare.com','https://cdn.jsdelivr.net','https://esm.sh','https://fonts.bunny.net','https://fonts.googleapis.com','https://fonts.gstatic.com','https://unpkg.com'] as const
export const FRAME_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${RESOURCE_SOURCES}`,   // RESOURCE_SOURCES = 'blob: data: ' + allowlist
  `style-src 'unsafe-inline' ${RESOURCE_SOURCES}`,
  `img-src ${RESOURCE_SOURCES}`, `font-src ${RESOURCE_SOURCES}`, `media-src ${RESOURCE_SOURCES}`,
  "worker-src blob:", 'connect-src blob: data:', "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ')
```

```ts
// 包装文档（R1 src/client/sandbox.ts:89-98）
export function buildSandboxedHtmlDocument(source: string, resizeId: string, theme: ArtifactTheme): string {
  const doc = new DOMParser().parseFromString(source, 'text/html')
  const securityHead = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1">`
  const themeHead = `<style id="dsh-artifact-theme">html,body{margin:0;overflow:hidden;background:transparent}${themeRootCss(theme)}</style>`
  doc.head.insertAdjacentHTML('afterbegin', `${securityHead}${themeHead}${storageShimScript()}`)
  doc.body.insertAdjacentHTML('afterbegin', `${themeApplyScript(theme)}${measureScript(resizeId)}${collectScript(resizeId, collectBridgeBody())}`)
  return `<!doctype html>${doc.documentElement.outerHTML}`
}

// storage shim 原文（R1 src/client/sandbox.ts:58，内嵌 <script> 内容）
`(function(){const create=function(){const values=new Map();return{get length(){return values.size},key:index=>Array.from(values.keys())[index]??null,getItem:key=>values.get(String(key))??null,setItem:(key,value)=>{values.set(String(key),String(value))},removeItem:key=>{values.delete(String(key))},clear:()=>values.clear()}};for(const name of["localStorage","sessionStorage"]){try{window[name].getItem("__dsh_probe__");continue}catch(e){}try{Object.defineProperty(window,name,{configurable:true,enumerable:true,value:create()})}catch(e){}}}())`

// 尺寸探针（R1 src/client/sandbox.ts:69；注意用显式遍历 getBoundingClientRect 而不是 scrollHeight）
`(function(){var id=${JSON.stringify(resizeId)};var send=function(){var body=document.body;if(!body){return}var root=body.getBoundingClientRect();var bottom=0;var nodes=body.querySelectorAll("*");for(var i=0;i<nodes.length;i+=1){var el=nodes[i];var tag=el.tagName;if(tag==="SCRIPT"||tag==="STYLE"||tag==="LINK"||tag==="META"){continue}var style=getComputedStyle(el);if(style.display==="none"||style.visibility==="hidden"||style.position==="fixed"){continue}var rect=el.getBoundingClientRect();bottom=Math.max(bottom,rect.bottom-root.top)}var height=Math.max(120,Math.ceil(bottom||body.scrollHeight));parent.postMessage({type:"dsh-artifact-resize",id:id,height:height},"*")};addEventListener("load",send);if(typeof ResizeObserver!=="undefined"){new ResizeObserver(send).observe(document.body)}requestAnimationFrame(send)})()`

// 父层接收 + clamp（R1 src/client/ArtifactRow.tsx:83-97）
useEffect(() => {
  const onMessage = (event: MessageEvent) => {
    const data = event.data
    if (data === null || typeof data !== 'object') return
    if ((data as {type?:unknown}).type !== 'dsh-artifact-resize') return
    if ((data as {id?:unknown}).id !== resizeId) return                       // useId() 做关联
    if (event.source !== frameRef.current?.contentWindow) return               // 必须校验来源
    const measured = Number((data as {height?:unknown}).height)
    if (Number.isFinite(measured)) setHeight(Math.min(4000, Math.max(120, Math.round(measured))))
  }
  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}, [resizeId])

// 宿主主题 → 子文档：读 body computed style（R2 src/client/theme.ts:14-21,33-47）
const TOKEN_BRIDGE = [
  ['foreground', '--dsw-alias-label-primary'],
  ['card', '--dsw-alias-bg-layer-1'],
  ['muted-foreground', '--dsw-alias-label-caption'],
  ['border', '--dsw-alias-border-l2'],
  ['primary', '--dsw-alias-brand-primary-new-colorprimary-new-color'],
  ['primary-foreground', '--dsw-alias-label-primary-inverted'],
] as const
export function resolveTheme(): ResolvedTheme {
  const computed = getComputedStyle(document.body)
  const themeVars: Record<string, string> = {}
  for (const [frameName, hostToken] of TOKEN_BRIDGE) themeVars[frameName] = computed.getPropertyValue(hostToken)
  const scheme = computed.colorScheme
  const colorScheme = scheme.includes('dark') && !scheme.includes('light') ? 'dark'
    : scheme.includes('light') && !scheme.includes('dark') ? 'light'
      : document.body.hasAttribute('data-ds-dark-theme') ? 'dark'
        : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  return { themeVars, colorScheme }
}
// 注入形式：buildFrameDoc 里 `--dsh-viz-${name}: ${sanitizeCssValue(value)};`，值含 [;{}<>] 则丢弃
// 主题跟随：MutationObserver 观察 documentElement/body 的 attributes + matchMedia('(prefers-color-scheme: dark)') change → 重算
```

来源：R1 `src/client/sandbox.ts:19,22-48,51-54,57-76,89-98`、`src/client/ArtifactRow.tsx:43-65,83-104,122-133`；R2 `src/shell.ts:20-52,80-129,235-247`、`src/client/VisualizeCard.tsx:65-119`、`src/client/theme.ts:14-47`；`asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/README.md:126`（`--dsw-alias-*` + `sidebarRight` 命名空间）；宿主 token 名以 live `cordis_inspect_query Theme.listTokens` 为准（本次客户端 inspect 不可用，见文末）。

---

## 4. 原地更新（同一 id 的后续 patch 不重建 iframe）

**结论**

- **改 `srcDoc` = 导航 = 整帧重载**。要"原地更新"，必须让 srcdoc **只构建一次**（`useMemo(..., [resizeId, theme])` 或 `[]`），之后只通过 `postMessage` 推内容。
- 两条实测路径：
  - **A. innerHTML 覆盖**（R1 streaming bridge）：子文档固定一个 `<div id="dsh-artifact-root">`，父层 `postMessage({type:'dsh-artifact-stream', html})`，子侧 `root.innerHTML = data.html`。副作用正好可接受：`innerHTML` 解析出的 `<script>` **永不执行**，所以流式期间的半截脚本不会跑；settled 时再切到整份 srcdoc 快照帧跑脚本。
  - **B. 增量 DOM 对账**（R2 streamSync）：把新 fragment 塞进游离 `div.innerHTML`，与现有 root 按**子节点索引**对齐——同 tag 同步属性并递归，不匹配则替换，多出的 append 并加进场动画 class，多余的删掉；`nodeName === 'SCRIPT'` 的新节点用 `document.createElement('script')` + 复制属性 + `textContent` 重新构造以使其**可执行**（每个完整脚本块在其索引上恰好到达一次，因此恰好执行一次，Claude 式逐组件浮现）。
- 若确实要"每行各自渲染快照"（时间线语义），就用普通 React 行 + `key`，不要指望跨行同步：R1 的 patch 行**直接渲染新的整份 html 的新 iframe**，不做 diff、不做跨行同步。
- 状态持久化 key 设计（交互态跨刷新/重放恢复）：`session + 位置标识 + 内容指纹`。R3 用三种 key：`f:${sessionId}:${fenceKey}:${fingerprint(raw)}`（围栏，内容指纹 ⇒ 新内容自动重置）、`p:${sessionId}:${fingerprint(raw)}`（面板，内容键）、`t:${sessionId}:${callId}`（工具卡，callId 跨重放稳定）。存 localStorage，LRU 上限 200 条，写失败静默降级为仅内存。

```tsx
// 一次性 srcdoc + postMessage 原地刷新（R1 src/client/stream/DraftSurface.tsx:28-68）
export function DraftSurface({ html }: { html: string }) {
  const [height, setHeight] = useState(200)
  const [theme] = useState<ArtifactTheme>(hostArtifactTheme)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const resizeId = useId()
  const srcDoc = useMemo(() => buildStreamingBridgeDocument(resizeId, theme), [resizeId, theme])  // ← 只建一次
  useEffect(() => {  // 每个流式分片只推消息，不重渲染 iframe
    frameRef.current?.contentWindow?.postMessage({ type: 'dsh-artifact-stream', html }, '*')
  }, [html])
  return <iframe ref={frameRef} sandbox="allow-scripts" srcDoc={srcDoc} style={{ height }} title="Generating HTML artifact" />
}

// 子侧：固定 root + 消息驱动的 DOM 对账（R2 src/shell.ts:165-226 精简）
addEventListener('message', function (event) {
  var data = event.data;
  if (!data || data.type !== /* STREAM_MESSAGE_TYPE */ 'dsh-visualize:stream' || data.token !== token) return;
  if (typeof data.fragment !== 'string') return;
  var next = document.createElement('div'); next.innerHTML = data.fragment;
  sync(root, next);           // 索引对齐；SCRIPT 节点走 executable() 重建才会执行
});
```

```ts
// 持久化状态 key（R3 src/client/interaction-store.ts:106-127）
export function fingerprint(raw: string): string { let h = 5381; for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0; return h.toString(36) }
export function fenceStateKey(sessionId: string, fenceKey: number | string, raw: string): string { return `f:${sessionId}:${String(fenceKey)}:${fingerprint(raw)}` }
export function toolStateKey(sessionId: string, callId: string): string { return `t:${sessionId}:${callId}` }
```

R2 的另一条"更新已渲染卡片"的路线是**换路径不换 id**：`update` 读回 workspace 里那张卡的 html、做唯一匹配替换、**覆写同一文件**（`source ?? resolve(viz/<slug>-<hash>.html)`），再把新 fragment 投影进 `meta`；同一回复内的第二次 patch 因此建立在第一次之上。

来源：R1 `src/client/stream/DraftSurface.tsx:28-68`、`src/client/stream/bridge.ts:16,25-30`、`src/client/ArtifactRow.tsx:236-240`（patch 行渲染新 html）；R2 `src/shell.ts:142-226`、`src/tool.ts:155-183`（同一路径覆写）；R3 `src/client/interaction-store.ts:32-34,106-127`、`src/client/toolview.tsx:62-63`。

---

## 4b. 交互回注（用户操作送回模型）

**宿主侧三条真实通道**

1. `agent.followup(message)` — 立即唤醒：`export interface Agent { ...; send(message: UserMessage, target: InboxTarget, wakeup: boolean): void; followup(message: UserMessage): void; steer(message: UserMessage): void; inject(message: UserMessage): void; }`。`followup` 唤醒，`inject` **不唤醒**（要等下一次输入）。`message` 用 `createUserMessage({content:[{type:'text',text}], source})` 构造（返回 deep-frozen，自动带 `id`）。
2. `agent.steer(message)` + 监听 `agent/turn-stopping` — 在本回合内注入修正输入，机器重读 inbox 再跑一步（不是新回合）。R3 用它做"围栏坏了让模型就地重发"。
3. `tools` 返回值里的 `exec.deferContext(message)` / `exec.includeTurn()`：延迟上下文进下一次请求。

**插件来源消息的 source 形状按会话格式版本分叉**：当前 `SESSION_FORMAT_VERSION = 4`，v4 的 kind 是 `` `plugin:${name}` ``（v3 才是 `{kind:'plugin', plugin:name}`）。

**客户端 → 宿主的三条真实通道**

| 通道 | 客户端调用 | 宿主落点 |
|---|---|---|
| 斜杠命令（不进聊天记录正文，宿主侧 handler 决定怎么处理） | `ctx.sessions.binding(id).session.command(line)` → `Promise<{ok:true,value:{matched:boolean}}\|{ok:false,...}>` | `ctx.commands.register({name, description, recordInput, handler(invocation)})`，`invocation.agent.followup(msg)` |
| 会话消息（排队成 user 消息） | `ctx.sessions.scope(sessionId)?.get('conversation')?.send(text)` | 模型下一回合读到 |
| 自定义 RPC | `ctx.connection.rpc.call(channel, endpoint, payload, signal?)` → `Promise<{ok:true,value}\|{ok:false,error}>` | `ctx.connection.rpc.handle(channel, handler)`，`handler(endpoint, payload, signal, peer)` |

R3 的 action 环回走**第 2 条**：客户端把 `[genui-action] <name> ...` 文本 `conversation.send(...)` 进会话，模型被要求重发更新后的 UI。R1 走**第 1 条**：把交互数据包成 `/artifact-submit <json>`，宿主命令 handler 解析后 `invocation.agent.followup(createUserMessage(...))`。R4 走**第 3 条**（`/artifact-viewer` 通道，`file/preview`、`bookmarks/read|write`）。

```ts
// 宿主：命令 + Agent.followup（R1 src/index.ts:116-135）
ctx.commands.register({
  name: 'artifact-submit',
  description: 'Record user interaction data submitted from an HTML artifact preview.',
  recordInput: false,                                   // 不把用户输入记进会话
  handler: (invocation) => {
    const parsed = parseSubmissionPayload(invocation.rawInput)   // 命令名之后的原文
    if (!parsed.ok) return { kind: 'error', text: parsed.error }
    const message = createUserMessage({
      content: [{ type: 'text', text: renderInteractionSubmission(parsed.value) }],
      source: { kind: 'plugin', plugin: name, form: 'notice', summary: renderSubmissionSummary(parsed.value) },
      // ↑ 0.2.0-rc.2 是 session format v4，规范写法是 { kind: `plugin:${name}`, form: 'notice', summary }
    })
    invocation.agent.followup(message)                  // 立即唤醒模型
    return { kind: 'success', text: `recorded interaction data for artifact ${parsed.value.id}` }
  },
})

// 客户端：送到当前会话（R1 src/client/stream/submit.ts:58-68，sessions 来源见下方"正确取当前会话"）
export async function submitInteraction(artifactId: string, title: string | undefined, data: unknown): Promise<boolean> {
  if (sessions === undefined || currentSessionId === undefined) return false
  const binding = sessions.binding(currentSessionId)
  if (binding === undefined) return false
  const result = await binding.session.command(formatSubmissionCommand(artifactId, title, data))
  return result.ok === true && result.value.matched === true
}

// 客户端：取"当前会话 id"的 0.2.0-rc.2 正确写法（R4 src/client/current-session.ts:28-45）
const currentId = ctx.sessions.list.getSnapshot().current
const binding = currentId === undefined ? undefined : ctx.sessions.binding(currentId)
const session = binding?.session

// 宿主：turn-stopping + steer（R3 src/plugin/fence-feedback.ts:313-335）
ctx.on('agent/turn-stopping', ({ agent, turn, signal }): void => {
  if (agent.session.header.parentSession !== undefined) return      // 子会话不动
  const state = sessions.get(String(agent.session.id)); if (state === undefined) return
  const plan = planFenceFeedback({ text: state.text, turn, lastCorrectedTurn: state.lastCorrectedTurn, corrected: state.corrected, aborted: signal.aborted })
  if (plan === null) return
  for (const fp of plan.fingerprints) state.corrected.add(fp)        // 先记账再发，防重入重复
  state.lastCorrectedTurn = plan.turn
  agent.steer(createFeedbackMessage(plan.text, agent.session.header.version))   // v4 → kind:`plugin:${name}`
})

// 客户端：action 环回（R3 src/client/index.tsx:116-127）
function sendInlineGenuiAction(ctx: Context, sessionId: SessionId, action: string, payload: Record<string, unknown>): void {
  const scoped = ctx.sessions.scope(sessionId)
  const conversation = scoped?.get('conversation') as IConversation | undefined
  if (conversation === undefined) return
  const payloadText = Object.keys(payload).length === 0 ? '' : ` 组件数据: ${JSON.stringify(payload)}`
  void conversation.send(`[genui-action] ${action}。...${payloadText}`).catch(() => { /* 掉就掉，UI 保持可用 */ })
}

// 自定义 RPC（R4 src/index.ts:79-150 宿主 / src/client/ArtifactPreview.tsx:228-231 客户端）
connection.rpc.handle('/artifact-viewer', async (endpoint, payload) => {
  if (endpoint === 'file/preview') { /* ... */ return { ok: true, value: { content } } }
  return { ok: false, error: { code: 'bad-request', message: `unknown endpoint ${endpoint}`, details: { issues: [] } } }
})   // 0.2.0-rc.2 只有 2 个参数；R4 传的第三参 { authority: 'loopback' } 被忽略
void rpc.call('/artifact-viewer', 'file/preview', { path, encoding: 'base64' }).then((result) => { /* result.ok */ })
```

来源：R1 `src/index.ts:116-135`、`src/interaction.ts:31-85`、`src/client/stream/submit.ts:20-68`；R3 `src/plugin/fence-feedback.ts:155-176,269-336`、`src/client/index.tsx:66-127`；R4 `src/index.ts:75-151`、`src/client/ArtifactPreview.tsx:220-241`、`src/client/current-session.ts:21-56`；`asar:dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js:235`（Agent 接口全文）、`asar:dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/message.js:53-59`（createUserMessage）、`asar:dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js:56`（`SESSION_FORMAT_VERSION = 4`）、`asar:dsh/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/README.md:130-134`（`plugin:<name>` 规则）、`asar:dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js:1848-1856`（`session.command`）、`:3364`（`scope`）、`:3407`（`binding`）、`:3192`（provide "sessions"）、`asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js:3383-3388`（`conversation.send`）、`asar:dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js:576,640,695`（rpc.handle + handler 四参）、`asar:dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/client.js:1212`（`rpc.call`）、host `cordis_inspect_query Service.listService {service:"commands"}`（CommandInvocation/CommandResult 原文）。

---

## 5. 侧栏 / 浮层

**结论**

- `shell.overlay`：`kind: "list"`，`scope: "root"`，必填 `id`，可选 `order`/`label`；ownerProps **为空**，standardProps 只有 root 组（`useResource`/`useWorkspaces`/`usePanelInfo`/`useSessions`/`useSessionStatus`/`useSessionRetainInfo`）。层级是"整帧浮层、在所有列之上、在滚动容器之外"，**本身 click-through**，条目自己开 `pointer-events`。要贴右侧面板就自己在组件里画右浮层 + 撑开宿主布局（R4 靠找到祖先 `[data-shell-overlay]` 的 parent 加 class/`--dsh-artifact-viewer-width`）。
- 右侧栏是真服务，不是 slot：`ctx.sidebarRight`（导航控制器）与 `ctx.sidebarRightTabs`（tab 类型注册表），二者由 ui-sidebar-right 在同一个 effect 里 `ctx.reflect.provide` 提供。
- 注册一个右侧栏 tab = 两步：① `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })`（返回 disposer，必须自己用 `ctx.effect` 持有）；② 用**同一个 `id` 作为 key** 注册 `sidebar.right.pane.tab`（body）与 `sidebar.right.pane.tab.title`（chip 标题）。`id` 全局唯一，`kind` 的 `builtin`/`extension`/`fallback` band 冲突会抛错。
- 打开 tab：`ctx.sidebarRight.openTab(kind, options?)`；打开资源：`ctx.sidebarRight.openResource('dsh-resource://<type>/...', options?)`。options：`paneId`、`replaceTab`、`revealIfOpened`、`params`（到 body 的 `navigation.params`）、`kind`。地址不在 `dsh-resource://`、没有类型认领、或 kind 无人注册都会**抛错**。`tabsIn(sessionId)` 读已提交 tab；`registerCloseHandler(kind, handler)` 在显式关闭前同步保存后台清理。
- tab body 组件拿数据的方式与其它 slot 不同：ownerProps 是 `{}`，数据靠 **slot 级注入 hook** `useTabInfo()`（`sidebar.right.pane.tab` 的 slot spec 里 `inject: { hooks: { tabInfo: tabInfoFactory } }`，hookContext 是 `TabHookContext`）。返回 `{ sidebar:{expanded,fullscreen}, panel:{id}, tab:{...tab, visible, navigation, signal, actions, refreshShortcut} }`。tab 自己发导航用 `tab.actions.openTab/openResource`。
- `conversation.chat.turnTail` 在 0.2.0-rc.2 是 **list**（必填 `id` + `order`），**不是** chain：ownerProps `{ turn: TurnLocation, seq: number, openFile }`。R2 为了兼容旧版同时传 `id/order` 与 `priority/select`，在 0.2.0-rc.2 只有 `id/order` 生效。
- `conversation.chat.assistant-actions` 是 list（必填 `id` + `order`），ownerProps `{ messageId }`。

```tsx
// shell.overlay 注册（R4 src/client/index.ts:88-109）
ctx.slots.inject('shell.overlay', () =>
  ctx.slots.register(
    { name: 'shell.overlay', id: 'artifact-viewer-panel', order: 50, locale: NS,
      store: viewerStore,                                  // root 作用域 store，用 defineStore 造
      inject: (): ArtifactPanelFace => ({
        hooks: { currentSession, bookmarks: bookmarks.store },   // hooks.x → 组件里 useX
        bookmarks, rpc, onOpenPath: (p) => ctx.workspaces.openPath(p),
        onOpenSession: (sessionId) => ctx.sessions.open(sessionId as SessionId),
      }) },
    ArtifactPanel,
  ),
)
// 组件签名（R4 src/client/ArtifactPanel.tsx:23-26,40-51）
export type ArtifactPanelProps = PropsRuntime<'shell.overlay'> & PropsStore<ReturnType<typeof createArtifactViewerStore>>
  & InjectFace<ArtifactPanelFace> & PropsLocale<typeof NS>
export function ArtifactPanel({ useStore, actions, useCurrentSession, useBookmarks, bookmarks, rpc, onOpenPath, onOpenSession, useSessions, t }: ArtifactPanelProps) {
  const panelOpen = useStore((s) => s.panelOpen)
  const sessionSnapshot = useCurrentSession((snapshot) => snapshot)
  const projectPath = useSessions((s) => s.current === undefined ? undefined : s.byId[s.current]?.cwd)
  if (!panelOpen) return null            // 开关就是 store 里的一个布尔
  ...
}

// store（R4 src/client/store.ts:18-53）
export const createArtifactViewerStore = () => defineStore({
  init: (): ArtifactViewerState => ({ panelOpen: false, activeTab: 'current', expanded: false, width: 420 }),
  actions: { togglePanel: (draft) => { draft.panelOpen = !draft.panelOpen }, setWidth: (draft, width) => { draft.width = width }, /* ... */ },
})

// 右侧栏 tab：两步注册（形态来自 asar 内 shipped guide 类型 + 文档）
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: 'my-artifact-preview', kind: 'artifact-preview', priority: 'extension',
  title: (address) => 'Artifact',          // chip 文本，在 tab 打开时捕获
}), 'artifact: tab type')
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
  { name: 'sidebar.right.pane.tab', key: 'my-artifact-preview' }, ArtifactTabBody))
ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
  { name: 'sidebar.right.pane.tab.title', key: 'my-artifact-preview' }, ArtifactTabTitle))
// 打开它
ctx.sidebarRight.openTab('artifact-preview', { params: { path } })            // 页类型
// 或按地址开启（需在 register 里声明 patterns）
// ctx.sidebarRight.openResource(`dsh-resource://file/${absPath}`, { params: { line: 12 } })
// body 组件：
function ArtifactTabBody({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab'>) {
  const info = useTabInfo()
  const params = info.tab.navigation.params          // openTab/openResource 传进来的 params
  const actions = info.tab.actions                   // tab 自身发起的导航走这里
  return <div>{/* ... */}</div>
}

// 侧栏 footer 按钮（R4 src/client/index.ts:75-86）
ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
  { name: 'sidebar.footer.action', id: 'artifact-viewer-toggle', order: 50, locale: NS, store: viewerStore },
  ArtifactToggle))   // ownerProps: { wide: boolean }
```

来源：R4 `src/client/index.ts:65-124`、`src/client/ArtifactPanel.tsx:23-26,40-51,300-320`、`src/client/store.ts:18-53`；`asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js:5519-5545`（TabSlot：`renderSlot(seat, {}, {entryKey: definition?.id ?? tab.kind, hookContext})`、`tabInfoFactory` 上下文）、`:6168`（`openTab`）、`:8690-8730`（`tabs.register` 定义与冲突规则）、`:9073-9074`（`ctx.reflect.provide("sidebarRightTabs"|"sidebarRight", ...)`）、`:9154-9165`（pane.tab / title 的 keyed 声明 + `inject:{hooks:{tabInfo}}`）、`:9190-9230`（shipped guide 的两步注册范例）；`asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/README.md:76,83,86,91,108`（tab 类型字段、band 规则、options、close handler）；`asar:dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:4816`（shell.overlay 条目）、`:5021`（sidebar.footer.action）、`:5113`/`:5163`/`:5211`（right.pane.tab / .title / tab.document）、`:2565`（turnTail=list）、`:2400`（assistant-actions=list）、`:3004`（conversation.input.dock）。

`sidebar.right.tab.document` 不是右侧栏的入口，而是 **documentpreview 包内部**的子 slot（"Document body selected by a registered implementation id"，声明者是 `sidebar.right.pane.tab` 的 documentpreview 条目），keyed 语义是"文档实现 id"（`CodeBody`/`HtmlBody`/`MarkdownBody`/`PdfBody`/...）。要在右侧栏预览 HTML 文件，正路是注册自己的 tab 类型，或直接替换/复用 documentpreview 的实现 key（`replaceRisk: none`，但那是跨包依赖）。

---

## 6. 打包与依赖

**结论**

- 三个文件的确切关系：`package.json` 是唯一入口。`dsh.bundle.patch`（路径或路径数组）指向 `cordis.patch.yml`（或任何 loader patch yaml），patch 里的 `insert` 行把插件按**包名**插进 profile 的 layer 栈；`dsh.client` 声明浏览器半。`dsh.plugin.json` **在 0.2.0-rc.2 里完全没被读取**（全 asar 0 命中 `dsh.plugin.json` / `plugin.json`）——留着无害，删掉也不影响。
- 客户端 bundle 的发现规则（全部硬性）：`package.json` 有 `dsh.client` 且 `dsh.client.platform === 'web'`；`exports["./client"]` 必须是字符串或 `{default: string}`；bundle 必须 `window.__ModuleLoader__.load({ id: <包名>, factory })`；`require()` **只能**命中 9 个种子词、已物化模块、boot graph 行。`<包名>/client` 与裸包名归一（`stripClientSuffix`）。声明了但缺 bundle 会在激活时报错。
- **0.2.0-rc.2 的冻结种子表（9 项，逐字）：**

```js
{ "react": ..., "react/jsx-runtime": ..., "react-dom": ..., "react-dom/client": ...,
  "@deepseek-ai/cordis": ..., "@deepseek-ai/dsh-client-store": ...,
  "@deepseek-ai/dsh-client-ui-slots": ..., "@deepseek-ai/dsh-client-ui-primitives": ...,
  "@deepseek-ai/dsh-client-ui-dockkit": ... }
```

  不在表里的（R1/R2/R4 的 externals 列表里都有，属历史残留）：`@deepseek-ai/dsh-client-web-react`、`@deepseek-ai/dsh-client-schema-form`、`@deepseek-ai/dsh-client-ui-attachment`、`@deepseek-ai/dsh-client-runtime/client`。**后者是致命的**：它在 0.2.0-rc.2 全盘不存在，值是导入就会 `require` 失败（错误原文：`missed the module table — not a platform seed word, ...`）。R1 `src/client/stream/draft.ts:20` 导入了 `conversationContextKey`（值），R4 `src/client/store.ts:3` 导入 `defineStore`、`src/client/current-session.ts:4-8` 导入 `createSnapshotStore`，都会踩这个坑。**替代**：`defineStore`/`createSnapshotStore` 来自种子里的 `@deepseek-ai/dsh-client-store`；`conversationContextKey(kind,id)` 语义就是 `` `${kind.length}:${kind}${id}` ``，本地内联即可。
- 跨模块的合法依赖只有两条：`dsh.client.external`（**只排序激活**，必须指向真实 dynamic package 行或精确静态表 key；不提供模块实例语义），或 cordis service。`neverBundle` 只是构建器指令，不等于运行时可解析。
- `peerDependencies`：0.2.0-rc.2 的接受范围实测有 4 种可跑写法（都在本机/aspect 里验证过）：
  - `"*"`（R1，最宽松，profile 里能装上）；
  - `"^0.1.0-rc.6 || ^0.2.0-rc.1"`（R2，两个大版本区间并存）；
  - `"^0.1.2-rc.1 || ^0.1.5-alpha.1 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1 || >=0.2.0-rc.1 <0.3.0-0"`（R3，覆盖历史 alpha + 当前 rc 行）；
  - `"^0.1.1-rc.2"`（R4，写死在老 rc 行上——**与 0.2.0-rc.2 不匹配**，只是 profile 用 link/本地安装时不强制）。
  `@deepseek-ai/cordis` 用 `^4.0.1`（当前 runtime 是 `~4.0.4`）。只把**真正 import 的包**写进 peers，且必须是 type-only 或种子模块。
- 客户端 bundle 构建（tsdown，三种实测配置）：`format: 'cjs'` + `platform: 'browser'` + `entryFileNames: 'client.js'` + `banner`/`footer`/`intro` 三件套；`deps.neverBundle` 放种子词；`define: {'process.env.NODE_ENV': '"production"'}`；CSS Modules 用 lightningcss 编译成注入 `<style data-plugin-css=...>` 的虚拟模块（每个插件的通行做法）。R3 额外加 `minify: true`、`sourcemap: false`、`codeSplitting: false`、纯净度门（非种子 `@deepseek-ai/*` 值导入直接 build error）。构建产物里 `require()` 只剩种子词——本机在跑的 `dsh-visualize/lib/client.js` 只有 `require("react")` 和 `require("react/jsx-runtime")`。

```json
// package.json（宿主+客户端双半，R1 版本，逐字可用）
{
  "name": "@dsh-external/dsh-html-artifact",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "src", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime"]   // ← 只排序激活；名字不存在也不报错，但毫无作用，可删
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-client-ui-primitives": ">=0.2.0-rc.1 <0.3.0-0",
    "@deepseek-ai/dsh-client-ui-slots": ">=0.2.0-rc.1 <0.3.0-0",
    "react": "^18.2.0"
  }
}
```

```yaml
# cordis.patch.yml（R1 原文；插入的行 id 与包名都要唯一）
- insert:
    - id: dsh-html-artifact
      name: '@dsh-external/dsh-html-artifact'
```

```ts
// tsdown.config.ts 客户端半（R1/R2/R3 共同部分）
{
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false,
  deps: { neverBundle: [...SEED_OR_TYPE_ONLY], alwaysBundle: (id) => !EXTERNALS.includes(id) },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}
// 宿主半：{ entry:{index:'src/index.ts'}, format:['esm'], platform:'node', target:'es2024', dts:true,
//           deps:{ neverBundle:['@deepseek-ai/schemastery','@deepseek-ai/cordis'] } }
```

**安装/启用**：把 `dsh.bundle.patch` 存在、`dsh.client` 正确的包装进 profile，然后 `plugin_manager install_bundle`（不要用 shell 复现）；或把包名加进 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`。组合顺序（`~/.dsh/profiles/desktop/cordis.yml` 注释原文）：bundles → `cordis.patch.yml` → `--patch` overlays。本机 `dsh-visualize` 就是这条路的活例（`package.json` `dsh.profile.bundles` 含 `@nagi-ovo/dsh-visualize`，实体在 `node_modules/@nagi-ovo/dsh-visualize`）。

来源：R1 `package.json`、`dsh.plugin.json`、`cordis.patch.yml`、`tsdown.config.ts:19-40,60-105`；R2 `package.json`（peer 区间）、`tsdown.config.ts:15-62`；R3 `package.json`（`dsh`/`peerDependencies`）、`tsdown.config.ts:25-27,153-188`；R4 `package.json`（`dsh.client.external`）、`tsdown.config.ts:23-32,68-71,118-126`；`asar:dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-5SrrfWpU.js:126`（`function rM()` 静态种子表，逐字 9 项）；`asar:dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js:57-72`（parseDshClient 校验 `platform`/`inject`/`external`/`immediately`）、`:171-181`（clientExportOf）、`:440`（self-request 拒绝）；`asar:dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js:700-705,744-751`（require 未命中种子/图行的错误原文）；`asar:dsh/node_modules/@deepseek-ai/dsh-client-modules/README.md`（`dsh.client` 契约、共享模块基线、构建前置）；`asar:dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:491-503`（`dsh.bundle.patch` 支持字符串或数组）；`asar:dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/package.json`（首个官方最小模板，含 `immediately`）；本机 `~/.dsh/profiles/desktop/package.json`、`cordis.yml`、`node_modules/@nagi-ovo/dsh-visualize/lib/client.js`。

---

## 7. genui 的 DOM 兜底通道（`fence-registry` 确认不存在）

**结论**

- `fence-registry` 在 0.2.0-rc.2 里 0 命中（与前提一致）。R3 的 registry 分支靠**运行时探测** `(primitives as any).registerFenceRenderer` 是否存在——不存在就永不进这条分支。
- 实际跑的是 DOM 通道：`MutationObserver(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['data-streaming'], characterData:true })` + 1s 周期兜底 sweep；从 `[data-chat-anchor-key]` 行里找 `.md-code-block`（另有 `.code-block`/`.code-block-small` 兼容面），用 `data-genui-rendered` 标记已接管，自己 `createRoot` 挂 React 树。选择器与结构判据都在源码里，可直接抄。
- 关键结构判据：真围栏面 = "banner chrome + 恰好一个 `<pre>` 且不含段落/列表/标题/表格"。取错会把整段回答藏掉（源码注释里记了两个真实事故）。
- 流式/已完结靠 `[data-streaming]` 属性区分；已完结才用 `[data-chat-anchor-key]`（形如 `assistant-step{turn}:{step}`）做稳定身份，流式为无身份渲染。
- action 回注：插件自建 React 树时自己包一层 `GenuiActionContext` provider，provider 的 handler 就是 `sendInlineGenuiAction`（见 §4b）。

```ts
// 通道选择（R3 src/client/index.tsx:151-158）
const registerFn = (primitives as unknown as HostFenceExt).registerFenceRenderer
const useRegistry = typeof registerFn === 'function' && !forcedDomChannel()
const channel = useRegistry ? 'registry' : 'dom'
console.info(`[genui] client active; fence-channel=${channel}`)

// 选择器与判据（R3 src/client/dom-fence.tsx:74-104）
const CODE_BLOCK_SELECTORS = '.md-code-block, .code-block, .code-block-small'
const PROCESSED = 'data-genui-rendered'
const STREAMING = '[data-streaming]'                 // 存在 = 仍在流式，缺省 = 已完结
const SWEEP_MS = 1000
const SURFACE_HOPS = 4                                // 从 <pre> 向上找 fence 面的最大层数
const BLOCK_CONTENT_SELECTOR = 'p, ul, ol, dl, table, h1, h2, h3, h4, h5, h6, blockquote, hr, img, figure'
function isPlausibleFenceSurface(candidate: Element): boolean {
  const pres = candidate.querySelectorAll('pre'); if (pres.length > 1) return false
  const pre = pres[0] ?? null
  for (const el of candidate.querySelectorAll(BLOCK_CONTENT_SELECTOR)) { if (pre !== null && pre.contains(el)) continue; return false }
  return true
}

// observer（R3 src/client/dom-fence.tsx:1015-1040）
const observer = new MutationObserver(records => { /* 先修 DOM surgery，再 rAF 调度 React 重渲染 */ repairSurgery(); schedule() })
observer.observe(document.body, { childList: true, subtree: true, attributes: true,
  attributeFilter: ['data-streaming'], characterData: true })   // characterData 必需：token 是文本节点更新
const interval = window.setInterval(sweep, SWEEP_MS)
```

来源：R3 `src/client/index.tsx:42-45,135-158`、`src/client/dom-fence.tsx:74-104,363,560-600,1015-1055`、`src/client/action-context.ts:15-32`（context 复用宿主实例或本地 fallback）、`src/client/session-resolver.ts:21-37`（从 `sessions.list` 快照解析当前会话，含 `retainedBy.mainView` 兜底）。

---

## 未验证 / 无法核实

| 点 | 状态 |
|---|---|
| 客户端 `cordis_inspect_query`（`Slots.listSubTree` / `Service.listService` / `Theme.listTokens`） | 三次调用均 10s 超时（无页面响应）。因此本文 client 侧结论全部来自 asar 内 shipped bundle 与内置 slot 目录，未用活体 provider 交叉验证。 |
| `@deepseek-ai/dsh-client-runtime/client` 是否另经某条动态 package 行提供 | 判为不存在（asar 全盘 0 命中 + 前端 dist 0 命中 + 种子表仅 9 项 + 在跑的 visualize bundle 无此 require），但未实际跑一次失败用例复现报错。 |
| `fence-registry` | 与前提一致：0 命中。R3 的 registry 分支代码路径未在 0.2.0-rc.2 上被执行过（`registerFenceRenderer` 探测失败）。 |
| 模型侧 args 用 `parameters`（裸 JSON Schema）在哪一层校验 | `ToolRuntime.register` 不校验 `parameters`；`defineTool` 在自家 `execute` 包装里校验。裸 definition 的校验点未定位到具体文件（R3 注释称"harness 用同一 validator 校验"，未核实到调用点）。 |
| 会话 format v4 是否接受旧式 `{kind:'plugin', plugin:name}` 源 | R1 这么写；v4 迁移规则里"其他直接来源保留原 kind 与自有字段"，推测可用，未实测。规范写法是 `` {kind:`plugin:${name}`} ``（`SESSION_FORMAT_VERSION = 4`）。 |
| `sidebar.right.tab.document` 的 ownerProps/hook 细节（`DocumentContent`、`resourceAddress`、`scrollportRef`、`addResource`） | 只读到 slot 目录声明，未读 documentpreview 实现；是否适合第三方插件接管未验证。 |
| `ctx.sidebarRight` 在**客户端** `ctx` 上的可达性 | 服务名已由 `ctx.reflect.provide("sidebarRight", controller)` 证实存在于客户端 runtime；但插件 `inject: ['sidebarRight']` 是否为受支持的声明方式未验证（官方包自己用 `ctx.get('sidebarRight')` 风格；建议用 `ctx.inject(['sidebarRight'], ...)` 可选注入）。 |
| `event.source` 校验与 iframe `postMessage` 在 opaque origin 下的 `event.origin` | 代码里统一用 `'*'` 发送、只靠 `id/token` + `event.source` 关联；未做 origin 校验的原因与风险未在源码中说明。 |
