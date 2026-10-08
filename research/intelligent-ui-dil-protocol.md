# ChatGPT Intelligent UI 的真实协议（抓包逆向）

来源：[Disdjj/intelligent-ui-demo](https://github.com/Disdjj/intelligent-ui-demo) —— MIT，0★，
2026-10-08 创建。用 Reqable 抓包（1515 条记录）+ 一次真实生成的完整产物。
**全网唯一公开的协议级证据。** 本文件只记事实，不记推测；推测另标。

## 内部代号

**DIL**（`dil_runner` / `model_dil_v2` / `dil_sandbox` / `dil_renderer`）；
产品侧代号 **opGenui / GenUI**。

## 关键结构性事实

### 1. 不是可选模式，是回答渲染的默认底座

所有助手回答都走这条管线，**连纯文本回答也带 `model_dil_v2.code`**（232 字节，只渲染一个 `<text>`）。
即：Intelligent UI 不是"可视化功能"，是"回答怎么被渲染出来"的底座。

### 2. 模型写的是自制声明式 DSL，不是 React，不是 HTML

形态：Markdown + `{@body <JS>}` 语句 + JSX-like 标签。
标签与指令：`<box>`、`{#if}`、`{:else}`、`{#each}`、`<icon name>`。

### 3. 编译在服务端做

编译产出四件：

| 字段 | 实测值 | 作用 |
|---|---|---|
| `code` | 30,932 B JS | 编译后的可执行产物 |
| `constants` | 108 条字符串池 | 常量池 |
| `fallbackMarkdown` | 687 字符 | **降级文本版本** |
| `fallbackMarkdownVersion` | — | 降级版本号 |
| `requiredComponents` | 如 `MemoryCite` | 需宿主解析的组件 |
| `appData.opGenui` | — | 应用侧数据 |

编译产物在流里**整体 replace 了 134 次**（446 B → 30,932 B）：每次重编译下发完整代码，
**不做编译产物增量**。

### 4. 流式通道

SSE 只有一种事件 `delta`，负载是 **JSON-Pointer 补丁** `{p, o, v}`，`o ∈ append / add / replace / remove`。
另有 `resume` 接口按**事件序号 offset** 断线续传。请求体带 `supported_encodings: ["v1"]`。

### 5. 渐进渲染：靠源码字符区间驱动

独立通道 `message.metadata.genui_components`，把源码的**字符区间**标注成组件：

```
{ type, tree_range, start_index, end_index }
```

`end_index` 随流反复 replace 增长 → 客户端据此判断"这个组件写完没有、能不能渲染"。
内建 `<chart>` 内部名叫 `charts_widget_v2`。

### 6. 容错是一等公民

**338 条 `recoveryDiagnostics` 补丁**（比编译产物补丁还多），记录解析器如何从
`unclosed_block` / `unterminated_tag` / `unterminated_braced_value` 中
`recovered_parse` 继续编译（带行列号）。另有 `appDirectiveSequenceActive`
标记 `{@body}` 序列未完成。

### 7. 沙箱与渲染分离：无 DOM Worker + 宿主原生渲染

- 客户端独立 **DIL Runner**：`cdn.platform.openai.com/assets/dil/runner-*.js`，
  184,775 B，**protocolVersion 14**。
- 在**无 DOM 的 Worker** 里 eval 编译产物。
- 自研 **React-like 渲染器**（hooks / effects / keyed children），输出"编码渲染树"。
- **宿主用 `data-d-component="box|row|text|chart..."` 把它渲染成真实 DOM**，
  可解析 **30 个 eager + 283 个 lazy 宿主组件**。
- 四层消息命名空间：`__oaiDilFrame` / `__oaiDilWorker` / `__oaiDilMessage` / `__oaiDilGlobalFunction`。
- 健康探测、generation 校验（workerGeneration / sessionGeneration / runnerId）、
  启动预算 4000 ms、两次启动尝试。

### 8. 交互回注

- `DIL.useState(v, { key })` 的 key 是**语义键**。
- 客户端把整棵状态树 `POST /backend-api/conversation/{cid}/message/{mid}/dil/view_state`。
- 下一轮通过请求体的 `genui_state_snapshots` 回灌给模型。
- 模型可调用的宿主 API：`GenUI.copy` / `GenUI.issueNewTurn` / `GenUI.openEntityDetail` /
  `GenUI.openUrl` / `GenUI.runPluginTool`（异步工具）。

## 六项能力对照

| 能力 | Intelligent UI |
|---|---|
| 产物身份 | 无（会话内消息级） |
| 增量更新 | **有**（JSON-Pointer 流式补丁 + 字符区间渐进渲染） |
| 持久化 | 无（在 ChatGPT 后端，仓库只是抓包） |
| 版本历史 | **无** |
| 交互回注 | **有**（view_state → genui_state_snapshots） |
| 沙箱隔离 | **有**（Worker 无 DOM + 全局冻结 + 组件名 allowlist + 受控 RegExp） |

## 架构含义（与我们的对照）

OpenAI 把两条路的优点合起来了：

- **沙箱里执行**（我的"逃生舱"要的安全面）
- **宿主原生渲染**（我的"快车道"要的主题/可访问性免费）

代价是：要写编译器、要写一个 React-like 渲染器、要写 Worker 消息协议。

**三个与协议选型无关、可以直接抄的机制：**

1. **字符区间驱动的渐进渲染**——不是等整块 JSON，也不是猜括号闭合。
2. **恢复式解析 + 诊断**——模型写坏一半，界面照样出。
3. **每次编译同时产出降级 Markdown**——TUI / headless / 复制粘贴都有东西可看，
   比"退化成一行结果"好得多。

**一个可单独采用的机制**：流式用 JSON-Pointer 补丁 `{p,o,v}`（增量更新语义）。

## 其它纠正（同时验证）

- **「Neural Expressive」不是生成式 UI**，是 Gemini 2026-05 I/O 的**设计语言**
  （流体动画、色彩、字体、触觉）。Gemini 真正的生成式 UI 叫
  **Dynamic View / Visual Layout**，2025-11-18 随 Gemini 3 上线。
  官方论文《Generative UI: LLMs are Effective UI Generators》arXiv 2604.09577v1；
  **PAGEN 数据集当前不可获取**（项目页 `/pagen` 404）。
- **Open-JSON-UI 已不是活规范**：旧文档 URL 重定向到 A2UI，GitHub 无官方仓库。
  不要作为可用规范引用。
- **hostartifacts.dev 不开源**：GitHub 全站搜 `hostartifacts` total_count = 0；
  Mintlify 文档全文 0 处 GitHub 链接；`install.sh`、`/docs`、`/support` 均 404。
  文档可当免费规格书，代码不可用。
