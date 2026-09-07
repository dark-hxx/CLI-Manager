# Root Cause And Touchpoints

## Root-cause statement

The lifecycle failure lives at the provider-domain/app-database boundary: `catalog.rs` counts import provenance rows in `providers.db` as runtime project references, so imported providers are falsely blocked; the fix must read actual schema-v2 overrides from `cli-manager.db`.

The project-switch failure lives at the frontend scope-selection boundary: `ProviderSwitchModal.applyProvider` calls the global Home writer instead of persisting the selected project/Worktree override, so the fix must restore target-scope persistence and leave materialization to `provider_scope_prepare` at terminal launch.

The Pi response delay lives at the Pi Extension lifecycle boundary: Pi awaits `agent_start` handlers, while the generated CLI-Manager Hook awaits an unbounded local bridge fetch; the fix must detach that notification and bound its request instead of delaying terminal input or PTY writes.

The Pi MCP capability gap lives at the discovery boundary: Pi's external MCP Adapter persists standard `mcpServers` metadata in known config files, but Pi has no registered config layout in the capability collector, so the UI receives an empty MCP list and correctly-but-unhelpfully emits the unknown-observability diagnostic. The fix must register the adapter's read-only config sources, not fabricate frontend state.

## Evidence

- `src-tauri/src/provider/repository/catalog.rs:317-330`: `provider_reference_count` queries `provider_import_refs`.
- `src-tauri/src/provider/database.rs:110-125`: `provider_import_refs` records source identity/fingerprint and cascades on provider delete.
- `src-tauri/src/provider/scope.rs:236-296`: runtime references come from `projects.provider_overrides` and `worktrees.provider_overrides`, parsed as schema-v2 CLI-Manager references.
- `src/components/settings/pages/NativeProviderSettingsPage.tsx:59-82`: disable has an error mapping; referenced delete does not.
- `src/components/ProviderSwitchModal.tsx:207-224`: the correct `withOverride` serializer already exists.
- `src/components/ProviderSwitchModal.tsx:255-264`: the correct project/Worktree persistence function already exists.
- `src/components/ProviderSwitchModal.tsx:322-366`: selection currently invokes `provider_global_preview` and `provider_global_apply`.
- `src-tauri/src/provider/scope.rs:781-827`: scoped launch already generates Claude settings and Codex profile metadata.
- `src/lib/projectStartupCommand.ts`: launch command assembly already consumes `--settings` / `--profile` metadata.
- `git blame`: commit `22c8b8b6` changed the project switch path to global Home apply; earlier commits persisted project overrides.
- `src-tauri/src/commands/hook_settings.rs:2242-2308`: generated Pi Hook `agent_start` awaited `postHookEvent`, whose fetch had no timeout.
- Installed Pi `0.84.1` source: `AgentSession` awaits ExtensionRunner `emit(agent_start)`, and ExtensionRunner awaits each handler promise.
- Installed `pi-mcp-adapter 2.26.0` configuration: its Pi-global `mcp.json` contains `mcpServers`; the documented precedence includes shared global, Pi global, shared project, and Pi project files.
- `src-tauri/agent-capabilities-core/src/lib.rs`: `AgentKind::Pi` previously added no config documents, while the WSL collector independently made the same omission.

## GitNexus impact

- `provider_reference_count`: LOW, 2 direct callers (`delete_provider`, `set_provider_enabled`), 4 impacted symbols across Repository and Commands.
- `delete_provider`: LOW, direct Tauri command caller only.
- `set_provider_enabled`: LOW, direct Tauri command caller only.
- `ProviderSwitchModal`: LOW, direct Sidebar consumer and indirect App consumer.
- `applyProvider`: LOW, direct modal consumer; Sidebar/App are transitive UI consumers.
- GitNexus semantic query FTS is unavailable because the local LadybugDB FTS extension is missing. Exact context/impact remained available; semantic discovery was cross-checked with fast-context, contracts, `rg`, Git history, and source reads.
- `pi_extension_source`: LOW; its direct source generator caller is `install_pi_modules`. The agent-capabilities subcrate and Windows-only WSL helper are not present in the GitNexus index, so their impact was checked through the capability contract, shared-core call sites, and direct source inspection.

