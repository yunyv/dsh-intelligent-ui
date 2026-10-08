# Claude 网页版（claude.ai）Artifact 的视觉位置

范围：claude.ai 网页版对话界面 + iOS App。所用截图全部为真实产品截图（含一张从新闻配图中裁出的产品界面截图，已注明）。

## 结论速查

1. 卡片插在助手那段文字的**内部**（正文流中间），不在回合末尾、不在操作行旁边。
2. 对话流里的卡是**入口卡片**（带缩略图预览）；完整预览在右侧独立面板，创建时自动打开，关掉后卡片仍在、点卡片可再开。
3. 卡片刻度：圆角边框行 = 加粗标题 / 灰色副标题（自由提示文案，**不是**"代码·HTML·SVG·React"类型徽章）/ 右侧倾斜缩略图；控件在面板头部和聊天列顶部，不落在卡片上。
4. 每次修改 = 助手那一轮里**再出一张新卡片**（标题会变），面板始终是最新版并显示 `vN · Latest`；版本历史在面板头部的版本下拉里。
5. 窄屏下卡片同样是**全宽内联**；点开是**半屏浮层**（不是并排面板），浮层底部有 `2 of 2` + ←/→ 翻版本。
6. 生成"文件"用的是**另一种形态**：图标 + 文件名 + 类型行 + 右侧 `Download` 按钮，无缩略图、不版本化。官方明确写文件功能 "Does not support versioning or remixing of Artifacts"。

---

## 1. artifact 卡片相对于助手回复正文的位置

**结论：插在助手那段文字中间——位于引入句之后、后续解释之前，属于正文流的一个块，不是整轮末尾。**

证据：

- `claude-inline-card.png`（面板已关闭状态，最干净地看出位置）：助手消息从上到下是
  1. `I'll create a CSS-based logo for Codecademy. Here's a simple, modern design using pure CSS that resembles Codecademy's branding:`
  2. ← **卡片就在这里**（`Codecademy Logo in CSS` / `Interactive artifact` / 右侧缩略图）
  3. `This CSS logo for Codecademy features:` + 5 条 bullet + `Would you like me to explain any part…`
- `claude-side-panel-and-card.png`：第 2 轮同样结构（引入句 → 卡片 → 解释段落）。
- 操作行（复制 / 赞踩 / `Retry` + `Claude can make mistakes.`）永远在消息最末尾，卡片在它**上方**，不与其同行（见 `claude-side-panel-and-card.png`）。
- Codecademy 分步教程原文佐证（该页截图与上面同源）："In the chat window, you can see that we get a clickable object named `Codecademy Logo in CSS`, which is an `Interactive artifact`."
  <https://www.codecademy.com/article/how-to-use-claude-artifacts-create-share-and-remix-ai-content>

## 2. 卡片与右侧面板的关系

**结论：对话流那张是"缩略入口卡"（不是完整预览）；完整预览在右侧独立面板，创建时自动打开，关闭后卡片保留在原位作为重新打开的入口。**

证据：

- `claude-inline-card.png`：面板被关掉后聊天恢复全宽，卡片仍留在正文原位——即卡片本身就是入口。
- `claude-side-panel-and-card.png`：卡片与右侧面板同时存在；面板内才是完整渲染结果。
- Codecademy 原文（hide / unhide 两步）："the logo is automatically rendered on the right side of the chat screen"；"To unhide the artifact, you can click on the artifact box on the chat screen. Otherwise, you can click the `|←` button on the top right of the screen."
  <https://www.codecademy.com/article/how-to-use-claude-artifacts-create-share-and-remix-ai-content>
- Anthropic 官方帮助中心："An artifact opens in its own window beside your conversation."
  <https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them>
- Anthropic 官方视频（2024-08-27 发布，官方频道）："With Artifacts, you have a dedicated window to instantly see, iterate, and build on the work you create with Claude."
  <https://www.youtube.com/watch?v=vUdNaAAc4FY>

`未证实`：官方文档没有逐字写"自动打开"。"自动打开"目前只有第三方分步截图（Codecademy 的 "automatically rendered on the right side"）与上面 Anthropic 官方截图的画面状态支持，属间接证据。

## 3. 卡片本身的形态

**结论：卡片 = 一条圆角描边行；左上加粗标题（artifact 名），下面一行灰色小字是自由提示文案，右侧一块带轻微透视倾斜的实时缩略图；面板头部集中了全部操作控件（Preview / Code 切换、版本徽标下拉、刷新、Publish、Copy ⌄、关闭）。**

