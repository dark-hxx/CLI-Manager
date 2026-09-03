# 阶段 A：工作区背景铺满开关

## Goal

实现背景作用域开关：关闭仅终端背景，开启工作区连续背景；复用现有终端背景资源与参数，独立验证透明度和主题兼容。

版本：`V1.3.9`。

## 文件职责与阶段边界

- 本阶段只负责背景作用域和渲染层，不实现辅助面板左右停靠、顶层 Tab 上下停靠或主侧栏换边。
- 设置模型、背景根层、XTerm 背景适配、workspace surface 样式和契约测试按职责拆分；不得把根背景布局算法、设置迁移和终端渲染细节堆入一个文件。
- `App` 只负责挂载工作区背景边界；`WorkspaceBackground` 只负责唯一根背景层；`XTermTerminal` 只负责 terminal-only/workspace 模式适配；设置页只负责控件和文案。
- 不按固定行数拆分已有大文件。若新增职责会使 `App.tsx`、`XTermTerminal.tsx` 或共享样式文件职责混杂，按职责抽取最小模块；无关重构不属于本阶段。
- 阶段 A 的测试只验证背景契约；B/C 的布局与拖拽测试不得提前混入同一个测试文件。

目标模块为 `WorkspaceLayoutShell.tsx`、`WorkspaceBackground.tsx`、`workspace-layout.css` 和 `workspaceBackgroundLayout.test.mjs`；`App.tsx` 只负责挂载，`XTermTerminal.tsx` 只负责消费 workspace 模式。`fillWorkspace` 是现有终端背景复合字段的同职责扩展，保留现有设置迁移入口即可，不在阶段 A 做无关的 settingsStore 全面拆分。

## Dependencies

- 父任务：`09-03-workspace-custom-layout`。
- 不依赖阶段 B/C；阶段 B/C 的视觉验收依赖本阶段完成。
- 必须兼容现有 `terminalBackground`、`XTermTerminal`、`Sidebar` 和 `TerminalSidePanel` 实现，不修改终端 Pane 树、PTY 或历史接口。

## Requirements

- A1：在 `TerminalBackgroundSettings` 增加 `fillWorkspace: boolean`，默认 `false`，并由 `migrateTerminalBackground` 做向后兼容校验。
- A2：`fillWorkspace=false` 时保持现有行为，背景图只在终端区域显示；`fillWorkspace=true` 且背景有效时，背景图在主工作区内容区连续铺满。
- A3：工作区背景只创建一个共享背景层，复用现有图片资源、透明度、适配、位置、模糊和暗化参数；不得为 Sidebar、辅助面板和每个终端分别重复加载或裁剪图片。
- A4：工作区内容层采用半透明 surface，不能通过父级 `opacity` 淡化文字和控件；标题栏、设置/确认弹层、右键菜单保持独立高不透明度背景。
- A5：当前会话级隐藏背景只覆盖对应终端 Pane；切换 Workspan、分屏、终端 Tab 后状态语义不变，且不关闭工作区根背景。
- A6：图片未选择、图片丢失、背景关闭时不显示异常图片层；终端-only 模式的现有渲染路径继续可用。
- A7：新增开关和说明文案接入 `src/lib/i18n.ts`，覆盖 `zh-CN` 与 `en-US`。

### 背景行为矩阵

| `enabled` | 图片资源 | `fillWorkspace` | 结果 |
|---|---|---|---|
| `false` | 任意 | 任意 | 不创建工作区背景层；保持无图/现有安全 surface |
| `true` | 有效 | `false` | 仅沿用 XTerm 的终端局部背景，侧栏/Tab/辅助面板不透图 |
| `true` | 有效 | `true` | 创建一层覆盖主工作区内容区的连续背景，XTerm 不重复绘图 |
| `true` | 缺失或加载失败 | 任意 | 不显示破损图片，回退安全 surface，不清空已保存路径 |

## Acceptance Criteria

- [ ] 开关关闭时，终端区域显示背景，项目侧栏和辅助面板保持现有不透明主题/皮肤效果。
- [ ] 开关开启时，项目侧栏、顶层 Tab、终端区域和辅助面板透出同一张连续背景图，无区域接缝或重复裁剪。
- [ ] 透明度、cover/contain/center/tile、九宫格位置、模糊和暗化在两种模式下均有效。
- [ ] 终端会话级隐藏背景只影响当前 Pane，且不会影响侧栏或其他 Pane。
- [ ] 阶段 A 未新增或实现 `terminalSidePanelSide`、`workspanTabBarPosition` 或主项目侧栏换边行为。
- [ ] 新增/修改文件按背景状态、渲染、设置 UI 和样式职责拆分，未形成新的职责混杂文件。
- [ ] `enabled=false` 时 `fillWorkspace` 不产生可见效果；`fillWorkspace` 只改变背景作用域，不改变图片资源和已有图像参数语义。
- [ ] 亮/暗主题、背景缺失、无图片、紧凑模式、终端全屏、历史工作区场景均无遮挡和空白。
- [ ] `npx tsc --noEmit` 和 `node --test scripts/workspaceBackgroundLayout.test.mjs` 通过；既有终端局部背景测试职责未被污染。
- [ ] `CHANGELOG.md` 的 `V1.3.9` 段和 `docs/功能清单.md` 背景图板块完成记录。

## Technical notes

- 推荐在 `App` 的主工作区内容层放置 `WorkspaceBackground`；`XTermTerminal` 在 workspace 模式下保留透明 xterm 配置，但不再为每个 Pane 显示一份背景伪元素。
- 工作区背景层应位于内容之下但不能通过新的 GPU 合成层包裹 xterm，避免复现已有背景图模式的文字抗锯齿问题。
