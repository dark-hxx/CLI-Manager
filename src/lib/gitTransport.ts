import { invoke } from "@tauri-apps/api/core";
import type { GitBranchInfo, GitBranchStatus, GitFileChange, GitPullStrategy } from "./types";
import {
  sshRemoteGitBranchStatus,
  sshRemoteGitBranches,
  sshRemoteGitChanges,
  sshRemoteGitCheckout,
  sshRemoteGitCommit,
  sshRemoteGitCreateBranch,
  sshRemoteGitDeleteUntracked,
  sshRemoteGitDiff,
  sshRemoteGitDiscard,
  sshRemoteGitFetch,
  sshRemoteGitListRepositories,
  sshRemoteGitPull,
  sshRemoteGitPullAbort,
  sshRemoteGitPush,
  sshRemoteGitRebaseContinue,
  sshRemoteGitRevertHunk,
  sshRemoteGitRevertLines,
  sshRemoteGitStage,
  sshRemoteGitStageAll,
  sshRemoteGitUnstage,
  sshRemoteGitUnstageAll,
  type SshRemoteGitContext,
} from "./sshRemoteGit";

export interface GitTransportResult<T> {
  value: T;
  asOf?: number;
}

export interface GitRepositoryRef {
  relativePath: string;
  absolutePath: string;
  branch: string | null;
}

export interface GitFileDiffPayload {
  content: string;
  canRevertHunks: boolean;
}

export interface GitTransport {
  readonly contextKey: string;
  readonly remote: boolean;
  listRepositories(): Promise<GitTransportResult<GitRepositoryRef[]>>;
  getChanges(repoId: string): Promise<GitTransportResult<GitFileChange[]>>;
  getFileDiff(repoId: string, path: string, status: string): Promise<GitTransportResult<GitFileDiffPayload>>;
  getBranchStatus(repoId: string): Promise<GitTransportResult<GitBranchStatus>>;
  listBranches(repoId: string): Promise<GitTransportResult<GitBranchInfo[]>>;
  stage(repoId: string, paths: string[]): Promise<void>;
  unstage(repoId: string, paths: string[]): Promise<void>;
  stageAll(repoId: string): Promise<void>;
  unstageAll(repoId: string): Promise<void>;
  discardFile(repoId: string, path: string, status: string): Promise<void>;
  deleteUntracked(repoId: string, paths: string[]): Promise<void>;
  revertHunk(repoId: string, path: string, diff: string, index: number): Promise<void>;
  revertLines(repoId: string, path: string, diff: string, lines: { side: "old" | "new"; lineNumber: number }[]): Promise<void>;
  commit(repoId: string, message: string, paths?: string[]): Promise<string>;
  fetch(repoId: string): Promise<string>;
  push(repoId: string, setUpstream: boolean, branch: string | null): Promise<string>;
  checkout(repoId: string, branch: string, remote: boolean, smart?: boolean): Promise<string>;
  createBranch(repoId: string, branch: string): Promise<string>;
  pull(repoId: string, strategy: GitPullStrategy): Promise<string>;
  pullAbort(repoId: string): Promise<void>;
  rebaseContinue(repoId: string): Promise<string>;
}

const localResult = <T>(value: T): GitTransportResult<T> => ({ value });

