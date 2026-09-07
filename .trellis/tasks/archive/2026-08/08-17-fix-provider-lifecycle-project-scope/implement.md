# Implementation Plan

## Ordered checklist

- [x] Update `src-tauri/src/provider/repository/catalog.rs` so lifecycle checks read real schema-v2 project/active-Worktree references from `cli-manager.db`, not `provider_import_refs`.
- [x] Add focused Rust regression coverage in the provider repository test module for project references, app-type isolation, Worktree status, and legacy/malformed values.
- [x] Add the missing referenced-delete mapping in `src/components/settings/pages/NativeProviderSettingsPage.tsx`.
- [x] Restore `ProviderSwitchModal.applyProvider` to persist the selected project/Worktree override through existing helpers and never call global Home apply.
- [x] Add the Grok unsupported branch so no list, override write, or global apply occurs.
- [x] Make session and Workspan Tabs close through their existing paths on mouse middle-click.
- [x] Keep the terminal preview entry visible for configured CLI tools and resolve Pi through its registered history source.
- [x] Update `src/lib/i18n.ts` for both `zh-CN` and `en-US`; retain 24-hour time behavior by not touching date/time formatting.
- [x] Update `CHANGELOG.md` under `V1.3.6` and correct `docs/功能清单.md` provider-scope descriptions.
- [x] Run formatting, focused tests, full type/Rust checks, and inspect the final diff.
- [x] Run `gitnexus_detect_changes` and review the aggregated impacted symbols/flows.
- [x] Change the generated Pi Hook lifecycle handlers to fire-and-forget reporting with a bounded loopback request timeout.
- [x] Discover Pi MCP Adapter global/project config sources in local, WSL, and SSH capability inspection; preserve `disabled: true` activation semantics.
- [x] Add focused Pi Hook and capability-core regressions without exposing MCP configuration secrets.

## Validation commands

```powershell
npx tsc --noEmit
Set-Location src-tauri
cargo fmt --check
cargo test provider::repository
cargo test provider::scope
cargo test install_then_uninstall_pi_extension --lib
cargo test --manifest-path agent-capabilities-core/Cargo.toml
cargo test
cargo check
node --test scripts/terminalMarkdownPreview.test.mjs
```

`npm run build` 仅构建 Vite 前端资源，不作为本次以 Rust/Pi Hook 为主修复的验证步骤；前端静态类型由 `npx tsc --noEmit` 覆盖。

## Risk and rollback points

- `catalog.rs` crosses `providers.db` and `cli-manager.db`; keep the read path read-only and do not add migrations.
- `ProviderSwitchModal` serves both project and Worktree entry points; verify each target writes only its own record.
- Do not change `provider_scope_prepare`, global writers, routing, or existing terminal hot-switch behavior unless verification exposes a direct defect.
- If app-database parsing reveals an undocumented legacy shape, stop and return to planning instead of adding a heuristic fallback.

## Pre-start review gate

- [x] Branch/upstream check reported: `master` synchronized with `origin/master` (0 ahead / 0 behind).
- [x] Root-cause statements and discovery list recorded.
- [x] GitNexus impact is LOW for every planned symbol edit.
- [x] Changelog target confirmed as `V1.3.6`.
- [x] Grok product decision confirmed.
- [x] User approves this final plan before `task.py start`.
