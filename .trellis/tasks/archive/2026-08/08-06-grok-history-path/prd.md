# 修复 Grok 会话历史路径解析

## Goal

恢复 Grok 会话历史列表、详情、搜索、统计和恢复链路对真实
`.grok\sessions` 目录的读取，保持当前 Grok Home 与历史来源设置的路径语义一致。

## Changelog Target

[TEMP]

## Root-Cause Statement

前端历史来源设置和 IPC 参数传递的是 Grok `sessionRoot`（例如
`C:\\Users\\1\\.grok\\sessions`），但后端 `history.rs` 的 Grok 收集器和精确查找器把该值当成配置根并再次追加 `sessions`，导致实际扫描
`...\\.grok\\sessions\\sessions`；修复应落在后端根路径契约和所有 Grok 读取触点，而不是在空列表 UI 处添加兜底。

## Confirmed Facts

- `src/lib/historyPathArgs.ts` 将已启用 Grok 历史实例的
  `locations.sessionRoot` 作为 `grokSessionRoot` 传入 IPC。
- `src/stores/historySourceSettingsStore.ts` 的 Grok 迁移和同步逻辑明确将
  Grok 配置目录转换为 `<root>\\sessions` 的 `sessionRoot`。
- `src-tauri/src/commands/history.rs` 的 `resolve_grok_history_root` 在显式路径
  下直接返回该值，但 `collect_grok_session_files` 与
  `find_exact_grok_session_in_root` 仍追加 `sessions`。
- 现有 Grok 单测使用 `.grok` 配置根，因此没有覆盖前端实际传入的
  `.grok\\sessions` 显式路径。

## Discovery List

- [ ] `src/lib/historyPathArgs.ts` — confirmed unrelated: emits the documented
  `sessionRoot` value and should remain unchanged.
- [ ] `src/stores/historySourceSettingsStore.ts` — confirmed unrelated: persists
  the correct Grok `sessionRoot` shape and should remain unchanged.
- [ ] `src-tauri/src/commands/history.rs` — in scope: normalize default and
  explicit roots to one session-root contract for list/detail/search/stats and
  exact lookup.
- [ ] `src-tauri/src/commands/history/catalog.rs` — in scope for impact review:
  receives `HistoryRoots` and must continue using the normalized Grok root.
- [ ] `src-tauri/src/commands/history_sources.rs` — confirmed unrelated: its
  descriptor and default candidate already describe `.grok\\sessions`.
- [ ] `src/stores/historyStore.ts` — confirmed unrelated: forwards summaries and
  does not construct the Grok filesystem path.

GitNexus impact/context was attempted but unavailable in this environment; the
discovery list uses the backend contracts plus repository symbol search.

## Requirements

- Treat `HistoryRoots.grok_session_root` and `resolve_grok_history_root` as the
  actual Grok session directory, not the parent `.grok` configuration directory.
- Preserve the default behavior when no explicit root is supplied by resolving
  the real default `.grok\\sessions` directory.
- Make list scanning, exact session lookup, source-base validation, detail
  loading, search, stats, refresh and index paths use the same root semantics.
- Keep existing IPC command signatures stable.
- Add regression tests for both explicit `.grok\\sessions` and implicit default
  roots, including exact session lookup.
- Update `[TEMP]` changelog and product functionality documentation.

## Scenario Matrix

| Dimension | Required coverage |
| --- | --- |
| Scope | Global/default real Home; configured explicit local session root |
| Runtime | Windows local path; WSL path remains governed by existing WSL handling |
| Session state | Empty root; one valid session; multiple project/session directories |
| UI path | History list; open detail; global search; stats/index refresh |
| Provider scope | Global, project and Worktree launch all share the real Grok Home |
| Hook state | Hook installed; Hook absent must not affect read-only history parsing |

## Acceptance Criteria

- [x] Grok history list discovers sessions under an explicit
  `...\.grok\sessions` root without looking under `...\\sessions\sessions`.
- [x] Exact Grok session lookup and detail loading work with the same explicit
  session root.
- [x] Default root behavior still resolves the real user Home session root.
- [x] Regression tests cover explicit roots and the default resolver path and
  pass.
- [x] `cargo fmt --all -- --check`, `cargo test` for the affected history module,
  `cargo check`, and `npx tsc --noEmit` pass.
- [x] `CHANGELOG.md` and `docs/功能清单.md` are updated under `[TEMP]`.
- [x] No commit is created in this turn; implementation remains as uncommitted
  working-tree changes for user review.

## Out of Scope

- Migrating or deleting existing Grok session files.
- Changing Grok Home/provider scope behavior already fixed in the preceding
  provider tasks.
- Reworking the history catalog schema or frontend history UI.

## Notes

- This is a root-cause bug fix because the failure crosses the frontend/backend
  IPC and filesystem path boundary.
