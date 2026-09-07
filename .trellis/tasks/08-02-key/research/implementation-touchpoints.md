# Provider Domain Rebuild — Current Implementation Touchpoints

## Current state after cleanup

The incomplete native provider CRUD implementation was removed. The stable
settings page and project switcher still use the existing CCS integration until
the new provider domain is implemented. This is intentional: there is no
reachable half-complete provider screen.

Historical provider migrations v25/v26 remain registered only so an existing
`cli-manager.db` does not fail SQLx migration validation. They are not the
future provider storage and no runtime code should query their tables.

## Required cutover inventory

| Area | Current source | Future responsibility |
| --- | --- | --- |
| Provider settings | `ProviderSettingsPage.tsx`, `commands/ccswitch.rs` | Replace CCS read-only browser with native CCS-compatible catalog/editor. |
| Project selector | `ProviderSwitchModal.tsx`, `providerSwitching.ts` | Store native v2 provider reference; offer Claude/Codex/Grok; reset follows global. |
| Terminal launch | `terminalStore.ts`, `commands/terminal.rs` | Resolve and materialize native provider; no runtime CCS read. |
| Startup command | `projectStartupCommand.ts` | Keep Claude/Codex mechanisms; add Grok launch environment via materializer. |
| Project/Worktree storage | project/worktree `provider_overrides` | Migrate legacy CCS ID through import map; retain unmapped repair issue. |
| CCS backend | `ccswitch.rs`, `ccswitch_db.rs` | Reduce to read-only import snapshot adapter after cutover. |
| CC Connect | `commands/cc_connect.rs`, handoff code | Resolve native catalog; never send local plaintext key to SSH target. |
| Hook/statusline | `hook_settings.rs`, statusline modules | Consume shared Home resolver/defaults; retain explicit roots. |
| History/transcripts | `historyPathArgs.ts`, history stores/commands, subagent transcript | Consume the same Home resolver for all CLI types; explicit history sources stay higher priority. |
| Data path | `app_paths.rs` | Add separate `providers.db`, generated, backup, journal paths. |
| Sync/export | sync stores/commands | Exclude plaintext key from default snapshot; preserve metadata/config placeholder. |

## Known cross-boundary risks

1. Tauri command names are strings, so GitNexus can undercount frontend-to-Rust
   impact. Search invoke sites and run end-to-end call-flow checks.
2. Current Hook and history path state can synchronize in both directions.
   Introducing Home fields without precedence separation can pull a newly
   selected Home back to an old explicit directory.
3. Global switching writes multiple external files while database state is
   transactional. The journal/backup/compensation design is mandatory.
4. Existing user config contains non-provider data in the same files: Hooks,
   MCP, project trust, permissions and statusline. Whole-file replacement is
   unsafe.
5. Existing CCS override IDs are not safe native IDs. Import mapping must
   precede launch cutover; no name/UUID-shape fallback is allowed.

## Mandatory discovery before each implementation phase

- Run GitNexus query/context then upstream impact for each edited symbol.
- Recheck the actual latest app migration version and all live invoke call sites.
- Recheck pinned CCS schema and the exact installed Claude/Codex/Grok CLI
  configuration versions before copying a writer.
- Test local/WSL path translation, Worktree/project/global precedence, and
  terminal snapshot immutability before replacing a launch path.
