# Journal - hxx (Part 2)

> Continuation from `journal-1.md` (archived at ~2000 lines)
> Started: 2026-07-30

---



## Session 59: 修复 Pi 终端兼容与本地历史恢复

**Date**: 2026-07-30
**Task**: 修复 Pi 终端兼容与本地历史恢复
**Branch**: `master`

### Summary

按职责拆分 Pi IME、ANSI 转换、诊断与门面；补齐 PTY truecolor/WSLENV，并使用 pi --session 精确恢复本地历史会话。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `68c2a0d1` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 60: 修复 Pi 输入法编辑器锚点

**Date**: 2026-07-30
**Task**: 修复 Pi 输入法编辑器锚点
**Branch**: `master`

### Summary

Pi 通过可见 viewport 成对横线识别无提示符编辑器，组合文字锚定输入行、候选框锚定下边框，并补齐全屏、缩放、滚动和非 Pi 回归。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c6eed21e` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 61: Hook 任务栏提醒与安装状态检测修复

**Date**: 2026-07-30
**Task**: Hook 任务栏提醒与安装状态检测修复
**Branch**: `master`

### Summary

为 Windows Hook 增加独立任务栏闪烁提醒与聚焦停止逻辑，补齐设置迁移、同步、双语 UI 和 Rust 参数测试；桥接关闭后仍可统一刷新并查看四种 CLI 的真实安装状态。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `51566bdb` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 62: 终端 Pane 状态标记与内容区边界修复

**Date**: 2026-07-30
**Task**: 终端 Pane 状态标记与内容区边界修复
**Branch**: `master`

### Summary

新增 Pane 焦点与 Hook 状态线条标记，并修复标记错误包围 Tab 栏的问题：覆盖层改为挂载在终端内容容器，设置预览、测试、组件规范、功能清单和变更日志同步更新。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `04055b45` | (see git log) |
| `fe9e214c` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 63: 调整 Pane 完成状态默认颜色

**Date**: 2026-07-30
**Task**: 调整 Pane 完成状态默认颜色
**Branch**: `master`

### Summary

将终端 Pane 标记的完成状态默认颜色从 #8FBF7F 调整为 #51A0CC，同步回归断言、前端组件规范、V1.3.3 变更日志与功能清单；保留现有 Tab/Workspan 圆点颜色。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `eca51e4c` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 64: 纠正 Pane 默认焦点边框颜色

**Date**: 2026-07-30
**Task**: 纠正 Pane 默认焦点边框颜色
**Branch**: `master`

### Summary

按截图澄清，将 #51A0CC 用于焦点 Pane 的默认边框及三种样式预览，完成状态默认色恢复为 #8FBF7F；同步测试、前端组件规范、V1.3.3 变更日志与功能清单。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `bdf0ec49` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 65: 单 Pane 布局隐藏状态标记

**Date**: 2026-07-30
**Task**: 单 Pane 布局隐藏状态标记
**Branch**: `master`

### Summary

Pane 标记增加当前可见分屏判定：单 Pane 即使包含多个 Tab 或 Hook 状态也不显示线条；真正分屏、深层分屏及分屏后的 Pane 全屏继续显示。同步回归测试、组件规范、V1.3.3 变更日志与功能清单。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `396d1c38` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 66: 简化终端状态标记设置

**Date**: 2026-07-30
**Task**: 简化终端状态标记设置
**Branch**: `feat/terminal-status-marker-settings`

### Summary

设置区块由 Pane 状态标记更名为终端状态标记，补齐中英文标题、描述和 ARIA；移除 Tab 框线选项，仅保留完整边框与顶部标记，旧 tab-frame 配置自动迁移到 tab-top。同步测试、组件规范、V1.3.3 变更日志与功能清单。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c525a6c8` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 67: 兼容 Grok TUI 鼠标交互

**Date**: 2026-07-30
**Task**: 兼容 Grok TUI 鼠标交互
**Branch**: `master`

### Summary

将 xterm 鼠标协议策略拆分到独立浏览器模块，允许 Grok 等鼠标型 TUI 接收普通点击和拖动；补充回归测试、V1.3.3 Changelog 与前端终端契约。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `151a7118` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 68: 统一终端粘贴图片存储目录

