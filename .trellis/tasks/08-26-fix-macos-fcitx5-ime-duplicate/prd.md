# 修复 macOS Fcitx5 中文输入重复

## Goal

在 macOS 的 Fcitx5 中文输入法中，确保一次确认上屏的文本只会写入终端 PTY 一次，同时不丢失中文、标点或普通键盘输入。

## Background

- 用户反馈：macOS 环境使用 Fcitx5 输入中文时，终端出现重复文本；Codex 与普通终端 CLI 均会发生。
- 终端输入由 `src/components/XTermTerminal.tsx` 装配：xterm 的 `onData` 与 `src/lib/terminalIme.ts` 的原生 `beforeinput` / `input` 恢复路径最终都会进入 `src/hooks/useTerminalInput.ts`，再写入 PTY。
- 当前跨来源重复保护以同文本、不同来源、80 ms 时间窗判定；它没有表示一次 IME composition 的事务边界。
- xterm 6.1.0-beta.288 会在 `compositionend` 后以 `setTimeout(0)` 异步提交 composition；项目同时为 macOS WKWebView 的输入恢复注册了原生文本事件。历史修复已表明，这两个路径的事件顺序会因 IME 而变化。
- 历史任务 `06-30-fix-codex-light-border-duplicate-ime-input` 仅保留了 Codex 定向诊断，未对共享输入链路实施重复输入修复。

## Requirements

- R1：对任一终端 CLI 中 Fcitx5 的一次中文 composition 提交，向 PTY 转发至多一次最终文本。
- R2：保留现有 macOS 输入恢复能力：中文/全角标点、ASCII 符号和普通非 IME 输入均不得因修复而丢失。
- R3：修复必须发生在共享输入转发边界，不得以 CLI 输出或 PTY 侧的文本删除掩盖重复。
- R4：为当前已知的两条输入来源及 composition 完成顺序补充可重复的自动化回归验证。
- R5：不新增依赖、不改动 PTY IPC 契约、不改变非终端表单的输入行为。
- R6：代码变更记录使用版本 `V1.3.8`，并同步更新 `CHANGELOG.md` 与 `docs/功能清单.md`。

## Root-Cause Statement

macOS 的 Fcitx5 可形成 `input → keydown(229)` 的 IME 事件顺序；xterm 随后的延迟 textarea-diff 回退会把刚刚已经送出的 CJK 文本再次以 `onData` 发出。当前共享转发器只拒绝 `nativeTextInput` 与 `onData` 的跨来源重复，却把两次 `onData` 都写入 PTY。修复应落在仍保留 IME process-key 时序的共享前端转发边界：只在 macOS 的近期 `229` 检查点内拒绝同源重复，不能在 CLI 输出或 PTY 侧删除文本。

## Acceptance Criteria

- [ ] 在 macOS + Fcitx5 中的 Codex 与普通终端 CLI 内，连续输入并确认中文候选时，终端不再出现一次提交重复成两份的情况。
- [ ] 中文、中文标点、ASCII 符号、ASCII 普通字符、退格和 Enter 的既有输入行为保持正确。
- [ ] xterm `onData` 与原生恢复对同一 IME 提交无论先后到达，均最多触发一次 PTY 写入；不同的连续提交不得被误删。
- [x] 覆盖已知 composition / 原生文本恢复时序的自动化回归测试通过。
- [x] 覆盖 macOS `input → keydown(229)` 后 xterm 同源 `onData` 重发的回归序列；没有 process-key 检查点的相同中文连续输入不得被合并。
- [x] 前端类型检查与相关终端 IME 测试通过。
- [x] `CHANGELOG.md` 和 `docs/功能清单.md` 已按 `V1.3.8` 记录修复。

## Out of Scope

- 不更换 xterm 版本或引入新的输入法依赖。
- 不修改 Rust PTY、传输协议或 CLI 自身的输入处理。
- 不借此重构终端输入、选择、建议或 IME 锚点模块。

## Scope Decision

问题影响所有终端 CLI（含普通终端），因此修复和回归验证以共享前端输入转发链路为范围；不得仅给 Codex 增加特判。

## Validation Limitation

当前没有可用的 macOS + Fcitx5 实机环境。交付前必须以确定性的 IME 事件序列回归测试、现有 composition 回归测试和 TypeScript 类型检查证明行为；macOS 实机验证保留为后续补测项，不得把未执行的人工验证表述为已通过。
