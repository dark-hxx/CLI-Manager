# 修复内部终端 diff 输出左侧色块错乱

## Goal

修复内部终端在显示 GitHub Actions / 高吞吐带 ANSI 颜色日志时，**左侧出现红色竖条色块、背景色串色**的渲染异常。根因为后端 PTY 字节流在 chunk 边界切断了 UTF-8 多字节字符与 ANSI CSI 转义序列，导致 xterm.js 解析出错并污染 SGR（背景色）状态。

## What I already know

- 后端 `src-tauri/src/pty/manager.rs:127-152` 直接把 16KB read buffer 累积到 32KB 阈值就 Base64 emit，**未对齐 UTF-8 边界**，**未保护 ANSI CSI 序列完整性**。
- 前端 `src/components/XTermTerminal.tsx:16` 使用模块级 `TextDecoder`，但 L226 调用 `decode(bytes)` 时**未传 `{ stream: true }`**，跨 chunk 的多字节字符被解码为 `U+FFFD` 替换符 + 残留字节。
- 残留字节落进 xterm.js 后可能被解析为 C1 控制字符（0x80-0x9F）或 SGR 参数，污染当前单元格的背景色属性，表现为**整列染色 + 下一行行首背景色泄漏**。
- 没有设置 `terminal.unicode.activeVersion = '11'`，CJK / Emoji 列宽在 WebGL 下与 Canvas 不一致。
- `WebglAddon` 未注册 `onContextLoss` 回调，GPU 上下文丢失后不会自动 dispose 回退。
- 最近 commit `508fa4e` 只补了 import，没动渲染逻辑，所以问题在此前就已存在。

## Root Cause (确认)

**主因（必修）**：PTY 字节流在 chunk 边界被切断，引发以下两类问题：
1. **UTF-8 切断**：3 字节中文字符 / 4 字节 Emoji 被切到两个 chunk → 前端各自 decode 出现 `U+FFFD` + 残留字节 → xterm 把残留字节当 SGR 参数处理 → 背景色染到错误位置。
2. **ANSI CSI 切断**：`\x1b[41m`、`\x1b[0m` 等转义序列被切断 → 前端先 write 残缺序列，xterm 处于"等待 CSI 终结符"状态 → 下一 chunk 的字符全部被吞或属性错位。

## Requirements

- [R1] 后端 PTY reader emit 前，确保每个 chunk 都在 UTF-8 字符边界结束（不完整的尾部字节延迟到下一 chunk）。
- [R2] 后端 PTY reader emit 前，确保每个 chunk 都在 ANSI 转义序列完成后结束（`\x1b` 已开始但未收到终结符的字节，延迟到下一 chunk）。
- [R3] 前端 `TextDecoder.decode` 调用必须传 `{ stream: true }`（双重保险，即使后端保证边界，前端也不应假设）。
- [R4] 前端为 `WebglAddon` 注册 `onContextLoss` 回调，丢失时 dispose 并回落到 Canvas 渲染。
- [R5] Rust 端为 R1/R2 添加单元测试（含 stress_random_split），作为修复正确性的客观判据。

**已显式排除**：CJK / Emoji 列宽修复（原 R4 unicode11 addon），见 Decision 段。

## Acceptance Criteria

- [ ] 在内部终端跑 `gh run view <id> --log` 浏览含红绿 diff 的 GitHub Actions 日志，左侧不出现红色竖条 / 背景串色。
- [ ] 中文 + ANSI 颜色混排（如 `echo -e "\033[41m中文红底\033[0m后文"`）显示正常，无 `□` / 残字符。
- [ ] 高吞吐输出（如 `cat large-log.txt`，> 1MB）期间无字符吞失、无背景色泄漏。
- [ ] `npx tsc --noEmit` 通过，`cd src-tauri && cargo check` 通过，`cargo test` 通过。
- [ ] WebGL context loss 模拟（DevTools `WEBGL_lose_context` 扩展）后终端不变白，能继续渲染。

## Definition of Done

- 上述 AC 全部通过
- 改动文件 ≤ 2 个（`src-tauri/src/pty/manager.rs` + `src/components/XTermTerminal.tsx`）
- 不引入新依赖（除非必须 `@xterm/addon-unicode11`）
- `cargo test` 中为 R1/R2 边界逻辑添加单元测试

