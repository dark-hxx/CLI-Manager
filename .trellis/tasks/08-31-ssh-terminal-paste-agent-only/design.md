# Technical design

## Root cause and scope

根因在“终端会话上下文 → SSH Agent 附件请求”边界：SSH Host 终端已经保存
`sshHostId` 和 `remotePath`，但粘贴链路把解析出已登记 SSH Project 当成前置条件，且
附件协议没有把 Host 级存储目录传给远端 Agent，因此无项目 Host 终端会在前端提前失败，
Host 独立目录也无法生效。修复落在会话上下文构造、Host 持久化、Tauri/daemon 请求契约
和 Agent 文件存储边界，不在 toast 或粘贴事件处增加兜底。

这是一项跨边界根因修复。GitNexus 查询已执行，但当前索引的 FTS 扩展不可用；已按项目
规约降级为精确 `rg` 符号追踪和 SSH Agent/SSH Host 契约核对。实现前仍需对每个现有
函数、方法或类执行 `impact(..., direction: "upstream")`，若返回 HIGH/CRITICAL 必须
暂停并报告。

## Data flow

```text
SSH Host editor
  -> SshHost.attachment_root
  -> SQLite ssh_hosts.attachment_root (migration 37)
  -> sshHostStore / sync backup-restore
  -> buildSshAgentHostLaunch(session.sshHostId, session.remotePath)
  -> ssh_remote_file_attach_{data,path}(..., attachmentRoot)
  -> daemon readonly bridge capability gate
  -> Agent fileAttach[Any]Begin.attachmentRoot
  -> managed remote root / session id / upload id
  -> returned absolute path -> terminal paste
```

### Host 列表附件面板

SSH Host 行只保留连接地址和操作入口，不展示认证方式徽标；认证方式仍由 Host 编辑器和
OpenSSH 连接测试使用。新增的上传入口打开 Host 级双栏面板：本地栏通过系统文件选择器
加入待传文件，远程栏读取该 Host Agent 实际解析出的附件根目录，底部传输队列逐项显示
等待、上传中、成功或失败。上传复用 `fileAttachAny`/旧版图片回退协议，使用 Host-only
Readonly bridge 和独立的管理会话 ID，因此不需要登记项目或活动终端，也不会改变终端
粘贴的会话上下文。

为兼容默认目录中的 `XDG_CACHE_HOME` 和远端 HOME，不在桌面端猜测缓存路径。Agent 增加
只读的 `fileAttachmentRoot` 请求，按与上传相同的自定义目录规则返回规范化的 Agent
附件根目录；旧 Agent 缺少该可选能力时，面板保留上传能力，远程栏显示能力不可用，成功
上传后仍以 Agent 返回的绝对路径反馈结果。

`remotePath` remains the SSH terminal launch working directory. `attachment_root` is an
independent Host-level storage preference and must never be inferred from the selected
project, another pane, local `cwd`, or a Worktree path.

## Host configuration and persistence

- Add `attachment_root: string` to `SshHost`, `CreateSshHostInput`, and the update form.
- Add migration `37 / add_attachment_root_to_ssh_hosts`:
  `ALTER TABLE ssh_hosts ADD COLUMN attachment_root TEXT NOT NULL DEFAULT '';` Existing
  Hosts therefore retain the current Agent default without data backfill.
- Extend `sshHostStore` create, update, load normalization, and validation. The stored value
  is trimmed and is either empty or a remote POSIX path accepted by the SSH home-path rules:
  absolute `/...`, `~`, or `~/...`; reject relative paths, `..`, control characters,
  backslashes, `$`, and backticks.
- Extend workspace backup/restore and portable SSH Host columns. The directory is not a
  credential or machine-local SSH field, so it is portable; restore treats a missing field as
  empty and sanitizes invalid imported values to empty instead of writing an unsafe path.
- Put the field in the existing SSH Host “Connection settings” section. The bilingual label
  and description must explicitly say it is a remote parent directory and that empty means
  Agent default.