**Date**: 2026-07-30
**Task**: 统一终端粘贴图片存储目录
**Branch**: `master`

### Summary

将终端剪贴板图片统一保存到用户数据目录 .cli-manager/attachments，保留大小限制、文件名去重与两天清理策略，并更新 V1.3.3 变更记录和后端持久化契约。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `7b977c45` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 69: SSH 任意文件粘贴

**Date**: 2026-07-31
**Task**: SSH 任意文件粘贴
**Branch**: `feat/ssh-agent`

### Summary

SSH Agent 0.1.7 / protocol 1.10 支持任意普通文件粘贴与拖拽，固定 20 MiB 上限，保留旧 Agent 图片回退兼容。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `9cfdd10b` | (see git log) |

### Testing

- [OK] 用户已验证任意小文件粘贴成功

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 70: 项目右键菜单增加外部终端入口

**Date**: 2026-07-31
**Task**: 项目右键菜单增加外部终端入口
**Branch**: `master`

### Summary

普通项目右键菜单新增显式外部终端入口，复用项目路径、Shell 与 CLI 启动命令，并避免在精简或全局外部终端模式下重复显示；补充回归测试、V1.3.3 Changelog 与功能清单。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `8e0eefc0` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 71: 容忍 Hook 配置目录失效

**Date**: 2026-07-31
**Task**: 容忍 Hook 配置目录失效
**Branch**: `master`

### Summary

Claude、Codex、Pi、Grok 的非强制配置目录解析在已选目录失效时返回缺失，避免阻断共享状态刷新及其他工具操作；保留目标工具明确安装或卸载时的校验，并补充回归测试、V1.3.3 变更记录和 Hook 契约。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `0321d7a8` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 72: 增加资源持续上涨诊断日志

**Date**: 2026-07-31
**Task**: 增加资源持续上涨诊断日志
**Branch**: `master`

### Summary

