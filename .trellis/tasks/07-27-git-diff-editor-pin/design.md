# Editor Pin Design

## Workspace State

```ts
interface GitDiffTab extends GitDiffTarget {
  repositoryLabel: string;
}

interface ProjectGitDiffWorkspace {
  tabs: GitDiffTab[];
  activeId: string | null;
}
```

Store 只保存可序列化身份，不保存 Transport、Project 快照或回调。Host 根据 projectId 从 projectStore 解析最新 Project。

## Transport Lease

```ts
interface GitTransportLease {
  contextKey: string;
  transport: GitTransport;
  release(): Promise<void>;
}
```

Registry 对相同完整项目上下文合并并发 acquire，维护 refCount，release 幂等。SSH key 至少包含 projectId、hostId、remotePath 和 installationId；Local/WSL release 为 no-op。

GitChangesPanel 也迁移为 acquire/release lease，并把 Transport 绑定给 gitStore。Pinned Host 直接使用自身 lease，避免依赖全局 current project。

## Mutation Refresh

Pinned Host 写成功后通过自身 Transport 拉取 changes 和 active diff；同时调用 gitStore 的 `refreshIfContext(contextKey)`，上下文不匹配时 no-op。禁止用无上下文的全局刷新。

## SSH Lifecycle

增加 `releaseSshRemoteGitContext`，复用现有 daemon consumer release 命令。旧 lease 的异步结果必须比较 contextKey 后丢弃。