- Each database Host row owns its value. A Host opened from the settings page and all SSH
  sessions created from that Host share the same setting; another Host ID never inherits it.

## Session-scoped launch resolution

Add a Host/session variant beside the existing project builder in
`src/lib/sshAgentHistory.ts`:

- `buildSshAgentHostLaunch(hostId, remotePath)` loads the exact Host row, its installed
  `cli-manager-ssh-agent` installation, connection spec, client identity, and Host
  `attachment_root`.
- It returns the existing launch shape with `projectId`, `projectName`, and `toolSource`
  empty, while retaining valid `hostId`, `remotePath`, `agentPath`, installation identity,
  remote machine identity, `clientInstanceId`, and a fresh `bridgeEpoch`.
- Share Agent/Host resolution with `buildSshAgentProjectLaunch` rather than duplicating the
  installation lookup. Project history/file browsing continues using the existing project
  builder and project root.
- Add `attachmentRoot` to the attachment launch type only; it is not used by interactive SSH
  command construction or project/Hook binding.

`sshRemoteFiles.ts` gains a session attachment entry point. The existing project entry point
remains for callers outside terminal paste, while `useTerminalInput` uses the session entry
point for every SSH paste/drop. It validates that the current session has its own
`sshHostId` and `remotePath`; a missing legacy session context fails with a localized context
error and never falls back to a local path. Registered SSH project sessions use their saved
session metadata too, so switching project selection cannot retarget an existing pane.

The no-project launch is allowed only for request-driven Readonly bridge traffic. The Primary
Hook bridge keeps its existing project ID and tool-source requirements. This preserves CLI
Hook/history/project binding while enabling Host-only file attachment.

## Desktop IPC and daemon contract

- Keep command names `ssh_remote_file_attach_data` and `ssh_remote_file_attach_path`.
- Add an optional `attachmentRoot` argument to those two Tauri commands and pass it through
  the existing blocking upload worker. File listing/read/search commands are unchanged.
- The desktop upload code validates and trims this value before creating a Begin request.
  Both `fileAttachAnyBegin` and legacy image `fileAttachBegin` carry the same optional
  `attachmentRoot`; chunks, finish, and abort remain upload-ID-only.
- Update the daemon capability gate so a Begin payload with a non-empty `attachmentRoot`
  requires `fileAttachCustomRoot` in addition to the normal `fileAttachAny` or `fileAttach`
  capability. Reject before writing to the remote Agent, so an old Agent cannot silently
  ignore the new field.
- Relax `ensure_bridge` only for `Readonly`/`Git` request-driven lanes: `project_id` remains
  mandatory for `Primary`, but is allowed to be empty for Host-only attachment. Agent,
  installation, remote-machine, client, host, bridge epoch, and transport identities remain
  mandatory.
- Preserve the existing upload policy: prefer `fileAttachAny` up to 20 MiB; fallback to
  validated legacy images only when `fileAttachAny` is missing; never paste a desktop local
  path to SSH. A missing custom-root capability maps through the existing upgrade error path.

## Remote Agent storage contract

The Agent release that understands custom roots is `0.1.11`, protocol `1.12`, and advertises
`fileAttachCustomRoot` alongside `fileAttach` and `fileAttachAny`. The current default root is
unchanged:

```text
${XDG_CACHE_HOME:-$HOME/.cache}/cli-manager-ssh-agent/attachments
```

For a non-empty configured root, the value is treated as a user-selected remote parent. The
Agent expands the supported `~` form without invoking a shell and creates/uses only this
managed namespace beneath it:

```text
<expanded attachment_root>/cli-manager-ssh-agent/attachments/
  <validated session id>/<validated upload id>/<safe file name>
```