证据：

- 卡片本体：`claude-inline-card.png` —— `Codecademy Logo in CSS`（标题）/ `Interactive artifact`（灰色副标题）/ 右侧白底、带倾斜透视的 logo 缩略图。
- 面板头部（从左到右）：眼睛图标（Preview）、代码括号图标（Code）、`v2 · Latest` 下拉、刷新图标、`Publish`、`Copy ⌄`、`X`——见 `claude-side-panel-and-card.png`。
- 聊天列顶部另有一行 `CSS-based Codecademy Logo ⌄`（artifact 名 + 下拉）——见 `claude-inline-card.png`、`claude-side-panel-and-card.png`。`未证实`：该下拉的确切功能（切换显示哪个 artifact / 还是切版本）没有找到可读文档。
- `Copy` 右侧的 `⌄` 是下载入口（Codecademy："we can download the artifact code using the `⌄` button on the right of the `Copy` button"，并按类型给出 "Download as py" 之类项）。
  <https://www.codecademy.com/article/how-to-use-claude-artifacts-create-share-and-remix-ai-content>
- 版本切换不在卡片上：在面板头部 `v2 · Latest`（`claude-version-dropdown.png`）。

关键澄清（与"类型标签"的预期相反）：那个灰色副标题位置**不是**"代码/HTML/SVG/React"固定分类徽章，而是随场景变化的提示文案：

- `Interactive artifact` —— 见 `claude-inline-card.png` / `claude-side-panel-and-card.png`
- `Click to open image` —— PCMag 转载的 Anthropic 官方截图（`8-bit style crab SVG` 卡）
  <https://www.pcmag.com/news/anthropic-brings-artifacts-split-screen-view-to-all-claude-users>

`未证实`：是否存在按 artifact 类型变化的固定徽章集合。另有一个无缩略图、改为左侧小图标的卡片变体（同 PCMag 截图），无法确认是历史版本还是特定类型专属。

## 4. 多次修改同一个 artifact

**结论：每轮各出一张卡片（标题会随内容变化），不是"一张卡 + 小字已更新"；面板始终显示最新版并带 `vN · Latest` 徽标，历史版本在面板头部的版本下拉里。**

证据：

- `claude-side-panel-and-card.png`：第 2 轮助手消息里是一张**新的**卡片，标题已变成 `Codecademy Logo in CSS with Capitalized First Letter`；同一画面右侧面板头部是 `v2 · Latest`。
- `claude-version-dropdown.png`：点开 `v2 · Latest` 后列出 `Version 2 - Latest`（带对勾）与 `Version 1`。
- Codecademy 原文："Claude saves all the versions of the artifact after each edit. We can select and view any version of the artifact created in a chat using the versions dropdown." 以及 "only version 2 of the artifact will be publicly available, as it was selected while publishing."
  <https://www.codecademy.com/article/how-to-use-claude-artifacts-create-share-and-remix-ai-content>

`未证实`：

- 第 1 轮的旧卡片在后续轮次里是否**逐条**保留在对话流中（没有一张截图同时拍到两轮卡片）。
- 版本历史的入口口径冲突：Codecademy 说在面板头部 "versions dropdown"（截图为证），另有第三方称在 "three-dot menu" 下（<https://www.ai-toolbox.co/claude-management-and-productivity/how-to-use-claude-artifacts-guide-2026>）。按截图采信前者。

## 5. 移动端 / 窄屏

**结论：窄屏下卡片同样是全宽内联在助手文字之间；点开后不是并排面板，而是半屏浮层，浮层底部有 `2 of 2` + ←/→ 翻版本。**

证据：

- `claude-mobile-inline-card.jpg`（iPhone 实机截图）：聊天里是 `📄 Yellow Circle on Blue Background SVG` 全宽一行；下方浮层显示 `Yellow Circle on Blue Background SVG` + `…` 菜单 + 渲染出的 SVG（黄圆蓝底），浮层底部是 `2 of 2` 与 `← →`。
  来源文章：<https://www.pocket-lint.com/anthropic-makes-claude-ai-artifacts-available-for-free>
- Anthropic 官方："Today, we're making Artifacts available for all Claude.ai users. In addition, you can now create and view Artifacts on our iOS and Android apps."
  <https://www.youtube.com/watch?v=vUdNaAAc4FY>
