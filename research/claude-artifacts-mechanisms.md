# Claude Artifacts 复刻机制调研（开源实现）

前提：目标环境 DSH 桌面 0.2.0-rc.2；宿主半为 TypeScript 工具，客户端半为浏览器 bundle；渲染槽位 `tool.call.toolview`；预览载体 `srcdoc` iframe。全部结论来自下表 commit 的源码。

## 0. 证据索引（抓取时 commit）

| 代号 | 仓库 | commit | 说明 |
|---|---|---|---|
| FRAG | `e2b-dev/fragments` | `40e5dcd171a1` | **`e2b-dev/ai-artifacts` 已重定向到此仓库**（`api.github.com/repos/e2b-dev/ai-artifacts` → 301 → `repositories/827005317` = fragments）。不要再去找 ai-artifacts 的独立源码 |
| OA | `13point5/open-artifacts` | `c032aeb738df` | 复刻早期 e2b XML 标签协议的那一支 |
| OAR | `13point5/open-artifacts-renderer` | `2187426b3329` | OA 的 React 运行时（独立站点，iframe src 指向它） |
| LC | `Nutlope/llamacoder` | `75a3a78e1fa0` | 浏览器内 esbuild-wasm + importmap + 受控 srcdoc |
| CAR | `claudio-silva/claude-artifact-runner` | `024eca0f3f93` | 服务端 Vite 编译，非浏览器沙箱；只用它的"环境清单" |
| LIBRE | `danny-avila/LibreChat` | `f10b1d91f1ee` | 标签协议 + Sandpack + 版本/持久化/增量补丁最完整 |
| LOBE | `lobehub/lobehub`（`lobehub/lobe-chat` 重定向到此 monorepo） | `14dfc07b14ee` | `<lobeArtifact>` + 流式 shell iframe 最精细 |
| LOBEUI | `lobehub/lobe-ui` | `70405664988b` | LOBE 的 srcdoc/CSP/shim/防闪烁实现实际在此 |
| OWUI | `open-webui/open-webui` | `8bd8b4fac5e0` | 无标签协议，纯代码围栏启发式；回注协议最完整 |

---

## 1. 模型侧协议

### 1.1 该抄的做法

**首选：单个 XML/自定义标签 + 内嵌裸代码（不要围栏），属性带 `identifier`/`type`/`title`/`language`；更新时复用 `identifier`；一次回复一个 artifact。**

理由是可落地的：标签方案不需要工具调用往返，能在纯文本流里边写边解析（见 §2），且 `identifier` 直接当 artifact 主键。结构化输出（`streamObject`）在 DSH 里意味着模型必须走 tool call，与 `tool.call.toolview` 槽位语义冲突且无法容忍未闭合 JSON。

**如果坚持标签，必须同时规定围栏长度规则。** LIBRE 的原文（`api/app/clients/prompts/artifacts.js`）：

```
1. Create the artifact using the following format:

   :::artifact{identifier="unique-identifier" type="mime-type" title="Artifact Title"}
   ````
   Your artifact content here
   ````
   :::

7. Use a backtick fence longer than any backtick fence in the artifact content. Use a 4-backtick fence by default; if the artifact content contains a 4-backtick fence, use 5 backticks, and so on.
```

这条规则是必需的：artifact 内容是 Markdown/含围栏的文档时，固定 3 反引号会让内容里的 ``` 提前闭合。LIBRE 的解析器（`packages/api/src/artifacts/update.ts`）实现了对应的"跳过内层同长围栏"逻辑：

```ts
const isClosingCodeFence = (line: string, openingFence: CodeFence): boolean => {
  const closePattern = new RegExp(`^\\${openingFence.marker}{${openingFence.length},}\\s*$`);
  return closePattern.test(line.trim());
};
```

### 1.2 五种实际协议的原文

**(a) XML 标签，无围栏 — OA / 早期 e2b 风格**（`13point5/open-artifacts/app/api/chat/systemPrompt.ts`）：

```
Wrap the content in opening and closing <artifact> tags.

Assign an identifier to the identifier attribute of the opening <artifact> tag. For updates, reuse the prior identifier. For new artifacts, the identifier should be descriptive and relevant to the content, using kebab-case (e.g., "example-code-snippet").

Include a title attribute in the <artifact> tag to provide a brief title or description of the content.

Add a type attribute to the opening <artifact> tag to specify the type of content the artifact represents.
...
<artifact identifier="factorial-script" type="application/code" language="python" title="Simple Python factorial script">
def factorial(n):
   if n == 0:
       return 1
```

同文件明确规定不要用围栏：

```
When generating code for artifacts DO NOT add backticks like a normal code block because the xml tag contains the language already
  eg: DO NOT USE ```javascript instead the language attribute should be used in the artifact xml tag
```

类型枚举（同文件，原文）：`application/code`（带 `language=`）、`text/markdown`、`text/html`、`image/svg+xml`、`application/mermaid`、`application/react`。

**(b) 指令围栏 + 内层代码围栏 — LIBRE**：外层 `:::artifact{...}` … `:::`，内层 ````` ```` `````。类型枚举原文（同 `artifacts.js`）：`text/html`、`image/svg+xml`、`text/markdown`/`text/md`、`application/vnd.mermaid`、`application/vnd.react`。另有 `packages/api/src/prompts/artifacts/components.ts`（711 行）注入 shadcn 组件清单，`generate.ts` 用 `<component><name>/<import-instructions>/<usage-instructions>` XML 包装以省 token。

**(c) `<lobeArtifact>` 作为"内置技能"下发 — LOBE**（`packages/builtin-skills/src/artifacts/content.ts` + `manifest.ts`）：

```
identifier: 'lobe-artifacts'
description: 'Create directly viewable web pages, browser games, SVG graphics or animations, and React components...'
```
技能正文：
```
Wrap the content in `<lobeArtifact>` tags with the following attributes:
1. **`identifier`**: A consistent, kebab-case ID (e.g., `dashboard-widget`).
   - *Crucial:* Persist this ID across all future updates to this specific item. If updating an existing artifact, reuse the previous identifier.
2. **`title`**: A concise, descriptive string suitable for a header.
3. **`type`**: The MIME type defining the rendering logic.
```
类型：`text/html`、`image/svg+xml`、`application/lobe.artifacts.react`（+ 代码里另有 `application/lobe.artifacts.code`、`application/lobe.artifacts.mermaid`，见 `packages/types/src/artifact.ts` 的 `ArtifactType` 枚举）。

关键设计：**把 artifact 协议做成"按需加载的 skill"而不是常驻 system prompt**。manifest 的 `description` 是路由依据，正文只在命中时才进上下文。这对 DSH 特别契合——DSH 已有 skill 机制。

**(d) 结构化输出 + Zod schema — FRAG**（`lib/schema.ts` + `app/api/chat/route.ts`）。无标签，走 `streamObject`：

```ts
const stream = await streamObject({
  model: modelClient as LanguageModel,
  schema,
  system: toPrompt(template),
  messages,
  maxRetries: 0, // do not retry on errors
  ...modelParams,
})
return stream.toTextStreamResponse()
```
schema 字段含 `commentary`、`template`、`title`（"Short title of the fragment. Max 3 words."）、`description`、`additional_dependencies`、`has_additional_dependencies`、`install_dependencies_command`、`port`、`file_path`、`code`。客户端用 `experimental_useObject({api, schema, onFinish})` 收 `DeepPartial<FragmentSchema>`（`app/page.tsx:87`）。**注意 `maxRetries: 0`。**

**(e) 无协议，纯代码围栏启发式 — LC / OWUI**。

LC 的原文（`lib/prompts.ts`）规定围栏头带路径：
```
**File Format:**
 - Each file in separate fenced block with path:
   ```tsx{path=src/App.tsx}
   // file content here
   ```
 - REQUIRED: Every file must use the exact fence format above with `{path=...}`
 - Only output changed files in iterations
 - Maintain stable file paths
```
多文件、**文件级增量**（"Only output changed files in iterations"）。

OWUI 完全没有协议：`src/lib/components/chat/Messages/ContentRenderer.svelte` 按渲染出的围栏块语言判定——
```js
const isArtifact =
  ['html', 'svg'].includes(normalizedLang) ||
  (normalizedLang === 'xml' && code.toLowerCase().includes('<svg'));
```
并把 `html`/`css`/`js` 三类块合并成一份 HTML（`src/lib/utils/index.ts:2355` `getCodeBlockContents`，每个 `html` 块开一个新 group，`css`/`js` 追加到最近 group）。

### 1.3 一次回复几个 / 如何更新

- "One artifact per message unless specifically requested" —— OA 与 LIBRE 的 prompt 逐字相同。
- LOBE 措辞："**Frequency:** Limit to one artifact per response unless explicitly engaged in a multi-file task."
- 更新语义统一是"**复用 identifier + 重发全量**"，所有 prompt 都含这句（LIBRE / LOBE 原文）：`Include the complete and updated content of the artifact, without any truncation or minimization. Don't use "// rest of the code remains the same...".`
- 例外只有 LC（文件级增量）和 FRAG 的 Morph 路径（见 §5）。
- **不要指望模型自己判断该不该产出 artifact**：全部 prompt 都写了大段"Good artifacts are / Don't use artifacts for"判据。OA 与 LIBRE 的判据措辞完全相同（>15 lines、self-contained、会被反复修改…），可直接抄。

### 1.4 隐藏的 thinking 判断段

三种做法，**推荐第 2 种**：

1. OA 把判断写进可见流并显式要求只写一句（`systemPrompt.ts`）：
   ```
   1. Briefly before invoking an artifact, think for one sentence in <thinking> tags about how it evaluates against the criteria for a good and bad artifact.
   ```
   解析器把 `<thinking>` 段单独产出为 `thought` part（`lib/utils.ts` 的 `parseMessage`，见 §2），UI 可隐藏。
