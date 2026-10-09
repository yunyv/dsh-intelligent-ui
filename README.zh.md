# dsh-intelligent-ui

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)
[![tests](https://img.shields.io/badge/tests-442%20passing-brightgreen)](#开发)

**让模型在对话里直接写出可操作的界面，而不是描述界面的文字。** 这是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个插件。

把 ChatGPT 所说的 **Intelligent UI**（内部代号 *DIL*）和 Claude 所说的 **Artifacts** 那套做法开源出来：模型的回答不再是"关于一个仪表盘的文字"，而**就是**那个仪表盘。能拖的滑块、能拨的开关、当场重算的数字（不发起第二次模型调用），以及一张模型可以原地改写、而你拖过的位置不丢的卡片。

全部内容是一个工具（`artifact`）、两条渲染路径、一层落盘产物。

> 检索关键词：DSH 插件 · DeepSeek Harness 插件 · 生成式 UI · GenUI · ChatGPT 智能 UI · Claude 产物 Artifacts · 声明式 DSL · Worker 沙箱 · 原生 DOM 渲染树 · 产物版本历史

## 这是什么

要一个你平时只能"读到"的东西——比如「做个能改席位和付费周期的订阅成本计算器」——回答**本身**就是一个能用的计算器。模型写一份很小的声明式文档，DSH 编译并在沙箱里执行它，宿主接着用原生 DOM 把结果画出来：真控件、宿主自己的字号与配色、明暗两套主题都正确。

由此得来三件事，而这三件就是全部意义：

- **你能操作这个回答。** 输入可改的图表、能勾的清单、能调的配置——而不是它们的截图。
- **它一直是对的。** 你让它改一处，它就地改写同一个产物。版本历史意味着你刚才在看的那一版还在盘上。
- **它活得比会话长。** 产物落盘，所以上周做的卡片今天仍然可以被原地改写，App 重启也一样。

## 两条路径

| | 编译路径 `engine: "dil"`（默认） | 逃生舱 `engine: "html"` |
|---|---|---|
| 模型写什么 | DIL 文档：正文 + `{@body …}` 声明 + 一个根 `<box>` | 自包含文档：`css` 再 `html` |
| 谁执行 | 帧内一个**无 DOM 的 Worker** 跑编译产物 | 帧自己跑文档 |
| 谁渲染 | **宿主**接到渲染树，用原生 DOM 画 | 帧自己画 |
| 拿到什么 | 主题免费、上行 token 省、控件天生联动、结构先流出来 | 表达力无上限（canvas、WebGL、D3、自定义仿真） |

关键区分：**沙箱是执行容器，不是显示容器。** 编译产物跑在一个碰不到 DOM 的 Worker 里，吐出一棵渲染树交给宿主画。所以"卡片里的代码够到宿主的元素"不是**被防住了**，而是**没有路径**。

## 安装

```sh
dsh plugin --profile desktop add github:yunyv/dsh-intelligent-ui
```

装完**必须重启 App**。构建产物已经提交进仓库，所以从 git 安装不需要任何构建步骤，也不需要授予构建权限。

想锁定一个确切的产物，可以走 tarball：

```sh
dsh plugin --profile desktop add ./dsh-intelligent-ui-0.1.0.tgz
```

开发用 checkout：

```sh
git clone https://github.com/yunyv/dsh-intelligent-ui && cd dsh-intelligent-ui
pnpm install && pnpm run check
bash scripts/reinstall-desktop.sh
```

**不要用目录链接安装。** 链接会把源码树里仅供类型检查的 `node_modules/@deepseek-ai/*` 暴露给 Loader；Node 解析到那些副本，而它们自己的传递依赖并没有装，导入直接抛 `Cannot find package`，整条 bundle 激活失败。

## 用起来

不需要配置。你只要要一个可交互的东西，模型就会去用这个工具。一份 DIL 文档长这样——正文、声明的状态、然后一棵树：

```
{@body const [seats,setSeats] = DIL.useState(5)}
{@body const [yearly,setYearly] = DIL.useState(false)}
{@body const total = 200 * (yearly ? 10 : 12) * seats}
<box gap={4}>
  <title size="lg">团队订阅成本</title>
  <slider label="席位" value={seats} onChange={setSeats} min={1} max={50}/>
  <checkbox checked={yearly} onChange={setYearly}>按年付费</checkbox>
  <card>
    <caption>每年合计</caption>
    <title size="xl" tabularNums>¥{total.toLocaleString()}</title>
  </card>
</box>
```

（DIL 只借用了花括号，它不是 JavaScript 的模板语法。`¥` 是字面量，`{total.toLocaleString()}` 才是插值。）

作者契约——完整的组件清单、让一份文档真的跑得起来的那些规则——作为 bundled **skill** 随包分发，所以它只在真的要写界面的那一轮才加载，而不是躺在每一次请求里。说 `skill genui` 就能读到。

卡片出现在哪里也归模型控制：它写一个语言标记为 `dsh-artifact`、内容只有产物 id 的围栏块，帧就挂载在回答里的那个位置。

## 它是怎么工作的

```
src/tool.ts            工具的全部判断；不 import 任何 @deepseek-ai/*，所以测试能直接驱动它
src/index.ts           harness 绑定：Config、产物根目录、注册、呈现钩子
src/dil/               移植来的 DIL 流式编译器（解析、代码生成、流式边界、降级投影）
src/store/             落盘产物层
src/client/            浏览器半：围栏认领、按 engine 分派、侧栏面板
src/client/dil/        沙箱、渲染树渲染器、补丁模型、状态回环
assets/genui-skill.md  DIL 作者契约，作为 bundled skill 按需加载
vendor/dil-replica/    上游原样副本（出处见 PROVENANCE.md）
```

编译器是**流式**的：喂给它一份还在增长的文档前缀，它报出哪些组件已经闭合、哪些还开着，所以卡片能在模型还在写的时候就出现。容错也不是全有全无——一个没写完的元素被丢掉，它周围的照样渲染。

一个产物可以同时在屏上出现两次（对话里的卡片 + 右侧栏），**两份共享同一份状态**，所以在任何一边拖控件，另一边跟着走。

## 产物层

落盘在 `~/.dsh/storages/dsh-intelligent-ui/`，数据模型抄 [coda0HQ/open-artifacts](https://github.com/coda0HQ/open-artifacts)（MIT）：

```text
index.json                               目录，永不存内容
artifacts/art-xxxxxxxx/versions/
  v0001.html  v0001.json                 内容与元数据分家
  v0002.html  v0002.json
```

版本**只追加，绝不改写**。每条带 `versionNumber` / `parentVersionId` / `contentSha256` / `contentBytes` / `changelog`；`restore` 生成新 head 而不动历史；`expectedLatestVersion` 做乐观并发；`read(id, N)` 取任意历史版本。

写序是「内容 → sidecar → 原子替换索引」，读路径与写路径都**以磁盘为准**，所以崩在中间也不会让 head 指到不存在的字节。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `storeRoot` | `''` | 产物目录；空表示 `~/.dsh/storages/dsh-intelligent-ui` |
| `maxSourceBytes` | `2000000` | 超过这个体积的文档直接拒绝 |
| `maxArtifactsPerSession` | `40` | 单会话产物上限 |
| `includeDegradedText` | `true` | 附加纯文本投影，供模型回读 |

## 开发

```sh
pnpm run check     # typecheck（三个工程）&& 构建 && vitest && 上游自带的测试
```

**442 个测试全绿：自有 344，上游移植 98。** 浏览器半是对着**构建产物** `lib/client.js` 测的，走真实的 `__ModuleLoader__.load({ id, factory })` 契约——所以那里的注册或渲染失败是真缺陷，不是测试脚手架的假象。

只改 `src/client/**` 时可以不用重启 App，把构建产物覆盖进安装副本，浏览器会重新装载：

```sh
pnpm run build && cp lib/client.js ~/.dsh/profiles/desktop/node_modules/dsh-intelligent-ui/lib/client.js
```

宿主侧（`src/*.ts`）的任何改动都需要重装**并且重启**。

## 给插件作者的三条

三个故障，都很值得知道，全都是**在评审里看不出来**、只能靠踩出来的。

**一、宿主半的加载是静默失败的。** 一个解析不到的模块说明符不会在对话里留下任何痕迹：条目只是变成 `fiberPhase: failed`，工具凭空消失。为了拿类型而写进 `peerDependencies` 的包会被打包器外置——所以只要运行时并不真的提供它，插件就一个字节都没跑起来，而 `inject`、Config、技能断言全都还是通过的。`tests/host-bundle.spec.ts` 现在把"构建产物只能 import 运行时真有的东西"变成硬约束。

**二、成功加载过的模块会被缓存到进程结束。** 把插件条目关掉再开会重新导入，这能救回一次**加载失败**。但它不会重读一个模块已经成功加载过的文件：ESM 缓存会作答，`apply` 跑在旧代码上，盘上的包是什么无关紧要。换了代码就必须重启。

**三、`ctx.inject(deps, cb)` 才是等可选服务的正确姿势。** 用 `ctx.get(name)` 探一次、没有就退，这在服务齐备时看不出任何问题，只在冷启动跑到提供方前面时才静默失效——然后它会一直时好时坏。可选依赖既不是一条硬 `inject`，也不是一次探测，而是**需要等的东西**。

## 来源与许可

MIT。DIL 路径在 `vendor/` 下原样收录了 [Disdjj/intelligent-ui-demo](https://github.com/Disdjj/intelligent-ui-demo)（MIT）；`src/dil/` 与 `src/client/dil/` 下的编译器与沙箱是它的移植。确切的 commit、改了什么、为什么，都在 [PROVENANCE.md](PROVENANCE.md)。第三方代码从不就地编辑——改动一律发生在 `src/`。

协议是 ChatGPT DIL `protocolVersion 14` 的一个快照，上游随时会改；细节封在 `src/dil/` 与 `src/client/dil/` 里。

与上游有两处**有意的分歧**，都写成了测试而不是任其漂移：块内的闭合标签不再吞掉文档后半段；纯文本投影保留插值的位置（`n = {n}` 而不是 `n = `），免得终端读者拿到一句带空洞的残句。
