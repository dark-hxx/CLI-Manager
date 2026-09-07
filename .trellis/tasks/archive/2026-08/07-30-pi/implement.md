# Implementation Plan

1. 执行远端更新检查并加载 `trellis-before-dev`。
2. 对 `attachTerminalIme` 执行 GitNexus upstream impact；若索引仍不可用，记录降级结果并按
   前端契约 + 精确搜索复核唯一调用链。
3. 先增加 Process keydown 同步重钉的回归，再在 `terminalIme.ts` 复用现有
   `pinHelperTextareaAnchor()`，不新增调度器。
4. 更新 `V1.3.3` Changelog、功能清单、任务复盘与前端 IME 契约。
5. 加载 `trellis-check` 后运行：
   - `node --test scripts/terminalImeAnchor.test.mjs scripts/terminalImeComposition.test.mjs scripts/terminalPiCompatibility.test.mjs`
   - `npx tsc --noEmit`
   - `git diff --check`
   - GitNexus `detect_changes`
6. 不运行 dev/build/Tauri，不提交代码；由用户人工验证全屏、有字输入、全屏后缩放、输入期间
   resize 与分屏。

## Final Outcome

- **UNRESOLVED**：Windows Pi 人工复测仍失败；首次 composition 正常，第二次连续输入仍右漂并只显示一个字符。
- 自动测试只能证明 resolver、Process key 和模拟 render 刷新的 DOM 合约，尚未覆盖 Windows 原生 IME/xterm/Pi 的真实事件序列。
- 按用户要求提交当前诊断实现与回归，但保持任务 `in_progress`，不得归档或宣称修复完成。

## Risk

- `attachTerminalIme` 是共享 IME 控制器，必须限制到 helper textarea 的无修饰 Process key。
- 同步重钉只改 DOM 几何；不得触发 fit、写 PTY 或改变 textarea value。