2. LOBE 用**独立标签常量**（`packages/const/src/plugin.ts`）：
   ```ts
   export const ARTIFACT_TAG = 'lobeArtifact';
   export const ARTIFACT_THINKING_TAG = 'lobeThinking';
   export const ARTIFACT_THINKING_TAG_REGEX = /<lobeThinking\b[^>]*>([\S\s]*?)(?:<\/lobeThinking>|$)/;
   ```
   当前 `packages/builtin-skills/src/artifacts/content.ts` 正文里**已不再要求 `<lobeThinking>`**，只保留常量与正则。可抄的是"把 thinking 段做成独立标签 + 独立正则"，而不是那个标签是否还在用。
3. FRAG 把它变成 schema 的一个字段 `commentary`（`lib/schema.ts`）——不需要正则，但要工具调用。

### 1.5 在 DSH 里落地要注意什么

- DSH 的 `tool.call.toolview` 槽位天然是"渲染结果"，artifact 数据应放在 tool call 的**结果 payload** 里，而不是去嗅探助手正文。若要复刻 Claude 体验（正文里出现 artifact 卡片），需要同时解析助手正文——那就要在客户端半订阅流式文本（§2 的分片问题会原样出现）。
- 模型侧协议必须**在 prompt 里写死 `identifier` 复用规则**，否则"原地更新"退化成"每轮新建 artifact"。DSH 宿主工具可以显式暴露两个分支：`kind: "create"` / `kind: "update"`，把判断交回模型（比正则嗅探可靠），但正文仍需能渲染出卡片。
- 选 `text/html` 类 artifact 时，把 "The only place external scripts can be imported from is https://cdnjs.cloudflare.com" 这条约束原样写进 prompt，否则模型会引 `unpkg`/`esm.sh` 而你的 CSP 白名单里没有（§3.5）。

---

## 2. 流式提取

### 2.1 该抄的做法

**不要每来一个 token 就重新解析整段文本。** 正确形态是：维护一个"已提交内容 + 尾部分片缓冲"，用行锚定的扫描器（不是单条正则）推进游标，并把**未闭合**状态显式建模为 `isPartial`。

### 2.2 四种实现的原文与差别

**(a) LC —— 行锚定状态机 + `isPartial`（`lib/utils.ts:258` `parseReplySegments`）。这是最值得抄的一个。**

```ts
export type ReplySegment =
  | { type: "text"; content: string }
  | { type: "file"; code: string; language: string; path: string; isPartial: boolean };

export function parseReplySegments(markdown: string): ReplySegment[] {
  markdown = normalizeFenceOpeners(sanitizeAssistantOutput(markdown));
  const segments: ReplySegment[] = [];
  const lines = markdown.split("\n");
  const fenceRegex = /^```([^\n]*)$/; // opening or closing fence line

  let textBuffer: string[] = [];
  let codeBuffer: string[] = [];
  let openTag: string | null = null; // e.g. tsx{path=src/App.tsx}
  ...
  for (const line of lines) {
    const match = line.match(fenceRegex);
    if (match && !openTag) {
      openTag = match[1] || "";
      flushText();
      codeBuffer = [];
    } else if (match && openTag) {
      // Closing fence → isPartial: false
    } else if (openTag) {
      codeBuffer.push(line);
    } else {
      textBuffer.push(line);
    }
  }

  // If a code fence remains open, emit a partial file segment
  if (openTag) {
    segments.push({ type: "file", code: resolved.code, language: resolved.language, path: dedupePath(resolved.path, usedPaths), isPartial: true });
  } else {
    flushText();
  }
```

行锚定（`^```([^\n]*)$`）而不是跨行正则，直接消掉了"分片边界落在标签中间"这类问题：**只有整行是围栏才算围栏**。附带两个真实模型兼容补丁，都可抄：

