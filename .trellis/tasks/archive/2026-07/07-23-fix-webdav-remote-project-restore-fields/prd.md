# fix-webdav-remote-project-restore-fields

## Goal

修复 WebDAV 同步与恢复远程项目时遗漏连接字段的问题，使恢复后的项目可直接使用，无需用户再次维护主机和远程路径。

## Changelog Target

V1.3.1

## Confirmed Facts

- 当前问题发生在远程项目的 WebDAV 同步与恢复流程。
- 现有快照已包含 `remote_path`，但未读取 `ssh_host_id`；恢复时还会无条件将其写为 `null`。[`src/stores/syncStore.ts:120`](../../../src/stores/syncStore.ts#L120)、[`src/stores/syncStore.ts:321`](../../../src/stores/syncStore.ts#L321)、[`src/stores/syncStore.ts:407`](../../../src/stores/syncStore.ts#L407)
- `ssh_hosts` 与 `ssh_host_groups` 当前不属于工作区快照，也不在 Rust 原子恢复的表白名单内。[`src/stores/syncStore.ts:182`](../../../src/stores/syncStore.ts#L182)、[`src-tauri/src/commands/sync.rs:21`](../../../src-tauri/src/commands/sync.rs#L21)
- 因此恢复后的 SSH 项目保留远程路径，却失去主机绑定，用户必须重新维护主机并重新绑定项目。
- 旧 SSH 功能验收曾明确要求同步时排除主机和绑定；本任务将改变该产品策略。[`../07-16-ssh-remote-project-terminal/acceptance.md:210`](../07-16-ssh-remote-project-terminal/acceptance.md#L210)
- 此问题跨越持久化、WebDAV 序列化与恢复数据消费边界，按分诊闸机归类为根因修复。

## Root Cause Statement

问题位于工作区快照与原子数据库恢复的边界：SSH 项目的 `ssh_host_id` 被备份查询遗漏并在恢复时清空，而依赖的主机实体不参与同一快照和事务，因此修复必须在快照与恢复契约中同时纳入可移植的主机档案和项目绑定。

## Discovery List

- [x] `src/stores/syncStore.ts`：工作区采集、快照格式、恢复语句；为本次根因修复的主触点。
- [x] `src-tauri/src/commands/sync.rs`：恢复 SQL 白名单与单连接事务；必须扩展以原子写入 SSH 主机实体。
- [x] `src/stores/sshHostStore.ts`：SSH 主机和分组的当前列集与写入顺序；作为同步 DTO 的字段依据。
- [x] `src-tauri/src/lib.rs`：SSH 主机、分组与项目外键关系；确认恢复写入次序为分组、主机、项目。
- [x] `src/lib/types.ts`：SSH 主机、项目的数据模型；确认主机上含机器本地和凭据引用字段，不能直接全量同步。
- [x] `src/components/settings/pages/SyncSettingsPage.tsx`：确认当前仅呈现通用备份/恢复流程，与 SSH 主机数据模型无直接耦合。
- [x] `src-tauri/src/webdav/mod.rs`：确认仅负责传输快照，不截断 workspace 数据；与字段丢失无关。

## Compatibility and Security Constraints

- 旧快照不含 SSH 主机时必须仍可恢复；其中的 SSH 项目保持未绑定状态。
- WebDAV、导出文件、日志和数据库快照不得包含 SSH 密码、私钥内容、凭据引用或机器本地私钥/SSH Config 文件路径。
- SSH 项目恢复必须与其主机和主机分组在同一 SQLite 事务中完成，以满足外键约束并避免半恢复状态。

## Requirements

- 同步工作区时，必须携带 SSH 主机分组和主机的可移植配置，并保留 SSH 项目与主机的绑定。
- 恢复远程项目时，必须写回远程路径和主机绑定，避免要求用户重新维护。
- 本地项目与既有 WebDAV 备份恢复流程保持兼容。
- 不同步 `identity_file`、`credential_ref`、`config_file`、`proxy_command` 或密码；恢复到同 ID 主机时保留其本机字段，目标设备缺失这些字段时将不可移植认证方式降级为可交互认证。

## Acceptance Criteria

- [x] 一个已配置主机、远程路径与项目配置的远程项目，备份并恢复后保持主机绑定与路径，无需再次编辑或重新绑定。
- [x] 既有本地项目备份可继续恢复。
- [x] 历史 WebDAV 备份中不存在新增字段时，恢复流程不会崩溃，并采用现有兼容策略。
- [x] SSH 密码、凭据引用、私钥路径和自定义 SSH Config 路径不会写入 WebDAV 或本地导出。
- [x] 主机、主机分组及项目在单一数据库事务中恢复；任何写入失败均保留恢复前数据库。
- [x] 恢复后 SSH 主机列表即时刷新，项目树中远程项目可直接使用恢复后的主机配置。
- [x] `CHANGELOG.md` 的 V1.3.1 与 `docs/功能清单.md` 记录该行为变更。

## Approved Design Decisions

- 同步范围为 SSH 主机分组和主机的可移植连接档案，项目继续以 `ssh_host_id` 绑定主机。
- 不同步任何秘密和机器本地路径。已有同 ID 主机的本地身份材料在恢复时保留；新设备只需完成认证，不需重建主机和项目配置。
- 对不具备本机身份材料的 `credential_ref` 和 `identity_file` 主机，恢复后降级为交互认证；自定义 ProxyCommand 不跨设备恢复。

## Out of Scope

- 不同步 SSH 密码、私钥内容、私钥路径、自定义 SSH Config 路径、凭据引用或 ProxyCommand。
- 不同步 SSH Agent 安装状态、Hook 集成和主机级工具偏好。
