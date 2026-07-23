# 修复 Workspan 分屏 Tab 与还原交互

## Goal

修复 Workspan 模式下单会话 Pane 分屏后缺少本地 Tab 标题的问题，恢复关闭与拖拽入口，并提供无损的整 Workspan 单 Pane 还原能力。

## Requirements

- Workspan 只有一个可见 Pane 且该 Pane 不超过一个可见会话时继续隐藏本地 Tab 栏；存在多个可见 Pane 时必须显示现有 Pane Tab 栏。
- Pane Tab 栏复用现有终端主题样式、会话名称、关闭按钮和 Pane 全屏/退出全屏按钮，不新建视觉体系。
- 顶部 Workspan Tab 右键菜单新增“还原为单 Pane”。还原整个 Workspan，以其活动 Pane 为目标，回退到首个 Pane；保留所有会话、顺序、活动会话、Workspan ID 和自定义名称，不创建或关闭 PTY。
- 还原非活动 Workspan 时不得切换当前 Workspan；范围过滤期间禁用还原；单 Pane 时为无操作。
- Pane 边缘投放区从 32%/160px 调整为 24%/120px，中心有效投放区约 52%；Workspan 边缘判断同步使用 0.26 阈值。
- Pane 内 Tab 可拖到顶部 Workspan 标签或标签栏空白区，脱离为独立顶层 Workspan；落到具体标签时按目标位置插入，落到空白区时追加到末尾；拖拽经过顶层标签栏时实时显示平滑移动的插入位置预选线；范围过滤期间禁用该拖出路径。
- 新增用户可见文案必须同步 zh-CN 与 en-US。
- 不修改后端、IPC、数据库结构、依赖或配置。

## Acceptance Criteria

- [ ] Workspan 左右、上下和嵌套分屏中的单会话 Pane 显示 Tab 名称，可关闭、拖拽和切换 Pane 全屏。
- [ ] 单 Pane 单会话 Workspan 仍隐藏重复的本地 Tab 栏；Workspan 关闭模式保持现有 Pane Tab 行为。
- [ ] “还原为单 Pane”一次性合并全部 Pane，Session ID 无丢失、无重复，活动会话与目标 Pane 正确。
- [ ] 还原不调用 PTY 创建/关闭，不受可能关闭会话的 unsplitBehavior 影响。
- [ ] 中心投放区扩大后，Tab 更容易移动回现有 Pane，四向边缘分屏仍可用。
- [ ] Pane Tab 拖到顶部具体标签或空白区时显示对应插入位置预选线，放下后成为独立顶层 Workspan；Session ID 无丢失、无重复，原 Workspan 其余会话保持不变。
- [ ] `npx tsc --noEmit`、相关 Node 测试和 `git diff --check` 通过。

## Root-Cause Statement

问题位于 `TerminalTabs` 的 Workspan 展示策略：它只依据单个 Pane 的可见会话数隐藏本地 Tab 栏，未考虑 Workspan 已进入多 Pane 分屏状态，导致单会话分屏失去标题、关闭和拖拽入口；修复应落在 Pane chrome 可见性和 Workspan 布局动作层。

## Scenario Matrix

- Workspan 开启/关闭；单 Pane、左右/上下/嵌套分屏。
- 单会话 Pane、多会话 Pane；活动/非活动 Workspan；Pane 全屏。
- 全部终端与项目/分组/Worktree 范围过滤。
- 本地 Shell、WSL、SSH 终端及深浅终端主题。

## Changelog Target

`[TEMP]`

## Notes

- GitNexus 索引刷新与 impact 均因 `.gitnexus/lbug` 访问被拒绝失败，实施时使用当前源码、前端契约和 `rg` 引用结果校验触点。
- 工作区已有 `TerminalTabs.tsx`、`components.css`、`SplitTerminalView.tsx` 等未提交修改，必须保留并基于现状做最小增量。
