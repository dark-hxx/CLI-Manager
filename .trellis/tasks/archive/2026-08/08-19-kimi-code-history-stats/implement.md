# Implement

1. `HistoryRoots` + IPC `kimiConfigDir` 贯穿 list/get/search/delete/stats/index。
2. `history/kimi.rs` parser/collect/lookup/delete + 接到 `scan_session_*`。
3. 前端 source/resume/stats infer/i18n。
4. Rust fixture 与 Node resume/pathArgs 测试。
5. CHANGELOG V1.3.7、功能清单、history-index / history-stats / history-session / cli-hook 契约。
6. 对齐 Kimi Code 上游 wire/index 实现，修复 nested loop event、usage 去重回退、latest-wins/tombstone、partial tail 和恢复 ID 白名单。
7. 通过全量 Rust 单测、`cargo check`、`npx tsc --noEmit`、专项 Node 测试、fmt、diff check 和 GitNexus 变更审查后，以普通 push 更新 PR。
