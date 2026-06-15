# fix-claude-code-ime-drift

## Goal

彻底修复 CLI-Manager 内嵌 xterm 终端中，Claude Code / Codex 输出动画/流式重绘导致中文输入法候选框漂移的问题。核心思路转变：**IME 锚点不再"先信硬件光标"，改为"先信输入框结构"**——结构化识别的边框输入行（`│ > … │`）是重绘也不消失的稳定特征，硬件光标只是 TUI 会甩到 spinner/状态/尾行的易变单点。

## What I already know

* 能控制的只有 IME 锚点 DOM（`.xterm-helper-textarea` / `.composition-view`），硬件光标（`buffer.cursorX/Y`）由 Claude Code 自己驱动，无法约束。
* 残余根因：compositionstart 撞上重绘中途时，旧逻辑会信任/冻结到尾行的硬件光标（`resolveCompositionAnchorCell` 的"终端静默→用光标"和"静默采样"两条分支）。
* 静默采样本身也可能采到重绘中途的光标，是不可靠信号。
* 现有结构识别逻辑（`getInputAnchorCell` + 双向扫描输入行）已经存在且可复用，边框/prompt 字符集已就绪。
* 相关实现集中在 `src/components/XTermTerminal.tsx`，GitNexus impact：`XTermTerminal` upstream risk LOW（直接调用方 0、受影响流程 0）。

## Requirements

* 反转 `resolveCompositionAnchorCell` 信任顺序：
  1. 光标已在输入行上 → 信任精确硬件光标（覆盖普通 shell 与空闲 TUI，保留行内 caret 位置）；
  2. 否则双向扫描最近的输入行，锚定到其文本末尾；
  3. 屏幕上没有任何输入框（全屏无 prompt 的 TUI）→ 才回落硬件光标。
* 删除"先信硬件光标"的两条分支及其全部支撑代码：静默采样定时器、采样缓存、写入活动时间戳、相关常量。
* 保留 compositionstart 冻结锚点机制、输入行识别、render 后覆盖与候选框定位逻辑。
* 不新增依赖，不改后端 PTY，不改配置，不做无关重构。

## Acceptance Criteria

* [ ] `resolveCompositionAnchorCell` 不再读取 `lastTerminalWriteAtRef` / `quietCursorCellRef`，结构扫描成为非光标情形的唯一锚点来源。
* [ ] 删除 `noteTerminalWriteActivity`、`quietCursorCellRef`、`quietCursorSampleTimerRef`、`lastTerminalWriteAtRef` 及常量 `CURSOR_TRUST_IDLE_MS`/`QUIET_CURSOR_SAMPLE_DELAY_MS`/`QUIET_CURSOR_MAX_AGE_MS`，无残留引用。
* [ ] `flushActiveWriteQueue` 的写入不再挂采样 callback。
* [ ] 清理 effect cleanup 中对 `quietCursorSampleTimerRef` 的清理块。
* [ ] TypeScript 检查通过：`npx tsc --noEmit`。
* [ ] 人工验证：Claude Code 输出动画/流式期间开始中文 IME，候选框稳定贴近真实输入框。
* [ ] 人工验证：普通 shell 输入/回车/粘贴/中文 composition 结束后行为正常，行内移动 caret 后 IME 仍贴近 caret。

## Definition of Done

* 最小代码改动完成，净代码量减少。
* 静态检查通过，若失败如实记录。
* 运行态 UI/IME 由人工验收，AI 不启动 Tauri 桌面应用。
* 若发现可沉淀的新规则，更新 spec 与记忆 `[[ime-anchor-freeze-on-composition]]`；否则不改。

## Decision (ADR-lite)

**Context**: 多轮启发式修复后，残余漂移根因是"任何信任硬件光标的分支都可能在重绘中途取到尾行光标"。静默采样也无法绕过这一点。

**Decision**: 不再用时序/采样去"猜光标可不可信"。改用结构稳定的输入框识别作为主锚点来源，硬件光标降级为"光标本就在输入行"或"压根没有输入框"两种安全场景才用。

**Consequences**: 删除整套采样机制，代码更简单、风险更低，并消除残余根因。代价是依赖输入框识别——漏判时回落硬件光标，失败面与今天持平、不会更差。

## Out of Scope

* 不重写候选框定位/冻结算法本身。
* 不扩大 prompt/边框字符集（除非验证发现新 CLI 不识别）。
* 不调整 UI 样式或终端布局，不改 Rust PTY。
* 不启动桌面应用做自动 UI 验证。

## Technical Notes

* 相关文件：`src/components/XTermTerminal.tsx`。
* 参考 spec：`.trellis/spec/frontend/component-guidelines.md`、`quality-guidelines.md`、`type-safety.md`。
* 关联记忆：`ime-anchor-freeze-on-composition`。

## Correction (06-15)

**问题**：上述"反转信任顺序 + 双向扫描最近输入行"落地后仍漂移——Claude Code 中文输入时候选框贴到屏幕顶部。

**死角**：以硬件光标 `cursorY` 为中心做就近双向扫描，前提仍是"光标大致在输入框附近"。但 TUI 硬件光标根本不指向底部输入框（视觉光标是反色字符画的），漂移后离屏幕顶部历史回显的 `> …` 行更近，就近扫描命中顶部诱饵。

**最终改法**：放弃以光标为中心扫描，改为**从 `terminal.rows-1` 向上扫描第一个输入行**——TUI 与普通 shell 的当前输入框恒在屏幕最底部。光标恰好落在该行时才返回精确光标（保留普通 shell 行内 caret）；屏幕无任何输入行才回落硬件光标。Requirements 第 2 点的"双向扫描最近"以此为准。