```ts
// GLM (and other models) sometimes glue an opening code fence onto the end of the
// preceding prose line, e.g. "...for the form elements.```tsx{path=src/types.ts}"
export function normalizeFenceOpeners(markdown: string): string {
  const pathFence = String.raw`\x60\x60\x60[^\n\x60]*\{path=[^}\n]*\}`;
  return markdown
    .replace(new RegExp(String.raw`([^\n])(${pathFence})`, "g"), "$1\n$2")
    .replace(new RegExp(String.raw`(${pathFence})[ \t]+(?=\S)`, "g"), "$1\n");
}
```
以及闭括号被模型拆到下一行的修补（`stripSplitFenceAttributeBrace`，同文件 L69-78）：`/\{\s*(path|filename)\s*=[^}\n]*$/i.test(fenceTag)`。还有 `stripThinkingBlocks(markdown)` 先摘掉思维链再解析。

**(b) LOBE —— 容错正则 `(?:<\/...>|$)`。**

`packages/const/src/plugin.ts`：
```ts
export const ARTIFACT_TAG_REGEX = /<lobeArtifact\b[^>]*>(?<content>[\S\s]*?)(?:<\/lobeArtifact>|$)/;
export const ARTIFACT_TAG_CLOSED_REGEX = /<lobeArtifact\b[^>]*>([\S\s]*?)<\/lobeArtifact>/;
```
一个正则同时表达"未闭合"和"已闭合"：`|$` 让未闭合时匹配到串尾。用 `[\S\s]*?` 惰性 + `$` 锚，等价于"取到结束标签或串尾"。

`src/store/chat/slices/portal/selectors.ts` 里的取内容与闭合判定：
```ts
const artifactCode = (id: string, identifier?: string) => (s: ChatStoreState) => {
  const messageContent = artifactMessageContent(id)(s);
  const regex = identifier
    ? new RegExp(`<lobeArtifact\\b[^>]*identifier="${escapeRegExp(identifier)}"[^>]*>(?<content>[\\S\\s]*?)(?:<\\/lobeArtifact>|$)`)
    : ARTIFACT_TAG_REGEX;
  const result = messageContent.match(regex);
  let content = result?.groups?.content || '';
  content = unwrapArtifactCodeBlock(content);
  return content;
};
```
`unwrapArtifactCodeBlock` 剥掉内容外层围栏：`CODE_FENCE_START_REGEX = /^\s*```[^\n]*(?:\n|$)/`、`CODE_FENCE_END_REGEX = /\n```\s*$/`。

**(c) LIBRE —— 显式围栏栈 + 25ms 节流 + 内容去重。**

`packages/api/src/artifacts/update.ts` 的 `findArtifactClose` 用 `codeFence` 变量记录当前打开的围栏，只在没有打开围栏时接受 `:::` 作为 artifact 结束：
```ts
const findArtifactClose = (text: string, start: number): ArtifactCloseRange | null => {
  ...
  if (closeRange) {
    if (!codeFence) return closeRange;
    fallbackClose = fallbackClose ?? closeRange;
  }
  const fence = getCodeFence(line);
  if (fence && !codeFence) codeFence = fence;
  else if (codeFence && isClosingCodeFence(line, codeFence)) { codeFence = null; fallbackClose = null; }
```
闭合围栏正则（要求 ≥ 开栏长度）：`new RegExp('^\\' + marker + '{' + length + ',}\\s*$')`。

客户端写入节流在 `client/src/components/Artifacts/Artifact.tsx`：
```ts
const throttledUpdateRef = useRef(throttle((updateFn: () => void) => { updateFn(); }, 25));
...
setArtifacts((prevArtifacts) => {
  if (prevArtifacts?.[artifactKey] != null && prevArtifacts[artifactKey]?.content === content) {
    return prevArtifacts;   // 内容未变则不产生新引用 → 不重渲染
  }
  return { ...prevArtifacts, [artifactKey]: currentArtifact };
});
```
**25ms 节流 + 引用相等短路**是防闪烁的第一道闸，与渲染层（§2.4）配合。

**(d) OA —— 反面教材，别抄。** `lib/utils.ts:40` 的 `parseMessage` 每次渲染都对**整段消息**重新扫一遍（`components/chat/message.tsx:76` 里 `parseMessage(text).map(...)`），是 O(n) 每 token / O(n²) 每次回复；且用 `message.indexOf("</artifact>")` 找结束标签，内容里出现该字符串即误判。它唯一值得抄的是"标签头可能被切断"的处理：

```ts
const tagEnd = message.indexOf(">", i);
if (tagEnd === -1) {
  buffer += char;      // '>' 还没到：把 '<' 当普通文本缓冲，不抛错
  i++;
  continue;
}
```

### 2.3 未闭合标签 / 分片边界的三条硬规则

1. **按行切，不按字符切。** LC 的 `^```([^\n]*)$` 与 LIBRE 的 `getLineEnd`/`getNextLineStart` 都是行锚定。行内不完整的标签永远不会被当成标签。
2. **`<head>` 封口前不要挂载任何东西。** LOBEUI `src/HtmlPreview/Iframe.tsx`：
   ```ts
   const headSealedPattern = /<\/head\s*>|<body[\s>]/i;
   const isHeadSealed = (raw: string): boolean => headSealedPattern.test(raw);
   // Empty until the user's <head> is *sealed* ... Holding off prevents partial
   // src="https://cd" URLs from being mounted and 404-ing while the model is still streaming.
   const headExtrasHtml: isHeadSealed(content) ? headExtras.join('') : '',
   ```
3. **"是否可挂载"要和"是否在流"分开判定。** 四个信号，可组合：
   - LOBEUI `const.ts`：`isFullHtmlDocument`（前 1024 字符含 `<!doctype html`/`<html`）、`isHtmlContentClosed`（**后 1024 字符**含 `</html>`）、`containsScript`（`/<script\b/i`）、`SRCDOC_MAX_LENGTH = 5 * 1024 * 1024`。
   - OWUI `ContentRenderer.svelte`：`const hasClosingCodeFence = (raw = '') => /(?:^|\n)```[ \t]*$/.test(raw.trimEnd());`——只有闭合围栏到达才自动打开面板。
   - LOBE `isArtifactTagClosed`（见 (b)）。
   - LIBRE `useArtifacts` 里的 `hasEnclosedArtifact`（`client/src/hooks/Artifacts/useArtifacts.ts:98`）：逐行扫描，维护 `codeFence`，只有"围栏闭合之后还单独出现 `:::`"才算 enclosed，进而把 tab 从 code 切到 preview。

### 2.4 防闪烁：三条被验证过的措施

**(1) 流式期间不要重挂 iframe，用 postMessage 打进常驻 shell iframe。** LOBEUI `src/HtmlPreview/Iframe.tsx` 分两模式：

```ts
// ── Static mode ── 非流式：直接把用户 HTML 交给 iframe，走浏览器正常解析管线
const staticSrcDoc = useMemo(() => { if (animated || tooLarge) return null; return buildStaticSrcDoc({ background, content, frameId }); }, [...]);
// ── Shell mode ── 流式：iframe 只加载一次，内容通过 postMessage 泵入
const shellSrcDoc = useMemo(() => { if (!animated || tooLarge) return null; return buildShellSrcDoc({ background, frameId }); }, [...]);
```

并且 **iframe 必须按模式换 key**，理由写在源码注释里：

```ts
// Setting iframe.srcdoc on an already-loaded element doesn't reliably
// re-navigate in Chromium when the previous document was also srcdoc-
// based — the new srcdoc attribute lands, but the document doesn't
// reload, so the user sees stale (often empty) shell content.
const iframeKey = animated ? 'shell' : 'static';
```

shell 内的 DOM 是**前缀匹配 morph**（`buildShellSrcDoc.ts`）：属性同步 → 逐子节点比对（`o.outerHTML === n.outerHTML` 短路）→ 递归 → 删多余尾部 → 新尾部经 `DocumentFragment` 一次性 append 并加 `.lobe-html-new` 触发 240ms 淡入。三个细节必须保留：

- `DocumentFragment` 批量插入是为了让 MutationObserver 型 CDN（Tailwind Play）**只收到一条 childList 记录**；逐个 append 会被批处理型 observer 丢事件。
- morph 之后 toggle 一个空 class 触发全文档重扫：`document.body.classList.add('_lobe-rescan'); ...remove(...)`。
- DOMParser 解析出的 `<script>` 是 inert，必须重建：`if (!src.hasAttribute('src')) { var text = src.textContent; if (text) s.text = text; }`——**只给内联脚本设 `.text`，给带 `src` 的脚本设 `.text` 会让某些浏览器跳过外部 fetch。**

`head` 里的资源按 `outerHTML` 做去重表 `headSeen`，避免重复执行脚本 / 重复加载。

**(2) 高度抖动要设地板 + 用 setTimeout 而非 rAF。** LOBEUI 的注释与代码：

```ts
// During streaming the shell body briefly reports a small height between morph
// commits ... Letting the iframe shrink to that interim height causes a visible
// up/down jitter that reads as flicker
const floored = Math.max(next, defaultHeightRef.current);
setHeight((prev) => (Math.abs(prev - floored) < 1 ? prev : floored));
```
且 `injectAutoHeightScript.ts` 与 LC 的 `html.ts` 都明确**不用 rAF**：LC 注释 `// Poll with timers, NOT requestAnimationFrame: rAF is fully suspended in hidden tabs`（`lib/preview/html.ts` 的 `waitForTailwindReady`，`pollMs = 50`、`timeoutMs = 5000`）。LC 还有独立的 `lib/preview/repaint.ts`，用 1px 宽度的几何变更强制 Chromium 重新光栅化：

```ts
iframe.style.width = "calc(100% - 1px)";
void iframe.offsetWidth;
scheduleRestore(() => { iframe.style.width = ""; void iframe.offsetWidth; }, 250);
```

**(3) 重新编译/重新加载期间保留旧画面，只叠角标。** LC `components/code-runner-react.tsx`：

```tsx
{(state.phase === "bundling" || state.phase === "running") &&
  (!hasEverBeenReady ? (
    <PreviewLoadingOverlay phase={state.phase} metrics={metrics} />
  ) : (
    <div className="absolute bottom-3 right-3 animate-pulse ...">Updating...</div>
  ))}
```
即 `hasEverBeenReady` 之后永不把预览替换成 loading 遮罩，只加一个 "Updating..." 角标。

**反面教材**：OA 的 `components/artifact/html.tsx` 直接把 `srcDoc={modifySrcDoc(code)}` 传给 iframe，每个 token 都改 srcdoc → 整个 iframe 重载。它靠"流式期间默认停在 code tab"（`components/artifact/index.tsx` 里 Tabs 只在 `!generating` 时渲染，`useState<ArtifactMode>("code")`）来遮盖，不是真正的解决方案。它的 React 分支则改用 postMessage（见 §6），说明作者自己也知道 srcDoc 热替换不可用。

### 2.5 在 DSH 里落地要注意什么

- 客户端 bundle 里做解析时，**每个 artifact 一个解析器状态**（游标 + 已提交内容 + openTag），不要每次 `useMemo` 全量重扫。若 toolview 收到的已经是"完整结果"（DSH 工具调用是请求-响应式），则只需在**流式参数增量**（tool call 的 partial args）上跑 LC 的 `parseReplySegments`。
- `tool.call.toolview` 里挂 iframe 时，务必实现 `iframeKey = streaming ? 'shell' : 'static'` 这一条；DSH 是 Electron/Chromium，srcdoc 热替换的失效行为与 LOBEUI 注释描述一致。
- 给 artifact iframe 加一个**看门狗**。LC 的取值是 15s（`lib/preview/html.ts` 注释 `blows past the 15s preview watchdog on cold load`）；并像 LC 那样在 srcdoc 里 parser-synchronously 绑 module script 的 error：
  ```js
  document.getElementById("__preview-app").addEventListener("error", function () {
    parent.postMessage({ source: "preview", type: "error", message: "..." }, "*");
  });
  ```
  注释解释了原因：模块脚本 fetch 失败只在 script 元素上触发 error，不会冒泡到 window，否则预览静默挂死。

---

## 3. 沙箱渲染

### 3.1 该抄的做法

`srcdoc` + **不含 `allow-same-origin`** 的 sandbox + **在 srcdoc 内部注入 CSP meta** + **在 srcdoc 内部注入 storage shim** + `postMessage` 用 `event.source === iframe.contentWindow` 校验（不是 `event.origin`）。

### 3.2 sandbox 属性逐项对照（原文）

| 实现 | 文件 | sandbox 值 |
|---|---|---|
| LOBEUI（默认） | `src/HtmlPreview/const.ts` | `allow-scripts allow-forms allow-modals` |
| LC | `components/code-runner-react.tsx:582` | `allow-scripts allow-forms allow-modals allow-popups` |
| OWUI（默认设置） | `src/lib/components/chat/Artifacts.svelte` | `allow-scripts` + ` allow-downloads` + ` allow-forms`（`allow-same-origin` 默认 false） |
| OWUI（通用 iframe 组件） | `src/lib/components/common/FullHeightIframe.svelte` | `allow-scripts allow-downloads`（`allowForms=false`、`allowPopups=false`、`allowSameOrigin=false`） |
| LIBRE（Sandpack） | `@codesandbox/sandpack-client@2.19.8` `dist/index-5796fa85.js:84` | `allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts allow-downloads allow-pointer-lock` |
| FRAG（远端 E2B URL） | `components/fragment-web.tsx` | `allow-forms allow-scripts allow-same-origin` |
| OA | `components/artifact/html.tsx` | **没有 sandbox 属性** |

### 3.3 `allow-same-origin` 为什么必须去掉

MDN `iframe` 元素页原文（`https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe`）：

> When the embedded document has the same origin as the embedding page, it is strongly discouraged to use both `allow-scripts` and `allow-same-origin`, as that lets the embedded document remove the sandbox attribute — making it no more secure than not using the sandbox attribute at all.

> `allow-same-origin`: If this token is not used, the resource is treated as being from a special origin that always fails the same-origin policy (potentially preventing access to data storage/cookies and some JavaScript APIs).

`srcdoc` 的 origin 是 `about:srcdoc`，其 base URL 取嵌入文档的 URL（MDN 同页）：`The about:srcdoc page uses the embedding document's URL as its base URL when resolving any relative URLs` —— 也就是**同源 srcdoc + allow-same-origin + allow-scripts 就等于没有 sandbox**。

LOBEUI 把这条写进了常量注释（`src/HtmlPreview/const.ts`），并且**点名了桌面端**：

```
 * Deliberately omitted:
 * - `allow-same-origin` — would let scripts read parent cookies / localStorage
 *   under cloud deployments, and bridge the IPC boundary on desktop builds.
 * - `allow-popups`, `allow-top-navigation` — phishing surface.
```

对 DSH 是直接命中：DSH 桌面版渲染器有 Node/Electron IPC 面，`allow-same-origin` 会给 artifact 一条通向宿主的路径。

**但 `allow-same-origin` 不是无条件错误——判据是 iframe 文档的 origin 与宿主是否同源：**
- 同源 / `srcdoc`：必须去掉（可逃逸 sandbox）。
- 跨源（LIBRE 的 Sandpack `https://<id>.codesandbox.io`、FRAG 的 E2B `result.url`）：此时 `allow-same-origin` 只是让**沙箱自己那个源**保留 storage，父页面仍不可触达，所以 LIBRE/FRAG 那样用是可接受的。
- 结论：**DSH 用 `srcdoc` 则一律不加 `allow-same-origin`。**

### 3.4 storage shim（因为去掉 allow-same-origin 后 `localStorage` 会抛异常）

LOBEUI `src/HtmlPreview/injectStorageShim.ts` 的注释与实现：

```
 * Why: When iframe sandbox does not include `allow-same-origin`, accessing
 * `window.localStorage` / `window.sessionStorage` throws a SecurityError.
 * Many LLM-generated demos use these APIs as a convenience even when they
 * don't need persistence — letting them throw kills the whole demo.
```
```js
function tryShim(name) {
  try {
    // Accessing the property in a sandboxed (no allow-same-origin) frame
    // throws synchronously — that's the signal to install the shim.
    window[name];
    return;
  } catch (_) {}
  try {
    Object.defineProperty(window, name, {
      configurable: true,
      value: createStorage(),
    });
  } catch (_) {}
}
tryShim('localStorage');
tryShim('sessionStorage');
```
内存 Storage 需完整实现 `length`/`key`/`getItem`/`setItem`/`removeItem`/`clear`。

LC 用**预置**（不探测）的等价物，写在 `lib/preview/html.ts` 的 `ERROR_BRIDGE` 里，且顺手把 `performance.setResourceTimingBufferSize(2000)` 也设了：
```js
function memoryStorageShim() {
  const values = new Map();
  return { get length() {...}, clear() {...}, getItem(key) {...}, key(index) {...}, removeItem(key) {...}, setItem(key, value) {...} };
}
try {
  performance.setResourceTimingBufferSize(2000);
  Object.defineProperty(window, "localStorage", { value: memoryStorageShim(), configurable: true });
  Object.defineProperty(window, "sessionStorage", { value: memoryStorageShim(), configurable: true });
} catch (_) {}
```

**推荐 LOBEUI 的"探测后 shim"**：如果将来允许 `allow-same-origin`（例如换成跨源 host），shim 不会覆盖真实 storage。

### 3.5 CSP 具体指令

**(a) 宿主页面的 CSP（LIBRE `packages/api/src/security/csp.ts`，逐条抄）。** 这套的关键是"宿主 CSP 用 nonce，artifact iframe 的内容由 artifact 自己的 sandbox+CSP 管"：

```ts
['default-src', ["'self'"]],
['base-uri', ["'self'"]],
['object-src', ["'none'"]],
['script-src', [`'nonce-${NONCE_SLOT}'`, "'strict-dynamic'", ...wasm, "'self'"]],
['script-src-attr', ["'none'"]],
['style-src', ["'self'", "'unsafe-inline'"]],
['img-src', ["'self'", 'data:', 'blob:', 'https:']],
['font-src', ["'self'", 'data:']],
['connect-src', ["'self'", 'https:', 'wss:']],
['media-src', ["'self'", 'data:', 'blob:']],
['frame-src', ["'self'", 'https:', 'blob:', 'data:', 'about:']],
['worker-src', allowDataWorkers ? ["'self'", 'blob:', 'data:'] : ["'self'", 'blob:']],
['manifest-src', ["'self'"]],
['form-action', ["'self'", 'https:']],
['frame-ancestors', frameAncestors],
```
三条带注释的取舍，直接适用于 DSH：
- `'wasm-unsafe-eval'` 而不是 `'unsafe-eval'`：`permits WebAssembly compilation without permitting eval()`。**DSH 若要在预览里跑 esbuild-wasm / Pyodide，只加 `'wasm-unsafe-eval'`。**
- `worker-src` 里的 `data:`：`required by Monaco's default CDN loader, which bootstraps its workers from a data: URL; without it the artifact editor silently drops to running worker tasks on the UI thread.`（DSH 的 artifact 代码编辑器若用 Monaco，同样需要。）
- `style-src` 故意不给 nonce：`A nonce in style-src makes browsers ignore 'unsafe-inline'`。所以 `'unsafe-inline'` + 不给 nonce。
- `'strict-dynamic'` 与宿主白名单互斥：`'strict-dynamic' makes browsers ignore every host source in script-src, so it cannot coexist with operator-supplied script hosts.`

**(b) 注入到 artifact srcdoc 内部的 CSP。** OWUI 用 meta（`src/lib/utils/csp.ts`）：

```ts
/**
 * Prepend a Content-Security-Policy <meta> tag to HTML.
 * First CSP meta tag wins per spec, so any existing CSP
 * in the HTML is effectively overridden.
 */
export function injectCsp(html: string, csp: string): string {
  if (!csp) return html;
  const escaped = csp.replace(/"/g, '&quot;');
  const tag = `<meta http-equiv="Content-Security-Policy" content="${escaped}">`;
  const idx = html.indexOf('<head>');
  return idx !== -1 ? html.slice(0, idx + 6) + tag + html.slice(idx + 6) : tag + html;
}
```
调用点：`srcdoc={injectCsp(contents[...].content, $config?.ui?.iframe_csp ?? '')}`；配置来自 `backend/open_webui/config.py:1731`：`IFRAME_CSP = os.getenv('IFRAME_CSP', '')`，**默认空 → 默认不注入任何 CSP**。

**meta 方式的硬限制（W3C CSP3 §3.3，原文）：**
> Note: The Content-Security-Policy-Report-Only header is not supported inside a meta element. Neither are the report-uri, frame-ancestors, and sandbox directives.

并且（同节）：
> policies in meta elements are not applied to content which precedes them
> Modifications to the content attribute of a meta element after the element has been parsed will be ignored.

所以：**`sandbox` 指令不能走 meta**，必须走 iframe 属性（OWUI 就是这么做的）；meta 必须尽可能靠前（`injectCsp` 插在 `<head>` 后第一位是对的）；**meta 注入后不能再改** —— 流式期间每次都重写 srcdoc 是可行的（新文档），但如果是往已加载文档里追加 meta，无效。

`frame-ancestors` 由 CSP3 §6.4.2 明确：`The frame-ancestors directive MUST be ignored when contained in a policy declared via a meta element.`

**(c) 推荐的 artifact 内部 CSP（把上面拼起来）**，由宿主在构造 srcdoc 时写入 `<head>` 首位：
```
default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://esm.sh; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'
```
注意 `'unsafe-inline'` 在 `script-src` 里是必需的：artifact 本体就是内联 `<script>`（`buildStaticSrcDoc` 把用户 HTML 直接放进 body）。若改用 nonce，需在 srcdoc 生成时逐个给内联脚本打 nonce——但 artifact 里的 `<script>` 是模型写的，nonce 注入必须在宿主侧做字符串替换，成本高于收益。

### 3.6 CDN 白名单

- Claude 原版 prompt（被 OA / LIBRE / LOBE 逐字继承）：`The only place external scripts can be imported from is https://cdnjs.cloudflare.com`。
- LIBRE 实际给 Sandpack 注入的 Tailwind：`const TAILWIND_CDN = 'https://cdn.tailwindcss.com/3.4.17#tailwind.js';`（`client/src/utils/artifacts.ts`）。**那个 `#tailwind.js` fragment 不是装饰**，注释说明：`Fragment hint lets Sandpack's static-template regex detect .js from the URL; without it, the versioned CDN path (/3.4.17) has no recognised extension and injectExternalResources throws "Unable to determine file type".`
- LC 用 `esm.sh` 做整个依赖图，构造在 `lib/preview/deps.ts`：
  ```ts
  const url = new URL(`https://esm.sh/${name}@${version}${options.subpath ? `/${options.subpath}` : ""}`);
  if (options.externalReact) url.searchParams.set("external", "react,react-dom");
  // Collapse the package's whole module graph into ONE bundled file. Without
  // this, esm.sh serves deep-graph libs (framer-motion has ~90 sub-modules) as
  // a request waterfall that blows past the 15s preview watchdog on cold load.
  url.searchParams.set("bundle", "");
  ```
  `?external=react,react-dom` 是必需的，否则每个包各带一份 React，hooks 直接爆。LC 还有 `findMissingPreviewModules` 在挂载前静态扫描 `import` 语句，提前报"importmap 里没有的 bare specifier"——因为 `no window error fires for a failed module resolution`。
- LOBE 的 React artifact 走 Sandpack `vite-react-ts` 模板（`src/features/Portal/Artifacts/Body/Renderer/React/index.tsx`），依赖表在 `packages/artifact-template/src/index.ts`，注意其中两条**版本钉死**及其理由，直接可复用：
  ```ts
  // The preview runs inside Sandpack's Nodebox, which emulates Node 16 and cannot load
  // native bindings. Vite 5+ requires Node 18/20+ and Vite 8 bundles rolldown (native),
  // so `latest` breaks the sandbox ("Cannot find native binding", "Vite requires Node.js 20.19+").
  'vite': '4.2.0',
  'esbuild-wasm': '^0.17.12',
  '@vitejs/plugin-react': '^4.3.4',
  // Pin to 0.x. lucide-react 1.x renamed/dropped several icons (notably `Github` and `Twitter`),
  // but most LLM training data still emits the 0.x names.
  'lucide-react': '^0.544.0',
  ```
- **OA 没有白名单也没有 CSP**，反而在 srcdoc 里注入 `unpkg.com/html2canvas` 和 `cdn.jsdelivr.net/.../es6-promise`（`components/artifact/html.tsx` 的 `packagesToInject`）。这是反面教材。

### 3.7 postMessage 握手：origin 校验与消息格式

**结论：`srcdoc` + 无 `allow-same-origin` 时 `event.origin` 是 opaque 值（不可用），必须用 `event.source === iframe.contentWindow` + 自定义 `frameId` 校验。**

LOBEUI 是唯一做全的（`src/HtmlPreview/Iframe.tsx`）：
```ts
useEffect(() => {
  const handler = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.frameId !== frameId) return;                              // ① 帧身份
    if (event.source !== innerRef.current?.contentWindow) return;      // ② 源窗口身份
    if (data.type === `${SHELL_UPDATE_MESSAGE_TYPE}:ready`) { setShellReady(true); return; }
    if (data.type === AUTO_HEIGHT_MESSAGE_TYPE) { ... }
  };
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}, [frameId]);
```
发送侧（父→子）：
```ts
win.postMessage({ frameId, payload, type: SHELL_UPDATE_MESSAGE_TYPE }, '*');
```
子→父 ready ping（在 shell 脚本最后同步发出）：
```js
parent.postMessage({ type: UPDATE_TYPE + ':ready', frameId: FRAME_ID }, '*');
```
`targetOrigin` 用 `'*'` 是**正确的**：目标是 opaque origin，没有可用的具体 origin 可写。安全性由"父侧校验 `event.source`"承担，而不是 targetOrigin。

消息类型常量：
```ts
export const SHELL_UPDATE_MESSAGE_TYPE = 'lobe-html-shell-update';   // buildShellSrcDoc.ts
export const AUTO_HEIGHT_MESSAGE_TYPE = 'lobe-html-resize';          // injectAutoHeightScript.ts
```

payload 形状（`Iframe.tsx` 的 `Payload`），**这个三分法是关键**：
```ts
interface Payload {
  bodyHtml: string;       // <body> innerHTML
  headExtrasHtml: string; // <head> 里非 <style> 的子元素 outerHTML（script src/link/meta/base/title）
  styleContent: string;   // <head> 里所有 <style> 的 textContent，合并成一个持续增长的 <style id="lobe-user-style">
}
```
注释说明为什么把 style 单列：`Inline <style> is intentionally excluded — those flow through styleContent so streaming partial CSS grows in place rather than stacking duplicate <style> blocks.`（半截 CSS 反复覆盖同一个 style 元素，而不是堆叠。）

OWUI 的校验方式（`FullHeightIframe.svelte`）是另一种可用形态：
```ts
// contentWindows of embeds rendered here; Chat.svelte trusts prompt messages from these
const embedWindows = new Set<Window>();
export const isEmbedWindow = (source: unknown): boolean => embedWindows.has(source as Window);
...
function onMessage(e: MessageEvent) {
  if (!iframe || e.source !== iframe.contentWindow) return;
  const data = e.data || {};
  if (data?.type === 'iframe:height' && typeof data.height === 'number') {
    iframe.style.height = Math.max(0, data.height) + 'px';
  }
  if (data?.type === 'pong') { iframe.contentWindow?.postMessage({ type: 'pong:ack' }, '*'); }
  if (data?.type === 'payload') {
    iframe.contentWindow?.postMessage({ type: 'payload', requestId: data?.requestId ?? null, payload: payload }, '*');
  }
}
```
`onLoad` 里把 `iframe.contentWindow` 注册进 `embedWindows`，`onDestroy` 里注销——`onLoad` 时窗口对象会变，必须按 load 重新注册。

LC 的消息格式（`lib/preview/html.ts` + `components/code-runner-react.tsx`），用 `source: "preview"` 做命名空间：
```js
parent.postMessage({ source: "preview", type: "error", message: String((event.error && event.error.stack) || event.message) }, "*");
parent.postMessage({ source: "preview", type: "console-error", message: ... }, "*");
parent.postMessage({ source: "preview", type: "ready", ... }, "*");   // 或 ready/tailwind-ready/document-loaded
```
父侧按 `event.data.type` 分派（`ready` / `document-loaded` / `tailwind-ready` / `error` / `console-error`），**没有校验 `event.source`**——这是个缺陷，不要抄这一点。

OA 用 `type` 直接分派且 targetOrigin 也是 `"*"`（`components/artifact/react.tsx`、`app/page.tsx`）：`UPDATE_COMPONENT` / `INIT_COMPLETE` / `CAPTURE_SELECTION` / `SELECTION_DATA`，同样无 `event.source` 校验。

### 3.8 在 DSH 里落地要注意什么

- srcdoc 一律 `sandbox="allow-scripts allow-forms allow-modals"`（照 LOBEUI），不加 `allow-same-origin`、不加 `allow-popups`（LOBEUI 注释把 popups 归为 phishing surface）。
- 用 `frameId`（`useId()` 即可）+ `event.source === iframe.contentWindow` 双校验；不要用 `event.origin`。
- 必须注入 storage shim，否则模型生成的 demo 大量挂掉（`localStorage` 抛 SecurityError）。
- 注入 CSP meta 到 `<head>` 首位；`sandbox` 指令不能走 meta（CSP3 §3.3），只能走 iframe 属性。
- 若宿主页自身也有 CSP，`script-src` 要含 `'wasm-unsafe-eval'`（esbuild-wasm / Pyodide）与 `'nonce-...' 'strict-dynamic'`；`style-src` 不要加 nonce。
- `srcdoc` 体积上限照抄 `SRCDOC_MAX_LENGTH = 5 * 1024 * 1024`（5 MiB），超限降级为只给源码。

---

## 4. 状态与版本

### 4.1 该抄的做法

**artifact 不单独持久化。** 权威存储就是"模型那条消息的文本 / 工具调用结果"，artifact 对象是**派生视图**。这条在四个项目里是一致的，也是唯一能保证"回放时恢复"的做法。

### 4.2 LIBRE：派生对象 + Recoil 镜像 + 服务端打补丁

artifact 类型（`client/src/common/artifacts.ts`）：
```ts
export interface Artifact {
  id: string;
  lastUpdateTime: number;
  index?: number;
  messageId?: string;
  identifier?: string;
  language?: string;
  content?: string;
  title?: string;
  type?: string;
  download?: ArtifactDownload;
}
```

id 构造（`client/src/components/Artifacts/Artifact.tsx`）：
```ts
const artifactKey = `${identifier}_${type}_${title}_${messageId}`
  .replace(/\s+/g, '_')
  .toLowerCase();