This keeps cleanup and deletion inside an Agent-owned subtree and leaves unrelated files in
the configured parent untouched. The Agent must reject path traversal, control characters,
backslashes, non-absolute/non-home paths, symlinked path components, non-directories, and
invalid file/session/upload names. It creates private directories/files as today, uses atomic
finish, and cleans only expired entries below the managed attachment root. The custom parent
itself is never recursively removed or cleaned.

The Begin request adds `attachmentRoot` with a default empty value for wire compatibility.
Older Agents continue to support the default root because the field is omitted when empty;
custom-root uploads fail explicitly with `ssh_agent_capability_missing:fileAttachCustomRoot`
until the Host Agent is upgraded.

## Error and compatibility behavior

- Replace the misleading paste error that says an SSH Project is required with a bilingual
  message for missing Host/session context.
- Keep Agent-not-installed, unsupported-file, size-limit, invalid-host, and capability
  failures on the existing localized attachment error path.
- Do not alter local PowerShell/CMD/Pwsh, WSL, Worktree relative-path handling, SSH project
  file browsing, Git, history, Hook installation, remote handoff, or Primary bridge binding.
- The returned remote path remains absolute and must still contain the Agent-managed
  `cli-manager-ssh-agent/attachments` namespace before the desktop pastes it.

## Verification and rollback shape

Focused tests cover Host field round-trip/default migration, valid/invalid custom roots,
session-vs-project context and split-session isolation, optional Tauri payload serialization,
Readonly no-project bridge acceptance, custom capability rejection, Agent namespace and cleanup
isolation, and old-Agent default/legacy-image compatibility. Run the full TypeScript and Rust
checks after focused tests.

Rollback is additive: removing the frontend use of `attachmentRoot` restores default Agent
storage; the database column can remain empty without affecting existing Hosts. If the new
Agent release is unavailable, the desktop continues default-root uploads and reports an upgrade
error only for Hosts that configured a custom root.

## Discovery list

- [x] `src/hooks/useTerminalInput.ts`: all image, native clipboard-file, Tauri drop, and text
  paste paths share the current session context; the project prerequisite is the direct failure.
- [x] `src/lib/sshRemoteFiles.ts`: Tauri attachment IPC and per-session consumer/release
  lifecycle; project-only launch construction is the attachment entry boundary.
- [x] `src/lib/sshAgentHistory.ts`: Host/Agent installation lookup and project launch shape;
  project history path remains intentionally related but unchanged in binding semantics.
- [x] `src/stores/terminalStore.ts`: SSH sessions already persist Host ID and remote path;
  launch construction must expose the Host field without changing interactive cwd behavior.
- [x] `src/lib/types.ts`, `src/stores/sshHostStore.ts`, `SshHostEditor`, and
  `SshHostsSettingsPage`: Host model, CRUD, validation, UI, and bilingual error mapping.
- [x] `src/stores/syncStore.ts`: portable Host backup/restore and machine-local credential
  separation.
- [x] `src-tauri/src/lib.rs`: migration registry and migration tests.
- [x] `src-tauri/src/commands/ssh_files.rs`: Tauri upload boundary, Begin payload, path
  validation, and legacy fallback.
- [x] `src-tauri/src/daemon/ssh_agent_bridge.rs`: Readonly bridge project gate and capability
  gate; Primary Hook/history behavior is confirmed unrelated.
- [x] `src-tauri/ssh-agent/src/files.rs` and `protocol.rs`: remote root resolution, cleanup,
  Begin schema, and advertised capabilities.
- [x] `src-tauri/ssh-agent/Cargo.toml`, lockfile, and `src/lib.rs`: Agent release identity.
- [x] `.trellis/spec/backend/ssh-agent-contracts.md`: update the cross-layer contract for
  Host-only attachments and protocol 1.12.
- [x] `CHANGELOG.md` and `docs/功能清单.md`: V1.3.9 delivery records.
- [x] Confirmed unrelated: SSH project file browsing, Git, history, Hook installation,
  remote handoff, local/WSL attachment commands, and terminal time-format/i18n behavior.
