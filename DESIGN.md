# dsh-artifacts-live 设计

范围：DSH 桌面版 0.2.0-rc.2，desktop profile 自用。目标是把 Claude 网页版 Artifacts 的四段（对象化产物 → 聊天内实时预览 → 增量原地更新 → 交互回注）在 DSH 里拼齐。

## 与参考实现的差异

| 维度 | `@nagi-ovo/dsh-visualize` | `lehhair/dsh-html-artifact` | 本插件 |
|---|---|---|---|
| 产物身份 | 文件路径，每次 create 新文件 | 会话内 id 注册表 | 会话内 id 注册表，可 list/read/destroy |
| 更新语义 | `update` 打文件补丁，iframe 整体重载 | `patch` old_string/new_string，原地更新 | `patch` 同语义；**按脚本是否变化决定原地协调还是重载** |
| 存储 API | 无 shim，artifact 用 localStorage 直接抛异常 | 内存 shim | 内存 shim + 跨重载快照回灌 |
| 交互回注 | 无 | 宿主 `Agent.followup` | 客户端 `inputActions.insertText` + `submit`（官方通道，无自建 RPC） |
| 侧栏 | 无 | 无 | `ctx.sidebarRightTabs` 注册 kind + `ctx.sidebarRight.openTab` 打开 |
| 回放 | 从工具结果 meta 恢复 | 未验证 | 同 visualize：meta 内嵌完整 html |

`lehhair/dsh-html-artifact` 不可 fork 的硬理由：它声明 `inject: ["@deepseek-ai/dsh-client-runtime"]`，而该包在 npm 上最新只到 `0.1.1-rc.2`，**0.2.0-rc.2 不存在**，客户端 entry 无法物化。另外它无 license、2026-08-15 后停更。

`dsh-genui` 的交互回环在本版失效：它依赖 `@deepseek-ai/dsh-client-ui-primitives` 导出的 action context，而 0.2.0-rc.2 的 primitives 导出表里没有任何 action context 符号，回退到本地空 context，控件只显示不发事件。

## 契约

### 宿主半

工具 wire name：`artifact`。

```
artifact { action: "create", title?, html, mode? }
artifact { action: "patch", id, old_string, new_string, replace_all? }
artifact { action: "read", id }
artifact { action: "list" }
artifact { action: "destroy", id }
```

- 注册表按会话隔离：`Map<SessionId, Map<artifactId, Record>>`。
- `execute` 返回对象即客户端的 `block.meta`，形状：

```ts
interface ArtifactMeta {
  action: 'create' | 'patch'
  id: string            // art-<8 hex>
  title: string
  html: string          // 完整快照，回放据此恢复，不依赖注册表存活
  version: number
  mode: 'inline' | 'wide'
  render: 'reload' | 'reconcile'   // patch 未触碰任何 <script> 时为 reconcile
  sizeBytes: number
}
```

- `presentCall` / `presentResult` 返回 `{ card: 'generic', title, kind }`。`card` 是既有 union 的成员，不写自定义值。

### 客户端半

- bundle 形态：`window.__ModuleLoader__.load({ id: 'dsh-artifacts-live', factory })`，模块体导出 `name` / `inject = ['slots']` / `apply`。
- 聊天内：`ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'artifact' }, ArtifactView))`。
- 组件 props：`{ phase, block, callId, inputActions, sessionId, ... }`；`block` 按 phase 为 `PreparingToolCall` / `StartedToolCall`（有 `argsRaw`）/ `ToolResultNode`（有 `meta` / `content` / `isError`）。preparing 阶段用注入的 `hooks.toolCallArgumentsPartial()` 取参数前缀做流式预览。
- iframe：`sandbox="allow-scripts"`（无 `allow-same-origin`，不透明源）、`referrerPolicy="no-referrer"`、`srcDoc`。
- 帧 CSP：

