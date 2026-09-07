# SSH Agent 新版本自动检测

## Changelog Target

TEMP（用户未指定版本号）

## Goal

在 SSH 主机「CLI 集成」页自动检测 `cli-manager-ssh-agent` 是否有可安装的更新版本，展示该版本，并允许用户按下后走现有签名预览/升级流程。打开页面仍不得自动建立 SSH 连接。

## Requirements

- 打开「CLI 集成」时自动解析当前可用的签名 Agent 发布（内置优先，缺省时回退官方网络源；自定义 Manifest 地址优先生效），不发起 SSH。
- 若已记录或最近检测的远端版本低于可用版本，展示新版本与当前版本，并提供「更新」操作。
- 「更新」复用现有预览确认与安装命令；不得跳过 Manifest 验签、制品校验或确认对话框，也不得自动安装。
- 版本比较使用与安装预览相同的语义化版本规则：`upgrade` 才提示更新；`reinstall` / `downgrade` 不自动提示降级。
- 检查失败必须展示真实错误，不得伪装成“已是最新”。
- 切换主机、修改 Manifest 地址、HTTP 开关、探测/安装结果变化后重新检查；关闭对话框或过期请求不得写入界面。
- 安装、升级、回滚仍不修改 Claude/Codex/Kimi Hook。
- 新增用户可见文案同时覆盖 `zh-CN` 与 `en-US`。

## Non-Goals

- 不自动 SSH 探测远端 Agent。
- 不绕过 bundled-first 策略去追独立 `ssh-agent-v*` prerelease。
- 不改变桌面应用自身的 Tauri updater。
- 不新增依赖、数据库字段或安装协议。

## Scenario Matrix

| 维度 | 预期 |
|---|---|
| 窗口焦点 | 仅在对话框打开时检查；失焦不额外 SSH。 |
| 分屏 | 设置对话框与终端分屏无关。 |
| 最小化 / 托盘 | 已发出的检查可完成；关闭对话框后丢弃结果。 |
| Sidebar 模式 | 对话框展示不受 sidebar 折叠影响。 |
| 多会话 / Workspan | 按当前 Host 的 installation/probe 版本比较。 |
| Focus mode | 不影响。 |
| Runtime | 检查发生在本机；真正升级仍走该 Host 的 SSH 认证链。 |
| Worktree | 不影响。 |
| CLI Hook | Agent 更新不改 Hook。 |
| 安装状态 | 未安装不显示“发现新版本”；已安装且更旧才显示更新；相同版本不提示；更高版本不自动降级。 |
| 发布源 | 内置、官方网络、自定义 Manifest、HTTP 开关、验签失败均走现有 supply chain 错误。 |
| 认证失败 | 自动检查不连 SSH；按下更新后的预览/安装沿用现有认证错误。 |

## Acceptance Criteria

- [x] 打开 CLI 集成不会自动 `ssh_agent_probe` / `detect_remote_agent_environment`。
- [x] 已安装且版本更旧时显示可用新版本，并可按下进入现有预览确认后升级。
- [x] 未安装、同版本、降级候选不显示更新 CTA。
- [x] 检查失败展示真实错误，不伪装成功。
- [x] 过期请求、关闭对话框、切换 Host 不会把旧结果套到新 Host。
- [x] zh-CN / en-US 文案完整。
- [x] `CHANGELOG.md` 与 `docs/功能清单.md` 已更新。
- [x] focused Node/Rust 测试与类型/编译检查通过。
