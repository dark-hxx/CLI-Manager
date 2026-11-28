# 设计说明

## 1. 设置页表面与边框层级（Track A）

- **5 级表面阶梯**：在 `.settings-scope` 定义 `--settings-nav-bg`、`--settings-canvas`、`--settings-group-bg`、`--settings-subsurface`、`--settings-control-bg`（及 `--settings-elevated-bg`、`--settings-field-bg`）。Light 模式以 `--bg-tertiary` 与 `--surface-container-lowest` 混色保证各色盘具备自然色调与 12–22 的 RGB 阶梯差；Dark 模式以 `--surface` 为基准按固定比例提亮，保证各主题亮度递进一致。
- **3 级边框层级**：区分外卡片结构线 `--settings-card-border`（13%）、内部行分隔线 `--settings-divider`（8% / 9%）与交互控件边界 `--settings-line`（16% / 17%）。
- **修正浅色主题坍塌与嵌套子卡**：更新 `themes.css` 中 8 套浅色主题的 `--surface-container-low`，并在 `settings.css` 为顶层 `bg-surface-container-low` 卡片提供 `--settings-group-bg`，为嵌套子卡片提供 `--settings-subsurface` 与 `--settings-divider` 边框，不再剥成透明无框。

## 2. 统一 CLI Hook 卡片组件（Track B）

- 新增 `CliHookBridgeCard` 与 `LegacyCliHookBody`，复用现有 `CliToolIcon`（6 个 CLI 全覆盖）、`StatusPill`（扩展 `conflict` / `error` / `pending`）与统一 `.hook-bridge-*` 布局：
  - 头部：`[34px IconTile] [标题 + 说明] ... [StatusPill] | [Switch] [Chevron]`，保障 6 个开关垂直对齐。
  - 状态：所有 6 个卡片始终可折叠；`enabled === false` 时在展开区顶部展示暂停接收提示（Antigravity 保留 `enableHint` 说明）。
  - 内容：提示条 → 事件卡/只读事件条 → 凹槽配置区 `.hook-bridge-well`（含 `.hook-path-row`）→ 统一操作栏 `[安装/补全] [卸载] ... [刷新/检查]`。

## 3. Antigravity Hook 协议与宿主安装修复（Track C）

- `hook-schema/src/antigravity.rs`：处理 `ExecutorTerminationReason` 全部枚举，`USER_CANCELED` 产出 `"Interrupt"`；空字符串规范化；`MAX_BYTES = 2 MiB`；`PreToolUse` 回退 `"ask"`。
- `antigravity_admission.rs` + 前端终端状态机：放行 `source=antigravity, event=Interrupt`，`AntigravityBinding.phase` 新增 `"canceled"`，在 `terminalRuntime.ts` 清除计时器与运行状态并在 `App.tsx` 拦截通知。
- `settings/antigravity.rs` / `antigravity_scope.rs` / `antigravity_document.rs`：精准识别 CLI-Manager 自有旧条目为 `PartialInstalled`（外来源仍报 `Conflict`）；统一原生 `config_display()` 与命令引号/原生反斜杠、PowerShell 首选项、10s 超时、硬链接安全回退及 UTF-8 BOM 解析。
