# Confirmed findings progress

## Root-cause statement

本批缺陷不是单一表现层错误，而是四类边界契约未在控制流中落实：短路迭代被误用于有副作用的全量净化；异步恢复 future 被创建但未驱动；多阶段提交把中间态误报为 committed 并提前删除回滚材料；路径、字符串和外部命令参数默认了输入一定不同、ASCII 或由工具隐式解释。修复均落在产生错误状态的根因符号，而不是调用方兜底。

## Discovery ledger

| Finding | Disposition | Evidence / verification |
| --- | --- | --- |
| JSON array redaction/strip stops after first secret | Fixed | Multi-entry regression test passes; `redact_json` impact HIGH. |
| TOML ArrayOfTables redaction stops after first secret | Fixed | Multi-table regression test passes. |
| release runtime marker accepts dev namespace | Fixed | Build-specific exact/suffixed-name test passes. |
| manual failover restoration future is never awaited | Fixed | Future is awaited; routing/provider tests and crate check pass. |
| hot-switch rollback is blocked by its own verifying journal | Fixed | Compensation exempts the matching journal, retains backups until terminal state, and reports `verifying` before commit; Provider global tests pass. |
| Claude display-name suffix slices a UTF-8 string by bytes | Fixed | `strip_suffix` replacement and non-ASCII regression test pass. |
| Git tag format lacks `--format=` | Fixed | Temporary-repository tag listing test passes; SSH agent mirror compiles. |
| Unix startup runs after failed `cd` | Fixed | Startup is joined to `cd` with `&&`; Rust crate check passes. |
| macOS/Linux ignore `open_file` | Fixed | Platform branches now distinguish open-file from reveal/open-parent; source-reviewed on Windows. |
| overwrite move/copy can delete a same-path source | Fixed | Pre-delete identity guard and destructive regression test pass. |
| OpenCode failed delivery commits dedup state | Fixed | 11 script tests pass, including failure followed by identical retry. |
| installer rollback early returns after link mutation | Fixed | All post-swap errors enter common restoration path; SSH agent compiles on Windows, Unix runtime validation remains platform-limited. |
| shared Hook removal may delete entries still in use | Confirmed safe in current HEAD | Existing Grok/Claude preservation tests pass. |
| Codex textual true rejects trailing inline comment | Fixed | Inline-comment regression test and 38 hook-settings tests pass. |
| Desktop-pet `.`/`..` uninstall traversal | Excluded by user | No code or destructive test performed. |

## Quality gate

- `cargo check --lib`: passed.
- `cargo check --manifest-path ssh-agent/Cargo.toml`: passed on Windows.
- Provider global tests: 26 passed.
- Hook settings tests: 38 passed.
- New focused Rust regressions: passed.
- `node --test scripts/opencodeHook.test.mjs`: 11 passed.
- `npm run check:architecture`: passed, 0 violations.
- `npm run check:architecture -- --strict`: passed, 0 violations.
- `git diff --check`: passed; only repository line-ending notices were emitted.
- Full `cargo fmt --all -- --check` is blocked by pre-existing formatting deviations outside this task; task-owned additions were formatted locally and no broad unrelated rewrite was applied.
