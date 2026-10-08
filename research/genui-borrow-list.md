# 生成式 UI 引入清单

范围：DSH 桌面 0.2.0-rc.2，desktop profile。目标插件基底是本地工程 `dsh-artifacts-live`。
本文件只记"拿什么、干什么用、放哪条路径"，不记论证过程。抓取时间：2026-10-08。

架构前提（见 `intelligent-ui-vs-claude.md`）：一个插件、一个工具、两条渲染路径。
- **快车道**：模型输出受约束组件描述 → 原生 React 渲染进对话流（Shadow DOM 隔离，不进 iframe）。
- **逃生舱**：模型输出自包含 HTML → 沙箱 iframe。

## 0. 决定性事实

**已有直接把 ChatGPT Intelligent UI 复刻出来的开源项目**：[0xcro3dile/answerui](https://github.com/0xcro3dile/answerui)
（MIT，29 commits，2026-10-08 发 v0.1.1）。作者原话：

> It's built on OpenUI (MIT), which handles the streaming and the components. I added the
> provider setup, Ollama detection, the CLI, prompt rules that make the tools actually
> recalculate, and the tests.

即：协议、组件目录、提示词生成、流式解析、非法片段丢弃 —— 全部由 OpenUI 承担。
作者自陈局限：指令约 10k token（需 `OLLAMA_CONTEXT_LENGTH=16384`）、小模型吃力、无 3D 无动画。

**没有任何一个项目可以直接 fork 成我们的插件**：它们都是自带后端与聊天界面的独立应用
（Next.js / Turborepo）。可复用的是**引擎包**，不是应用。

## 1. 快车道：直接引入 OpenUI 作渲染器

[thesysdev/openui](https://github.com/thesysdev/openui) —— MIT，10.1k★。
装 `@openuidev/react-lang`（目录定义 / 解析器 / 渲染器 / 提示词生成）+ `@openuidev/react-ui`（预置库）。

它替我们解决四件事：
1. 组件契约（Zod schema）→ **提示词由目录自动生成**，加组件提示词自动跟上。
2. 流式渲染器：边收边出 partial 树。
3. **非法片段丢弃** —— 模型 hallucinate 组件名不会崩页。
4. **间距/尺寸是枚举档**，模型无法发明 13px —— 版式下限的来源。

用 `openuiChatLibrary`（root = `Card` 垂直容器，专为 chat 回复优化），不用 `openuiLibrary`
（root = `Stack`，面向 dashboard）。

内置组件面（覆盖我们需要的版式）：Content（`CardHeader` `CallOut` `MarkDownRenderer` `CodeBlock`）、
Layout（`Tabs` `Accordion` `Carousel` `SectionBlock` `Steps`）、Charts（8 种）、`Table`、
Forms（`Form` `Input` `Select` `DatePicker` `Slider` `CheckBoxGroup` `RadioGroup` `SwitchGroup`）、
Interactive（`Button` `ListBlock` **`FollowUpBlock`** —— 回传为用户消息，即"按钮即追问"）。

## 2. 逃生舱：照抄 CopilotKit 的参数顺序

[CopilotKit/OpenGenerativeUI](https://github.com/CopilotKit/OpenGenerativeUI) —— MIT，1,566★。

工具参数按固定顺序流式到达：

```
initialHeight → placeholderMessages → css → html → jsFunctions → jsExpressions
```

理由（官方原文）：CSS 先到，界面永远不会先渲染出无样式的裸 HTML；表达式最后到，
用户看着每个行为逐个生效。

四条可搬的机制：
- 流式期间用 **Idiomorph** 把每次更新变形进预览帧（不闪）。
- `html` 完成后才启动最终沙箱帧，注入**共享设计系统 CSS** + CDN importmap，
  依次跑 `jsFunctions`、再逐条跑 `jsExpressions`。
- 帧内 `ResizeObserver` 自动撑高。
- **sandbox functions**：Zod 校验的宿主回调（`sendPrompt` / `openLink`），生成 UI 可调回宿主。
- **`designSkill`**：设计系统作为一份 skill 注入模型上下文 —— 这是"精美"的落地形式，
  不是把规则写在文档里。

参考：[docs.copilotkit.ai/generative-ui/open-generative-ui](https://docs.copilotkit.ai/generative-ui/open-generative-ui)

## 3. 设计系统（两条路径共用一份 token）

| 拿什么 | 许可 | 干什么用 | 放哪 |
|---|---|---|---|
| **Radix Colors v3** | MIT | 12 步**用途语义**色阶（1–2 背景 / 3–5 组件背景 / 6–8 边框 / 9–10 实心 / 11–12 文本），11/12 步按 **APCA Lc 60/Lc 90** 保证对比度。模型选"用途"而非 hex | 宿主 + iframe |
| **Open Props** | MIT | 数值骨架：阴影 6 档、调过的缓动曲线、字号/间距模数，以及 `--motionOK` / `--OSdark` / `--forcedColors` 能力开关 | 宿主 + iframe |

**没有合并单文件可用**：`@radix-ui/colors` 只有逐色文件（`blue.css` / `blue-dark.css`，各约 1KB），
`dark.css` 与 `radix-colors.css` 均 404。Open Props 单文件
`cdn.jsdelivr.net/npm/open-props@1.7.23/open-props.min.css` = 29,566 B（实测 200）。

## 4. 图表

| 场景 | 用 | 依据 |
|---|---|---|
| 逃生舱默认 | **Observable Plot**（ISC） | `@observablehq/plot@0.6.17/dist/plot.umd.min.js` = 209,183 B，无依赖、无网络请求；配色继承 `currentColor`、背景默认透明、**CSS 特异性为 0** 可被宿主覆盖；有 title 时自动包 `<figure>` |
| 逃生舱大数据量 | ECharts 6（按需） | v6 重做默认主题为 design tokens；但独立主题文件仍是旧语言，新默认只在 npm 包内 |
| 快车道 | Recharts 底层 + **Tremor 视觉规则** | 见下 |

**不直接用默认值的**：Recharts（灰网格 + 蓝紫 + 圆角柱，是"AI 味"来源）、nivo（默认渐变阴影）、
visx（自述不是图表库，无默认样式）。

**必须抄的一条工程规则（来自 shadcn/ui chart）**：图表容器渲染一个 `<style>`，把配置变成
`--color-*` CSS 变量，**并用一层选择器重写第三方 SVG 内部 class**（轴刻度 → `muted-foreground`、
网格 → `border/50`、关掉 focus outline）。不管用哪个图表库，这层容器都必须有。

## 5. 版式骨架

**不存在免费的"AI 生成报告版式"整块库。** timeline / compare / FAQ / pricing / bento / KPI
这些分类基本落在付费或半免费的 shadcn 块市场（Shadcn Studio / shadcnblocks / Shadcn Space /
Tailark / ReUI）。免费 MIT 的只有三个：

- **shadcn/ui 官方 blocks**（MIT，125k★）—— 官方块只有 dashboard / sidebar / login 一档，
  但它的 token 规则要抄：`--chart-1..5` **只有 5 个系列色**是刻意的决定（约等于一个读者能同时
  记住的分类数，逼你聚合而不是画 14 条线）；`--radius` 派生整套 radius scale。
- **Tremor Blocks**（MIT，300+ 块，Vercel 收购后全部免费开源）——
  块分类正好命中需求：**KPI Cards 29、Chart Compositions 15、Chart Tooltips 21、Bar Charts 12**。
  设计信条官方自述 **"show the data, hide the chrome"**：默认砍掉图表容器的边框/轴线/网格线，
  只留数据和一条 baseline。**只抄源码结构与 CSS，不引依赖。**
  注意仓库是 `tremorlabs/tremor-npm`（16,483★），不是 `tremorlabs/tremor`（3,650★）。
- **blocks.so**（MIT）—— 60+ 块，Stats 15 / Sidebar 6 / Tables 5。抄 stats 结构。

**动作项：自己写 8 个版式的结构 + CSS 规范**（并排对比 / 时间线 / 步骤流 / 指标墙 / 带侧栏详情 /
问答折叠 / 日程 / 价格对比），把上表的视觉规则写成硬约束。比引入付费块库可控。

## 6. 容器层：让块安全地进对话流

[**AI Elements**（vercel/ai-elements）](https://github.com/vercel/ai-elements) —— MIT，2,465★。
`Conversation`（StickToBottom）`Message` `MessageResponse` `Reasoning` `Sources` `Tool` `PromptInput` `CodeBlock`。

价值点：`MessageResponse` 专门处理**流式部分内容不跳动**，`Conversation` 做"贴底但不打断用户上滑"。
**这正是把可视化塞进对话流最容易翻车的地方（流式时布局抖）。** 快车道直接抄这一层。

同类的 prompt-kit 不优先（AI Elements 由 Vercel 维护且走 shadcn registry 安装）。

## 7. 字体

**用 Fontsource CDN，不用 Google Fonts API。** 理由：版本锁定（Google 会静默推更新）、
可离线、可按 subset 只取 latin；woff2 URL 全在 `cdn.jsdelivr.net` 上，命中白名单。

实测路径：
- `cdn.jsdelivr.net/fontsource/css/geist@latest/latin.css` = 8,530 B
- `.../geist-mono@latest/latin.css` = 8,800 B
- `.../ibm-plex-sans@latest/latin.css` = 6,970 B

**按语义分档，模型选档不选字体名**（避免收敛到 Inter，也避免每次随机换字体）：
- 数据型：`IBM Plex Sans` + `IBM Plex Mono`（同源双体，字号对齐）
- 叙述型：`Geist Sans` + `Geist Mono`（比 Inter 少一分默认感）

**没有**"专为 AI 生成界面准备、按语义分档的免费开源字体清单"。Fontjoy / Fontpair 是给人用的。

## 8. 反 AI 套路：做成渲染前闸门

**Gesso anti-slop** —— MIT，91★。规则全文：
`raw.githubusercontent.com/Gesso-Build/skills/main/skills/anti-slop/references/rules.md`

- **73 条可执行规则**，每条有确切阈值 + 理由 + before/after + 多数带幂等 auto-fix；
  分 FIX / GATE / BASE / FLAG 四档；severity 分带：1–2 孤立 tell、3–6 有共同成因的模式、7+ 模板级。
- `check` 可使构建失败（pass 意味着零 FIX/GATE 命中）；`fix --write` 只改不需人类决策的部分。
- 逐元素豁免：`data-slop-allow="rule-id"` / CSS `--slop-allow`。
- 覆盖 color（gradient-text、十个 indigo-violet hex、252–296° 饱和紫带）、motion、copy
  （em-dash、裸大数字、`99.9%`/`10x`/"supercharge, seamlessly"、apologetic error copy）、
  imagery、quality、以及 masthead-eyebrow / live-clock-eyebrow / viz-redundant-scale。
- **关键性质：它静态解析"模型生成的 HTML/CSS 文本"，从不执行标记**，所以能放在渲染之前。

**这一条直接对着逃生舱的输出物，是六类里唯一能进 CI 的。**

## 9. 动效

[**emilkowalski/skills**](https://github.com/emilkowalski/skills) —— MIT，44.2k★，动效判断写成可执行规范：

- **频率表决定"要不要动"**：100+ 次/天（快捷键、命令面板）→ **永不动画**；几十次/天（hover、列表导航）→
  去掉或大幅削减；偶发（modal / drawer / toast）→ 标准动画；罕见/首次 → 可加惊喜。
- **缓动表**：进入/退出 `ease-out`；屏内移动 `ease-in-out`；hover/变色 `ease`；持续运动 `linear`。
  **UI 永不用 `ease-in`。**
- **时长表**：按钮按压 100–160ms；tooltip/popover 125–200ms；dropdown 150–250ms；modal 200–500ms。
  **规则：UI 动效 < 300ms。**
- **只有 transform 和 opacity 可动画**；高频触发用 CSS transition（可中断），手势用 spring。
- 具体值：`--ease-out: cubic-bezier(0.23,1,0.32,1)`、`--ease-drawer: cubic-bezier(0.32,0.72,0,1)`、
  按压 `scale(0.97)`、**永不用 `scale(0)` 入场**（用 0.93+）。

[FormKit **AutoAnimate**](https://github.com/formkit/auto-animate) —— MIT，13,928★。
零配置，父元素一句话，只在子节点增/删/移三种事件上动。**入口在根目录不是 dist**：
`cdn.jsdelivr.net/npm/@formkit/auto-animate@0.10.0/index.min.js` = 8,406 B（实测 200）。
逃生舱里"列表/卡片增删不瞬跳"用 8KB 解决。

**不要为了一个 fade 装动效库。** 能 CSS 就 CSS；只有 exit 动画、布局动画、手势驱动才引 motion
（`motion@14.0.0` UMD = 143,867 B）。

## 10. Token 层的硬校验（比事后 lint 更根本）

规则来源：
- `@atlaskit/stylelint-design-system` —— 强制 color/spacing 走 `var(--ds-*)`，禁止硬编码 hex/px
- `stylelint-design-token-guard` —— 检测 hex/rgb/hsl 硬编码并可 autofix 成 token

**动作项：把"禁止硬编码 hex / 只在 token 白名单内取值"做成快车道渲染器输出前的硬校验。**
配合 Radix 的步进语义，写成渲染器的硬约束：文本只用 step 11/12、边框只用 6–8、实心只用 9/10。
对比度问题在设计层就消失，不需要跑检查器。

## 11. 明确没找到 / 未验证

1. **不存在**免费开源的"AI 生成报告版式"整块库（见 §5）。
2. **没有**按数据型/叙述型语义分档的免费开源字体清单（见 §7）。
3. **Salesforce Lightning**：未找到可独立消费的纯 CSS token 单文件包，未验证其 npm 形态与许可。
4. **`avoid-ai-design` 扫描器**：仅见于二手文章，未找到官方仓库，不作为结论。
5. **"Chart.js 默认偏平庸"**：未找到高质量可引用的对照评测来源，不作为结论。
6. `github.com/google/A2UI` 现已 301 → **`a2ui-project/a2ui`**（Apache-2.0，16,625★）。
   它本身不含整块版式，web 端无官方高质量 React 渲染器（社区实现 17–98★）。
   **作为版式骨架是同类最弱一档；只有为了协议对齐（未来接 AG-UI / CopilotKit）才值得考虑。**
7. `@openuidev/browser-bundle` 体积：`dist/openui-bundle.min.js` 3,623,579 B +
   `dist/openui-styles.css` 317,403 B（官方称首次约 650KB gzip）。
   **只在"逃生舱也用 OpenUI Lang 而非裸 HTML"时才值得装。**
8. OpenUI / json-render / Radix / Open Props / Observable Plot **均未在本机安装实测**，
   API 形状取自官方文档与 README，版本未钉死。
9. GitHub API 在调研末段触发未认证限流（60/hr），部分 star 数取自前一次成功实读。

## 12. CDN 路径坑（已实测）

| 包 | 坑 | 正确路径 |
|---|---|---|
| `@radix-ui/colors` | **无合并单文件**（`dark.css`、`radix-colors.css` 均 404） | 逐色 `blue.css` / `blue-dark.css`（133 个文件） |
| `@formkit/auto-animate` | 入口不在 `dist/`（404） | 根目录 `index.min.js` |
| `@openuidev/browser-bundle` | — | `dist/openui-bundle.min.js` + `dist/openui-styles.css` |
