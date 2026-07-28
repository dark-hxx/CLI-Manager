# Interaction and Accessibility Design

## Selection Model

Controller 保存 `{ selectedKeys, anchorKey, side }`。范围计算使用解析模型中的稳定 change order，不读取 DOM 行号。切换 target、diff hash 或 options 时整体重置。

Split 模式 old/new side 独立；Shift 操作与 anchor side 不同则重置 anchor 并只选当前行。Unified 仍保留原始 old/new side 供后端选择行契约使用。

## Focus Model

复用项目现有 Radix Dialog/焦点环能力，而不是继续维护 `window.keydown + Portal div`。Dialog 标题引用完整文件名，状态信息使用 polite live region，破坏性确认继续由现有 ConfirmDialog 负责。

## Visual States

selected 同时使用背景、gutter 标记和 `aria-selected`；insert/delete 保留 `+/-` 文本语义。Hover 不使用缩放，防止代码列布局抖动。
