# 已验证环境事实

范围：本机 DSH 桌面版 0.2.0-rc.2，desktop profile 自用，不做分发。

## 平台

- profile 目录 `~/.dsh/profiles/desktop`，Electron 主进程写死：`resolveDesktopPaths()` → `join(dshHome, "profiles", "desktop")`。
- desktop profile 就是一个 web profile：`PROFILE_TEMPLATES.web = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`。
- 宿主进程由主进程拉起：`spawn(node, ["--expose-internals", <runtime>/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js, runtimeDir, projectDir, primaryRuntime, pnpm, nodeBin], { cwd: projectDir })`。
- GUI 地址 `127.0.0.1:19387`。

## 装插件：实测可热生效，不需要重启 App

```
plugin_manager install_bundle  target=@nagi-ovo/dsh-visualize
→ stage=enable, application=applied, changed=true
```

profile 变更点：`package.json` 的 `dsh.profile.bundles` 追加包名，`dependencies` 追加依赖。

两半都要独立验证，缺一不可：

1. 客户端半：`cordis_inspect_query client/Slots/listSubTree root=tool.call.toolview` → `selected.occupants` 出现 `{registrant:"dsh-visualize", key:"visualize", active:true}`。
2. 宿主半：`cordis_inspect_query host/Tool/listTools` → 工具名出现；再真实调用一次，产物落盘且字节数与回报一致。

只看到 tools 列表有名字不够，只看到槽位占用也不够。

## 回滚

- 桌面版内置「禁用第三方插件、备份 profile patch 并重启」恢复入口：备份 `cordis.patch.yml` 为 `.bak-<时间戳>`，bundles 重置回 web 模板。
- patch 匹配不上 → warn + skip；bundle 加载失败 → 汇报一次，其余 bundle 照常生效。

## 构建

- 运行时不含 `.d.ts`（asar 内 290 个 `@deepseek-ai/*` 包，0 个 `.d.ts`），不能拿 asar 做类型检查。
- npm 上 `@deepseek-ai/*` 有完整 `0.2.0-rc.2`，带 `lib/types/*.d.ts` 并导出 `./src/*`。用精确版本做 devDependencies 即可 typecheck，无需 clone 仓库：
  - `@deepseek-ai/dsh-tools@0.2.0-rc.2` → `exports["."] = { types: "./lib/types/index.d.ts" }`，另有 `./presentation`、`./types`、`./invariant`。
  - `@deepseek-ai/dsh-client-ui-slots@0.2.0-rc.2` → `exports["."] = { types: "./lib/types/index.d.ts" }`。

## 客户端扩展点（live 槽位树实测）

- `tool.call.toolview`：keyed，key 是 wire tool 名。ownerProps = `ToolCallCommonProps & ToolCallPhaseProps`，`phase ∈ preparing | start | result`；流式参数用 `useToolCallArgumentsPartial`。注册已占用的 key 会替换该视图；未认领的 key 走 generic 行。
- 其他可用：`conversation.chat.turnTail`、`conversation.chat.assistant-actions`、`sidebar.right.pane.tab`、`sidebar.right.pane.tab.title`、`sidebar.right.tab.document`、`shell.overlay`。
- `sidebar.right.pane.tab` 的注册是开放的；「由插件主动打开标签」的 API（asar 文档注释里出现过 `ctx.sidebarRight.openTab`）在客户端 Service 目录里查不到，**未验证**。
- 不存在：`fence-registry`（app.asar 0 命中）。`presentResult` 29 命中，`tool.call.toolview` 92 命中。

## 主题桥（可直接抄）

`@nagi-ovo/dsh-visualize` 的 iframe 主题 token：`--background`、`--foreground`、`--card`、`--card-foreground`、`--muted-foreground`、`--border`、`--primary`、`--primary-foreground`、`--viz-series-1`…`--viz-series-6`。

工具类：`.card`、`.viz-stat`、`.viz-grid`、`.viz-row`、`.viz-controls`、`.viz-badge`、`.btn` / `.btn-primary` / `.btn-ghost`、`.form-label` / `.form-control` / `.form-select` / `.form-check`、`.text-small`。

本地参考文件：`~/.dsh/profiles/desktop/node_modules/@nagi-ovo/dsh-visualize/assets/references/design.md`。