export function createLocalGitTransport(projectRoot: string): GitTransport {
  return {
    contextKey: `local:${projectRoot}`,
    remote: false,
    listRepositories: async () => localResult(await invoke<GitRepositoryRef[]>("git_list_repositories", { projectPath: projectRoot })),
    getChanges: async (repoId) => localResult(await invoke<GitFileChange[]>("git_get_changes", { projectPath: repoId })),
    getFileDiff: async (repoId, filePath, status) => localResult(await invoke<GitFileDiffPayload>("git_get_file_diff", { projectPath: repoId, filePath, status })),
    getBranchStatus: async (repoId) => localResult(await invoke<GitBranchStatus>("git_branch_status", { projectPath: repoId })),
    listBranches: async (repoId) => localResult(await invoke<GitBranchInfo[]>("git_list_branches", { projectPath: repoId })),
    stage: async (repoId, paths) => { await invoke("git_stage_paths", { projectPath: repoId, paths }); },
    unstage: async (repoId, paths) => { await invoke("git_unstage_paths", { projectPath: repoId, paths }); },
    stageAll: async (repoId) => { await invoke("git_stage_all", { projectPath: repoId }); },
    unstageAll: async (repoId) => { await invoke("git_unstage_all", { projectPath: repoId }); },
    discardFile: async (repoId, filePath, status) => { await invoke("git_discard_file", { projectPath: repoId, filePath, status }); },
    deleteUntracked: async (repoId, paths) => { await invoke("git_delete_untracked_paths", { projectPath: repoId, paths }); },
    revertHunk: async (repoId, _path, diffText, hunkIndex) => { await invoke("git_revert_hunk", { projectPath: repoId, diffText, hunkIndex }); },
    revertLines: async (repoId, _path, diffText, selectedLines) => { await invoke("git_revert_lines", { projectPath: repoId, diffText, selectedLines }); },
    commit: async (repoId, message, paths) => paths
      ? invoke<string>("git_commit_paths", { projectPath: repoId, message, paths })
      : invoke<string>("git_commit", { projectPath: repoId, message }),
    fetch: (repoId) => invoke<string>("git_fetch", { projectPath: repoId }),
    push: (repoId, setUpstream, branch) => invoke<string>("git_push", { projectPath: repoId, setUpstream, branch }),
    checkout: (repoId, branch, remote, smart = false) => invoke<string>(smart ? "git_smart_checkout_branch" : "git_checkout_branch", { projectPath: repoId, branch, remote }),
    createBranch: (repoId, branch) => invoke<string>("git_create_branch", { projectPath: repoId, branch }),
    pull: (repoId, strategy) => invoke<string>("git_pull", { projectPath: repoId, strategy }),
    pullAbort: async (repoId) => { await invoke("git_pull_abort", { projectPath: repoId }); },
    rebaseContinue: (repoId) => invoke<string>("git_rebase_continue", { projectPath: repoId }),
  };
}

export function createSshGitTransport(context: SshRemoteGitContext): GitTransport {
  return {
    contextKey: `ssh:${context.contextKey}`,
    remote: true,
    listRepositories: async () => {
      const result = await sshRemoteGitListRepositories(context);
      return { value: result.value.map((repo) => ({ relativePath: repo.relativePath, absolutePath: repo.repoId, branch: repo.branch })), asOf: result.asOf };
    },
    getChanges: (repoId) => sshRemoteGitChanges(context, repoId),
    getFileDiff: (repoId, path, status) => sshRemoteGitDiff(context, repoId, path, status),
    getBranchStatus: (repoId) => sshRemoteGitBranchStatus(context, repoId),
    listBranches: (repoId) => sshRemoteGitBranches(context, repoId),
    stage: async (repoId, paths) => { await sshRemoteGitStage(context, repoId, paths); },
    unstage: async (repoId, paths) => { await sshRemoteGitUnstage(context, repoId, paths); },
    stageAll: async (repoId) => { await sshRemoteGitStageAll(context, repoId); },
    unstageAll: async (repoId) => { await sshRemoteGitUnstageAll(context, repoId); },
    discardFile: async (repoId, path, status) => { await sshRemoteGitDiscard(context, repoId, path, status); },
    deleteUntracked: async (repoId, paths) => { await sshRemoteGitDeleteUntracked(context, repoId, paths); },
    revertHunk: async (repoId, path, diff, index) => { await sshRemoteGitRevertHunk(context, repoId, path, diff, index); },
    revertLines: async (repoId, path, diff, lines) => { await sshRemoteGitRevertLines(context, repoId, path, diff, lines); },
    commit: async (repoId, message, paths) => (await sshRemoteGitCommit(context, repoId, message, paths)).shortId ?? "",
    fetch: async (repoId) => (await sshRemoteGitFetch(context, repoId)).output ?? "",
    push: async (repoId, setUpstream, branch) => (await sshRemoteGitPush(context, repoId, setUpstream, branch)).output ?? "",
    checkout: async (repoId, branch, remote, smart = false) => (await sshRemoteGitCheckout(context, repoId, branch, remote, smart)).output ?? "",
    createBranch: async (repoId, branch) => (await sshRemoteGitCreateBranch(context, repoId, branch)).output ?? "",
    pull: async (repoId, strategy) => (await sshRemoteGitPull(context, repoId, strategy)).output ?? "",
    pullAbort: async (repoId) => { await sshRemoteGitPullAbort(context, repoId); },
    rebaseContinue: async (repoId) => (await sshRemoteGitRebaseContinue(context, repoId)).output ?? "",
  };
}

export function createGitTransport(
  projectRoot: string,
  remoteContext: SshRemoteGitContext | null,
  remoteRequired = false,
): GitTransport {
  if (remoteRequired) {
    if (!remoteContext) throw new Error("ssh_agent_context_unavailable");
    return createSshGitTransport(remoteContext);
  }
  return createLocalGitTransport(projectRoot);
}
