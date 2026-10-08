# dsh-artifacts-live

DSH 里的 Claude 网页版 Artifacts：模型写一份自包含 HTML，在对话里的沙箱 iframe 中**实时渲染**，之后用增量补丁**原地更新**，预览里的交互数据可以**发回会话**。

范围：DSH 桌面版 0.2.0-rc.2，desktop profile 自用。

## 现状：已在桌面版 0.2.0-rc.2 上跑通

宿主半与客户端半都已在运行中的桌面 App 里激活，并用真实工具调用端到端验证过（create → patch 原地更新 → list）：

```
client/Slots/listSubTree root=tool.call.toolview
  → {registrant:"dsh-artifacts-live", key:"artifact", active:true}
client/Slots/listSubTree root=sidebar.right.pane.tab
  → {registrant:"dsh-artifacts-live", key:"dsh-artifacts-live:panel", active:true}
host/Tool/listTools
  → 首条即 name:"artifact"
```

## 开发迭代：客户端改动热重载，不用重启 App

只改 `src/client/**` 时，把构建产物覆盖进 profile 的安装副本即可，浏览器会自动重新装载：

```sh
pnpm run build
cp lib/client.js ~/.dsh/profiles/desktop/node_modules/dsh-artifacts-live/lib/client.js
```

宿主侧（`src/*.ts`）改动才需要重装 + 重启 App，用 `scripts/reinstall-desktop.sh`。

客户端半有一处自检通道：拿不到浏览器控制台时，可以用
`cordis_inspect_query client/Slots/listSubTree root=tool.call.toolview` 看座位有没有被占用；
更细的定位可在代码里临时打点（本次排查就是靠把结局注册进 `shell.overlay`、或向本机
监听端口发信标做到的）。

## 模型侧用法

```
artifact { action: "create", title?, html, mode? }        # 新建，返回 id
artifact { action: "patch", id, old_string, new_string, replace_all? }
artifact { action: "read", id }
artifact { action: "list" }
artifact { action: "destroy", id }
```

工具描述里内置了协议：什么时候该开 artifact（要看的、要操作的东西）、一次回复只开一个、之后一律 patch 而不是重写、把内部状态写进 `window.__dshArtifactData`。

## 行为要点

- **一份产物对应一个 frame**。创建它的卡片持有沙箱 iframe；后续 `patch` 卡片只渲染一行更新提示，补丁直接送进那个运行中的文档，不会出现第二个预览。
- **流式期不重挂 iframe**。模型还在写调用时，已到达的片段经 postMessage 泵入同一个 frame（120ms 节流）；调用落定后重载一次让脚本执行；此后仅当 `<script>` 内容变化才重载，否则做索引对齐的 DOM 协调——artifact 的 DOM、输入值、内存变量都保留。
- **存储可跨重载**。`localStorage`/`sessionStorage` 是不透明源下的内存 shim，frame 把快照报给卡片，重载时回灌。
- **交互回注**走官方客户端通道：卡片 chrome 的「提交交互数据」向 frame 取 `window.__dshArtifactData` + 表单值 + 点击过的按钮，经 `inputActions.insertText` + `submit()` 发成一条用户消息。按钮放在卡片上而不是 frame 内，不污染 artifact 布局。
- **位置由正文里的围栏声明**：助手在回答中写下标记围栏，产物就渲染在那一行——完整、可交互，夹在正文中间，不在回合末尾，也不在折叠里。

  ````
  ```dsh-artifact
  art-xxxxxxxx
  ```
  ````
  围栏里只有 id，源码仍走工具结果，所以产物可 patch、回答正文也不会被塞进一兆字节。折叠（标准/简洁/详细三档）不影响它：助手回复正文本来就不进过程组。工具行因此在调用结束后只留一行紧凑行（标题 + 版本 + 在侧栏打开 / 在此预览），调用进行中则给实时预览。
