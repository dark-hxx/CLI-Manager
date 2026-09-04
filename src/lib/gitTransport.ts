import { invoke } from "@tauri-apps/api/core";
import {
  normalizeGitDiffPayload,
  type NormalizedGitDiffPayload,
} from "./gitDiffLimits";
import type { GitDiffOptions } from "./gitDiffOptions";
import type {
  GitBranchInfo,
  GitBisectStatus,
  GitBlameLine,
  GitBranchStatus,
  GitCommitDetail,
  GitCommitPage,
  GitFileChange,
  GitHistoryFilters,
  GitFileHistoryEntry,
  GitPendingOperation,
  GitPullStrategy,
  GitReflogEntry,
  GitRemoteInfo,
  GitRewriteStep,
  GitStashInfo,
  GitSubmoduleInfo,
  GitTagInfo,
} from "./types";
import {
  sshRemoteGitBranchStatus,
  sshRemoteGitBranches,
  sshRemoteGitChanges,
  sshRemoteGitCheckout,
  sshRemoteGitCommit,
  sshRemoteGitCommitDetail,
  sshRemoteGitCommitFileDiff,
  sshRemoteGitCreateBranch,
  sshRemoteGitDeleteUntracked,
  sshRemoteGitDiff,
  sshRemoteGitDiscard,
  sshRemoteGitFetch,
  sshRemoteGitListRepositories,
  sshRemoteGitListCommits,
  sshRemoteGitPull,
  sshRemoteGitPullAbort,
  sshRemoteGitPush,
  sshRemoteGitRebaseContinue,
  sshRemoteGitOperationContinue,
  sshRemoteGitOperationAbort,
  sshRemoteGitCommitPatch,
  sshRemoteGitCompareRefs,
  sshRemoteGitExecuteOperation,
  sshRemoteGitTags,
  sshRemoteGitBisectAction,
  sshRemoteGitBisectStatus,
  sshRemoteGitBlameFile,
  sshRemoteGitDeleteRemoteBranch,
  sshRemoteGitFileHistory,
  sshRemoteGitForcePushWithLease,
  sshRemoteGitListReflog,
  sshRemoteGitListRemotes,
  sshRemoteGitListStashes,
  sshRemoteGitListSubmodules,
  sshRemoteGitPushTag,
  sshRemoteGitRemoteAction,
  sshRemoteGitRestoreReflog,
  sshRemoteGitRewriteCommits,
  sshRemoteGitStashAction,
  sshRemoteGitStashCreate,
  sshRemoteGitSubmoduleAction,
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

export interface GitFileDiffPayload extends NormalizedGitDiffPayload {}

export interface GitTransport {
  readonly contextKey: string;
  readonly remote: boolean;
  listRepositories(): Promise<GitTransportResult<GitRepositoryRef[]>>;
  getChanges(repoId: string): Promise<GitTransportResult<GitFileChange[]>>;
  listCommits(repoId: string, cursor?: string | null, search?: string, reference?: string | null, filters?: GitHistoryFilters | null): Promise<GitTransportResult<GitCommitPage>>;
  listTags(repoId: string): Promise<GitTransportResult<GitTagInfo[]>>;
  getCommitPatch(repoId: string, commitId: string): Promise<GitTransportResult<string>>;
  getCommitDetail(repoId: string, commitId: string): Promise<GitTransportResult<GitCommitDetail>>;
  getCommitFileDiff(repoId: string, commitId: string, path: string, oldPath?: string | null, options?: GitDiffOptions): Promise<GitTransportResult<GitFileDiffPayload>>;
  getFileDiff(repoId: string, path: string, status: string, options?: GitDiffOptions): Promise<GitTransportResult<GitFileDiffPayload>>;
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
  operationContinue(repoId: string, operation: GitPendingOperation): Promise<string>;
  operationAbort(repoId: string, operation: GitPendingOperation): Promise<string>;
  compareRefs(repoId: string, baseRef: string, targetRef?: string | null): Promise<GitTransportResult<GitFileDiffPayload>>;
  executeOperation(repoId: string, operation: string, branch?: string | null, target?: string | null, mode?: string | null): Promise<string>;
  listStashes(repoId: string): Promise<GitTransportResult<GitStashInfo[]>>;
  createStash(repoId: string, message: string, includeUntracked: boolean): Promise<string>;
  stashAction(repoId: string, action: "apply" | "pop" | "drop", selector: string): Promise<string>;
  listRemotes(repoId: string): Promise<GitTransportResult<GitRemoteInfo[]>>;
  remoteAction(repoId: string, action: "add" | "set-url" | "rename" | "remove" | "fetch", name: string, value?: string | null): Promise<string>;
  pushTag(repoId: string, remote: string, tag: string): Promise<string>;
  deleteRemoteBranch(repoId: string, remote: string, branch: string): Promise<string>;
  forcePushWithLease(repoId: string, remote: string, branch: string): Promise<string>;
  listReflog(repoId: string): Promise<GitTransportResult<GitReflogEntry[]>>;
  restoreReflog(repoId: string, selector: string, branch: string): Promise<string>;
  fileHistory(repoId: string, path: string): Promise<GitTransportResult<GitFileHistoryEntry[]>>;
  blameFile(repoId: string, path: string): Promise<GitTransportResult<GitBlameLine[]>>;
  getBisectStatus(repoId: string): Promise<GitTransportResult<GitBisectStatus>>;
  bisectAction(repoId: string, action: "start" | "good" | "bad" | "skip" | "reset", good?: string | null, bad?: string | null): Promise<string>;
  listSubmodules(repoId: string): Promise<GitTransportResult<GitSubmoduleInfo[]>>;
  submoduleAction(repoId: string, action: "init" | "update" | "sync", path?: string | null): Promise<string>;
  rewriteCommits(repoId: string, upstream: string, steps: GitRewriteStep[]): Promise<string>;
}

const localResult = <T>(value: T): GitTransportResult<T> => ({ value });

const historyFilterPayload = (filters?: GitHistoryFilters | null) => filters ? {
  allRefs: filters.scope === "all",
  references: filters.scope === "selected" ? filters.references : [],
  author: filters.author,
  since: filters.since,
  until: filters.until,
  path: filters.path,
} : null;

export function createLocalGitTransport(projectRoot: string): GitTransport {
  return {
    contextKey: `local:${projectRoot}`,
    remote: false,
    listRepositories: async () => localResult(await invoke<GitRepositoryRef[]>("git_list_repositories", { projectPath: projectRoot })),
    getChanges: async (repoId) => localResult(await invoke<GitFileChange[]>("git_get_changes", { projectPath: repoId })),
    listCommits: async (repoId, cursor, search, reference, filters) => localResult(await invoke<GitCommitPage>("git_list_commits", { projectPath: repoId, cursor, search, reference, filters: historyFilterPayload(filters) })),
    listTags: async (repoId) => localResult(await invoke<GitTagInfo[]>("git_list_tags", { projectPath: repoId })),
    getCommitPatch: async (repoId, commitId) => localResult(await invoke<string>("git_get_commit_patch", { projectPath: repoId, commitId })),
    getCommitDetail: async (repoId, commitId) => localResult(await invoke<GitCommitDetail>("git_get_commit_detail", { projectPath: repoId, commitId })),
    getCommitFileDiff: async (repoId, commitId, filePath, oldFilePath, options) => localResult(normalizeGitDiffPayload(
      await invoke<GitFileDiffPayload>("git_get_commit_file_diff", { projectPath: repoId, commitId, filePath, oldFilePath, options }),
    )),
    getFileDiff: async (repoId, filePath, status, options) => localResult(normalizeGitDiffPayload(
      await invoke<GitFileDiffPayload>("git_get_file_diff", {
        projectPath: repoId,
        filePath,
        status,
        options,
      }),
    )),
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
    operationContinue: (repoId, operation) => invoke<string>("git_operation_continue", { projectPath: repoId, operation }),
    operationAbort: (repoId, operation) => invoke<string>("git_operation_abort", { projectPath: repoId, operation }),
    compareRefs: async (repoId, baseRef, targetRef) => localResult(await invoke<GitFileDiffPayload>("git_compare_refs", { projectPath: repoId, baseRef, targetRef: targetRef ?? null })),
    executeOperation: (repoId, operation, branch, target, mode) => invoke<string>("git_execute_operation", { projectPath: repoId, operation, branch: branch ?? null, target: target ?? null, mode: mode ?? null }),
    listStashes: async (repoId) => localResult(await invoke<GitStashInfo[]>("git_list_stashes", { projectPath: repoId })),
    createStash: (repoId, message, includeUntracked) => invoke<string>("git_stash_create", { projectPath: repoId, message, includeUntracked }),
    stashAction: (repoId, action, selector) => invoke<string>("git_stash_action", { projectPath: repoId, action, selector }),
    listRemotes: async (repoId) => localResult(await invoke<GitRemoteInfo[]>("git_list_remotes", { projectPath: repoId })),
    remoteAction: (repoId, action, name, value) => invoke<string>("git_remote_action", { projectPath: repoId, action, name, value: value ?? null }),
    pushTag: (repoId, remote, tag) => invoke<string>("git_push_tag", { projectPath: repoId, remote, tag }),
    deleteRemoteBranch: (repoId, remote, branch) => invoke<string>("git_delete_remote_branch", { projectPath: repoId, remote, branch }),
    forcePushWithLease: (repoId, remote, branch) => invoke<string>("git_force_push_with_lease", { projectPath: repoId, remote, branch }),
    listReflog: async (repoId) => localResult(await invoke<GitReflogEntry[]>("git_list_reflog", { projectPath: repoId })),
    restoreReflog: (repoId, selector, branch) => invoke<string>("git_restore_reflog", { projectPath: repoId, selector, branch }),
    fileHistory: async (repoId, path) => localResult(await invoke<GitFileHistoryEntry[]>("git_file_history", { projectPath: repoId, path })),
    blameFile: async (repoId, path) => localResult(await invoke<GitBlameLine[]>("git_blame_file", { projectPath: repoId, path })),
    getBisectStatus: async (repoId) => localResult(await invoke<GitBisectStatus>("git_bisect_status", { projectPath: repoId })),
    bisectAction: (repoId, action, good, bad) => invoke<string>("git_bisect_action", { projectPath: repoId, action, good: good ?? null, bad: bad ?? null }),
    listSubmodules: async (repoId) => localResult(await invoke<GitSubmoduleInfo[]>("git_list_submodules", { projectPath: repoId })),
    submoduleAction: (repoId, action, path) => invoke<string>("git_submodule_action", { projectPath: repoId, action, path: path ?? null }),
    rewriteCommits: (repoId, upstream, steps) => invoke<string>("git_rewrite_commits", { projectPath: repoId, upstream, steps }),
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
    listCommits: (repoId, cursor, search, reference, filters) => sshRemoteGitListCommits(context, repoId, cursor, search, reference, filters ? { ...filters, references: filters.scope === "selected" ? filters.references : [] } : null),
    listTags: (repoId) => sshRemoteGitTags(context, repoId),
    getCommitPatch: (repoId, commitId) => sshRemoteGitCommitPatch(context, repoId, commitId),
    getCommitDetail: (repoId, commitId) => sshRemoteGitCommitDetail(context, repoId, commitId),
    getCommitFileDiff: async (repoId, commitId, path, oldPath) => {
      const result = await sshRemoteGitCommitFileDiff(context, repoId, commitId, path, oldPath);
      return { ...result, value: normalizeGitDiffPayload(result.value) };
    },
    getFileDiff: async (repoId, path, status, options) => {
      const result = await sshRemoteGitDiff(context, repoId, path, status, options);
      return { ...result, value: normalizeGitDiffPayload(result.value) };
    },
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
    operationContinue: async (repoId, operation) => (await sshRemoteGitOperationContinue(context, repoId, operation)).output ?? "",
    operationAbort: async (repoId, operation) => (await sshRemoteGitOperationAbort(context, repoId, operation)).output ?? "",
    compareRefs: async (repoId, baseRef, targetRef) => {
      const result = await sshRemoteGitCompareRefs(context, repoId, baseRef, targetRef);
      return { ...result, value: normalizeGitDiffPayload(result.value) };
    },
    executeOperation: async (repoId, operation, branch, target, mode) => (await sshRemoteGitExecuteOperation(context, repoId, operation, branch, target, mode)).output ?? "",
    listStashes: (repoId) => sshRemoteGitListStashes(context, repoId),
    createStash: async (repoId, message, includeUntracked) => (await sshRemoteGitStashCreate(context, repoId, message, includeUntracked)).output ?? "",
    stashAction: async (repoId, action, selector) => (await sshRemoteGitStashAction(context, repoId, action, selector)).output ?? "",
    listRemotes: (repoId) => sshRemoteGitListRemotes(context, repoId),
    remoteAction: async (repoId, action, name, value) => (await sshRemoteGitRemoteAction(context, repoId, action, name, value)).output ?? "",
    pushTag: async (repoId, remote, tag) => (await sshRemoteGitPushTag(context, repoId, remote, tag)).output ?? "",
    deleteRemoteBranch: async (repoId, remote, branch) => (await sshRemoteGitDeleteRemoteBranch(context, repoId, remote, branch)).output ?? "",
    forcePushWithLease: async (repoId, remote, branch) => (await sshRemoteGitForcePushWithLease(context, repoId, remote, branch)).output ?? "",
    listReflog: (repoId) => sshRemoteGitListReflog(context, repoId),
    restoreReflog: async (repoId, selector, branch) => (await sshRemoteGitRestoreReflog(context, repoId, selector, branch)).output ?? "",
    fileHistory: (repoId, path) => sshRemoteGitFileHistory(context, repoId, path),
    blameFile: (repoId, path) => sshRemoteGitBlameFile(context, repoId, path),
    getBisectStatus: (repoId) => sshRemoteGitBisectStatus(context, repoId),
    bisectAction: async (repoId, action, good, bad) => (await sshRemoteGitBisectAction(context, repoId, action, good, bad)).output ?? "",
    listSubmodules: (repoId) => sshRemoteGitListSubmodules(context, repoId),
    submoduleAction: async (repoId, action, path) => (await sshRemoteGitSubmoduleAction(context, repoId, action, path)).output ?? "",
    rewriteCommits: async (repoId, upstream, steps) => (await sshRemoteGitRewriteCommits(context, repoId, upstream, steps)).output ?? "",
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
