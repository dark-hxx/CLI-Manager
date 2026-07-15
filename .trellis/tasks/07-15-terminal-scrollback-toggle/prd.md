# 终端回滚行数自定义开关

## Goal

在“设置 → 终端”中增加默认关闭的“自定义回滚行数”开关，并将内置终端默认回滚行数从 5000 调整为 9000。

## Changelog Target

[TEMP]

## Requirements

- 新增持久化布尔设置 `terminalScrollbackCustomEnabled`，默认关闭。
- 开关关闭时，终端固定使用默认 9000 行回滚。
- 开关开启时，沿用现有 1000–50000 行输入框与滑杆，配置默认值为 9000。
- 所有已有用户升级后开关默认关闭；旧的自定义行数值保留，但开启开关前不生效。
- 设置变化热更新到已有终端，不重建终端、不重启 PTY。
- 用户可见文案同时支持 zh-CN 与 en-US。

## Acceptance Criteria

- [x] 未保存开关值或保存值类型非法时，加载结果为关闭。
- [x] 开关关闭时，新建和已有终端的有效回滚行数为 9000。
- [x] 开关开启时，终端使用保存的 1000–50000 行自定义值。
- [x] 开关关闭时，数值输入框和滑杆不可编辑，并明确提示当前使用默认 9000 行。
- [x] 切换开关或修改行数无需重建终端即可生效。
- [x] 隐藏终端输出缓冲上限按有效回滚行数计算。
- [x] TypeScript 类型检查通过。

## Verification

- `npx tsc --noEmit`：通过。
- `git diff --check`：通过，仅存在仓库既有的 LF/CRLF 提示。
- 桌面端中英文切换、设置持久化及终端运行时交互需人工验证；按项目规范未自动启动 Tauri 应用。

## Out of Scope

- 不实现无限回滚增长。
- 不修改 Rust 后端、PTY、daemon、IPC 或会话快照持久化上限。
- 不保证 Codex/Claude TUI 主动清屏或重绘的内容进入 scrollback。

## Technical Notes

- 主要触点：`src/stores/settingsStore.ts`、`src/components/settings/pages/ThemeSettingsPage.tsx`、`src/components/XTermTerminal.tsx`。
- GitNexus 对共享 `Settings` 接口给出 CRITICAL 结构影响评级；改动必须包含默认值、显式布尔加载校验和完整 TypeScript 检查。
- 关闭开关将有效回滚行数热更新为 9000；若当前缓冲超过该值，xterm 会裁剪顶部历史且不可恢复。