## Technical Approach

### 后端（manager.rs）

提取两个纯函数到 `pty/mod.rs`：

```rust
/// 返回 bytes 中可安全 emit 的字节数（在 UTF-8 边界且不在未完成的 ANSI ESC 序列内）。
/// 剩余字节保留在 pending buffer 中等待下一次 read 拼接。
fn safe_emit_boundary(bytes: &[u8]) -> usize;
```

实现要点：
- 从尾部回退，找最后一个完整的 UTF-8 char 起点（最多回退 3 字节）
- 从尾部回退，若发现未终结的 `\x1b[...` / `\x1b]...` / `\x1bP...` 序列，截到 `\x1b` 之前
- ESC 终结符规则：CSI = `0x40-0x7E`，OSC = `\x07` 或 `\x1b\\`，DCS = `\x1b\\`

reader 线程改成：
```rust
let safe = safe_emit_boundary(&pending);
if safe > 0 && (... 触发条件 ...) {
    let encoded = STANDARD.encode(&pending[..safe]);
    app_handle.emit(&output_event, encoded);
    pending.drain(..safe);  // 保留 [safe..] 给下一轮
}
```

### 前端（XTermTerminal.tsx）

```ts
// L226 改成
const text = SHARED_TEXT_DECODER.decode(bytes, { stream: true });

// Terminal 创建后增加
import { Unicode11Addon } from "@xterm/addon-unicode11";
terminal.loadAddon(new Unicode11Addon());
terminal.unicode.activeVersion = '11';

// WebglAddon 容错
if (webglAddon) {
  webglAddon.onContextLoss(() => {
    webglAddon?.dispose();
    webglAddonRef.current = null;
  });
}
```

## Out of Scope

- 字体 fallback 渲染优化（不影响功能）
- ConPTY 自身的列宽 bug（Windows 系统级问题，App 层无法根治）
- 历史会话渲染（HistoryDiffView 走另外的代码路径）

## Verification Strategy (重点 — 因为 bug 间歇性)

bug 由 `reader.read()` 的字节切断时机触发，无法手动稳定复现。验证转为**确定性测试**：

### Layer 1：Rust 单元测试（核心判据）

不依赖真实 PTY，构造"恶意"字节流喂给 `safe_emit_boundary`：

- `split_in_utf8`：3 字节中文 / 4 字节 emoji 在每个切点位置都能正确保留尾部
- `split_in_csi`：`\x1b[41m` 在 ESC / `[` / 参数 / 终结符前各切一刀，都能正确回退
- `split_in_osc`：`\x1b]...` BEL 终结的 OSC 序列同理
- `stress_random_split`：长字节流（含 ANSI + CJK + ASCII 混排）随机切 1000 次，逐次 emit + 拼接后**字节级等价于原流**

修复对错有客观判据。

### Layer 2：确定性复现脚本（端到端验证）

`scripts/repro-pty-tear.sh`（不入仓，仅本地）：故意按 7 字节非对齐切片 + 1ms flush，最大化触发概率。修复前色块乱，修复后干净。

### Layer 3：调试观测点

在 reader 线程对"safe_emit_boundary 截断了未完成序列"事件加 `debug!` 日志（保留 N 字节），证明保护真的在生效，并能量化触发频率。

## Decision (ADR-lite)

**Context**：终端 ANSI 色块错乱间歇性出现，无法手动稳定复现。  
**Decision**：方案 C（先后端字节边界 + 前端 streaming decode + WebglAddon 容错，**不引入** `@xterm/addon-unicode11`）。验证依赖 Rust 单测的字节级断言而非 UI 观察。  
**Consequences**：CJK 列宽问题在纯 ASCII 日志场景下不影响修复主因；若后续真实出现 CJK 列宽错位再补 unicode11 addon。

## Open Questions

(无 — 已收敛)

## Technical Notes

- xterm.js Unicode 11 文档：需要 addon。
- portable_pty 文档：reader 返回的就是原始字节流，不做任何编解码。
- ConPTY 在 Windows 上会自己重写一些 ANSI 序列，但不会拼凑 UTF-8。
- `pendingChunks.join("")` 拼接 string 不会引入边界问题（string 已是 UTF-16），问题只在 bytes→string 这一步。
