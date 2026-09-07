# 修复 Pi 有字与缩放后输入法右漂

> **状态：未解决。** 2026-07-30 用户在 Windows Pi 中复测，首次 composition 正常，但候选上屏后的第二次输入仍漂到最右侧且只显示一个字符。自动回归通过不代表人工验收通过。

## Goal

根因修复 Pi 编辑器已有文字时 Windows 中文输入法候选框漂到终端最右侧的问题，并保证
全屏及窗口缩放后仍锚定到当前输入位置附近。

## Background

- 用户实测：Pi 全屏状态下，输入框已有文字时，输入法候选框出现在窗口最右侧。
- 用户实测：全屏后继续缩放窗口，输入法仍漂到最右侧。
- 用户二次实测：可见输入光标明确在左侧，但拼音仍出现在最右侧且只显示一个字母。
- 用户截图确认：首次进入 Pi 的第一次 composition 正常；候选上屏后立刻开始第二次输入时稳定漂移。
- 上一轮修复 `c6eed21e` 已加入 Pi 成对横线区域解析以及 resize 后 textarea 重钉，但只用
  静态 buffer fixture 验证锚点结果，没有覆盖真实 xterm helper textarea 的持续写回时序。
- 截图显示 Pi 输入行仍有可见光标，错误集中在原生 IME 使用的 helper textarea 横坐标。
- 本机 Pi 0.83.0 的 `pi-tui` 会通过 `CURSOR_MARKER` 把硬件光标定位到编辑器，并同时用
  `SGR 7` 绘制软件光标；继续把状态区光标当作主要根因与当前版本实现不符。
- xterm 6.1.0-beta.288 在 cursor move、resize 及自己的 `compositionstart` 监听器中执行
  `_syncTextArea()`。其源码明确说明动态 TUI 的 partial render 会让 IME 位置提前锁定。
- 应用的捕获阶段 `onImeProcessKeyDown` 早于 textarea target 监听器，但当前只记录 keyCode 229
  时间，不在 Windows IME 锁定位置前同步重钉 textarea。

## Requirements

- 先确定漂移来自 Pi 锚点解析错误，还是 xterm 在 render/resize/composition 时序中再次覆盖
  helper textarea；禁止继续叠加无依据的定时器兜底。
- 在捕获阶段收到 IME Process keydown 时，必须同步应用 CLI 专用 composition + textarea
  resolver，使原生 IME 读取位置前 textarea 已处于正确锚点。
- Pi 输入框为空或已有文字时，composition view 与 Windows 原生候选框都必须使用当前输入
  行的有效横坐标，不得回退到右侧状态区。
- 全屏、全屏后缩放、输入期间缩放和分屏 resize 必须重新计算并稳定保持锚点。
- 保留普通 Shell、Claude、Codex 和非 Pi 会话现有 IME 行为。
- 不修改 PTY、IPC、CSS、xterm 私有状态或依赖。
- 不运行 dev/build/Tauri 启动命令；由用户执行 Windows Pi 人工验收。
- 保留并提交本轮诊断代码与回归，但任务不得标记完成或归档。

## Acceptance Criteria

- [x] 新回归覆盖 Pi 输入框已有文字且硬件光标/textarea 状态不同步的布局。
- [x] 新回归覆盖 resize/render 后 helper textarea 被再次写回右侧的真实调用顺序。
- [x] 新回归证明 Process keydown 的同步重钉发生在 compositionstart 之前，且不依赖 RAF/
  timeout 才首次生效。
- [x] 新回归覆盖硬件光标仍位于 Pi 编辑器右侧、反色软件光标位于左侧，并证明组合锚点优先使用软件光标。
- [x] 新回归覆盖连续 composition：第二次先冻结右侧锚点，随后 Pi render 左侧光标时同步刷新组合位置和可用宽度。
- [ ] 全屏时输入中文，候选框不再漂到最右侧。
- [ ] 全屏后缩放窗口再输入中文，候选框仍位于输入位置附近。
- [ ] 输入期间缩放、分屏缩放、空输入框和非 Pi 会话保持正确。
- [x] 定向 Node 测试、`npx tsc --noEmit`、`git diff --check` 通过。

## Out of Scope

- Pi 工具背景、历史恢复、Hook、PTY 环境变量及其他 CLI 的新行为。
- 启动桌面应用进行自动化视觉验收。

## Changelog Target

`V1.3.3`

## Notes

- Issue lineage: #177。
- Final user instruction: mark unresolved and commit the diagnostic implementation.