增加独立 JSONL 资源诊断日志，覆盖进程与 WebView 周期快照、终端输出积压告警和恢复状态；复用 10 MiB/7 天轮转并补齐回归测试与 V1.3.3 变更记录。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ce3c9360` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 73: 修复终端光标原生显隐

**Date**: 2026-07-31
**Task**: 修复终端光标原生显隐
**Branch**: `master`

### Summary

移除通用 DECTCEM 延迟拦截和 Codex 专用光标实验，保留 Claude 背景图下的单格反色软件光标，并补充回归测试与前端规约。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `5f562763` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 74: 修复远程连接设置页面响应式布局

**Date**: 2026-08-06
**Task**: 修复远程连接设置页面响应式布局
**Branch**: `master`

### Summary

完成 cc-connect 设置页流式宽度和窄屏换行；更新 V1.3.5 变更日志与前端响应式布局规约；npx tsc --noEmit、git diff --check 通过。保留现有 Pi 任务未解决状态，不归档。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `89c84ce2` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 75: 新增 Codex 运行时光标隐藏开关

**Date**: 2026-08-06
**Task**: 新增 Codex 运行时光标隐藏开关
**Branch**: `master`

### Summary

在 Windows 开发者设置中新增默认关闭的隐藏 CODEX 运行时光标开关，复用 V1.3.0 前 80ms 光标显示合并逻辑，仅对 Codex 会话生效；补齐中英文文案、设置持久化、文档和回归检查。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `66e71e22` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 76: 修复 Codex 光标隐藏未生效

**Date**: 2026-08-06
**Task**: 修复 Codex 光标隐藏未生效
**Branch**: `master`

### Summary

定位并修复 Codex 光标隐藏开关未生效：首帧 Codex 输出在写入前锁存识别结果，重新 focus 的全部路径重新应用 CSI ?25l；同步更新终端契约、变更记录、功能清单和回归断言。类型检查与 21 个相关测试通过。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `4a605543` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 77: 修复 Tab 图标在项目 CLI 工具变更后不刷新

**Date**: 2026-08-07
**Task**: 修复 Tab 图标在项目 CLI 工具变更后不刷新
**Branch**: `master`

### Summary

项目 cli_tool 从 codex 改为 opencode 后，已启动会话的 Tab 图标不更新——因 inferSessionVendor 只读 session.startupCmd，不参考 project.cli_tool。改为 project 优先 + session 兜底，与 buildTerminalTabHoverInfo 已有模式一致。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `9bf48abf` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 78: 支持 Windows 便携版与自定义数据目录

**Date**: 2026-08-07
**Task**: 支持 Windows 便携版与自定义数据目录
**Branch**: `master`

### Summary

实现 Windows 便携版、自定义数据根目录、迁移重启和便携更新分流，并修复 Windows verbatim 路径导致 SQLite URL 启动失败。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `eafe5da3` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 79: 补齐 Tab CLI 工具图标并新增 Kimi

**Date**: 2026-08-07
**Task**: 补齐 Tab CLI 工具图标并新增 Kimi
**Branch**: `master`

### Summary

OpenCode/Pi/Amp/Aider/Crush/Cline/Goose 等无厂商归属的 CLI 工具在 Tab 上不显示图标——Tab 只用 VendorIcon，这些工具 descriptor 的 vendor 为 null。改为厂商图标 -> CLI 工具图标 -> 无 的回退链，新增 cliToolIcon prop 贯穿 SortableTab/SortableWorkspanTab/DragOverlayTab。同时新增 Kimi CLI 工具（命令 kimi，vendor kimi，LobeHub Kimi 彩色图标），暂不接入历史解析。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `d6036889` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
## Session 80: 同步 master 并发布版本 1.3.5

**Date**: 2026-08-10
**Task**: 同步 master 并发布版本 1.3.5
**Branch**: `master`

### Summary

拉取 origin/master，将 package.json、package-lock.json、src-tauri/Cargo.toml、Cargo.lock 和 tauri.conf.json 的应用版本统一更新为 1.3.5；cargo check 通过，版本一致性校验通过，未推送远端。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `eabf83fc` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 81: 优化历史会话索引数据库体积

**Date**: 2026-08-12
**Task**: 优化历史会话索引数据库体积
**Branch**: `master`

### Summary

新建并完成 Trellis 任务：将历史 catalog FTS 升级为 detail=none，使用三元组候选加正文连续匹配，兼容 v5→v6 迁移并回收碎片；156 个 history 测试、cargo check 和 fmt 检查通过。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `d6e10b19` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 82: 修复历史索引压缩迁移检测

**Date**: 2026-08-12
**Task**: 修复历史索引压缩迁移检测
**Branch**: `master`

### Summary

确认发布后打开历史 catalog 会自动检查 user_version 与真实 FTS schema；修复版本号已为 6 但 FTS 仍为旧 detail 模式时跳过迁移的问题。新增真实 schema 检测和回归测试，更新历史索引契约与 TEMP changelog；cargo fmt、cargo check、cargo test history 157/157 通过。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ad1e2a26` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 83: 修复 Codex 供应商启动覆盖真实 Home

**Date**: 2026-08-06
**Task**: 修复 Codex 供应商启动覆盖真实 Home
**Branch**: `feat/native-provider-management`

### Summary

修复原生 Codex 全局、项目与 Worktree 供应商启动错误替换 CODEX_HOME 的回归；全局使用真实 Home，scope 使用安全配置覆盖与子进程密钥，恢复 MCP、Hook、沙箱、历史和实时统计链路。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `b8a41dee` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 84: 修复 Grok 供应商真实 Home 启动

**Date**: 2026-08-06
**Task**: 修复 Grok 供应商真实 Home 启动
**Branch**: `feat/native-provider-management`

### Summary

修复 Grok 全局、项目、Worktree 与显式供应商启动覆盖 GROK_HOME 的回归；改用进程级 endpoint/key/model 覆盖，恢复 Hook、MCP、历史与实时统计可见性，并补齐跨层测试和供应商合同。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `f38bd412` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 85: 修复 Grok Home 隔离并恢复旧会话

**Date**: 2026-08-06
**Task**: 修复 Grok Home 隔离并恢复旧会话
**Branch**: `feat/native-provider-management`

### Summary

