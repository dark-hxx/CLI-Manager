# WebDAV 远程项目恢复设计

## 数据流

```text
SQLite(groups, ssh_host_groups, ssh_hosts, projects)
  -> collectBackupData
  -> BackupSnapshotV3.data.workspace
  -> WebDAV / 本地 ZIP
  -> buildWorkspaceRestoreStatements
  -> backup_restore_database（单连接事务）
  -> projectStore + sshHostStore reload
```

## 快照契约

`WorkspaceBackup` 新增 `sshHostGroups` 和 `sshHosts`。每个 SSH 项目继续保存 `environment_type`、`remote_path` 和 `ssh_host_id`。

可同步 SSH 主机字段：标识、名称、分组、地址、端口、用户名、Config 别名、认证模式、跳板主机、HTTP/SOCKS5 代理端点、保活/超时、终端编码、启动脚本、备注、排序和时间戳。

禁止进入快照的字段：`identity_file`、`credential_ref`、`config_file`、`proxy_command` 以及任何密码或私钥内容。

## 恢复和本机状态

恢复语句顺序为：删除项目相关表和 SSH 主机表；插入常规分组、SSH 主机分组、SSH 主机、项目、Worktree、命令模板。全部由现有 Rust 单连接事务执行。

恢复前读取目标设备同 ID SSH 主机的本机字段。恢复到同 ID 主机时保留这些字段；新设备没有本机字段时，`credential_ref` 模式降级为 `password_prompt`，`identity_file` 模式降级为 `interactive`，缺失本地 ProxyCommand 时禁用该代理模式。这样备份本身不泄露秘密，也不会在同一设备恢复时清空可用凭据。

旧 V3 及更早快照没有新数组时按空数组处理。其 SSH 项目仍会按现有行为恢复为未绑定主机。

## 事务白名单

Rust 的恢复 SQL 白名单加入 `ssh_host_groups` 和 `ssh_hosts` 的精确 INSERT 列集，以及相应 DELETE 语句。前端不扩大自由 SQL 能力。

## 风险和控制

- `ssh_hosts` 被整表替换会触发依赖表的外键动作；SSH Agent/Hook 等机器状态不在本次快照范围，恢复后按现有孤立状态处理。
- 旧快照不包含主机数据时不制造伪主机或猜测绑定，维持原有未绑定降级。
- 快照格式仍是 V3；新增可选 workspace 字段不要求版本升级，避免破坏历史恢复。
