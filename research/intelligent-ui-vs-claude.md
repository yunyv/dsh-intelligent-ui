# Intelligent UI / Claude 侧同类能力：机制与可借鉴项

范围：DSH 桌面 0.2.0-rc.2，desktop profile。目标对象是已装的两个可视化插件
`@nagi-ovo/dsh-visualize@0.1.4` 与本地 `dsh-artifacts-live@0.1.0`。
抓取时间：2026-10-08。

## 1. ChatGPT Intelligent UI 的机制（官方口径）

原文关键句（决定我们该抄什么）：

> We built a library of native, streamable components, along with a compiler that
> processes the interface as the model generates it. … The compiler allows the
> interface to appear progressively as the model generates it, without waiting for
> the entire response to be complete.

> We expanded our training methods to help the model make thoughtful decisions about
> content, layout, visuals, and interaction. This included evaluating the interfaces
> it creates for clarity, usefulness, and completeness.

出处：<https://openai.com/index/gpt-6-for-everyone/>；帮助中心 <https://help.openai.com/en/articles/20001598-intelligent-ui-in-chatgpt>

可操作的三条结论：

1. **受约束的组件目录 + 编译器**，不是自由 HTML。模型只能在原生组件库里组合。
2. **设计判断力在模型侧**（训练 + 评估），不是靠 skill 提示词补出来的。
3. 产品化配套三件：**可渐进渲染**、**组件级状态保留**（清单类组件刷新会话后仍在，不跨会话）、
   **用户偏好档位**（Personalization → Layout and Visuals → Simple；Custom Instructions）。
   另有两条边界：Work 标签页与 Voice 不支持；无独立用量配额。

## 2. Claude 侧的两件事

| | Artifacts | Agent Skills |
|---|---|---|
| 形态 | 自由 HTML/React，沙箱 iframe 内运行 | 按需加载的正文 + 资源目录 |
| 机制 | 自包含单文件；Claude Code 版由完整会话上下文生成**稳定 URL 的活页面**，内容变化同 URL 更新并留版本历史，默认私有、团队内可分享 | `web-artifacts-builder`：脚手架 React18+TS+Vite+Parcel+Tailwind+shadcn/ui（40+ 组件），开发后**打包成单个自包含 HTML** |
| 设计纪律 | 无（自由发挥） | `frontend-design`：两遍法（先出 token/布局方案 → 对照 brief 自查是否落入通用默认 → 再写代码），并逐条点名"AI 套路"（居中布局、紫色渐变、统一圆角、Inter、eyebrow 全大写标签、`A · B · C` 元信息串等） |

出处：<https://github.com/anthropics/skills>、
<https://github.com/anthropics/skills/tree/main/skills/web-artifacts-builder>、
<https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md>、
<https://the-decoder.com/anthropic-brings-artifacts-to-claude-code-letting-teams-share-live-pages-from-coding-sessions>

一句话：Claude = 不受约束的 HTML + skill 提供的工具链 + 写死的设计品味契约。
与 OpenAI 的受约束路线互补，不是同一套东西。

## 3. 现成开源实现（可直接借规范，不必借框架）

