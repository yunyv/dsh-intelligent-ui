# dsh-genui

模型在对话里生成的是**可操作的界面**，不是描述界面的文字。一个工具（`artifact`）、两条渲染路径、一层落盘产物。

范围：DSH 桌面版 0.2.0-rc.2，desktop profile。

## 两条路径

| | 编译路径（`engine: "dil"`，默认） | 逃生舱（`engine: "html"`） |
|---|---|---|
| 模型写什么 | DIL 文档：正文 + `{@body …}` 声明 + 一个根 `<box>` | 自包含文档：`css` 再 `html` |
| 谁执行 | iframe 内**无 DOM Worker** 跑编译产物 | iframe 直接跑文档 |
| 谁渲染 | **宿主**接到渲染树，用原生 DOM 画成真界面 | iframe 自己画 |
| 拿到什么 | 主题免费、token 省、控件天生联动、结构先出 | 表达力无上限（3D、D3、自定义仿真） |

关键区分：**沙箱是执行容器，不是显示容器。** 编译产物在 Worker 里跑并且碰不到 DOM，吐出一棵渲染树交给宿主画。所以"卡片里的代码碰到宿主元素"在结构上不可能发生——不是被防住了，是没有路径。

## 安装

```sh
bash scripts/reinstall-desktop.sh
```

脚本会 build、pack 成 tarball、装进 desktop profile。**不要用目录链接安装**：链接会把源码树里仅供类型检查的 `node_modules/@deepseek-ai/*` 暴露给 Loader，Node 会解析到那些副本，而它们自己的传递依赖没装，导入直接抛 `Cannot find package`，整条 bundle 激活失败。

装完**必须重启 App**：Host 对 Loader specifier 的包元数据缓存在进程内，包括"这个包导不进来"这个否定结论。

## 状态

工程与测试已完成；**在运行中的 App 里尚未激活过**，因为激活需要一次重启，而重启会结束做开发的会话。

已验证的部分：

- `pnpm run check` 全绿：`typecheck` 三个工程 + `tsdown` 构建 + **330 个自有测试** + **98 个上游测试**
- 编译链路端到端跑通（在测试里）：`compileDil` → Worker → 渲染树 → renderer → Shadow DOM → 点击 → trigger → 新树 + `stateChanged`
- 客户端半以**构建产物** `lib/client.js` 走真实 `__ModuleLoader__.load` 契约加载，断言注册到 `tool.call.toolview` 的 `artifact` 键
- 产物层用**两个真实 OS 进程**验证：A 进程写到 v3，B 进程读回同一 sha 并续写到 v4

未验证的部分：真实会话里生成一张卡片、跟随主题、交互回注、重启后仍可 patch。重启后按下节验收。

## 重启后验收

```
cordis_inspect_query client/Slots/listSubTree root=tool.call.toolview
  → occupants 里要有 {registrant:"dsh-genui", key:"artifact", active:true}
cordis_inspect_query client/Slots/listSubTree root=sidebar.right.pane.tab
  → 要有 {registrant:"dsh-genui", key:"dsh-genui:panel", active:true}
cordis_inspect_query host/Tool/listTools
  → 要有 name:"artifact"，描述里提到 `source` 与 `engine`
cordis_inspect_query host/Config listConfigs name=dsh-genui
  → 应有四个配置项
```

然后在真实会话里走一遍：

1. 让它做一个能调参的东西（例如「做个能改人数和付费周期的团队订阅成本计算器」）。卡片应当出现在它写标记的那一行，跟随明暗主题。
2. 改一个滑块，点「把当前设置交回对话」。下一轮它应当知道你改成了多少。
3. 再让它改一处（例如换个费率）。应当是**原地重编**，你拖过的滑块位置不丢。
4. **再重启一次 App**，回到这个会话，让它再改同一个产物。这条验证的是落盘产物层——前身插件在这里是坏的。
5. TUI / headless 下同一个工具调用应当显示降级 Markdown，而不是一行占位。

## 开发循环

只改 `src/client/**` 时不用重启 App，把构建产物覆盖进 profile 的安装副本即可，浏览器会重新装载：

```sh
pnpm run build
cp lib/client.js ~/.dsh/profiles/desktop/node_modules/dsh-genui/lib/client.js
```

宿主侧（`src/*.ts`）改动需要重装 + 重启。

拿不到浏览器控制台时，用 `cordis_inspect_query client/Slots/listSubTree root=tool.call.toolview` 看座位有没有被占用。

## 配置

`storeRoot`、`maxSourceBytes`（默认 2 MB）、`maxArtifactsPerSession`（默认 40）、`includeDegradedText`（默认开）。

## 产物层

落盘在 `~/.dsh/storages/dsh-genui/`，数据模型抄 [coda0HQ/open-artifacts](https://github.com/coda0HQ/open-artifacts)（MIT）：

```text
index.json                              目录，永不存内容
artifacts/art-xxxxxxxx/versions/
  v0001.html  v0001.json                内容与元数据分家
  v0002.html  v0002.json
```

**不可变追加版本**，每条带 `versionNumber` / `parentVersionId` / `contentSha256` / `contentBytes` / `changelog`；`restore` 生成新 head 而不改历史；`expectedLatestVersion` 做乐观并发；`read(id, N)` 取任意历史版本。

写序是「内容 → sidecar → 原子替换索引」，读路径与写路径都**以磁盘为准**，所以崩在中间不会让 head 指偏。

## 工程

```
src/tool.ts              工具的全部判断，不 import 任何 @deepseek-ai/*，所以能被单测直接驱动
src/index.ts             harness 绑定：Config、产物根目录、注册、呈现钩子
src/dil/                 移植来的 DIL 流式编译器
src/store/               落盘产物层
src/client/dil/          沙箱、渲染树渲染器、补丁模型、状态回环
src/client/fence.tsx     围栏认领 + 按 engine 分派
assets/genui-skill.md    DIL 作者契约，作为 bundled skill 按需加载
vendor/dil-replica/      上游原样副本（出处与 commit 见 PROVENANCE.md）
```

第三方代码只放在 `vendor/`，从不编辑；改动一律发生在 `src/`。

## 已知限制

- 编译链路**不在浏览器里编译**：编译器用 `node:vm` 做语法校验，进了浏览器包会在运行时炸。所以文档写出过程中只显示一行「正在生成界面」，落定后界面一次出现。这是取舍，不是遗漏。
- 协议是 ChatGPT DIL `protocolVersion 14` 的一个快照，上游随时会改。协议细节封在 `src/dil/` 与 `src/client/dil/` 里。
- 上游 `vendor/dil-replica` 是 0★、1 天龄的研究性仓库，我们接盘它的 bug；依据是它自带 98 个测试，其中含对真实抓包的逐字保真断言。
- 逃生舱的 `jsFunctions` / `jsExpressions` 分步执行未采纳：一个脚本加上现有的「脚本变了就重载」规则够用。
