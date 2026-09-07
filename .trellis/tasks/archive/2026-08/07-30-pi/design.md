# Technical Design

## Root Cause

第一次候选上屏后，Windows 可以在 Pi 完成已提交文本的 TUI 回显前开始下一次 composition。
控制器在 compositionstart 冻结了这一瞬间的右侧过渡锚点；Pi 随后的 render 已把反色软件光标和
硬件光标重绘到左侧，但 render/cursor 回调只重复应用旧冻结值，`composition-view` 继续从最右列
计算位置和 `maxWidth`，表现为拼音漂到右侧且只显示一个字母。Pi resolver 同时必须在编辑区域内
优先反色软件光标，才能覆盖硬件光标尚未稳定的帧。

## Change Boundary

- `src/lib/terminalIme.ts`：在已有捕获阶段 `onImeProcessKeyDown` 中同步调用
  `pinHelperTextareaAnchor()`，复用现有“通用 composition anchor → CLI composition resolver →
  CLI textarea resolver”链路。
- `src/terminal/browser/TerminalPiIme.ts`：在成对横线限定的编辑区域内优先使用反色软件光标；
  区域内没有软件光标时才使用硬件光标。
- `src/terminal/browser/TerminalPiCompatibility.ts`：仅 Pi 激活态声明 composition 锚点可随 TUI
  render/cursor 刷新。
- `src/lib/terminalIme.ts`、`useTerminalInput.ts`、`XTermTerminal.tsx`：透传该动态刷新能力；
  composition update、render 和 cursor move 仅在能力开启时重新解析冻结锚点。
- `scripts/terminalImeComposition.test.mjs`：锁定 Process keydown 先同步重钉、再记录恢复时间的
  调用顺序；保留现有 resize/composition 回归。
- 普通 Shell、Claude 和 Codex 不启用动态刷新，继续冻结 composition 起始锚点。

## Event Order Contract

1. 捕获阶段收到无 Ctrl/Alt/Meta 的 keyCode 229。
2. 同步执行 `pinHelperTextareaAnchor()`，禁止只排入 RAF/timeout。
3. 记录 `lastImeProcessKeyAt`，保留原生标点恢复逻辑。
4. xterm textarea target keydown/compositionstart 继续正常执行。
5. 应用 compositionstart 再冻结同一 resolver 结果，作为组合文字后续更新锚点。

## Compatibility

- 非 Pi 会话复用各自的通用/CLI resolver，不改变输入数据和 composition 提交逻辑。
- 非 keyCode 229、带修饰键、非 helper textarea 的 keydown 不重钉。
- 不访问 xterm 私有成员，不增加监听器、定时器、依赖或 CSS。

## Rollback

移除 `onImeProcessKeyDown` 中的同步重钉调用即可；其余 Pi 解析和 resize 修复保持不变。