| 项目 | 许可 / 热度 | 机制要点 | 对本项目的可借之处 |
|---|---|---|---|
| [OpenUI](https://github.com/thesysdev/openui) | MIT | OpenUI Lang：行式紧凑语言（`id = Expr`），流式逐行解析；`createLibrary` 从组件目录**生成系统提示词**；`<Renderer response library isStreaming onAction onStateUpdate onError toolProvider>`，`onError` 回结构化错误供模型自纠；`@openuidev/browser-bundle` 提供 CDN/iframe 免构建嵌入 | 线协议形态；提示词由目录生成；结构化错误→自纠闭环；**browser-bundle 可直接塞进我们现有沙箱帧当内层渲染器** |
| [json-render (Vercel Labs)](https://github.com/vercel-labs/json-render) | Apache-2.0，18.5k★ | `defineCatalog` + `catalog.prompt()`；`createSpecStreamCompiler().push(chunk)` 边收边出 partial spec；动态属性 `$state`/`$cond`/`$template`/`$computed`；内置 `setState` action、`watch`、`visible`；36 个 shadcn/ui 组件；渲染目标含 React/Vue/Svelte/Solid/RN/**Ink 终端**/MCP | SpecStream 编译器；目录→提示词；动态属性与 action 模型；`@json-render/ink` 提示 TUI 侧可行 |
| [A2UI (Google)](https://github.com/google/A2UI) | Apache-2.0，16.6k★ | 声明式 JSONL 三信封 `surfaceUpdate` / `dataModelUpdate` / `beginRendering`；扁平组件列表 + ID 引用；客户端维护**受信任组件目录**；"safe like data, expressive like code"；可增量更新 | 信封语义与增量更新；采用标准即获得互操作；Web 渲染器需自写 |
| [CopilotKit OpenGenerativeUI](https://github.com/CopilotKit/generative-ui) | 开源 | 无组件目录，模型直接产 HTML/CSS/JS，流进沙箱 iframe：**样式先应用 → HTML 渐进流入 → JS 逐表达式执行**；可选把宿主函数暴露给生成 UI（sandbox functions） | 渐进内层执行顺序；宿主函数回注（让卡片能直接调 DSH 工具） |
| [Tambo](https://github.com/tambo-ai/tambo) | 开源 | 组件用 Zod 注册，schema 变成 LLM tool 定义，props 边生成边流入 | 属性级流式；组件即工具 |
| [openai/mcp-extensions](https://github.com/openai/mcp-extensions) | Apache-2.0 | 把 ChatGPT 专有能力加在 MCP 上：侧栏入口、文件类型自定义查看器、composer @ 提及、扩展表单 | 第三方插件贡献 UI 的形状（我们暂无对位） |

分档（行业通行分类）：受约束生成（A2UI / OpenUI / json-render / Tambo / CopilotKit 受控档）与
不受约束生成（Claude Artifacts / MCP Apps / CopilotKit OpenGenUI）。
我们两个插件都落在**不受约束**那一档。

## 4. 我们现有两个插件的实际覆盖

### `@nagi-ovo/dsh-visualize` 0.1.4

- 宿主 `visualize` 工具，`create` / `update` 两动作；**fragment 直接作为工具参数**
  → 客户端 `StreamingPreview` 能在模型还在写参数时就开始渲染。
- 产物落 `viz/<slug>-<hash>.html`（内容寻址，重复渲染复用文件名）；完整 fragment 内嵌在
  `output.presentationMeta` → 回放不依赖文件存活。
- 客户端：沙箱 iframe（CSP 白名单 7 个 CDN）、主题桥（`--dsh-art-*`）、`TurnCards` 在折叠时
  于答末尾复显。
- 自带 `visualize` skill：`references/design.md` + `references/charts.md`（Chart.js 优先）
  ——已经是**一份小型设计品味契约**。
- 明写限制：卡片内按钮不能向主对话发 follow-up；TUI / headless 退化为普通工具结果行。

### `dsh-artifacts-live` 0.1.0（本地）

- 会话内注册表 `art-<8hex>`，`create`/`patch`/`read`/`list`/`destroy`。
- **一份产物一个 frame**；流式期经 postMessage 泵入同一帧，落定重载一次，
  此后仅当 `<script>` 变化才重载，否则索引对齐做 DOM 协调 → DOM、输入值、内存变量都保留。
- `localStorage`/`sessionStorage` 内存 shim + 跨重载快照回灌。
- 交互回注：卡片 chrome 按钮取 `window.__dshArtifactData` + 表单值 + 点击过的按钮，
  经 `inputActions.insertText` + `submit()` 变成一条用户消息。
- 位置由正文围栏 `dsh-artifact <id>` 声明 → 渲染在正文中间，不进折叠过程组。
- 右侧栏「产物」面板列出本会话全部产物。
- 已知缺口：注册表仅进程内存（Host 重启后旧卡片可见但不可 patch）；无版本历史；无稳定链接/分享。

## 5. 差距矩阵

| 能力 | ChatGPT Intelligent UI | Claude | visualize | artifacts-live |
|---|---|---|---|---|
| 受约束原生组件目录 | ✅ 核心 | ✗ | ✗ | ✗ |
| 编译器 / 结构先出、数据后填 | ✅ 核心 | ✗ | 部分（裸 HTML 前缀泵入） | 部分（同左 + postMessage） |
| 自由 HTML 表达力 | ✗（无代码执行） | ✅ | ✅ | ✅ |
| 组件级状态保留 | ✅（线程内） | 靠代码自行实现 | 帧重载即丢 | ✅ shim + 回灌 |
| 动作回注对话 | ✅ 按钮即 follow-up | ✗（靠复制） | ✗ | ✅（用户手动触发） |
| 偏好档位（少图 / 简单） | ✅ | ✗ | ✗ | ✗ |
| 设计品味契约 | 训练内建 | ✅ frontend-design | ✅ 小型 | 无 |
| 设计自评/自纠环 | ✅ 训练期评估 | ✅ 两遍法自查 | ✗ | ✗ |
| 产物身份跨进程 | 会话对象 | ✅ 持久 + 版本历史 | 路径（文件在） | ❌ 内存 |
| 稳定链接 / 分享 | 线程内 | ✅ Claude Code Artifacts | 文件路径 | ✗ |
| 第三方贡献 UI | ✅ Apps SDK / MCP | MCP Apps | ✗ | ✗ |
| TUI / headless 呈现 | n/a | n/a | ❌ 退化 | ❌ 退化 |

## 6. 三条可选主路线

**A. 加一层受约束声明式路径（OpenAI 那条）**
在现有自由 HTML 之外，新增组件目录 + 线协议 + 宿主页内原生渲染（不进 iframe）。
收益：结构先出的渐进渲染、主题与可访问性免费、无代码执行的安全面、token 更省、
**组件可声明动作**直接回注对话。代价：需要设计目录、提示词生成、双路径分流纪律。

**B. 深化自由 HTML 路径（Claude 那条）**
补：持久化产物对象 + 版本历史 + 稳定标识跨重启；`web-artifacts-builder` 式脚手架/
打包技能；引入 `frontend-design` 品味契约；加自评环。
收益：质量与"像产品"程度立竿见影，风险低。代价：不解决受约束档的独有能力。

**C. 只补短板**
把已知缺口补齐（visualize 的交互回注、artifacts-live 的持久化、偏好档位），不动架构。

**D. 第三方 UI 贡献面**（组件目录插件化 / MCP Apps 对位）——依赖 A 先落地，后期。

## 7. 未验证事项

- OpenUI / json-render / A2UI 三者的包在本机未安装、未实测；其 API 形状取自官方文档与
  README，版本未钉。
- `@openuidev/browser-bundle` 的 CDN 落地域名未确认，是否落在现有 CSP 白名单内未知。
- DSH 0.2.0-rc.2 是否存在可直接容纳"宿主页内原生组件渲染"的座位（非 iframe）未验证；
  已知槽位里 `conversation.chat.turnTail`、`sidebar.right.tab.document` 等需逐个实测。