## Discovery list

- [x] `src-tauri/src/provider/repository/catalog.rs`: wrong lifecycle reference check; implementation target.
- [x] `src-tauri/src/provider/database.rs`: import provenance schema and cascade semantics; confirmed no schema change needed.
- [x] `src-tauri/src/provider/scope.rs`: authoritative scope-reference parser and launch materialization; reuse semantics, no contract change required.
- [x] `src-tauri/src/commands/provider.rs`: stable IPC wrappers; confirmed signature changes are unnecessary.
- [x] `src-tauri/src/provider/repository/tests.rs`: backend regression-test location.
- [x] `src/components/settings/pages/NativeProviderSettingsPage.tsx`: lifecycle error-code mapping target.
- [x] `src/components/settings/providers/useNativeProviderCatalog.ts`: invokes lifecycle commands; confirmed behavior remains unchanged.
- [x] `src/components/ProviderSwitchModal.tsx`: project/Worktree regression and Grok guard target.
- [x] `src/lib/providerSwitching.ts`: schema-v2 serializer/parser; confirmed reusable without changes.
- [x] `src/stores/projectStore.ts`: project override persistence; confirmed reusable.
- [x] `src/stores/worktreeStore.ts`: Worktree override persistence; confirmed reusable; removed Worktrees are deleted and missing Worktrees are not launch-active.
- [x] `src/stores/terminalStore.ts`: launch-time scope preparation; confirmed existing Claude/Codex behavior is authoritative.
- [x] `src/lib/projectStartupCommand.ts`: startup argument application; confirmed existing behavior is authoritative.
- [x] `src/lib/i18n.ts`: bilingual lifecycle and Grok unsupported messages.
- [x] `CHANGELOG.md` and `docs/功能清单.md`: `V1.3.6` delivery records.
- [x] Global Home writer/routing/SSH commands: confirmed unrelated; this task must not change them.
- [x] `src-tauri/src/commands/hook_settings.rs`: Pi lifecycle source generator; implementation target for non-blocking bridge delivery.
- [x] `src-tauri/agent-capabilities-core/src/lib.rs`: canonical local and SSH Pi MCP configuration discovery; implementation target.
- [x] `src-tauri/src/commands/agent_capabilities.rs`: Windows WSL Pi configuration discovery; implementation target, mirrors the shared source order.
- [x] `src/components/terminal/AgentCapabilitiesCard.tsx`: confirmed it already renders `mcpSummary` and detail rows; no presentation fix is needed.
- [x] Pi MCP Adapter/server execution: confirmed out of scope; collector only reads normalized static metadata and existing exact-session evidence.

## Scenario matrix

| Dimension | Required result |
| --- | --- |
| Provider origin: manual/imported | Origin alone never blocks disable/delete. |
| Provider state: current/non-current | Current stays blocked; eligible non-current follows real references. |
| Project reference: none/exact app/other app | Only exact app + provider ID blocks. |
| Worktree: active/missing/deleted | Active exact reference blocks; missing is not launch-active; deleted row has no reference. |
| Scope: project/Worktree | Selection writes only the chosen target; Worktree remains higher priority. |
| CLI: Claude/Codex/Grok | Claude uses launch settings; Codex uses launch profile; Grok selection only shows unsupported. |
| Environment: local/WSL | Project selection never invokes global Home apply in either environment. |
| Existing terminal/new terminal | Existing process remains unchanged; next launch resolves the saved override. |
| Custom startup command | Existing no-auto-rewrite warning remains. |
| Legacy Grok override | Backend remains compatible; UI creates no new override and performs no cleanup. |
| Pi Hook bridge | Local bridge healthy, slow, unavailable: all event handlers return immediately; reporting is best-effort and bounded. |
| Pi MCP config | No adapter config: retain explicit unknown diagnostic; active/disabled adapter config: show rows without starting servers. |
| Capability environment | Local, WSL, SSH Agent: use the same Pi adapter source order in the respective environment; no desktop-path fallback for SSH. |
