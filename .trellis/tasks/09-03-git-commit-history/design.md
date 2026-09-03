# Git Commit History Design

## Boundaries

- UI：`GitChangesPanel` 仅负责视图切换，新的 `GitHistoryView` 负责列表、搜索、分页、详情选择和请求代际控制。
- Transport：在 `GitTransport` 增加只读的提交分页、提交详情和提交文件 Diff 方法，本地与 SSH 实现保持同一返回契约。
- Desktop backend：本地仓库使用 libgit2 Revwalk/tree diff；WSL Linux 仓库使用固定参数的 `git log/show`，继续复用现有路径分流与超时执行器。
- SSH：Desktop bridge 增加 history 请求白名单；SSH Agent 增加 dispatch、固定 argv Git 执行和 `gitHistory` 能力声明。
- Viewer：提交 Diff 复用现有共享 Diff Viewer，但使用独立的只读 target/controller，不允许任何工作区 mutation。

## Data Contracts

```ts
interface GitCommitSummary {
  id: string;
  shortId: string;
  parents: string[];
  title: string;
  authorName: string;
  authorEmail: string | null;
  authoredAt: number;
  refs: string[];
}

interface GitCommitPage {
  commits: GitCommitSummary[];
  nextCursor: string | null;
}

interface GitCommitFile {
  path: string;
  oldPath: string | null;
  status: "A" | "M" | "D" | "R" | "C";
  added: number;
  deleted: number;
  binary: boolean;
}

interface GitCommitDetail {
  commit: GitCommitSummary;
  files: GitCommitFile[];
}
```

- 分页 cursor 使用最后一条提交的完整 OID；后端校验为 40/64 位十六进制 OID 后再解析。
- 搜索条件作为分页身份的一部分；搜索或仓库变化时清空 cursor 栈。
- 提交文件 Diff 返回现有 `GitFileDiffPayload`，但 `canRevertHunks` 固定为 `false`。

## Data Flow

1. 用户进入历史视图，UI 以 repository id、transport context、search 和 cursor 发起列表请求。
2. Transport 路由到 native/WSL 或 SSH；返回 50 条提交及下一页 cursor。
3. 用户选择提交后才加载该提交详情；选择文件后才加载 patch。
4. 每个异步层使用 generation/context key 丢弃过期结果。
5. 历史手动刷新只重载当前页与已选详情，不触发工作区状态 mutation。

## Compatibility And Safety

- SSH 新请求只在 Agent 声明 `gitHistory` 后发送；旧 Agent 在前端显示双语升级提示。
- Merge 提交选择 `parents[0]`；根提交与空树比较。
- Detached HEAD 从 HEAD 开始 Revwalk；空/未出生分支返回空页。
- shallow clone 只展示本地可达历史，不尝试联网补齐。
- 重命名保留 oldPath；二进制文件展示统计状态，Diff 沿用现有安全降级。
- 所有 shell-out 使用固定 argv；不拼接提交、路径或搜索字符串到 shell 命令。

## Rollback

删除历史视图入口、Transport 新方法和后端只读命令即可回滚；未写数据库、配置或仓库状态，不需要数据迁移。