所有供应商作用域保留真实 GROK_HOME；endpoint/key/model 改用进程级覆盖，并在清理旧快照前备份和恢复历史会话。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `f38bd412` | (see git log) |
| `f4ae4c5e` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 86: 修复 Grok 会话历史路径并提交任务

**Date**: 2026-08-07
**Task**: 修复 Grok 会话历史路径并提交任务
**Branch**: `feat/native-provider-management`

### Summary

修复 Grok 历史读取把 sessionRoot 重复追加 sessions 的根因；统一默认与显式 session root，补充回归测试、规范、变更日志和产品文档，并提交对应 Trellis 任务。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `0fc7f495` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 87: 修复 Diff 回退确认与折叠项目交互

**Date**: 2026-08-13
**Task**: 修复 Diff 回退确认与折叠项目交互
**Branch**: `master`

### Summary

修复 Diff 文件级与代码块级回滚确认层级导致的卡死/不可见问题；统一折叠侧边栏项目的 CLI 图标、单击跳转、双击启动行为并提高浮层不透明度；同步中英文文案、规格、功能清单与 V1.3.6 变更记录。通过 npx tsc --noEmit 与 git diff --check。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `47661dcc` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 88: 修复供应商作用域与 Pi 终端诊断

**Date**: 2026-08-17
**Task**: 修复供应商作用域与 Pi 终端诊断
**Branch**: `master`

### Summary

修复供应商生命周期引用扫描、项目作用域切换、Grok 项目级提示、Tab 中键关闭、Pi 预览、Pi Hook 非阻塞上报与 MCP Adapter 能力发现。

### Git Commits

| Hash | Message |
|------|---------|
| `3207bc68` | (see git log) |

### Status

[OK] **Completed**


## Session 89: 修复 SSH Grok 会话历史打开提示

**Date**: 2026-08-18
**Task**: 修复 SSH Grok 会话历史打开提示
**Branch**: `master`

### Summary

SSH Grok 在历史入口改为显示明确的暂不支持提示，避免暴露底层 history_remote_source_required 错误。

### Main Changes

- 将 SSH 会话历史能力限制为远程桥接已支持的 Claude Code 与 Codex CLI。
- 在侧边栏和终端工具栏统一显示 Grok 暂不支持查看会话历史的中英文提示。
- 补充能力矩阵测试、V1.3.7 交付记录和历史契约。

### Git Commits

| Hash | Message |
|------|---------|
| `60372d68` | (see git log) |

### Testing

- [OK] node --test scripts/projectCapabilities.test.mjs scripts/sshRemoteFileContext.test.mjs（5/5 通过）
- [OK] npx tsc --noEmit（通过）
- [OK] npm run build（通过）

### Status

[OK] **Completed**


## Session 90: 历史会话对话消息操作栏

**Date**: 2026-08-18
**Task**: 历史会话对话消息操作栏
**Branch**: `master`

### Summary

对话页复用原文消息操作栏；编辑和插入通过既有闸门后切换原文表单，SSH/快照保持只读，并补齐 V1.3.7 记录与历史会话契约。

### Git Commits

| Hash | Message |
|------|---------|
| `9f8602bb` | (see git log) |

### Status

[OK] **Completed**


## Session 91: Fix PR #219 Kimi cross-platform tests

**Date**: 2026-08-19
**Task**: Fix PR #219 Kimi cross-platform tests
**Branch**: `agent/kimi-code-cli-hooks`

### Summary

Fixed CRLF-safe Kimi frontend test extraction and Unix-only SSH Agent planner coverage; validated and pushed the PR branch for review.

### Git Commits

| Hash | Message |
|------|---------|
| `a9781941` | (see git log) |
| `2152a22d` | (see git log) |

### Status

[OK] **Completed**


## Session 92: 修复 Kimi Hook 本地检测延迟

**Date**: 2026-08-19
**Task**: 修复 Kimi Hook 本地检测延迟
**Branch**: `master`

### Summary

移除本地 Kimi Hook 状态与安装中的 CLI/doctor 子进程检测，修正空配置状态，保留 TOML 原子写入保护，并将 TEMP 发布记录整理到 V1.3.7。

### Git Commits

| Hash | Message |
|------|---------|
| `890f59d4` | (see git log) |

### Status

[OK] **Completed**


