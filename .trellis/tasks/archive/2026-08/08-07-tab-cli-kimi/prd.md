# 补齐 Tab CLI 工具图标并新增 Kimi

## Changelog Target

V1.3.5

## Goal

修复 Tab 没有显示 CLI 工具图标的问题（OpenCode、Pi、Amp、Aider、Crush、Cline、Goose 等工具），并新增 Kimi CLI 工具支持。

## Background

当前 Tab 渲染使用 `VendorIcon`（品牌厂商图标），只认 12 个厂商品牌（`VendorKey`）。对于没有明确厂商归属的 CLI 工具（如 OpenCode、Pi、Amp 等），`vendor` 字段为 `null`，导致 Tab 上不显示任何图标。

实际上，`CliToolIcon` 系统已经为所有 CLI 工具都准备了图标（包括 OpenCode、Pi、Amp 等），但 Tab 渲染层没有使用它。

## Requirements

### 1. Tab 图标补齐

**修改点**：`src/components/TerminalTabs.tsx`

- `SortableTab` 组件：当 `vendor` 为 `null` 时，回退渲染 `<CliToolIcon>`
- `SortableWorkspanTab` 组件：同上逻辑
- `DragOverlayTab` 组件：同上逻辑

**渲染优先级**：`VendorIcon` → `CliToolIcon` → 无图标

**Props 改造**：
- `SortableTab` 的 `vendor` prop 保持不变（继续用 `VendorKey | null`）
- 新增 `cliToolIcon?: CliToolIconKey | null` prop，由调用方传入
- 组件内部：`vendor` 存在时用 `VendorIcon`，否则若 `cliToolIcon` 存在则用 `CliToolIcon`

### 2. 新增 Kimi CLI 工具

**修改点 1**：`src/lib/cliTools.ts` 的 `CLI_TOOL_DESCRIPTORS`

在 opencode 条目下方新增：

```ts
{
  id: "kimi",
  command: "kimi",
  label: "Kimi",
  icon: "kimi",
  vendor: "kimi",  // VendorKey 里已有 kimi
}
```

注意：**不接入 `historySourceId`**，只加 CLI 工具选项。

**修改点 2**：`src/components/CliToolIcon.tsx` 的 `CLI_TOOL_ICONS`

新增：

```ts
import KimiColor from "@lobehub/icons/es/Kimi/components/Color";

const CLI_TOOL_ICONS: Record<CliToolIconKey, IconComponent> = {
  // ...
  kimi: KimiColor,
  // ...
};
```

**修改点 3**：`src/lib/cliTools.ts` 的 `CliToolIconKey` 类型

新增 `"kimi"` 联合成员。

## Acceptance Criteria

- [ ] 所有 CLI 工具在 Tab 上都有图标显示（有厂商的显示厂商图标，无厂商的显示 CLI 工具图标）
- [ ] 新增 Kimi 工具：命令为 `kimi`，图标使用 `@lobehub/icons/es/Kimi/components/Color`
- [ ] Kimi 的 `vendor` 为 `"kimi"`（已在 `VendorKey` 和 `VendorIcon.tsx` 中存在）
- [ ] 类型检查通过（`npx tsc --noEmit`）
- [ ] CHANGELOG.md 在 V1.3.5 下记录此修复
- [ ] Kimi 暂不接入历史记录解析（不加 `historySourceId`）

## Notes

- `VendorIcon` 用于品牌厂商图标（Claude、OpenAI、Gemini 等）
- `CliToolIcon` 用于 CLI 工具图标（每个工具都有）
- 图标回退链：`VendorIcon` → `CliToolIcon` → 无
- Kimi 既有厂商图标（`VendorIcon` 的 `"kimi"`），又有 CLI 工具图标（`CliToolIcon` 的 `"kimi"`）——优先用厂商图标
