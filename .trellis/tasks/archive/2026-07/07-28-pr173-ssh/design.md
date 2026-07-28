# Design

## Integration Strategy

以 `origin/pr/173` 创建本地解决分支，再合并 `origin/master`。使用正常三方合并保留 Git 历史；唯一内容冲突 `CHANGELOG.md` 手工按版本和分类合并，不改写 39 个 PR 文件。

## Eligibility Contract

资格判断继续使用现有权威信号：

```text
notification running/attention -> task_running
notification done/failed       -> stopped
process exited/error            -> stopped
otherwise                       -> task_state_unknown
```

SSH PTY 长驻只说明 SSH/Codex 进程存在，不能证明当前回合正在运行或空闲。Hook 未安装、事件丢失或应用恢复后没有明确终态时，选择安全侧拒绝托管。

## Data Flow

```text
tabNotifications + sessionStatuses
  -> getRemoteHandoffEligibility
  -> useRemoteHandoffCoordinator
  -> optional SSH session identity binding
  -> backend preflight/start
```

门禁位于身份绑定和后端启动之前，避免未知状态下进行远端同步、绑定或关闭原 PTY。

## Compatibility

- 不修改 IPC 数据结构。
- 不修改 Rust 预检、代理或恢复协议。
- 不新增依赖、数据库迁移或设置项。
- 明确终态的 SSH 空闲会话仍保持 PR #173 的托管能力。

## Rollback

资格修复仅涉及一个条件和对应测试，可独立回退；合并提交保留双亲，必要时可整体回退本地集成提交。