## Session 93: Review and harden PR 220 Kimi history

**Date**: 2026-08-20
**Task**: Review and harden PR 220 Kimi history
**Branch**: `pr220`

### Summary

Reviewed PR #220 against current Kimi Code, fixed wire usage parsing, append-only index and tombstone behavior, session-id command validation, added regression coverage, ran full checks, and updated V1.3.7 documentation.

### Git Commits

| Hash | Message |
|------|---------|
| `c52a9b7f` | (see git log) |

### Status

[OK] **Completed**


## Session 94: Fix provider dialog layering and terminal file navigation

**Date**: 2026-08-21
**Task**: Fix provider dialog layering and terminal file navigation
**Branch**: `master`

### Summary

Raised the provider delete confirmation above its parent modal and normalized slash-form Windows file paths at the Explorer boundary, with regression coverage and V1.3.8 release records.

### Git Commits

| Hash | Message |
|------|---------|
| `575f903e` | (see git log) |

### Status

[OK] **Completed**


## Session 95: 修复 PR #224 Grok Hook 配置恢复

**Date**: 2026-08-21
**Task**: 修复 PR #224 Grok Hook 配置恢复
**Branch**: `agent/grok-ssh-hooks-history`

### Summary

修复 Grok 兼容 Hook 卸载覆盖用户配置的问题，补齐 Linux 测试编译与 Windows 测试告警清理，并已推送至 PR #224。

### Main Changes

- Grok compat 配置以 installation id marker 记录原始状态，只恢复本实例持有的 true/缺失值。
- 补充注释、既有 false、外部实例、用户改写、缺失表和 dotted TOML 的回归测试。

### Git Commits

| Hash | Message |
|------|---------|
| `dde0f550` | (see git log) |
| `84326c38` | (see git log) |
| `e4c62bc2` | (see git log) |

### Testing

- [OK] npx tsc --noEmit；cargo check/test；SSH Agent 90 项主机测试；Linux x86_64/aarch64 测试编译；34 项前端脚本测试通过。

### Status

[OK] **Completed**

### Next Steps

- PR #224 仍与 master 冲突；解决冲突并合并后，从上游 master 创建 ssh-agent-v0.1.10 标签。


## Session 96: Fix file preview refresh and file tab menu

**Date**: 2026-08-24
**Task**: Fix file preview refresh and file tab menu
**Branch**: `master`

### Summary

Fixed Markdown preview zoom, persistent local/WSL/SSH file refresh, Markdown table Diff token layout, and terminal-themed file tab close actions.

### Git Commits

| Hash | Message |
|------|---------|
| `9c6aa22d` | (see git log) |

### Status

[OK] **Completed**


## Session 97: History smart-title prompt and responsiveness

**Date**: 2026-08-26
**Task**: History smart-title prompt and responsiveness
**Branch**: `master`

### Summary

Added a global local smart-title prompt, persisted save feedback, non-blocking Provider execution, shared SQLite contention handling, and immediate generation loading feedback.

### Git Commits

| Hash | Message |
|------|---------|
| `65a6b5cf` | (see git log) |

### Status

[OK] **Completed**


## Session 98: 修复 macOS Fcitx5 终端中文重复输入

**Date**: 2026-08-26
**Task**: 修复 macOS Fcitx5 终端中文重复输入
**Branch**: `master`

### Summary

在共享终端输入边界修复 macOS Fcitx5 的同源 CJK 重发，并补齐回归测试与规范。

### Main Changes

- 新增 Process-key 检查点的同源 CJK 去重，覆盖普通 Shell、Codex 与其他内置 CLI。

### Git Commits

| Hash | Message |
|------|---------|
| `b669c1db` | (see git log) |

### Testing

- [OK] node --test scripts/terminalImeInputDedup.test.mjs scripts/terminalImeComposition.test.mjs；npx tsc --noEmit；npm run build。

### Status

[OK] **Completed**

### Next Steps

- 待 macOS + Fcitx5 真机补测中文候选、标点、ASCII、分屏与切换标签场景。


## Session 99: 修复 Grok Build Alt+Enter 换行

**Date**: 2026-08-31
**Task**: 修复 Grok Build Alt+Enter 换行
**Branch**: `master`