```
default-src 'none';
script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' <CDN 白名单>;
style-src 'unsafe-inline' <CDN 白名单>;
img-src <CDN 白名单>; font-src <CDN 白名单>; media-src <CDN 白名单>;
worker-src blob:; connect-src blob: data:;
frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

CDN 白名单：`cdnjs.cloudflare.com`、`cdn.jsdelivr.net`、`esm.sh`、`fonts.bunny.net`、`fonts.googleapis.com`、`fonts.gstatic.com`、`unpkg.com`，外加 `blob:`、`data:`。

- 主题桥：读 `document.body` 计算样式，映射
  `--dsw-alias-label-primary`→foreground、`--dsw-alias-bg-layer-1`→card、`--dsw-alias-label-caption`→muted-foreground、`--dsw-alias-border-l2`→border、`--dsw-alias-brand-primary-new-colorprimary-new-color`→primary、`--dsw-alias-label-primary-inverted`→primary-foreground，
  以 `--dsh-art-<name>` 注入；值经 `/[;{}<>]/` 过滤。`body[data-ds-dark-theme]` + `matchMedia` 推 scheme。
- 高度桥：帧内 `ResizeObserver` → `parent.postMessage({ type: 'dsh-artifacts:height', token, height }, '*')`；父侧校验 `token === callId` 且高度有限，clamp 到 `[48, inline 800 / wide 1200]`。
- 存储 shim：帧内 `localStorage` / `sessionStorage` 以内存对象实现，避免不透明源直接抛异常；父侧缓存每个 artifact id 的快照，重载时回灌。
- 交互回注：卡片 chrome 上的按钮向帧发 `dsh-artifacts:collect`，帧回 `dsh-artifacts:data`，负载 = `window.__dshArtifactData` + 表单控件值 + 点击过的按钮及次数；父侧 `inputActions.captureInsertion()` → `insertText(payload, span)` → `submit()`。按钮放在卡片 chrome 而不是帧内，不污染 artifact 布局。

### 侧栏

- `ctx.sidebarRightTabs.register({ id, kind, title, guide, patterns? })` 注册类型。
- 会话体注册到 keyed `sidebar.right.pane.tab`，chip 到 `sidebar.right.pane.tab.title`，key = definition 的 `id`。
- 打开：`ctx.sidebarRight.openTab(kind, options?)`。

## 目录

```
dsh-artifacts-live/
  package.json  dsh.plugin.json  cordis.patch.yml
  tsconfig.json  tsconfig.client.json  tsdown.config.ts
  src/index.ts              宿主半：注册表 + artifact 工具
  src/patch.ts              old_string/new_string 替换语义（纯函数，可测）
  src/client/index.tsx      客户端半：槽位注册 + 侧栏注册
  src/client/frame.ts       帧文档构建：CSP、主题、高度桥、存储 shim、交互采集
  src/client/ArtifactView.tsx  聊天内卡片
  src/client/Panel.tsx      侧栏面板
  tests/                    纯逻辑单测
  research/                 调研与环境事实
