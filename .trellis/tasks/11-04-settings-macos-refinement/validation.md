# 设置页升级验证记录

日期：2026-11-04。代码实施完成；人工桌面验收和 Git 提交待处理。

## 自动检查

- `npm run build`：通过 TypeScript 和 Vite 生产构建。仍有大 chunk 与 WorktreeFinishDialog 同时静态/动态导入的构建警告，未阻断构建。
- `npm run check:architecture -- --strict`：1493 个源码文件，0 个超过 2000 行，0 个架构违规。
- `git diff --check`：通过。
- 最后一批 `node --test`：24/24 通过，覆盖 settingsDialog、settingsFocus、settingsPresentation、extensionsSettingsLayout、extensionsMcpSaving、nativeProviderEditing；验证共享弹窗外观隔离、继承和 pending 控件。
- 前一批定向回归：25/25 通过，覆盖 settingsFocus、settingsPresentation、extensionsSettingsLayout、extensionsMcpSaving、defaultThemeSettings、workspaceBackgroundLayout。
- 之前一批定向回归：30/30 通过，包含供应商选择和终端主题预览。
- 补充供应商编辑/详情/配置/Home/导入、SSH 工具集成、系统字体、终端标记和 OSC 52 回归：72 项中 71 通过，1 项已有静态断言失败，详情见下文。
- 新设置渲染测试使用真实 React/Mantine 的静态渲染，验证控件、下拉和弹窗的样式作用域及标签语义。焦点测试执行真实 hook，但使用最小 DOM 模拟；两者都不等同于桌面视觉验收。
- 共享弹窗测试执行真实 DialogContent / ConfirmDialog / Context，将 Radix 的 DOM/Portal 边界替换为轻量渲染组件，覆盖设置内外的类名、关闭标签、调用方样式和 pending 禁用；不声称验证真实 Radix 焦点。
- 不涉及 Rust、IPC、数据库、依赖版本或存储协议变更；未启动应用服务或 Tauri。

## 已有测试失败

`scripts/terminalOsc52.test.mjs` 中 “live PTY output enables OSC 52 copies and replay disables them” 仍断言回放分支调用参数名为 `rawText`；当前 `useTerminalDisplay.ts` 使用 `snapshotText`，两者均明确传递 `{ applyOsc52: false }`。

已用 `git diff --exit-code HEAD -- scripts/terminalOsc52.test.mjs src/features/terminal/hooks/useTerminalDisplay.ts` 确认这两个文件未被本任务修改。此项不是本任务新增失败，也未为通过测试而放宽断言或改动终端逻辑。

## 影响分析与代码复核

- 已在各组件修改前执行 impact。`DiagnosticModal` 为 HIGH，`FieldRow` 为 MEDIUM；最后补齐共享 `DialogContent` 样式上下文前的 impact 为 CRITICAL（369 个关联节点、16 个直接引用、120 个关联流程），已告知用户并按共享组件边界复核。
- 刷新本地索引后，最终 `detect_changes(scope=all)` 返回 36 个已跟踪变化文件、52 个符号、134 个关联流程，风险 CRITICAL；`partial=false`、`truncated=false`，符号和流程列表均完整返回。没有把该结果解释为低风险或全安全。
- MCP 常驻进程仍持有旧索引；最终分析使用 CLI 相同的 LocalBackend 在新进程读取本地索引，确认无 stale 标记。FTS 扩展不可用，完整符号/流程分析未返回 partial。
- `detect_changes` 基于 Git diff，未跟踪的新文件不计入上述文件/符号数；新增 SettingsPrimitives、SettingsThemeProvider、CSS、公开 sponsors 模块与测试已逐一审阅，并由类型构建、严格架构和定向测试覆盖。
- SettingsModal 的 React.lazy 调用未出现在图的 incoming 中，已核对 App.tsx 的 lazy 声明与实际挂载；不是无调用。getFocusableElements 的上游为 useFocusTrap，DiagnosticModal 的上游为 SshHostEditor。
- 复核 SettingsModal 的分类、关闭和 MCP 离开确认仍调用原守卫；SSH 诊断、目录选择和安装操作仅增加样式作用域。DialogContent 只读取可选展示上下文，ref、Portal、Overlay、事件、z-index 和 pending 行为保持原实现。
- 临时完整图结果位于系统临时目录的 `cli-settings-final-graph.json`，本文保留稳定的结果摘要；新增共享弹窗行为仍需下列人工桌面验收。

## 人工验收（待执行）

项目 `quality-guidelines.md` 要求实际 UI 由人工检查，以下项目未标记通过：

- [ ] 1200×800、900×600、350×600：遍历全部可见分类；小于 760px 使用顶部选择器；模板单/双栏、供应商长名称、SSH 表单和模型价格表均可操作，正文无整页横向溢出。
- [ ] 浅色、深色、系统主题，以及已有配色：边框、禁用、错误和选中状态可辨；普通分组无重阴影；工作区背景图片不透入设置页。
- [ ] 设置 → 通用 → 界面语言切换中文与英文：导航、说明、按钮、菜单、关闭提示均正确，长文本可换行，日期时间继续使用 24 小时制。
- [ ] 界面字号 13px / 18px、用户自定义字体：输入框、分段选择和按钮不裁切；主题卡片勾选与说明不重叠。
- [ ] 键盘进入设置、Tab / Shift+Tab 回绕、窗口跨 760px 断点：焦点落在可见控件，焦点环与选中状态可区分；退出后焦点恢复。
- [ ] MCP 有待保存修改时，通过桌面分类、顶部分类、扩展子分类及关闭按钮切换：仍出现保存/放弃确认。
- [ ] 供应商维护、SSH 编辑/诊断/目录选择、WSL 对话框和下拉菜单：浮层不被裁切；首次 Escape 只关闭顶层浮层，关闭后焦点回到触发控件；忙碌/禁用时保留原有守卫。
- [ ] 设置项切换与重启读取：主题、字体、终端/Hook 开关和 OSC 52 开关仍按原持久化语义生效；隐藏入口继续隐藏。
