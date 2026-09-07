# 实施计划

1. 在 `ssh_agent_bridge.rs` 为 bridge entry/handle/reservation 记录 lane 和 slot，保存重建计划，增加按 slot + control 精确停止并保留生命周期元数据的内部方法。
2. 将能力缺失响应标记为 bridge stale，并在 manager 请求层对原 payload 最多刷新/重试一次；保持 resume claim 和错误清理语义。
3. 补充 stale bridge、单次刷新、slot 隔离和非 capability 错误不刷新测试。
4. 更新 `CHANGELOG.md` 的 `V1.3.9` 和 `docs/功能清单.md` 的 SSH 远程文件板块。
5. 运行格式化、Rust 编译/测试、Agent 测试、TypeScript 检查和 diff 检查。

## Validation commands

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib daemon::ssh_agent_bridge`
- `cargo test --manifest-path src-tauri/ssh-agent/Cargo.toml`
- `npx tsc --noEmit`
- `git diff --check`
- `gitnexus detect_changes`（提交前；本任务明确不提交）

## Risk points

- `SshAgentBridgeManager` 是共享 Host bridge 的生命周期中心，GitNexus 已评估其结构上游影响为 CRITICAL；只做精确 slot/control 失效，不改外部 command/API。
- 删除是变更请求；只能重试在 capability gate 尚未写 frame 的请求，不能把远端执行后的不确定结果纳入本机制。
- 保留无关的 `AGENTS.md`、`CLAUDE.md` 本地修改，不在本任务中触碰。
