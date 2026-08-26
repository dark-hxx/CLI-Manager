# Built-in Live Server Scenario Matrix

| Dimension | Expected behavior |
|---|---|
| Window focus: current / other / unfocused | Server and watcher are backend-owned; browser opening does not depend on terminal focus. |
| Split pane: current / other / deep split | File-panel context determines the project root; terminal pane topology is untouched. |
| Minimized / tray | Existing servers continue while the app process runs; app exit stops them. |
| UI mode: expanded / collapsed / embedded panel | The action is present wherever the existing file context menu is rendered; hidden panels do not own server lifecycle. |
| Multi-session / Workspan | Registry keys by effective project path, not terminal session; Workspan switching does not stop or retarget a server. |
| Focus mode on / off | No behavior difference. |
| Local PowerShell/CMD/Pwsh/Bash | Shell-independent because no external command is spawned. |
| WSL | Explicitly unsupported in this delivery; no local-path fallback. |
| SSH | Explicitly unsupported; no remote path is passed to local IPC. |
| Main repository | Project root is served normally. |
| Linked Worktree with `.git` file | Effective Worktree path is its own server root; `.git` shape is irrelevant to entry eligibility. |
| Missing Worktree directory | New start fails explicitly; an already-registered server can still be stopped by normalized key. |
| Claude/Codex hook installed states | Unrelated; no hook dependency or change. |
| Same project opened twice | Existing port/session is reused. |
| Two projects | Independent loopback ports and watchers. |
| Unicode/space paths | URL path segments are percent-encoded and decoded before validated resolution. |
| Symlink/reparse inside root | In-root targets serve; targets canonicalizing outside root are rejected. |
| Browser refresh | HTML embeds the reload client; asset changes advance the server version and reload within one second. |
| Browser unavailable/opener failure | Start result remains explicit and the UI reports the opener failure; no alternate browser/runtime fallback. |
| Port allocation failure | Start fails with `listener_bind_failed`; no fixed-port or external-server fallback. |
| Application exit | All shutdown senders fire and watcher/listener owners are dropped. |
