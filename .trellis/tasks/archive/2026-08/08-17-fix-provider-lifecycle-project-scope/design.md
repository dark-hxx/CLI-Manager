# Design

## 1. Boundaries

This fix keeps the existing three authorities separate:

1. `providers.db` owns provider catalog data, keys, import provenance, and global apply state.
2. `cli-manager.db` owns project and Worktree `provider_overrides`.
3. `provider_scope_prepare` materializes an override only when a terminal starts.

No dependency, database migration, IPC signature, or global writer change is required.

## 2. Lifecycle reference validation

Replace the import-provenance count with an app-database reference scan:

```text
disable/delete
  -> validate non-current provider
  -> open cli-manager.db read-only
  -> inspect project overrides
  -> inspect active Worktree overrides
  -> parse schema-v2 reference for the requested app type
  -> block only an exact provider ID match
  -> mutate providers.db
```

Use the same schema-v2 reference-shape semantics as `scope.rs`: exact app key,
`grok` compatibility alias, `schemaVersion=2`, `source=cli-manager`, matching
`appType`, non-empty `providerId`. Lifecycle scanning counts only a value that
successfully meets that contract and exactly matches the requested catalog ID.
Legacy CCS or malformed values do not identify a native provider and are
ignored by this scan; direct scope resolution keeps its existing migration
diagnostics when it needs to launch such a value.

Missing `cli-manager.db` means no registered project/Worktree references and returns zero. Database I/O errors remain explicit provider reference-check errors. Active Worktrees count; missing Worktrees do not, matching runtime scope resolution. Provider import rows remain owned by their existing cascading foreign key.

Cross-database atomicity is intentionally unchanged: the app is the sole normal writer and the existing UI command remains the mutation boundary. Introducing `ATTACH` or a new transaction coordinator would add disproportionate complexity.

## 3. Project and Worktree selection

`ProviderSwitchModal.applyProvider` will:

1. Build a schema-v2 reference through existing `withOverride`.
2. Persist it through existing `updateTargetProviderOverrides`.
3. Update local probe state with source `project` or `worktree`.
4. Refresh provider badges and show the existing scoped-success message.

It will not require Home availability, request a global preview, request confirmation for global file writes, or call `provider_global_apply`.

The terminal pipeline remains unchanged:

- Claude: snapshot `settings.json`, startup `--settings <path>`.
- Codex: non-secret profile beside the real Codex Home, startup `--profile <name>`, secret in process environment only.
- Existing terminals: unchanged until a new launch/resolution.

Reset continues to remove only the selected target's app-specific override.

## 4. Grok behavior

When `appType` is `grokbuild`, the modal renders a localized unsupported message and does not load or list providers, persist overrides, or call global apply. The project/Worktree menu entry remains visible so the user receives an explicit explanation.

Existing backend Grok snapshot/override handling stays in place solely for backward compatibility. This task does not migrate or erase historical values.

## 5. Terminal Tab and Markdown preview

- Both sortable session and Workspan tabs handle only auxiliary button `1`.
  They prevent the browser default and delegate to the existing `onClose`
  callback, preserving confirmation, focus and resource cleanup behavior.
- Preview source resolution accepts every registered `HistorySource` exposed by
  the existing CLI descriptor registry, including `pi`; unknown sources are
  not fabricated.
- The preview control is visible for configured Agent CLI sessions. It remains
  disabled until a resolvable history source and a bound `cliSessionId` are
  available, so there is no ambiguous "latest project session" fallback.

## 6. Error and UI contract

- Map both referenced-disable and referenced-delete backend codes to explicit localized messages.
- Add a dedicated bilingual Grok project-scope unsupported message.
- Do not hardcode visible strings.
- Preserve current global-switch UI and settings-page behavior.

## 7. Compatibility and rollback

- Provider and project JSON schemas remain unchanged.
- IPC command names and payloads remain unchanged.
- Rolling back restores previous behavior without requiring data migration because this fix writes the already-supported schema-v2 override.
- Historical Grok data is untouched.

## 8. Pi Hook responsiveness and MCP discovery

- The Pi Hook generated source keeps the existing three lifecycle event mappings, but event handlers return synchronously after starting `postHookEvent`; the detached function catches bridge failures and aborts its loopback request after one second.
- Pi MCP Adapter configuration is static discovery only. The collector reads, from low to high precedence, shared global MCP files, Pi's agent-root `mcp.json`, project `.mcp.json`, then project `.pi/mcp.json`. Existing metadata-only parsing retains names, scope, activation, and transport while never serializing commands, URLs, credentials, or arguments.
- Pi uses `disabled: true` as its native disable marker. Disabled entries remain in details and are excluded from active totals. A non-empty static result suppresses the "unknown extension observability" diagnostic; its health remains `unknown` until exact-session evidence exists.
- Local and SSH use the shared discovery core. The WSL collector mirrors the same ordered sources through its fixed read-only WSL file path flow; no WSL UNC path is opened directly.

## 9. Verification

- Rust tests cover exact project reference, other-app reference, active versus
  missing Worktree reference, and legacy/malformed values that must not block
  native catalog operations.
- TypeScript type-check verifies UI/type integration.
- Manual source-level checks verify Claude/Codex selection calls only target persistence and Grok takes the unsupported branch.
- Run provider Rust tests, full `cargo test`, `cargo check`, and `npx tsc --noEmit`.
- Run the Pi Hook source regression and Agent Capability core regression tests.
- Run terminal preview regression tests; TypeScript static validation is sufficient for this Rust/Pi Hook-focused change, so do not run the production frontend build unless release packaging is explicitly requested.
- Run `gitnexus_detect_changes` before delivery.
