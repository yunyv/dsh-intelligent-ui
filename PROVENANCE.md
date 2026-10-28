# 第三方代码出处

规则：`vendor/` 下只放**原样未改**的上游副本，改动一律发生在 `src/`。
每次 vendor 必须记录上游仓库、commit、许可，以及我们改了什么。

| vendor 路径 | 上游 | commit | 许可 | 我们的改动 |
|---|---|---|---|---|
| `vendor/dil-replica/` | [Disdjj/intelligent-ui-demo](https://github.com/Disdjj/intelligent-ui-demo) 的 `replica/` | `938ab09f8870b22a260b4b80d8c55484f6451cb2` | MIT | 无（原样存放）。实际采用时在 `src/` 侧适配 |

## 数学组件的构建输入

`@mathjax/src@4.1.3` 与 `@mathjax/mathjax-newcm-font@4.1.3` 是精确锁定的构建依赖，
原包不改动、不放入 `vendor/dil-replica/`。`src/client/dil/math/` 使用 direct ESM 接口，
预载完整 40 个 NewCM SVG 字体数据分片；构建脚本将引擎与数据生成一个独立 Worker 的
IIFE 字符串，再由宿主客户端携带。执行 DIL 程序的原 Worker 和线协议不变。

本地适配包括：列模板重复的分配前限额、SafeHandler 过滤、请求级 TeX 状态隔离、
根 SVG 的 ex→em 换算、请求内自然宽度／标签／显式行距布局、布局残留清理、受限
SVG 词法与双重几何预算，以及宿主取消／超时调度；没有修改原始字形路径。
来源包的版本／完整性由锁文件记录，生成 Worker 另记 SHA-256。

本插件原样分发这两个固定包的已发布产物：不重新生成或改写任何字形轮廓，也不含
原 OTF／WOFF2 文件，只有 NewCM 的 SVG 字形路径。MathJax 核心代码为 Apache-2.0，
十种上游版权原文逐条保留在 Worker 横幅和第三方通知中；字体的署名与 GUST／LPPL
声明按上游制品保留，并随包附完整许可正文。完整通知与许可文本见
[`assets/math/THIRD_PARTY_NOTICES.md`](assets/math/THIRD_PARTY_NOTICES.md)。

## 计划 vendor（尚未落地）

| 用途 | 上游 | 许可 |
|---|---|---|
| 逃生舱的 iframe 沙箱桥 | [JetBrains/websandbox](https://github.com/JetBrains/websandbox) | Apache-2.0 |
| 逃生舱的流式顺序与防闪渲染 | [CopilotKit/OpenGenerativeUI](https://github.com/CopilotKit/OpenGenerativeUI) | MIT |
| 产物落盘与版本历史的数据模型 | [coda0HQ/open-artifacts](https://github.com/coda0HQ/open-artifacts) | MIT |

## 基线

`src/` 的初始内容来自本地前身工程 `../dsh-artifacts-live`
（基线提交见该仓库；此前无 git 历史）。在此之上做 DIL 管线改造。

## 注意

`vendor/dil-replica/` 是对 ChatGPT Intelligent UI（内部代号 DIL）协议的**独立重实现**，
不含 OpenAI 的运行时代码（上游已声明）。上游为 0★、1 天龄的研究性仓库，
我们接盘其 bug；其 98 个测试一并纳入本项目测试套件，作为敢接盘的依据。