```
**id 里含 `messageId`**：同一 `identifier` 在不同消息里是不同 artifact。这意味着"复用 identifier 更新"实际产生的是**新条目**，不是覆盖。这对"版本历史"的含义有决定性影响，见下。

`index` 由 `ArtifactContext` 分配，且**每块 Markdown 传 `baseIndex`** 保持文档序稳定（`client/src/Providers/ArtifactContext.tsx`）：
```ts
export function ArtifactProvider({ children, baseIndex = 0 }) {
  ...
  const getNextIndex = useCallback((skip: boolean) => {
    if (skip) return baseIndex + counterRef.current;
    const nextIndex = counterRef.current;
    counterRef.current += 1;
    return baseIndex + nextIndex;
  }, [baseIndex]);
```
这个 `skip` 参数与 `resetCounter()` 是给"Markdown 分块重渲染时不要重复分配 index"用的。

状态容器（`client/src/store/artifacts.ts`）：`artifactsState: atom<Record<string, Artifact|undefined>|null>`、`currentArtifactId`、`artifactsVisibility`、`visibleArtifacts`。清空时机（`useArtifacts.ts` 与 `useResetArtifactsOnConversationChange.ts`）：换会话或面板卸载时 `resetArtifacts()` + `resetCurrentArtifactId()`。

**"版本"下拉的实际语义**（`client/src/hooks/Artifacts/useArtifacts.ts`）：
```ts
const ids = Object.keys(artifacts ?? {}).sort(
  (a, b) => (artifacts?.[a]?.lastUpdateTime ?? 0) - (artifacts?.[b]?.lastUpdateTime ?? 0),
);
```
`client/src/components/Artifacts/Artifacts.tsx:477`：`orderedArtifactIds.length > 1` 时渲染 `ArtifactVersion`，`totalVersions={orderedArtifactIds.length}`，`onVersionChange` 只是 `setCurrentArtifactId(target)`。

→ **LIBRE 的"v1/v2/…"是"本会话内所有 artifact 的时间序列表"，不是单个 artifact 的修订历史。**不要照着实现成"同一 artifact 的历史版本"，除非改 id 构造（去掉 `messageId`）。

持久化 / 回放：消息文本就是存储。用户手工编辑 artifact 内容时，服务端只替换该 artifact 那一段（`api/server/routes/messages.js` 的 `POST /artifact/:messageId`）：
```js
const { index, original, updated } = req.body;
...
const artifacts = findAllArtifacts(message);
if (index >= artifacts.length) return res.status(400).json({ error: 'Artifact index out of bounds' });
...
updatedText = replaceArtifactContent(part.text, targetArtifact, unescapedOriginal, unescapedUpdated);
```
注意 `index` 是 **artifact 在该消息内的序号**（不是 id），且前端会把 `$` 做 LaTeX 转义，服务端要 `unescapeLaTeX`。回放时客户端只是重新解析消息文本 → `artifactsState` 重建，因此**没有任何"恢复"逻辑需要写**。

### 4.3 LOBE：完全按需派生，连 store 都不存内容

`packages/types/src/artifact.ts`：
```ts
export interface PortalArtifact {
  children?: string;
  id: string;          // 消息 id
  identifier?: string;
  language?: string;
  title?: string;
  type?: string;
}
```
portal 里只存 `{id=消息id, identifier, type, title, language}`；内容每次用正则从消息文本里取（`artifactCode(id, identifier)`，见 §2.2(b)）。当前查看的 artifact 存在 `portalStack`（栈），所以有 `canGoBack` / `stackDepth`。

### 4.4 OA / FRAG / LC

- OA：`ArtifactMessagePartData {generating, id, type, title, content, language}` 每次渲染从消息文本派生（`lib/utils.ts`），**无持久化、无版本、无 store**。
- FRAG：`Message` 上有 `object?: DeepPartial<FragmentSchema>` 和 `result?: ExecutionResult`（`lib/messages.ts`）；`ExecutionResult` 分两支（`lib/types.ts`）：`ExecutionResultInterpreter {sbxId, template, stdout, stderr, runtimeError?, cellResults}` 与 `ExecutionResultWeb {sbxId, template, url}`。**artifact 的"实例"是远端沙箱 `sbxId`，本地只有指针。**
- LC：文件以 `files: Record<path, code>` 存在聊天记录里（Prisma），并有自愈逻辑 `getFilesFromMessage`：老数据里多个代码块塌缩成同一路径时，从原始消息文本重新抽取（`lib/utils.ts`）：
  ```ts
  // Cheap count of fenced code blocks in a message body (open + close fence lines divided by 2).
  // Used to detect legacy messages whose stored `files` collapsed ... so they can be re-extracted.
  ```

### 4.5 在 DSH 里落地要注意什么

- 把 artifact 对象当**纯函数 `parse(payload) → Artifact[]`** 的产物，缓存由前端负责。不要在宿主侧再建一张 artifact 表。
- id 必须显式设计。若要真版本历史，**id 不能含 messageId/轮次**，应为 `conversationId + ":" + identifier`，并把每轮解析结果 append 成 revision 数组；否则会退化成 LIBRE 那种"全会话 artifact 列表"。
- 版本列表的排序键用 `lastUpdateTime`（LIBRE 做法）即可，但要注意它在流式期间每 25ms 变一次（§2.2(c)），排序会抖动；更好的做法是"首次出现顺序"做主序、`lastUpdateTime` 只用于"自动打开最新"。
- 回放恢复的唯一要求是：**工具调用结果 payload 里带完整的 artifact 元数据（identifier/type/title/language）+ content**，且解析函数纯。DSH 的会话持久化已经覆盖了工具调用结果，所以不需要额外落库。

---

## 5. 增量更新

### 5.1 该抄的做法

**两级：**
- **便宜档（推荐先做）**：模型给 `original`/`updated` 两个字符串，宿主在 artifact 正文范围内做 search-replace。语义是 old_string/new_string，不是 unified diff。参考 LIBRE 的 `replaceArtifactContent`。
- **省 token 档**：模型给"带 `// ... existing code ...` 占位符的懒惰编辑"，再由第二个模型（Morph Apply）合并成全文。参考 FRAG。

### 5.2 LIBRE：`original` / `updated` + 围栏感知的搜索范围

`packages/api/src/artifacts/update.ts` 的核心是先算出"artifact 正文的实际范围"，再在其中定位 `original`：

```ts
export const replaceArtifactContent = (
  originalText: string,
  artifact: ArtifactBoundary,
  original: string,
  updated: string,
): string | null => {
  const artifactContent = artifact.text.substring(artifact.start, artifact.end);
  const range = getSearchRange(artifactContent);
  if (!range) return null;

  const { searchStart, searchEnd } = range;
  const innerContent = artifactContent.substring(searchStart, searchEnd);
  const originalTrimmed = original.replace(/\n$/, '');
  const relativeIndex =
    originalTrimmed === '' && innerContent.trim().length > 0
      ? -1
      : innerContent.indexOf(originalTrimmed);

  if (relativeIndex === -1) return null;   // 找不到就失败，不做模糊匹配

  const absoluteIndex = artifact.start + searchStart + relativeIndex;
  return normalizeBeforeClosingArtifactFence(
    replaceRange(originalText, absoluteIndex, absoluteIndex + originalTrimmed.length, updated),
  );
};
```

`getSearchRange` 的职责是**跳过 artifact 头行和外层代码围栏**，只在真正的代码正文里搜索：
```ts
const getSearchRange = (artifactContent: string): SearchRange | null => {
  const openingLineEnd = getLineEnd(artifactContent, artifactContent.indexOf(ARTIFACT_START));
  ...
  const openingFence = getOpeningCodeFence(artifactContent, contentStart, contentEnd);
  if (!openingFence) return { searchStart: contentStart, searchEnd: contentEnd };
  const closingFenceStart = findClosingCodeFenceStart(artifactContent, openingFence.contentStart, contentEnd, openingFence);
  if (closingFenceStart === -1) return { searchStart: openingFence.contentStart, searchEnd: contentEnd };
  // 收尾还有非空白内容 → 说明围栏不是整体包裹，退回全范围
  const trailingContent = artifactContent.slice(closingLineEnd, contentEnd);
  if (trailingContent.trim().length > 0) return { searchStart: contentStart, searchEnd: contentEnd };
  ...
};
```

`replaceRange` 顺带处理换行粘接：
```ts
const separator = endText.startsWith('\n') || updated.endsWith('\n') ? '' : '\n';
```
`normalizeBeforeClosingArtifactFence` 把紧贴 `:::` 前的多余空行压成一个。两者都是"补丁后文本仍然合法"的必要收尾。

**API 契约**：`POST /api/messages/artifact/:messageId`，body `{index, original, updated}`；成功即 `part.text = updatedText`，所以**下一条消息的历史里就是新内容，没有额外 diff 存储**。

局限（要记住）：`relativeIndex === -1` 直接 400，没有模糊/近似匹配；`original` 必须逐字节出现在 artifact 正文里。这要求 prompt 里明确"复述要替换的原文"，而 LIBRE 的 prompt **没有**这一条——这条能力靠的是前端编辑器把用户改动作为 `original/updated` 发上去，不是模型产出 diff。**如果 DSH 要让模型产出 diff，必须在 prompt 里新增"输出 original（原文逐字复制）与 updated"的指令。**

### 5.3 FRAG：懒惰编辑 + Morph Apply 二次合并

schema（`lib/schema.ts` 的 `morphEditSchema`）：
```ts
export const morphEditSchema = z.object({
  commentary: z.string().describe('Explain what changes you are making and why'),
  instruction: z.string().describe('One line instruction on what the change is'),
  edit: z.string().describe(
    "You should make it clear what the edit is, while also minimizing the unchanged code you write. When writing the edit, you should specify each edit in sequence, with the special comment // ... existing code ... to represent unchanged code in between edited lines. ... Be Lazy when outputting code, rely heavily on the exisitng code comments, but each edit should contain minimally sufficient context of unchanged lines around the code you're editing to resolve ambiguity. DO NOT omit spans of pre-existing code (or comments) without using the // ... existing code ... comment to indicate its absence. ..."
  ),
  file_path: z.string().describe('Path to the file being edited'),
});
```

合并由**另一个模型**执行（`lib/morph.ts`）：
```ts
const openai = createOpenAI({ apiKey: morphApiKey, baseURL: 'https://api.morphllm.com/v1' });
const { text: mergedCode } = await generateText({
  model: openai('morph-v3-large') as LanguageModel,
  prompt: `<instruction>${instructions}</instruction>\n<code>${initialCode}</code>\n<update>${codeEdit}</update>`,
});
```
路由 `app/api/morph-chat/route.ts`：`generateObject({schema: morphEditSchema})` → `applyPatch(...)` → 把 `{...currentFragment, code: mergedCode, commentary}` 用 `ReadableStream` 以**与 AI SDK 相同的纯文本格式**吐出去，让客户端 `useObject` 无感复用。

客户端只在这三个条件同时成立时走这条路径（`app/page.tsx`）：
```ts
const shouldUseMorph = useMorphApply && fragment && fragment.code && fragment.file_path
const apiEndpoint = shouldUseMorph ? '/api/morph-chat' : '/api/chat'
```

**这是唯一真正做到"只发 diff 不重发全量"的实现，但代价是引入外部模型服务（Morph，需 `MORPH_API_KEY`）。**

### 5.4 LC：文件级增量

prompt 原文：`Only output changed files in iterations` / `Maintain stable file paths`。没有行级 diff——模型只重发变化的文件，未提及的文件沿用上一轮。配合 `parseReplySegments` 的 `{path=...}` 与 `dedupePath` 得到 `Record<path, code>`，前端对每个文件独立 bundle 缓存。

LC 的缓存策略也值得抄：`BUNDLE_CACHE_LIMIT = 24`，key 是 `stableFilesKey(files, options)`，命中时 `durationMs: 0, cacheHit: true, cacheSource: PREVIEW_CACHE_STORAGE`（`lib/preview/bundle.ts`、`lib/preview/cache-policy.ts`）。

### 5.5 Claude 原版 / OA / LOBE：全量重发

三者的 prompt 都写死"重发完整内容，不许用省略注释"（见 §1.3）。LOBE 的 `## Step C: Integrity` 原文：
```
- Output the **full, non-truncated** code/text.
- Do NOT use lazy placeholders like `// ... rest of code`.
```

### 5.6 在 DSH 里落地要注意什么

- 走"便宜档"时，`replaceArtifactContent` 的 `getSearchRange` 是**唯一难写的部分**，建议直接移植（它解决的是"模型把原文连同外层围栏一起复述导致 indexOf 失败"）。
- 必须定义失败语义：找不到 `original` 时**不要静默替换第一处**，返回错误给模型重试（LIBRE 返回 400 `Original content not found in target artifact`）。
- 若 DSH 的模型支持 `old_string`/`new_string` 工具参数，把它做成宿主工具的两个必填字段，比让模型在正文里产出 diff 可靠得多；同时保留"重发全量"作为 fallback（模型常常宁愿全量）。
- 不要引入 Morph 那类外部合并服务；DSH 若要做"懒惰编辑"，可以在宿主侧用确定性算法（`// ... existing code ...` 分段 + 唯一匹配）合并，失败再退回全量。

---

## 6. 交互回注

### 6.1 该抄的做法

**`postMessage` 白名单类型 + `event.source` 校验 + 宿主侧"是否来自我们自己的 iframe"注册表。** 其中 OWUI 的 `input:prompt` 是最完整的"artifact 内部状态回注会话"实现。

### 6.2 OWUI：iframe 直接向会话发 prompt

`src/lib/components/chat/Artifacts.svelte` / `Chat.svelte:1428` 原文：
```js
const isSameOrigin = event.origin === window.origin;
const type = event.data?.type;

// Prompt-driving types are trusted only same-origin, from our own embed iframes
// (opaque srcdoc origin, submission still confirmed below) or via explicit opt-in.
const promptTypes = ['input:prompt', 'input:prompt:submit', 'action:submit'];
const isOwnEmbed = isEmbedWindow(event.source);
const isTrusted =
  isSameOrigin || isOwnEmbed || ($settings?.iframeSandboxAllowSameOrigin ?? false);

// Non-prompt message types are always restricted to same-origin only.
if (!isSameOrigin && !promptTypes.includes(type)) {
  return;
}

// Prompt types from an untrusted cross-origin source are silently dropped.
if (promptTypes.includes(type) && !isTrusted) {
  return;
}
```
要点：
- 三类 prompt 类型是**显式白名单**，其它类型一律同源才接受。
- **`srcdoc` 的 origin 是 opaque，所以 `isSameOrigin` 永远为 false** —— 注释里明写了这一点（`opaque srcdoc origin`）。真正放行靠的是 `isEmbedWindow(event.source)`。

父→子的 `payload` 请求/应答（`FullHeightIframe.svelte`）：
```js
if (data?.type === 'payload') {
  iframe.contentWindow?.postMessage(
    { type: 'payload', requestId: data?.requestId ?? null, payload: payload },
    '*'
  );
}
```
子侧先发 `{type:'payload', requestId}` 索取，父侧按 `requestId` 回填。**这是把宿主侧数据（如 DSH 的会话上下文、当前工作目录）注入 artifact 的正确形态：拉取而非推送。**

OWUI 还有 `args` 注入（`onLoad` 时直接写 `iframe.contentWindow.args = args`），但那只在 `allow-same-origin` 时可用，不要抄。

### 6.3 LC：把 iframe 里的错误与 console 回注给模型做自动修复

`lib/preview/html.ts` 的 `ERROR_BRIDGE` 挂了三类钩子：
```js
window.addEventListener("error", (event) => {
  parent.postMessage({ source: "preview", type: "error", message: String((event.error && event.error.stack) || event.message) }, "*");
});
window.addEventListener("unhandledrejection", (event) => {
  parent.postMessage({ source: "preview", type: "error", message: "Unhandled promise rejection: " + ... }, "*");
});
const originalError = console.error;
console.error = (...args) => {
  parent.postMessage({ source: "preview", type: "console-error", message: args.map(...).join(" ") }, "*");
  originalError(...args);
};
```
父侧把 `error + consoleErrors` 组成 fix payload 回注给模型（`components/code-runner-react.tsx`）：
```ts
const error = state.phase === "error"
  ? formatErrorForFixPayload(state.error, consoleErrors)
  : undefined;
...
useEffect(() => {
  if (!canAutoFix || !allowAutoFix || !onRequestFix || isFixPending || !error || !filesKey) return;
  if (autoFixSentForFilesRef.current === filesKey) return;   // 同一份文件只自动修一次
  autoFixSentForFilesRef.current = filesKey;
  onRequestFix(error);
}, [allowAutoFix, canAutoFix, error, filesKey, isFixPending, onRequestFix]);
```
`autoFixSentForFilesRef` 的"同一 filesKey 只自动修一次"是必需的熔断，否则错误会无限循环。

另外它把 `console.error` 的**参数做 JSON 序列化**（`try { return JSON.stringify(arg) } catch (_) { return String(arg) }`），并把 `Error` 取 `stack || message`。

### 6.4 OA / open-artifacts-renderer：截图回注（"crop and talk"）

宿主 → 子（`components/artifact/html.tsx`、`components/artifact/react.tsx`）：
```ts
iframeRef.current?.contentWindow?.postMessage({ type: "CAPTURE_SELECTION", selection }, "*");
```
子 → 宿主（注入到 srcdoc 的脚本，用 html2canvas）：
```js
async function handleCaptureSelection(selection) {
  const [selectionCanvas, artifactCanvas] = await Promise.all([
    html2canvas(document.body, { x: selection.x, y: selection.y, width: selection.width, height: selection.height, logging: false, useCORS: true }),
    html2canvas(document.body),
  ]);
  window.parent.postMessage({
    type: "SELECTION_DATA",
    data: { selectionImg: selectionCanvas.toDataURL("image/png"), artifactImg: artifactCanvas.toDataURL("image/png") },
  }, "*");
}
```
宿主收到后把两张 PNG **当作附件塞进下一次请求**（`components/chat/panel.tsx`）：
```ts
...selectedArtifacts.map((url) => ({ url })),
```
对应的 prompt 说明（`app/api/chat/systemPrompt.ts`）：
```
Users can also add image attachments to the query. Sometimes these images would be about the artifacts produced. ...
The UI allows them to speak and crop areas of the artifact to add as attachments. So when they speak they would refer to these crops with words like "this", "this text", "this button", etc.
```
**这是"交互回注"里唯一把 artifact 的像素状态送回模型的做法**，需要 `html2canvas` + 允许 `unpkg`/`jsdelivr`（OA 直接注入 CDN，见 §3.6，是它的安全债）。

React 分支则用持续推送代替截图（`components/artifact/react.tsx`，渲染端在 OAR `app/page.tsx`）：
```ts
// 宿主
iframeRef.current?.contentWindow?.postMessage({ type: "UPDATE_COMPONENT", code }, "*");
// 渲染端
window.parent.postMessage({ type: "INIT_COMPLETE" }, "*");
const handleMessage = (event: any) => {
  if (event?.data?.type === "UPDATE_COMPONENT") setCode(event?.data?.code || "");
  else if (event?.data?.type === "CAPTURE_SELECTION") handleCaptureSelection(event.data.selection);
};
```
`INIT_COMPLETE` 握手是为了解决"iframe 未就绪就 postMessage 丢失"——父侧 `useEffect(() => { handleRender(); }, [code])` 在 `iframeLoaded` 之前发的消息会丢。

OAR 的 React 求值方式（`lib/utils.ts`）值得单独注意，因为它决定 CSP：
```ts
const factoryFunction = new Function(transformedCode)();
const component = factoryFunction(React, recharts, uiComponents, lucide);
```
配合 `Babel.transform(codeWithoutExports, { presets: ["react"], plugins: [importTransformerPlugin] })`（`@babel/standalone`）。`new Function` = **需要 `'unsafe-eval'`**（不是 `'wasm-unsafe-eval'`），这是 DSH **不应该**采用的方案。

### 6.5 LOBEUI：只做高度回传（无状态回注）

```js
// injectAutoHeightScript.ts
function post() {
  var h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  parent.postMessage({ type: AUTO_HEIGHT_MESSAGE_TYPE, frameId: frameId, height: h }, '*');
}
var ro = new ResizeObserver(post); ro.observe(document.body); ro.observe(document.documentElement);
```
没有表单值收集、没有按钮点击回传。LOBE 的"交互回注"走的是另一条路（artifact 里的 `<Button>` 用本地状态），不经过宿主。

### 6.6 在 DSH 里落地要注意什么

- 回注通道建议做成**拉取式**：artifact 侧 `postMessage({type:'dsh:request', requestId, method})`，宿主回 `{type:'dsh:response', requestId, ok, data}`。白名单 method（如 `getConversationSummary`、`getWorkspaceFiles`、`submitPrompt`），不要暴露通用能力。
- `submitPrompt` 这一条（OWUI 的 `input:prompt` 等价物）是交互回注的核心价值，但必须：① 只在 `event.source` 命中已注册 iframe 时放行；② 走 DSH 自己的用户确认流程（OWUI 的注释是 `submission still confirmed below`），不要静默把 artifact 里产生的内容直接发给模型。
- 错误回注（LC 的 `error` / `console-error`）可直接抄，且必须带"同一份内容只自动修复一次"的熔断。
- 不要用 `new Function` / `@babel/standalone` 求值模型代码（OAR 方案需要 `'unsafe-eval'`）。DSH 客户端 bundle 里应当用**构建期已知的组件注册表 + 数据驱动**，或走 esbuild-wasm（`'wasm-unsafe-eval'`）。

---

## 7. 浏览器内运行方案的适用边界

### 7.1 esbuild-wasm（LC 用法，推荐档）

- 版本与体积：npm `esbuild-wasm` latest `0.28.2`，`dist.unpackedSize = 14532821`。其中 `esbuild.wasm` 实测 **13,978,850 字节（13.3 MiB），gzip 后 3,781,673 字节（3.6 MiB）**（`https://cdn.jsdelivr.net/npm/esbuild-wasm@0.28.2/esbuild.wasm`）。
- 初始化（LC `lib/preview/bundle.ts`）：
  ```ts
  export function ensureEsbuild(): Promise<void> {
    globalThis.__llamacoderEsbuildInitPromise ??= esbuild.initialize({
      wasmURL: ESBUILD_WASM_URL,   // "/preview-vendor-v2/esbuild/esbuild.wasm" —— 自托管，不走 CDN
      worker: true,
    });
    return globalThis.__llamacoderEsbuildInitPromise;
  }
  ```
  **`worker: true` + 自托管 wasm 是关键**：CDN 托管 wasm 会因跨源 + COEP 而失败；`worker: true` 让编译不阻塞主线程。
- 编译调用（LC，逐字）：
  ```ts
  const result = await esbuild.build({
    entryPoints: ["/main.tsx"],
    bundle: true,
    outfile: "/bundle.js",
    write: false,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    sourcemap: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
    external: options.externalReactDependencies ? REACT_DEPENDENCY_SPECIFIERS : [],
  });
  ```
  `REACT_DEPENDENCY_SPECIFIERS = ["react", "react-dom", "react/jsx-runtime", "react-dom/client"]`。标为 external 的包由 **importmap** 在 iframe 里解析（`lib/preview/deps.ts` 的 `buildImportMapObject`）——这是 DSH 最该用的组合：**esbuild-wasm 只做 bundle，依赖解析交给 importmap + CDN。**
- CSP：WebAssembly 编译需要 `script-src 'wasm-unsafe-eval'`（LIBRE 的 `csp.ts` 注释：`'wasm-unsafe-eval' permits WebAssembly compilation without permitting eval()`）。
- **放哪里跑**：放在**宿主页面（DSH 客户端 bundle）**里编译，把产物 JS 字符串拼进 srcdoc。**不要放进 srcdoc iframe**，原因按可验证度排序：
  1. 无 `allow-same-origin` 的 srcdoc 是 opaque origin，wasm 要跨源 fetch（13.3 MiB），依赖 CDN 的 CORS 头，且该文档的 CSP 必须自己注入 `'wasm-unsafe-eval'`。
  2. `new Worker(blob:)` 并非规范禁止——MDN `Worker()` 页面原文：`This must be same-origin with the caller's document, or a blob: or data: URL.`——但行为依赖浏览器（`w3c/webappsec-mixed-content#41`：`Safari refuses to load blob URLs (iframe and worker) due to mixed content checks. Chrome loads both blob URL, the worker is not secure context.`），且 MDN 指出 `data:` URL 的 worker 有 opaque origin，`its access to other external resources is highly restricted`。**即"能用但不可靠"，而我未在 Electron/Chromium srcdoc 下实测。**
  3. 最决定性的理由是工程性的：宿主页面本来就跑着客户端 bundle，在其中编译可以复用一次 wasm 初始化（LC 用 `globalThis.__llamacoderEsbuildInitPromise` 做单例），放进 iframe 则每次重建文档都要重载 13.3 MiB。

### 7.2 Sandpack（LIBRE / LOBE 用法，重档）

- npm `@codesandbox/sandpack-react` latest `2.20.0`；`@codesandbox/sandpack-client` latest `2.19.8`。
- 默认 bundler 端点：`baseUrl: options.bundlerURL ?? "https://preview.sandpack-static-server.codesandbox.io"`（`sandpack-client@2.19.8` `dist/index-5796fa85.js:49`）。**默认必须联网，且要过 CodeSandbox 的服务。**
- 自托管：LIBRE 通过启动配置下发（`api/server/routes/config.js:307`）：
  ```js
  bundlerURL: process.env.SANDPACK_BUNDLER_URL,
  staticBundlerURL: process.env.SANDPACK_STATIC_BUNDLER_URL,
  ```
  客户端按模板选用（`client/src/utils/artifacts.ts`）：
  ```ts
  return { ...sharedOptions, bundlerURL: template === 'static' ? startupConfig.staticBundlerURL : startupConfig.bundlerURL };
  ```
  → **要用 Sandpack 就必须自托管 sandpack bundler（`sandpack-bundler`）**，否则 DSH 桌面版离线不可用，且依赖第三方。
- sandbox 属性固定为 `allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts allow-downloads allow-pointer-lock`（同文件 L84）。它带 `allow-same-origin`，但 iframe 是跨源的 `<id>.codesandbox.io`，所以可接受；**DSH 若用 srcdoc，不能沿用这个字符串。**
- LOBE 的 React artifact 依赖 Sandpack 的 `vite-react-ts` 模板（`src/features/Portal/Artifacts/Body/Renderer/React/index.tsx` → `template="vite-react-ts"`），其沙箱是 Nodebox（模拟 Node 16），因此 Vite 必须钉 `4.2.0` + `esbuild-wasm ^0.17.12`（见 §3.6）。
- 结论：**Sandpack 对 DSH 的性价比最低**（第三方 bundler + 固定 sandbox 串 + Nodebox 版本陷阱）。除非要支持"多文件 Vue/Svelte 项目"。

### 7.3 WebContainer（不适用）

- npm `@webcontainer/api` latest `1.6.4`。
- 硬性要求（官方文档 `https://webcontainers.io/guides/quickstart` 原文）：
  > WebContainers require SharedArrayBuffer, which, in turn, requires the website where they are running to be cross-origin isolated. Because of that, you'll need to set COOP/COEP headers:
  > ```
  > Cross-Origin-Embedder-Policy: require-corp
  > Cross-Origin-Opener-Policy: same-origin
  > ```
- 另有限制（同页）：`the boot method can be called only once and only a single WebContainer instance can be created.`
- 对 DSH 的含义：**`srcdoc` iframe 永远不是 cross-origin isolated**（COOP/COEP 只能由 HTTP 响应头设置，`srcdoc` 没有响应头），且要开 COEP 就必须给宿主页所有跨源资源加 CORP 头。**在 srcdoc 预览里跑 WebContainer 不可行。**

### 7.4 结论：DSH 的选型

| 需求 | 方案 | 依据 |
|---|---|---|
| 单文件 HTML/SVG/Markdown/React（模型生成） | `srcdoc` + `sandbox="allow-scripts allow-forms allow-modals"` + storage shim + CSP meta | §3 |
| React/TSX 单组件 | 宿主侧 esbuild-wasm 编译成单 bundle，产出的 JS 塞进 srcdoc，`react`/`react-dom` 走 importmap | §7.1 + LC `lib/preview/deps.ts` |
| Tailwind | 复用 LOBEUI 的两条路径之一：静态时用 `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4`（LC `getPreviewStyleAssets` 的 `vendor === "cdn"` 分支）；流式时用预编译 CSS + 候选类种子（LC `buildTailwindCandidateSeed` 写一个 `<div hidden class="...候选类...">`） | §2.4 / LC `lib/preview/html.ts` |
| 多文件项目 / npm install | 不做。要做得自托管 Sandpack bundler | §7.2 |
| Node 环境 / 跑真实 dev server | 不做 | §7.3 |

---

## 8. 尚未查证的点

1. **`lobehub/lobe-ui` 的 `streamingMode`/`throttleMs` 具体数值**：`src/HtmlPreview/HtmlPreview.tsx:190` 有 `streamingMode = 'auto'` 默认值，`headClosed` 之后有节流提交逻辑（`const [throttledContent, setThrottledContent] = useState(trimmedChildren)` 附近），但我没有取到 `throttleMs` 的默认常量值。写代码前应直接读该文件 L180-320。
2. **OWUI 的 `artifactCode`（单块预览）与 `artifactContents` 的关系**：`ContentRenderer.svelte` 的 `previewHandler` 设 `artifactCode`，`Chat.svelte:2001` 设 `artifactContents`；`Artifacts.svelte` 用 `artifactCode` 的订阅去 `contents.findIndex(c => c.content.includes(value))` 定位选中项。这段匹配是子串匹配，边界情况（两块内容互为子串）未验证。
3. **`e2b-dev/ai-artifacts` 历史版本（XML 标签时期）的源码**：该仓库已无 tags/releases（`/tags` 与 `/releases` 均返回空数组），重定向到 fragments。若需要当年的 XML 解析器原文，应从 `13point5/open-artifacts`（其 prompt 与解析器就是那一支）取，或翻 fragments 的 commit history 找 rename 前的 `lib/utils.ts`。我没有做这步历史考古。
4. **LIBRE `ArtifactCodeEditor`（Monaco）的 worker 注入与 CSP 交互**：只知道 `csp.ts` 里 `worker-src` 需要 `data:` 是为了 Monaco 默认 CDN loader，没有读 Monaco 的注入实现。
5. **LC 的 `lib/preview/files.ts`、`cache-policy.ts`、`tailwind-signature.ts` 细节**：只读了 `bundle.ts` / `deps.ts` / `html.ts` / `repaint.ts`。Tailwind 候选类提取算法与 b bundle 缓存的持久化位置（`PREVIEW_CACHE_STORAGE`）未逐行确认。
6. **Sandpack 的 runtime（非 static）客户端 iframe 的 sandbox 值**：`sandpack-client` dist 里只找到一处 `setAttribute("sandbox", ...)`（属于 `SandpackStatic`）。runtime 客户端通过 `createElement("iframe")` 创建后是否也设 sandbox 未确认（`dist/index-5796fa85.js:77` 附近）。
7. **`web_fetch`/`curl` 无法访问需要登录的 GitHub 代码搜索**：LibreChat 中"谁把 `:::artifact` 变成 `artifactsState`"最终定位到 `client/src/components/Artifacts/Artifact.tsx` 的 `artifactPlugin` + `throttle(25)`，是通过下载仓库 tarball 后本地 grep 得到的，不是代码搜索 API。若后续要查其它仓库的同类问题，走 `curl codeload.github.com/<repo>/tar.gz/refs/heads/main` 再本地 grep，比逐文件 raw 抓取快。（`curl` 对该域名需 `--http1.1 --retry`，Open WebUI 与 LibreChat 的 tarball 都在第一次尝试时以 exit 18 部分下载失败。）
8. **在 `sandbox` 无 `allow-same-origin` 的 srcdoc 文档里 `new Worker(blob:)` 的实际行为**：规范允许 blob:/data:，浏览器实现不一致（见 §7.1 第 2 条），我未在 Electron/Chromium 的 srcdoc 下实测。这一条只影响"要不要把 esbuild-wasm 放进 iframe"的取舍，不影响 §7.1 的结论（放宿主页面）。
9. **LIBRE `useArtifactProps` 的 `deriveFiles` 与 `ArtifactCodeEditor`（Monaco）的编辑→预览回灌路径**：只读了 `useArtifactProps.ts` 前 80 行与 `SandboxArtifactTabs.tsx` 的 `deriveFiles != null && editedCode ? deriveFiles(editedCode) : files`，Monaco 侧的 `onChange` 与节流未逐行确认。
