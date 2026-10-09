# Design

## 根因陈述

问题位于窗口全局快捷键与终端输入的分发边界：useKeyboardShortcuts 在 window capture 阶段匹配可配置 Tab 绑定，没有把终端内的 Shift+左右方向键交还给终端，因此先触发全局 Tab 动作；后续 xterm 回调的 Codex 放行无法撤销该动作。修复落在全局捕获入口。

preventDefault 本身不等于 stopPropagation。单会话实验只证明全局处理器错误地取消默认行为，多会话实验直接证明触发 Tab 切换；不能将其混写成“xterm 必然收不到事件”。

## 处理边界

在 `src/features/workspace/api/useKeyboardShortcuts.ts` 的真实键盘回调中提前判断目标是否位于 `.xterm`。仅当目标为终端、Shift=true、Ctrl/Alt/Meta=false、key 为 ArrowLeft/ArrowRight 时，立即返回，不 preventDefault / stopPropagation，也不读取或修改活动会话。

条件位于所有全局动作之前：相同组合键即使逐项录制到其他全局动作，也遵守终端输入优先。其他键及终端外目标沿原流程处理。

数据流：`window capture 让行 → xterm custom handler → Codex 原生输入 / shell 选区 → 原有输入转发 → PTY`。

全局入口不复制 Codex 识别、不读取显示内容、不监听 Hook；终端内部判定、选区和 xterm 编码保持原实现。

## 文件与职责

| 文件 | 必要改动 |
| --- | --- |
| `src/features/workspace/api/useKeyboardShortcuts.ts` | 终端 Shift 方向键的捕获优先级；保留公共 eventToCombo / isShortcutMatch 语义。 |
| `src/shared/i18n/messages/settings.zh-CN.ts` / `settings.en-US.ts` | 既有 tabSwitchDescription、tabModifier.shift 文案说明终端内保留及终端外范围。 |
| `scripts/codexQueuedQuestionShortcut.test.mjs` | 真实全局回调与既有终端回调的分发结果回归测试。 |
| `.trellis/spec/frontend/component-guidelines.md` | 输入选区契约增加全局入口也必须让行的约束。 |
| `CHANGELOG.md` / `docs/功能清单.md` | V1.4.2 记录与对应终端功能说明。 |

## 发现清单

- [x] 设置预设和逐项录制共用 KeyboardShortcutMap；仅需调整既有翻译说明。
- [x] Settings Store 保留原绑定；无需迁移。
- [x] 全局捕获是修复点；App 是 useKeyboardShortcuts 的直接调用者。
- [x] XTerm / useXTermController 已放行 Codex Shift 方向键，保持实现。
- [x] Input 选区、IME 去重和 onData 转发确认无须修改。
- [x] xterm 编码、系统及随包 ConPTY 的独立实验均保留 Shift，确认无须修改。
- [x] Web 仅拦截剪贴板键，没有这条桌面 Tab 捕获路径，确认无须修改。
- [x] 文件编辑器复用 eventToCombo，该函数不变，确认无须修改。
- [x] Hook、恢复、数据库与环境不参与新优先级判定，确认无须修改。

## 影响分析与风险

GitNexus 按函数名查询失败，风险 UNKNOWN；按文件 UID 分析成功，报告 **CRITICAL**：4 个直接导入者、59 条关联流程、20 个模块。直接导入者是 App、useXTermController、useFileEditorShortcuts、ShortcutSettingsPage；后三者复用 eventToCombo，因此文件级范围大于本次回调条件。已向用户报告风险，未知结果不作为无影响证据。

仅改变全局回调的一项按键所有权判断，保留公共转换、绑定存储和监听器注册阶段；回归覆盖其他全局动作和编辑区入口。

兼容变化：用户选择 Shift Tab 时，终端内该组合键用于终端操作；终端内切 Tab 可选 Alt/Ctrl。终端外 Shift 原绑定继续有效。设置文案同步交付。

## 场景矩阵

| 维度 | 预期 |
| --- | --- |
| 终端 / 其他控件 / 应用外焦点 | 仅终端目标让行；其他控件沿原规则；应用外无本窗口事件。 |
| 单/多会话、分屏深层、Workspan | 按真实目标判断，不依赖活动会话快照。 |
| 空输入、草稿、选区 | 全局均让行，由终端内部处理。 |
| 普通/全屏、focus mode、侧栏收起 | 同一 DOM 范围规则，与布局无关。 |
| PowerShell/CMD/Bash/WSL/SSH | 共用桌面前端入口，不改 PTY 编码。 |
| Worktree、主检出、Hook 有无 | 不依赖路径或 Hook。 |
| Shift / Ctrl+Shift / Alt+Shift / Meta | 仅单独 Shift 的左右箭头被保留，其余沿原流程。 |
| Shift/Alt/Ctrl Tab、自定义录制 | 终端 Shift 优先；终端外 Shift 和其他绑定保留。 |
| 文件编辑器、设置录制 | 非终端目标沿原规则，不改按键转换。 |

## 回滚与验证限制

无迁移，回滚入口条件和配套文案即可恢复旧行为。按项目质量规则不启动 CLI-Manager / Tauri 服务；真实 Codex 提问、分屏与语言切换留人工验收。隔离浏览器及 ConPTY 探针不能替代原生验收。
