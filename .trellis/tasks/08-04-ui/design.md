# 原生供应商大屏详情与全局切换 UI 调整设计

## 1. 页面结构

`NativeProviderSettingsPage` 保留现有 `catalog/home` surface 和 CLI 类型状态：

- catalog surface：类型 Tab、通用配置、供应商目录与详情。
- home surface：Home、环境诊断、全局预览/应用和 Adopt。
- 详情内部增加四个本地 Tab：`basic`、`effective`、`keys`、`documents`。
- 默认 `basic`；供应商切换或 CLI 类型切换时回到 `basic`，避免把旧 Tab 语义带到新供应商。

## 2. 全局供应商入口

基本信息 Tab 内放置明确的全局状态/操作卡，复用现有 `NativeProviderGlobalSection` 的 preview → confirm → apply 流程。页面继续由 `useNativeProviderHome` 提供状态，应用成功后沿用 `refreshSelection` 刷新目录与详情。

不新增直接写文件路径、不绕过 Home、锁、指纹、journal、补偿或错误映射。

## 3. 大屏高度

设置内容区本身已经是 `flex-1 overflow-y-auto`。供应商主从网格改为基于可视窗口的响应式高度：在宽屏使用 `calc(100vh - 页面头部与通用配置占用空间)` 的 bounded 高度，并保留最小高度；列表和详情各自 `min-h-0`/独立滚动。小屏继续自然堆叠，避免把固定 viewport 强加到单列布局。

## 4. 详情 Tab 内容

| Tab | 内容 |
|---|---|
| 基本信息 | 名称、分类、启用状态、Base/Request URL、模型、API 格式、当前 Key、编辑/复制/删除、全局状态/操作 |
| 生效配置 | source/common/provider/effective/live 预览、字段来源、长内容独立滚动 |
| API 密钥 | Key 列表、激活、启停、排序、编辑、Reveal、替换/删除 |
| 完整配置 | Claude settings.json、Codex auth.json/config.toml、Grok config.toml，保留现有草稿和校验行为 |

## 5. Codex/Grok 一致性

复用同一目录、详情、Key、文档组件和基础表单结构；app type 只决定文案、格式、文档 kind 和后端目标。Claude 专属配置继续只在 Claude 表单显示。

## 6. 风险与回滚

- 风险：Tab 状态可能遮蔽现有内容；通过默认 basic、可见 Tab 状态和独立滚动降低风险。
- 风险：大屏高度计算受设置窗口头部变化影响；使用 CSS `calc` 与上下限，不改全局 SettingsLayout。
- 回滚：移除详情 Tab 壳和高度 class 即可恢复现有连续堆叠；全局操作继续使用既有组件。
