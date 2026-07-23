# 实施计划

1. 在 `src/stores/syncStore.ts` 扩展工作区快照选择列和恢复构造：采集 SSH 分组、可移植 SSH 主机字段与 `ssh_host_id`；恢复时按外键顺序构造语句并合并目标设备同 ID 主机的本机字段；成功后刷新 SSH 主机 store。
2. 在 `src-tauri/src/commands/sync.rs` 扩展受限恢复 SQL 白名单，并添加覆盖 SSH 分组、主机和项目的原子恢复测试。
3. 更新 WebDAV 与 SSH 同步契约、`CHANGELOG.md` V1.3.1 和 `docs/功能清单.md` V1.3.1。

## 验证

- `npx tsc --noEmit`
- `cargo test --manifest-path src-tauri/Cargo.toml sync::`
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`
- 手动：备份含 SSH 主机、分组和远程项目的工作区，在另一设备恢复，确认主机和远程路径自动可见；确认密码、私钥路径和自定义 Config 路径不出现在快照。

## 完成结果

- `npx tsc --noEmit`、`cargo check --locked --manifest-path src-tauri/Cargo.toml` 与同步模块 4 项 Rust 回归测试通过。
- 已完成人工 WebDAV 恢复验证：远程项目恢复后保留主机绑定和远程路径，敏感及本机路径字段未进入快照。
