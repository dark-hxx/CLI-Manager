# 设置页配色对比度、Hook 卡片统一改版与 Antigravity Hook 协议修复

## 目标与范围

按确认方案在 `V1.5.2` 记录下交付四项优化与根因修复：

1. **设置页配色与区块分隔优化（Light / Dark 全套配色）**：解决浅色默认/配对主题下画布、左侧导航与内容卡片近乎同色及外框 7% 透明度近乎不可见的问题，同步修复嵌套子卡片透明剥离与 `SegmentedControl` 同色不可辨问题。
2. **CLI Hook 整体开关与页面视觉重设计**：移除 `collapsible={enabled}` 导致的禁用态空盒 Bug，统一采用可折叠卡片结构、CLI 品牌图标、垂直对齐的总开关、统一事件卡与底部操作栏，并清理重复源码（`HookSettingsPage.tsx` 降回 400–1200 行规范区间）。
3. **Antigravity CLI Hook 桥接格式统一**：将 Antigravity CLI Hook 纳入 `CliHookBridgeCard` 与 `HookSettingsSectionKey`（默认折叠），顶部展示实时状态徽章、总开关与折叠箭头，接入页面顶部「刷新全部 Hook 状态」，同步补全页面/弹框简介文案并修正路径斜杠混用。
4. **Antigravity CLI Hook 挂载方式与脚本协议修复**：
   - 支持官方大写 `ExecutorTerminationReason`（`NO_TOOL_CALL`、`ERROR`、`MAX_*` 等），并将 `USER_CANCELED` 映射为 `Interrupt`（静默清除 Tab 运行中状态，不弹通知/任务栏提醒）。
   - 将空字符串 `transcriptPath` / `hookEventName` 视作缺省；stdin 上限提升至 2 MiB；`PreToolUse` 兜底返回改为 `"ask"`。
   - 识别自有历史配置（路径迁移 / `timeout: 5` / 旧正斜杠格式）为可修复的 `PartialInstalled`，不再锁死安装与卸载按钮；保留外来冲突保护。
   - 修正 `config_display()` 原生分隔符、剥离 `\\?\` 前缀、增强 PowerShell 包装错误控制并将超时提至 `10s`、WSL 补充 `test -x` 检查、首次安装硬链接不支持时安全回退、兼容 UTF-8 BOM。

## 用户决策确认

- 独立新建 Trellis task：`11-25-settings-theme-hook-redesign-agy-fix`
- `CHANGELOG.md` 版本号：`V1.5.2`
- `USER_CANCELED` 策略：通过 `Interrupt` 静默清除运行状态，不触发完成/失败提示或任务栏闪烁
