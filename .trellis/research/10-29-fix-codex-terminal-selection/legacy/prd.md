# 修复 Codex 终端无法拖选复制（SSH 与 macOS）

## Goal

恢复 Codex CLI 输出内容的可见文本选择与复制，覆盖 SSH 远程会话和 macOS 本地会话；交付版本为 V1.4.5。

## Background

- 用户反馈：使用 SSH Agent 连接远程 Codex 时，终端输出无法选中复制。
- 补充反馈：macOS 本地 Codex（未使用 SSH Agent）同样无法复制，拖选时没有选中高亮。
- 尚未在真实用户环境复现，不能将问题归因为 SSH Agent 或剪贴板权限。
- 当前分支 master 与本地 origin/master 记录同步（0/0）；保留既有归档文件删除，不自动执行 Git 同步。

## Requirements

- R1：定位从鼠标按下、拖选到 xterm 选择状态及复制入口的根因，区分无法建立选区与复制失败。
- R2：覆盖本地/SSH、Windows/macOS、普通/备用缓冲区、鼠标上报开/关、前台/切换后及 daemon 恢复等状态。
- R3：修复不得破坏正常 TUI 鼠标交互、滚轮、链接、终端焦点、分屏或既有复制快捷键。
- R4：同步维护中英文用户文案（如有）、CHANGELOG.md 的 V1.4.5 记录及 docs/功能清单.md 的终端功能板块。

## Confirmed Findings

- 实际依赖为 xterm 6.1.0-beta.288。真实浏览器与生产配置的 24 个组合基线及 1 个候选配置实验表明：鼠标上报开启后，Win32 使用 Shift 可以建立选区；MacIntel 在普通、Shift、Option 手势下均没有选区。开启 macOptionClickForcesSelection 后，MacIntel 的 Option 手势可以选中文本且不发送鼠标报告。
- 共享鼠标策略仅由桌面 controller 调用，local/WSL/SSH 共用；桌面缺少 macOS 强制选择开关。源/快照恢复结果相同，不需要在 SSH Agent 或复制函数里兜底。
- 证据与完整触点见 `research/findings.md`、逐例结果见 `research/selection-baseline.json`。MacIntel 模拟不是 macOS WebKit 或用户现场复现。

## Acceptance Criteria

- [ ] AC1（R1）：记录证据、根因陈述和代码触点清单，明确哪些环节已排除、哪些仍需实机验证。
- [ ] AC2（R2）：真实 xterm 回归验证鼠标上报开启时的可见选择及所选文本，覆盖 macOS 与 Windows 的策略分支和恢复场景。
- [ ] AC3（R3）：验证 TUI 鼠标上报、原有选择和复制策略无非预期回归。
- [ ] AC4（R4）：定向测试、必要类型检查和独立严格架构检查通过；完成双文档记录。
- [ ] AC5：明确列出无法在当前 Windows 环境完成的 macOS、本地 Codex 和 SSH 实机验收项，不将模拟验证写成用户问题已复现。

## Out Of Scope

- 不修改 SSH Agent 协议、认证或部署流程，除非发现直接证据需要调整范围。
- 不升级 xterm 依赖，不调整其他 CLI 的交互约定，不进行无关终端重构。
- Web/Tap 是独立终端构造入口，其相同默认配置风险已记录，但不默认为本次桌面反馈的交付范围。

## Approved Scope

用户明确要求“修复 mac os 的缺陷”，按已提交的推荐方案实施：保留普通 TUI 鼠标交互，上报模式下 Windows/Linux 继续 Shift 拖选，macOS 修复为 Option 拖选；普通 shell 继续直接拖选。不引入无修饰键优先选择策略。用户补充 `/tui fullscreen` 作为场景线索，纳入备用缓冲区覆盖，但不将该命令本身认定为鼠标上报状态的证据。