- 佐证（同形态描述）："Claude Artefacts are now being opened in a half screen pop up by default, instead of a full screen. They still can be expanded to full screen."
  <https://www.threads.com/@testingcatalog/post/C-Tb2EIAZCO>

`未证实`：

- 当前官方帮助中心对移动端的口径是 "view the result in the **Artifacts** tab"，与截图里的半屏浮层不完全一致（可能是入口描述与实际渲染描述之别）。
  <https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them>
- 有用户报告移动端在某些情况下不渲染 artifact（仅代码块），与上述截图冲突，无法判定适用范围。
  <https://www.reddit.com/r/ClaudeAI/comments/1t9t4z5/why_is_no_one_talking_about_the_fact_that>

## 6. 与"文件"的对比

**结论：形态不同。生成的文件在对话里是一行"文件行"——左文档图标 + 加粗文件名 + 灰色类型行（如 `Document · PDF`）+ 右侧 `Download` 按钮；没有缩略图预览，不版本化、不 remix。**

证据：

- `claude-file-card-download.png`（从新闻报道配图中裁出的真实产品界面截图，未做内容改动）：助手消息末尾一条描边行 = 文档图标 / `Seoul Eats Food Truck report` / `Document · PDF` / 右侧 `Download`。原图：<https://www.bgr.com/img/gallery/claude-can-now-create-pdf-word-and-excel-files-for-you/intro-1757419973.jpg>
- Anthropic 官方发布页设置项原文："**Upgraded file creation and analysis** — Allow Claude to create and edit docs, spreadsheets, presentations, PDFs, and data reports on web and desktop. **Does not support versioning or remixing of Artifacts.**"
  <https://www.anthropic.com/news/create-files>（截图资产：`https://cdn.prod.website-files.com/68a44d4040f98a4adf2207b6/68e95d910d03dc12cdc4df7c_1cbf5333ab0784b215a2450fb8dd95cd2e207aea-3840x2160.png`）
- 两个官方帮助页的措辞本身就是区分：文件是 "Claude will generate the file, which you can then **download** directly from the conversation"（<https://support.claude.com/en/articles/12111783-create-and-edit-files-with-claude>）；artifact 是 "opens in its own window **beside** your conversation"（<https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them>）。
- 二手佐证（文件行在对话里 + 悬停出现下载按钮）：第三方教程转述 "When Claude generates a downloadable file, it usually appears as an attachment or file card directly inside the chat… You'll notice a download icon or a button labeled download." <https://www.youtube.com/watch?v=zx0qkdrw9cI>

`未证实`：

- 文件行与 artifact 卡片是否共用同一 UI 组件（两者视觉高度相似：都是描边行 + 图标 + 标题 + 副标题）。
- 较新的文件生成流程里，对话流改成了"工具步骤列表"（每步一行、带 `⌄` 折叠、右侧文件预览面板带 "Download the file to view all formatting" 提示），与上图的单行文件行关系不明。

---

## 截图清单

| 文件 | 证明什么 |
| --- | --- |
| `claude-inline-card.png` | 卡片插在助手文字**中间**（上方有引入句、下方还有 bullet 列表）；面板关闭后卡片保留为入口；卡片 = 标题 + 灰色提示文案 + 右侧倾斜缩略图 |
| `claude-side-panel-and-card.png` | 右侧面板与卡片并存；面板头部全部控件（Preview/Code、`v2 · Latest`、刷新、`Publish`、`Copy ⌄`、`X`）；第 2 轮另出一张**新标题**的卡片；操作行在消息最末尾 |
| `claude-version-dropdown.png` | 版本历史在面板头部下拉里：`Version 2 - Latest` / `Version 1` |
| `claude-mobile-inline-card.jpg` | 窄屏 = 全宽内联卡片 + 半屏浮层（含 `2 of 2` 与 ←/→ 翻版本） |
| `claude-file-card-download.png` | "文件"是另一种形态：图标 + 文件名 + `Document · PDF` + `Download`，无缩略图、无版本 |

来源：`claude-*.png`（前三张）取自 Codecademy 分步教程实拍（<https://www.codecademy.com/article/how-to-use-claude-artifacts-create-share-and-remix-ai-content>，原始资产 `https://static-assets.codecademy.com/claude-artifacts/7_hidden_artifact.png`、`11_edit_artifact.png`、`13_artifact_versions.png`）；`claude-mobile-inline-card.jpg` 取自 Pocket-lint 文章；`claude-file-card-download.png` 取自 BGR 报道配图的裁切。
