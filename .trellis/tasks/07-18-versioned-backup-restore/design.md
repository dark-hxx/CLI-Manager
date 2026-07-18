# Technical Design

## Snapshot Contract

`BackupSnapshotV3` 由 manifest 与五个强类型数据域组成。manifest 包含 snapshot/device/app/platform/time/hash 信息；内容哈希仅覆盖规范化 data，不包含创建时间和快照 ID。

`BackupDomain` 固定为 `workspace | preferences | model_prices | notifications | statusline`。workspace 将关系紧密的 groups/projects/worktrees/templates 作为一个整体，避免部分恢复破坏外键。

## Storage

- WebDAV：`<remoteDir>/backups/<UTC>--<deviceName>--<deviceId>--<snapshotId>.json`。
- 本地：`cli-manager-backup-YYYYMMDD-HHmmss-<snapshotId>.zip`，包含 `snapshot.json`。
- Outbox：`.cli-manager/backups/outbox/<targetHash>/<snapshotId>.json`。
- Restore safety：`.cli-manager/backups/restore-safety/latest.zip`。

WebDAV client 增加 `PROPFIND Depth: 1` 与 `DELETE`。使用 `quick-xml` 的 namespace reader 解析 multistatus；快照文件名经过严格解析，禁止任意远程路径输入。

## Settings Policy

为所有 `Settings` key 建立穷尽分类，新增 key 未分类时 TypeScript 编译失败。当前便携集合基础上加入命令提示 provider/LLM/baseUrl/apiKey/model 和 `fileExplorerIgnoredPaths`。三方通知单独成域。`terminalBackground`、`desktopPet`、Shell/Hook/cc-switch 路径、平台兼容和派生统计排除。

## Restore

恢复流程：完整校验与规范化 → 创建 safety snapshot → SQLite 事务替换选中 DB 域 → 批量应用便携设置 → 校验并原子替换状态栏文件 → 刷新 stores。任何步骤失败都用 safety snapshot 自动回滚。

项目和 Worktree 路径不改写；恢复后运行现有 path diagnostics 与 `markMissingWorktrees`。

## Compatibility

V1/V2 映射到 V3 的已存在域；缺失 settings/model_prices/statusline 保持本地。旧自动同步配置只做一次迁移，不再自动下载。
