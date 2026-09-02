# 技术设计：能力错误触发 bridge 刷新

## Architecture and boundary

修复集中在 `src-tauri/src/daemon/ssh_agent_bridge.rs` 的请求调度层。
Tauri 文件 command、前端 SFTP 组件和 Agent protocol 不改契约：它们继续发出
`fileDelete`，由 daemon 根据当前 bridge 的 `hello.capabilities` 做门控。

## Data flow

1. `SshAgentBridgeManager::request` 为请求取得一个带 slot/control 身份的 reservation。
2. bridge 线程握手后保存 capabilities；`handle_agent_request` 在任何 Agent frame 写入前检查所需 capability。
3. 如果能力缺失，bridge 向当前请求返回稳定的
   `ssh_agent_capability_missing:<capability>`，并结束该旧 bridge，使排队请求也收到同一可刷新错误。
4. manager 按 slot + control 精确标记并停止产生错误的 bridge，使用 entry 保存的 lane/会话计划替换它，然后只重试原请求一次。
5. 重试创建新的 SSH Agent bridge，重新执行 hello/identity/capability 协商；刷新计划覆盖当前请求看到的 Agent 安装身份，避免继续使用旧 installation id。新 Agent 支持时请求正常执行；仍不支持时返回原稳定错误。

## State and concurrency rules

- `BridgeEntry` 保存原始 `SshLaunchPlan` 与 lane，`BridgeRequestReservation` 保存 `slot` 与 `Arc<BridgeControl>`；失效操作只在 slot 仍指向同一个 control 时停止 entry，替换时沿用原有 sessions/consumers，避免旧错误误杀随后建立的新 bridge。
- capability refresh 是单次、请求级的，不改变全局重连退避，也不把永久不支持的 Agent 变成无限重连。
- capability gate 发生在 `request()` 写 frame 前，因此第一次 `fileDelete` 不可能已经执行；一次重试不会重复删除。
- 仍使用现有 `BridgeControl::stop`、child kill/reap、pending-request 错误传播和 consumer release 机制。
- Primary、Readonly、Git 通过各自 slot 保持隔离。若文件请求先复用了 Primary，刷新会重建原 Primary 并保留其会话/consumer；独立 Readonly/Git bridge 则只刷新自己的 lane。

## Compatibility and security

- Agent `0.1.13` / protocol `1.14` 的 `fileGet`、`fileDelete` 能力与远端路径保护不变。
- 旧 Agent 仍最终收到 `ssh_agent_capability_missing:*`；不降级为 shell 命令或本地文件操作。
- root、relative path、symlink、非空目录和删除 root 的拒绝仍由现有 daemon/Agent 校验负责。
- one-shot `ssh_agent_probe` 仍独立探测真实远端可执行文件；本修复不把探测结果伪装成 bridge capabilities。

## Test strategy

- 在 bridge 单元测试中验证 reservation slot/control 的精确停止，且 slot 被替换后旧 reservation 不会停止新 entry。
- 验证能力缺失仍在 frame 写入前返回，并且 `handle_agent_request` 会让运行中的 bridge进入失效路径。
- 验证 capability refresh 判定只允许一次；非 capability 错误不触发刷新。
- 保留并运行现有 protocol 1.14 Agent fileDelete、路径安全、bridge lane、consumer 生命周期和重连测试。

## Rollback

本改动只触及 daemon bridge 生命周期和内部测试，无数据库迁移、IPC 签名或 Agent 发布物变化。若验证失败，可回滚 `ssh_agent_bridge.rs` 及两份产品记录，不影响远端 Agent 已安装状态。
