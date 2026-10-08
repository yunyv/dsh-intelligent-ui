# dsh-genui 设计

范围：DSH 桌面 0.2.0-rc.2，desktop profile。一个包、一个工具、两条渲染路径。
本文件只写当下要落地的形状与接线点；机制出处在 `PROVENANCE.md`，
前身插件（HTML 路径的实现来源）的设计留档在 `../dsh-artifacts-live/DESIGN.md`。

## 目标形态

模型在对话里生成的是**可操作的界面**，不是描述界面的文字。两条路径：

| | DIL 路径（默认） | 逃生舱 |
|---|---|---|
| 模型写什么 | DIL 文档（`{@body}` 语句 + JSX-like 标签） | 自包含 HTML/React |
| 谁执行 | iframe 内 **无 DOM Worker** 跑编译产物 | iframe 直接跑 HTML |
| 谁渲染 | **宿主**接到渲染树，用原生组件画成真 DOM | iframe 自己画 |
| 拿到的 | 主题/可访问性免费、token 省、控件天生联动 | 表达力无上限（3D、D3、自定义仿真） |
| 状态 | 语义键 → 产物层 → 下一轮回灌模型 | `window.__dshArtifactData` + 手动回注 |

关键区分：**沙箱是执行容器，不是显示容器。** 这是 ChatGPT 那条路的要害——
表达力和控制权同时拿到，且"卡片里的代码碰到宿主元素"在结构上不可能发生。

## 进程分工

```
模型 ──source──► 宿主半：编译 ──DilCompiled──► 工具结果 meta
                        │                              │
                        │                              ▼
                        │                    客户端半：mount
                        │                  ┌───────────┴───────────┐
                        │                  ▼                       ▼
                        │            iframe + Worker          ShadowRoot
                        │            （执行，碰不到 DOM）      （宿主渲染树）
                        │                  │                       ▲
                        │                  └──渲染树 postMessage───┘
                        │
                        └── fallbackMarkdown ──► 工具结果文本（TUI / headless / 复制粘贴）
```

- **宿主半**（Node，ESM）：编译 DIL、落盘产物、维护版本。编译放这里是因为要持久化
  `fallbackMarkdown` 与 `stateKeys`，回放时不必重编。
- **客户端半**（浏览器，CJS bundle）：为了**渐进渲染**，客户端会用同一份编译器对
  **流式到达的部分源码**再做一次编译，边收边画。同一份代码两处调用，不是两套实现。

## 四个接缝（上游是独立应用，我们是插件）

上游 `vendor/dil-replica/` 是个 Node HTTP 服务 + 聊天页。接缝只有四处：

1. **流从哪来**：上游读 SSE（`{p,o,v}` 补丁）。我们读 DSH 工具参数的流式片段。
   → 客户端直接对累积的 `source` 前缀调编译器，不需要补丁通道。
2. **渲染到哪**：上游 `mount(container, tree)` 直接画 DOM。我们画进 **Shadow DOM**，
   主题变量穿透影子边界。
3. **状态往哪存**：上游 `POST /dil/view_state`。我们存产物层（`src/store/`）。
4. **token 从哪来**：上游 `dil.css` 自带色板。我们换成 `--dsw-alias-*`。宿主只暴露
   **14 个颜色 token**，间距/圆角/字号/阴影宿主没有，由渲染器自带的刻度决定。

## 线上契约

工具 wire name 保持 `artifact`；围栏语言 `dsh-artifact`；产物 id `art-<8hex>`。

`meta` 形状（客户端只认它，不读工具文本）：

```ts
interface ArtifactMeta {
  kind: 'artifact'
  engine: 'dil' | 'html'      // 渲染路径，决定客户端挂哪个视图
  action: 'create' | 'patch'
  id: string
  title: string
  version: number
  mode: 'inline' | 'wide'
  session: string
  sha256: string
  dil?: DilCompiled           // engine === 'dil'，形状见 src/dil/types.ts
  html?: string               // engine === 'html'
  render?: 'reload' | 'reconcile'   // html 路径：脚本是否变化
}
```

`DilCompiled` 的形状严格等于上游 `compile()` 的返回值，字段名不改。

工具文本（模型看到的那一行）保持一句话确认。`fallbackMarkdown` 是否随确认一起返回，
由 config 开关控制（默认开），因为它同时解决 TUI/headless 与复制粘贴。

## 接线顺序（等 A/B/C 的接口落地后机械执行）

1. `src/meta.ts`：加 `engine`、`dil`、`sha256`，`artifactMetaFrom` 按 engine 分支校验
2. `src/index.ts`：参数加 `source`（DIL）与 `engine`；`create` 调 `compileDil()`；
   `patch` 对 source 做文本替换后重编；`read`/`list` 走产物层
3. `src/registry.ts` → `src/store/`：进程内 Map 换成落盘实现，工具与客户端都读它
4. `src/client/index.tsx`：`tool.call.toolview` 视图与 fence 通道按 `meta.engine` 分派
5. `src/client/DilCard.tsx`（新）：Shadow DOM 宿主 + `mountDilView()`；
   流式期用 `source` 前缀编译做预览
6. 端到端：生成 → 原地 patch → 交互回注 → 重启后仍可 patch

## 验收

- `pnpm run check` 全绿（typecheck + build + 自有 vitest + 上游 98 个）
- 装进 desktop profile 后两半都激活：
  `client/Slots/listSubTree root=tool.call.toolview` 出现
  `{registrant:"dsh-genui", key:"artifact", active:true}`；
  `host/Tool/listTools` 出现 `artifact`
- 真实会话：卡片跟随明暗主题；改一个滑块后下一轮模型知道改成多少；
  重启 App 后旧产物仍可 patch；TUI 下看到降级 Markdown 而不是一行占位

## 已知风险

- 上游是 0★、1 天龄、Claude 协同生成的研究性仓库。我们接盘它的 bug，依据是它自带
  98 个测试，且其中包含对真实抓包的逐字保真断言。
- 协议是 `protocolVersion 14` 的快照，OpenAI 随时会改。协议细节必须封在
  `src/dil/` 与 `src/client/dil/` 里，不许渗到 UI 层。
- 宿主半改动的包元数据缓存在进程内，**装完必须重启 App**；客户端半可热重载。