```

## 验证

1. `pnpm run check`（typecheck + test + build）。
2. `plugin_manager install_bundle target=<本地路径>` 或 `dsh plugin --profile desktop add <路径>`。
3. 两半独立验证：`client/Slots/listSubTree root=tool.call.toolview` 出现 `{registrant:'dsh-artifacts-live', key:'artifact', active:true}`；`host/Tool/listTools` 出现 `artifact`。
4. 真实会话：让模型 create 一个交互 artifact，再 patch 它，观察是否原地更新；点提交按钮，观察会话是否收到交互数据。

## 实现期修正（实测后改的设计）

- **卡片呈现只走 `presentationMeta`。** `presentCall` / `presentResult` 在 0.2.0-rc.2 的 Web GUI 里 0 命中、不被消费（`dsh-tools/README.md` 明文写了）；唯一的载荷通道是 `output.presentationMeta` → `result.meta` → 客户端 `block.meta`。客户端不读 card union，因此不需要任何边界强转。
- **一个 artifact 只有一个 frame。** 创建它的卡片持有 iframe 并通过页面内 store 采纳后续 revision；`patch` 卡片渲染一行更新提示。原设计中「每张卡片各自渲染」被否掉——那会出现重复预览，且改 `srcDoc` 等于整帧重载。
- **流式期改为泵入而非重挂。** `srcDoc` 变更 = iframe 重载（Chromium 对 srcdoc 换 key 才可靠重导航），所以 frame 只建一次，流式片段经 `postMessage` 做索引对齐协调；落定时重载一次让脚本执行。
- **主题切换不再重载**：新增 `dsh-artifacts:theme` 消息，帧内改 `--dsh-art-*` 与 `color-scheme`。
- **meta 增加 `session` 字段**，供会话级面板过滤。
- **`sandbox` 加 `allow-modals`**：artifact 里的 `alert`/`confirm` 不再被静默吞掉（`allow-forms` 不加，`form-action 'none'` 已挡住提交）。
- **打包安装，禁止目录链接**：源码树的 `node_modules/@deepseek-ai/*` 会被 Loader 优先解析并因缺传递依赖而导入失败。详见 README「两个必须知道的坑」。

## 线上排障记录：唯一真正的激活 bug

现象：宿主半 `fiberPhase: active`，但 `tool.call.toolview` 里始终没有我们的座位。

定位链（全程无浏览器控制台）：

1. `/plugins` 路由不需要鉴权，按源文件 stat 复刻宿主的 `artifactRevision` 就能取到 bundle：
   我们的 bundle **HTTP 200**，说明行确实在 boot 图里（`fetchBundle` 只对图内 id + 匹配 rev 返回 200）。
2. 自签一个浏览器 cookie（`~/.dsh/.credentials.yaml` 里的 `client-connection/browser-session` 密钥
   + `v1.<b64url(payload)>.<b64url(hmac-sha256)>`，cookie 名 `dsh-auth-<b64url(sha256(authority))>`）
   后抓到真实 `__DSH_BOOT__`：我们的行在 `application` 批次里，rev 与文件一致。
3. 浏览器侧源码（`dsh-client-ui-slots` + `dsh-client-ui-renderer` 的 `SlotRegistry`）显示：
   脚本执行只注册 factory，物化后才跑模块体；座位注册经 `inject` 的回调在插件自己的 effect 里执行。
4. 在模块体和 `apply` 入口向本机监听端口发信标 → **两者都命中**，说明模块物化且 `apply` 被调用。
5. 把诊断改走信标后拿到真实异常：
   `Cannot read properties of undefined (reading 'effect')`。

根因：`SlotRegistry.prototype.register` 是原型上的方法，内部读 `this.ctx.effect`。
代码写成 `const register = ctx.slots.register` 把方法摘了下来，`this` 丢失 → `this.ctx` 为 undefined。
`ctx.slots.inject(...)` 是当方法调用的，所以它没报同一个错，掩盖了问题。

修法：`const register = (options, component) => ctx.slots.register(options, component)`，
并在 jsdom 测试里让假 ctx 的 `register`/`inject` 也依赖 `this.ctx.effect`，让同类错误无法再漏过测试。

顺带确认的两条平台行为：

- 客户端 bundle 改动会被宿主重新对账（`__DSH_BOOT__` 的 rev 变化）并被浏览器重新装载，**无需重启 App**。
- 宿主侧改动不然：Loader 的包元数据缓存到进程结束（含「导不进来」这一否定结论），必须重启。

## 位置：为什么改成围栏驱动

DSH 把 `tool-call` 节点硬编码进回合的过程组：

```js
const TURN_PROCESS_INDEPENDENT_KINDS = new Set([
  "system-prompt","user","steering","turn-trigger",
  "turn-process","turn-error","turn-max-tokens","turn-tail"
]);
```

插件无法让工具行逃出折叠；这个版本也没有「认领正文代码围栏」的座位（`fence-registry` 在 0.2.0-rc.2 不存在）。而**助手回复正文不进过程组**，所以正文是唯一"常在视野内"的位置。

做法：模型在正文里写标记围栏（语言 `dsh-artifact`，内容只有 id），客户端用 `MutationObserver` 观察平台的代码块表面，认领后隐藏该块并在原位挂载完整帧。

- 表面是 `primitives` 的 `div.md-code-block`，语言在 `[data-code-block-banner]` 的文本里；两者都在运行时核对过。
- **语言认不出来**：这个构建把未知围栏语言映射成**本地化标签**（`dsh-artifact` 在 DOM 里显示为「代码块」，`json`/`js` 才原样显示），所以原始 info string 根本不进 DOM。识别因此以**内容**为准：块首行是 id 形状（`art-[a-z0-9]{4,}`）**且** store 里确实有这个产物——双重闸门。前两条（语言、`dsh-artifact <id>` 首行）保留，供其它构建使用。
- 兜底：宿主丢掉 infostring 时，块的**首行**写成 `dsh-artifact <id>` 也能认领。
- 只在 artifact 已知时认领，因此回放缺工具结果的会话时标记仍按代码块显示，不会挂出空帧。
- 观察器只看元素增删，并把扫描合并到一帧；早期版本观察 `characterData` 且每次变更都全文档扫描，实测每秒几十次。
- 工具行不再渲染第二份帧：调用结束后只留紧凑行（可选「在此预览」展开），所以一个 artifact 在页面上只有一份活帧。

## 注册表生命周期

`ArtifactRegistry` 原来是 `apply()` 里的局部变量：插件一被重新加载（覆盖安装/升级），模块重新导入，
注册表就变成空的，而转录里的卡片还在（快照内嵌在工具结果里）——表现是「卡片看得见，但改不动」。
现在挂在进程级 `Symbol.for('dsh-artifacts-live.registry')` holder 上，跨模块重载存活。Host 重启仍会丢，
这条限制写在 README「已知限制」里。

## 冷启动：真正的断点在"重复扫描"上

现象：热重载一切正常，冷启动（重启 App）看不到正文里的产物，而座位注册成功、侧栏也正常。

排查结论（按证据顺序）：

1. 座位在冷启动后被查询到 `{registrant:"dsh-artifacts-live", key:"artifact", active:true}` —— 客户端半确实被应用了，不是"模块没加载"。
2. 冷启动时转录**一次性渲染完**，而 store 由工具行的 effect 在其后填充；唯一能同时看到"标记块 + 已知产物"的那次扫描，正好落在被 rAF 合并、甚至可能被丢掉的那一批里。
3. 于是：初始 `scan()` 时 store 还空、store 订阅触发时块还没渲染、之后再没有任何触发源 —— 认领永远不会发生。

修法：**在观察器之外加 1 秒轮询**（页面隐藏时跳过；转录上一次全量 `querySelectorAll` 是微秒级）。认领从此不依赖"恰好抓到某次 DOM 变化"，这也是这个通道不需要任何宿主座位就能工作的前提。

同时保留：DOM 观察器（让认领在一帧内发生，而不是最多等 1 秒）、store 订阅（目录补齐即重扫）、`body` 未就绪时等 `DOMContentLoaded`。

教训：**客户端半的冷启动时序必须单独验证**。热重载页面早已渲染完、store 也早已补齐，条件对通道最有利，测不出这类问题。

方法上还有一个坑值得记下：诊断用的本机监听进程如果由会话启动，**它会随 App 重启一起被杀**（会话本身就跑在 App 里），`launchctl submit` 的临时任务同样会被清掉；要么用 `~/Library/LaunchAgents` 的正规 LaunchAgent，要么别指望跨重启的日志。