### Summary

为 Grok Build 终端补充稳定 CLI 上下文识别，使三种配置的换行组合键在匹配时发送 ESC + CR；普通 Shell、Claude 和 Codex 行为保持不变。

### Main Changes

- 新增 Grok Build 会话上下文分类并接入终端换行字节选择。
- 补充终端回归测试、前端输入契约及 V1.3.9 交付记录。

### Git Commits

| Hash | Message |
|------|---------|
| `f175f706` | (see git log) |

### Testing

- [OK] node --test scripts/terminalNewlineShortcut.test.mjs；npx tsc --noEmit。
- [OK] 相关鼠标、OSC 52、OpenCode 终端测试通过；完整脚本测试存在既有无关静态契约失败。

### Status

[OK] **Completed**

### Next Steps

- 人工在 Grok Build 项目终端中分别验证 Alt+Enter、Shift+Enter、Ctrl+Enter 换行且不提交。


## Session 100: 修复 Grok Build Alt+Enter 换行并合并 PR #240

**Date**: 2026-08-31
**Task**: 修复 Grok Build Alt+Enter 换行并合并 PR #240
**Branch**: `master`

### Summary

修复 Grok Build 本地、WSL 与 SSH 终端的 Alt+Enter 换行；补充精确命令识别、当前 TUI 提示门控和原生 Alt+Enter 透传，合并远程 PR #240，完成 issue #236 关联。

### Git Commits

| Hash | Message |
|------|---------|
| `f6b8ca66` | (see git log) |
| `66ba0fba` | (see git log) |

### Status

[OK] **Completed**


## Session 101: 终端滚动到底部快捷跳转按钮

**Date**: 2026-08-31
**Task**: 终端滚动到底部快捷跳转按钮
**Branch**: `master`

### Summary

实现终端非底部滚动时的底部快捷跳转按钮；复用 xterm Buffer 状态、终端主题和字号控件布局，补齐中英文文案、静态回归测试、V1.3.9 变更记录与前端规范。

### Git Commits

| Hash | Message |
|------|---------|
| `37cc08a3` | (see git log) |

### Status

[OK] **Completed**


## Session 102: 终端滚动快捷键

**Date**: 2026-08-31
**Task**: 终端滚动快捷键
**Branch**: `master`

### Summary

为终端滚动到底部功能增加可配置的 Ctrl+End、PageUp、PageDown 快捷键；普通缓冲区按页滚动，alternate buffer 保留给全屏 TUI；补齐中英文设置文案、测试、V1.3.9 变更记录与前端规范。验证通过 tsc、build 和相关终端测试；完整终端测试仍有既有 terminalCursorMovement 缺失文件失败。

### Git Commits

| Hash | Message |
|------|---------|
| `7ce0c105` | (see git log) |

### Status

[OK] **Completed**


## Session 103: SSH Agent SFTP 发布与远程目录选择器

**Date**: 2026-09-01
**Task**: SSH Agent SFTP 发布与远程目录选择器
**Branch**: `master`

### Summary

完成 SSH 文件浏览器 SFTP 入口与 Host 面板复用；增加远程目录选择器，支持手动输入、子目录导航、返回上级、刷新和选择当前目录。Agent 升级到 0.1.13 / protocol 1.14，新增 fileGet/fileDelete，完成前端构建、Rust 检查和 Agent 测试，并推送 ssh-agent-v0.1.13 触发 GitHub 预发布。

### Git Commits

| Hash | Message |
|------|---------|
| `4601e769` | (see git log) |

### Status

[OK] **Completed**


## Session 104: Fix Codex CLI output recovery

**Date**: 2026-09-03
**Task**: Fix Codex CLI output recovery
**Branch**: `master`

### Summary

Fixed Issue #245: hardened terminal output scheduling and daemon ACK recovery; separated checkpoint snapshots from live frames, detected spool truncation gaps and reused reconnect replay_reset recovery, moved spool reads outside the global clients lock, and added regression tests plus V1.3.9 documentation.

### Git Commits

| Hash | Message |
|------|---------|
| `c51a0bcf` | (see git log) |

### Status

[OK] **Completed**