- **一个产物两个视图**：正文里那份和右侧栏那份是同一个 artifact；点「在侧栏打开」把侧栏指到它。
- **右侧栏产物面板**：通过 `ctx.sidebarRightTabs.register` + `ctx.sidebarRight.openTab` 注册「产物」页，列出本会话全部 artifact 并预览选中的那个。页面出现第一个 artifact 时自动展开一次。

## 沙箱

```
sandbox="allow-scripts allow-modals"        # 无 allow-same-origin，不透明源
default-src 'none'
script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' <CDN 白名单>
style-src  'unsafe-inline' <CDN 白名单>
img-src / font-src / media-src <CDN 白名单>
worker-src blob: data: ; connect-src blob: data:
frame-src 'none' ; object-src 'none' ; base-uri 'none' ; form-action 'none'
```

白名单：`cdnjs.cloudflare.com`、`cdn.jsdelivr.net`、`esm.sh`、`fonts.bunny.net`、`fonts.googleapis.com`、`fonts.gstatic.com`、`unpkg.com`，外加 `blob:`、`data:`。

模型自带文档骨架也能用（`<!doctype>/<html>/<head>/<body>` 被解包，顺序不变），且会剥掉它自己声明的 CSP，防止削弱帧内策略。

## 工程

```
pnpm run check      # typecheck(宿主半 + 客户端半) + vitest + tsdown
bash scripts/reinstall-desktop.sh   # 构建 + 打包 + 装进 desktop profile
```

依赖分两套：`devDependencies` 里放**精确版本 0.2.0-rc.2** 的 `@deepseek-ai/*`（带 `.d.ts`，用于类型检查），运行期它们由宿主运行时提供。

## 两个必须知道的坑

1. **不要用目录链接安装本插件。** `dsh plugin --profile desktop add <源码目录>` 会把源码树（含为类型检查安装的 `node_modules/@deepseek-ai/*`）暴露给 Loader；Node 会先解析到这些副本，而它们自己的传递依赖没装，导入直接抛 `Cannot find package '@deepseek-ai/dsh-scope'`，整条 bundle 激活失败。必须走打包安装（`scripts/reinstall-desktop.sh` 已如此）。
2. **装完必须重启 App。** Host 对 Loader specifier 的包元数据缓存至进程结束，包括「这个包导不进来」这个否定结论；`plugin_manager` 会直接回 `restart-required`。

## 已知限制

- **宿主半的改动要重启进程才生效**：客户端半改动会被浏览器热重载，工具描述、Config、结果提示这类宿主侧内容不会。

- **artifact 注册表在进程内存里。** 每次 revision 都内嵌在工具结果里，所以**转录永远能渲染**；但 `patch`/`read` 需要宿主还记得这个 id。
  - 插件被重新加载（覆盖安装、升级）不会丢：注册表挂在进程级 holder 上。
  - **Host 重启会丢**（内存清空）。此时旧卡片照常显示，但模型无法再按 id 改它，只能新建一个。这是当前实现与 Claude「持久化对象 + 版本历史」之间最大的差距，下一步要么从会话日志重建，要么落盘到 `~/.dsh/storages/`。
- 单帧上限 2 MB（`maxArtifactBytes`），单会话 40 个 artifact（`maxArtifactsPerSession`），都可在 profile 的插件 config 里调。

## 与参考实现的关系

- 沙箱与主题桥的做法参考 `@nagi-ovo/dsh-visualize`（BSD-3-Clause）与 `lobehub/lobe-ui` 的 `HtmlPreview`；存储 shim 与「流式期不重挂 frame」两条来自后者的结论。
- 不 fork `lehhair/dsh-html-artifact`：它声明 `inject: ["@deepseek-ai/dsh-client-runtime"]`，而该包在 0.2.0-rc.2 的运行时里不存在（app.asar 0 命中），客户端 entry 无法物化；且无 license、2026-08-15 后停更。
- 调研原文在 [`research/`](research/)：`00-verified-environment.md`（环境实测）、`claude-artifacts-mechanisms.md`（开源实现机制）、`dsh-plugin-api-usage.md`（DSH 侧 API 用法）。设计见 [`DESIGN.md`](DESIGN.md)。
