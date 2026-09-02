# Issue #245 实施计划

## Phase 1：实现前复核

- [x] 运行 `trellis-before-dev`，读取本任务涉及的项目 spec 和开发前检查项。
- [x] 对即将修改的全局前端 scheduler、`DaemonHost` 输出投递/ACK 方法和 `SessionBuffer` 读取方法补做 GitNexus impact；CRITICAL 结果已知，改动保持最小且只限本问题链路。
- [x] 确认工作树中 `AGENTS.md`、`CLAUDE.md` 仍仅包含用户已有改动。

## Phase 2：前端

- [x] 在 `useTerminalDisplay.ts` 增加 hidden-document timer handle、可见性判断与 `visibilitychange` 迁移。
- [x] 复用既有 entry 选择和 fairness 逻辑，使用 rAF + watchdog timer 且由任一回退回调取消另一句柄，保证同一时刻只消费一个 terminal entry。
- [x] 扩展 `scripts/terminalReplay.test.mjs` 的可控 document/timer stub，覆盖 hidden 持续输出、可见恢复与 rAF 停滞回退。

## Phase 3：daemon

- [x] 将 `emit_daemon_output` 从“等待所有客户端容量”改为“保存后尝试非阻塞投递”。
- [x] 调整 `push_output_to_attached`，paused 客户端只停止 live 投递，attach barrier 继续保序缓存。
- [x] 增加从 `SessionBuffer` 按 `last_sent_sequence` 取得保留输出并按高/低水位补发的内部路径。
- [x] 在 ACK 解除 paused 后触发补发；移除会阻塞输出 worker 的 Condvar wait/notify 及相关测试。
- [x] 新增 Rust 回归测试，证明高水位期间 worker/生产路径不等待 ACK，并证明 ACK 恢复后补发顺序和单客户端隔离。

## Phase 4：契约与记录

- [x] 更新 `.trellis/spec/backend/terminal-output-scheduling-contracts.md` 和 `.trellis/spec/backend/pty-daemon-contracts.md`，记录 hidden timer fallback 及“背压暂停客户端投递、不阻塞 PTY producer”的可执行契约。
- [x] 按现有格式更新 `CHANGELOG.md` 的 `V1.3.9` 条目。
- [x] 在 `docs/功能清单.md` 的终端/PTY 功能板块记录 Issue #245 修复。

## Phase 5：质量门禁

- [x] 运行 `npx tsc --noEmit`。
- [x] 运行终端 replay Node tests（`node --test scripts/terminalReplay.test.mjs`）。
- [x] 运行 `cargo fmt --check`、`cargo check` 与相关 `cargo test`；全量 cargo test 通过，仓库级 fmt check 仅剩既有 `src-tauri/src/provider/database.rs:1073` 格式差异。
- [x] 执行 `trellis-check`，复核跨层数据流、契约、i18n 和测试覆盖。
- [x] 执行 GitNexus `detect_changes()`，结果为 low risk、affected_count=0；变更符号集中在终端 scheduler、daemon SessionBuffer/DaemonHost/DaemonPtyEventSink 与对应测试。
- [x] 用户确认后执行 `task.py start` 并进入实现阶段；实现完成后按 Trellis finish 流程交付。

## Phase 6：Review 修复

- [x] checkpoint 快照与 live backlog 分离；补发只读取 spool/内存原始 live 事件，避免把快照追加到已有 xterm。
- [x] 补发前检查包含空 resize sequence 的连续性；发现缓存截断缺口时关闭慢客户端，交给既有重连 attach/replay_reset 恢复。
- [x] spool 回读移出全局 `clients` 锁，补发期间保持 paused 作为顺序屏障，并新增 checkpoint 排除与截断缺口回归测试。
