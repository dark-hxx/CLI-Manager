# V1.4.2 修复验证

## 根因与修复

全局 `window` 捕获监听器在 xterm 之前匹配 Shift Tab 绑定，提前取消默认输入并可能切换活动标签；终端内部已有的 Codex 放行不能撤销这一步。修复在 `useKeyboardShortcuts.ts:66` 按真实 `.xterm` 目标让行仅带 Shift 的左右方向键，避免全局动作，并保留终端内部的 Codex/普通 shell 分流。

`preventDefault` 不等于 `stopPropagation`。此前单会话复现证明默认取消，多会话复现证明 Tab 动作，不据此声称每个环境的 xterm 都收不到事件。

## 发现清单与交付范围

| 触点 | 处理与核查 |
| --- | --- |
| 全局快捷键 `useKeyboardShortcuts` | 提前判定终端目标；所有全局动作之前让行 Shift+左右，其他修饰键保持原路由。 |
| 设置预设 / 逐项录制 / Settings Store | 共用既有绑定映射；中英文说明终端内用途与 Shift 的终端外范围，存储结构无改动。 |
| xterm 自定义回调 / Input 选区 | 沿用现有 Codex 放行与清理选区、普通 shell 选区逻辑；测试串起全局与终端处理器。 |
| App / 文件编辑器 / 设置录制 | App 继续注册同一 Hook；共享 eventToCombo 和 isShortcutMatch 语义保持原样。 |
| PTY / ConPTY / 输入编码 | 前期隔离验证保留 Shift；本次真实 xterm 验证发送一次原生转义序列，无 Rust 改动。 |
| Web / Hook / 恢复 / 数据库 / 环境 | 确认不参与新优先级判定，保持原实现。 |
| 交付记录与契约 | CHANGELOG 的 V1.4.2、功能清单的 Codex 提问板块、输入选区契约同步更新。 |

实际修改范围为设计列出的七个文件及当前任务文档。AGENTS.md / CLAUDE.md 无内容差异；其他 checkout 和运行中的应用未修改。

## 自动验证结果

| 验证 | 结果 |
| --- | --- |
| 新回归测试先于产品修复运行 | 43 项中 18 项按预期失败，均涉及终端 Shift 绑定被全局处理；其余 25 项通过。 |
| `node --test --test-reporter=spec scripts/codexQueuedQuestionShortcut.test.mjs scripts/terminalNewlineShortcut.test.mjs scripts/codexManualInput.test.mjs` | 65/65 通过。 |
| 隔离 headless Edge + 安装的真实 xterm + 源码中的两层处理器 | 20/20 通过，无页面错误。 |
| `npx tsc --noEmit` | 通过，退出码 0。 |
| `npm run check:architecture -- --strict` | 通过：1264 个源文件，0 个超过 2000 行，0 个新增违规。 |
| `git diff --check` | 通过，退出码 0；仅有工作区 LF/CRLF 转换提示。 |
| 手工差异审阅 | 七个约定文件；必要注释、双语键名、公开接口和修饰键范围一致。项目没有独立 lint 脚本。 |

新增测试执行真实全局 Hook 并核查 capture 注册，随后调用真实 xterm 回调。覆盖左右方向键、单/多会话、Codex/shell、空输入/草稿、终端 textarea/容器、终端外控件与编辑器、逐项录制的全局动作、Alt/Ctrl/复合修饰键、普通方向键、Ctrl+W 以及紧凑模式。

浏览器测试用真实键盘事件验证全局监听器之后 `defaultPrevented=false`；Codex 路由下左键产生且仅产生 `\x1b[1;2D`，右键产生且仅产生 `\x1b[1;2C`。终端内没有 Tab/调色板等全局动作；普通 shell 仍调用选区入口，终端外仍可触发 Tab 动作。CLI 身份和 Input 选区控制器为桩，浏览器测试不代表已验证真实 Codex 提问窗口或选区视觉。

## GitNexus 结果的边界

编辑前文件级 upstream 分析为 CRITICAL：4 个直接导入文件、59 条关联流程、20 个模块，风险已在批准前告知。后三个直接导入者复用未修改的 eventToCombo，文件级报告大于实际 Hook 回调变更。测试脚本 UID 未收录，结果 UNKNOWN。

交付前 `detect_changes(scope=all)` 返回 6 个变更文件、0 个已映射符号/流程以及 low 摘要。此前已发现按名解析不可用，因此不把“0 个符号”当作无影响证明；实际范围以逐文件 diff、已有导入链检查和行为测试为准。用户授权后、正式提交前再次执行了变更分析。

## 用户验收与补充核查

用户于 2026-10-08 明确反馈“测试修复成功，可以提交”，确认本次快捷键问题已解决；代码已提交为 `b7eb8008`。该反馈未逐项描述分屏、语言切换等矩阵，不扩写为全部细分场景均已由用户验证。

依 `.trellis/spec/frontend/quality-guidelines.md:248`，AI 未启动 CLI-Manager 服务或 Tauri 应用。以下是交付时提供的补充核查项，不能用独立浏览器代替原生结果：

- 在含此修复的构建中，把 Tab 切换设为 Shift；Codex 有待回答提问时，空输入/有草稿/已有选区下按 Shift+左/右，确认原生提问操作且不切 Tab。
- 多 Tab、分屏及 Workspan 切换后，检查按键只作用于有焦点的终端；覆盖常用本地/WSL/SSH 会话及 Hook 有无。
- 普通 shell 的 Shift 选区、输入替换和普通方向键正常；改成 Alt/Ctrl 后仍能在终端内切 Tab，Ctrl+W 仍走关闭确认。
- “设置 → 通用 → 界面语言”切换 zh-CN/en-US，检查快捷键说明与 Shift 标签，时间仍为 24 小时制。

实现、自动验证及用户对修复结果的验收已完成，按用户授权提交并归档。未安装、启动或覆盖现有程序，未执行 Git 同步或推送。

## 同轮追加的菜单图标最小修复

- 用户反馈项目右键菜单“修改”与“MCP 与 Skills”均为齿轮图标。`SidebarView.tsx` 中项目与 Worktree 两处扩展入口改用设置页已经使用的 `lucide-react` Puzzle，修改操作保留 Settings。
- 此项是静态图标修正，单独提交 `1f7b5020`，同时更新 CHANGELOG 的 V1.4.2 和功能清单“项目树交互”板块；文案、事件和可见性条件均未修改。
- 编辑前 SidebarView 的按名影响分析不可用；文件级结果为 CRITICAL（直接导入方 Sidebar，59 条流程、20 个模块），已告知。提交前再次运行 detect_changes，并人工核查最终三文件差异。
- 初次类型检查发现共享图标入口未导出 Puzzle；沿用设置页的直接 lucide-react 导入后 `npx tsc --noEmit` 通过。最终严格架构检查与暂存差异检查通过；按最小修复规则不新增仅断言图标名称的测试，原生图标显示未由 AI 启动应用检查。
