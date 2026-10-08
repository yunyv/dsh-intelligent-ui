# 第三方代码出处

规则：`vendor/` 下只放**原样未改**的上游副本，改动一律发生在 `src/`。
每次 vendor 必须记录上游仓库、commit、许可，以及我们改了什么。

| vendor 路径 | 上游 | commit | 许可 | 我们的改动 |
|---|---|---|---|---|
| `vendor/dil-replica/` | [Disdjj/intelligent-ui-demo](https://github.com/Disdjj/intelligent-ui-demo) 的 `replica/` | `938ab09f8870b22a260b4b80d8c55484f6451cb2` | MIT | 无（原样存放）。实际采用时在 `src/` 侧适配 |

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
