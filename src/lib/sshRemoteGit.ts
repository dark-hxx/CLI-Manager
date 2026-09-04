import { invoke } from "@tauri-apps/api/core";
import type {
  Project,
  GitBranchInfo,
  GitBranchStatus,
  GitBisectStatus,
  GitBlameLine,
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
import { buildSshConnectionSpec, type SshConnectionSpecPayload } from "./ssh";
import { getSshClientInstanceId } from "./sshClientIdentity";
import { useBackgroundOperationStore } from "../stores/backgroundOperationStore";
import { useSshAgentIntegrationStore } from "../stores/sshAgentIntegrationStore";
import { useSshHostStore } from "../stores/sshHostStore";
import { isDefaultGitDiffOptions, type GitDiffOptions } from "./gitDiffOptions";

interface SshGitLaunch extends SshConnectionSpecPayload {
  hostId: string;
  remotePath: string;
  clientInstanceId: string;
  projectId: string;
  projectName: string;
  bridgeEpoch: string;
  agentPath: string;
  agentInstallationId: string;
  agentRemoteMachineId: string;
  toolSource: "";
  environmentOverrides: Record<string, string>;
  initializationCommand: null;
  startupCommand: null;
}

export interface SshRemoteGitContext {
  contextKey: string;
  consumerId: string;
  launch: SshGitLaunch;
  rootPath: string;
}

export interface SshRemoteGitRepository {
  repoId: string;
  relativePath: string;
  branch: string | null;
}

export interface SshRemoteGitSnapshot<T> {
  value: T;
  asOf: number;
}

export interface SshRemoteGitDiff {
  content: string;
  canRevertHunks: boolean;
  byteLength?: number;
  lineCount?: number;
}

export function createSshRemoteGitConsumerId(
  clientInstanceId: string,
  hostId: string,
  projectId: string,
  rootPath: string,
  installationId: string,
): string {
  return [
    "git",
    clientInstanceId,
    hostId,
    projectId,
    installationId,
    encodeURIComponent(rootPath),
  ].join(":");
}

type ReadKind = "gitListRepositories" | "gitChanges" | "gitDiff" | "gitDiffWithOptions"
  | "gitListCommits" | "gitListCommitsFiltered" | "gitCommitDetail" | "gitCommitFileDiff"
  | "gitBranchStatus" | "gitBranches" | "gitTags" | "gitCompareRefs" | "gitCommitPatch"
  | "gitListStashes" | "gitListRemotes" | "gitListReflog" | "gitFileHistory"
  | "gitBlameFile" | "gitBisectStatus" | "gitListSubmodules";

type WriteKind =
  | "gitStage" | "gitUnstage" | "gitStageAll" | "gitUnstageAll"
  | "gitDiscardFile" | "gitDeleteUntracked" | "gitRevertHunk" | "gitRevertLines"
  | "gitCommit" | "gitCommitPaths" | "gitFetch" | "gitPush" | "gitCheckout"
  | "gitSmartCheckout" | "gitCreateBranch" | "gitPull" | "gitPullAbort" | "gitRebaseContinue"
  | "gitOperationContinue" | "gitOperationAbort" | "gitExecuteOperation"
  | "gitStashCreate" | "gitStashAction" | "gitRemoteAction" | "gitPushTag"
  | "gitDeleteRemoteBranch" | "gitForcePushWithLease" | "gitRestoreReflog"
  | "gitBisectAction" | "gitSubmoduleAction" | "gitRewriteCommits";

interface MutationResponse {
  output?: string;
  shortId?: string;
  asOf: number;
}

export async function buildSshRemoteGitContext(project: Project): Promise<SshRemoteGitContext> {
  if (project.environment_type !== "ssh" || !project.ssh_host_id?.trim() || !project.remote_path.trim()) {
    throw new Error("ssh_project_configuration_invalid");
  }

  const hostStore = useSshHostStore.getState();
  if (!hostStore.loaded) await hostStore.fetchHosts();
  const hosts = useSshHostStore.getState().hosts;
  const host = hosts.find((candidate) => candidate.id === project.ssh_host_id);
  if (!host) throw new Error("ssh_host_not_found");

  const integrationStore = useSshAgentIntegrationStore.getState();
  if (!integrationStore.loaded) await integrationStore.fetchAll();
  const installation = useSshAgentIntegrationStore.getState().installations.find(
    (candidate) => candidate.host_id === host.id && candidate.status === "installed",
  );
  if (!installation?.install_path || !installation.installation_id || !installation.remote_machine_id) {
    throw new Error("ssh_agent_not_installed");
  }

  const clientInstanceId = getSshClientInstanceId();
  const rootPath = project.remote_path.trim();
  const contextKey = JSON.stringify([
    project.id,
    host.id,
    rootPath,
    installation.installation_id,
  ]);
  return {
    contextKey,
    consumerId: createSshRemoteGitConsumerId(
      clientInstanceId,
      host.id,
      project.id,
      rootPath,
      installation.installation_id,
    ),
    rootPath,
    launch: {
      ...buildSshConnectionSpec(host, hosts),
      hostId: host.id,
      remotePath: rootPath,
      clientInstanceId,
      projectId: project.id,
      projectName: project.name,
      bridgeEpoch: crypto.randomUUID(),
      agentPath: installation.install_path,
      agentInstallationId: installation.installation_id,
      agentRemoteMachineId: installation.remote_machine_id,
      toolSource: "",
      environmentOverrides: {},
      initializationCommand: null,
      startupCommand: null,
    },
  };
}

export async function releaseSshRemoteGitContext(context: SshRemoteGitContext): Promise<void> {
  await invoke("history_remote_close", {
    hostId: context.launch.hostId,
    consumerId: context.consumerId,
  });
}

async function request<T>(
  context: SshRemoteGitContext,
  kind: ReadKind | WriteKind,
  payload: Record<string, unknown>,
  readOnly: boolean,
): Promise<T> {
  const id = `remote-git:${context.consumerId}`;
  const operation = () => request<T>(context, kind, payload, readOnly);
  useBackgroundOperationStore.getState().start({
    id,
    kind: "remoteGit",
    titleKey: "backgroundOperations.remoteGit.title",
    detailKey: "backgroundOperations.remoteGit.loading",
    contextLabel: context.rootPath,
    ...(readOnly ? { retry: () => { void operation().catch(() => undefined); } } : {}),
  });
  try {
    const result = await invoke<T>("ssh_remote_git_request", {
      consumerId: context.consumerId,
      sshLaunch: context.launch,
      kind,
      payload: { rootPath: context.rootPath, ...payload },
    });
    useBackgroundOperationStore.getState().succeed(id);
    return result;
  } catch (error) {
    useBackgroundOperationStore.getState().fail(id, error);
    const message = error instanceof Error ? error.message : String(error);
    if (!readOnly && (
      message.includes("response_timeout")
      || message.includes("channel_closed")
      || message.includes("read_failed")
    )) {
      throw new Error(`remote_git_result_unknown:${message}`);
    }
    throw error;
  }
}

export async function sshRemoteGitListRepositories(context: SshRemoteGitContext): Promise<SshRemoteGitSnapshot<SshRemoteGitRepository[]>> {
  const result = await request<{ repositories: SshRemoteGitRepository[]; asOf: number }>(context, "gitListRepositories", {}, true);
  return { value: result.repositories, asOf: result.asOf };
}

export async function sshRemoteGitChanges(context: SshRemoteGitContext, repoPath = ""): Promise<SshRemoteGitSnapshot<GitFileChange[]>> {
  const result = await request<{ changes: GitFileChange[]; asOf: number }>(context, "gitChanges", { repoPath }, true);
  return { value: result.changes, asOf: result.asOf };
}

export async function sshRemoteGitListCommits(
  context: SshRemoteGitContext,
  repoPath = "",
  cursor?: string | null,
  search?: string,
  reference?: string | null,
  filters?: GitHistoryFilters | null,
): Promise<SshRemoteGitSnapshot<GitCommitPage>> {
  const kind = filters ? "gitListCommitsFiltered" : "gitListCommits";
  const result = await request<{ page: GitCommitPage; asOf: number }>(
    context,
    kind,
    { repoPath, cursor: cursor ?? null, search: search?.trim() || null, reference: reference?.trim() || null, filters: filters ? { allRefs: filters.scope === "all", references: filters.references, author: filters.author, since: filters.since, until: filters.until, path: filters.path } : null },
    true,
  );
  return { value: result.page, asOf: result.asOf };
}

export async function sshRemoteGitCommitDetail(
  context: SshRemoteGitContext,
  repoPath: string,
  commitId: string,
): Promise<SshRemoteGitSnapshot<GitCommitDetail>> {
  const result = await request<{ detail: GitCommitDetail; asOf: number }>(
    context,
    "gitCommitDetail",
    { repoPath, commitId },
    true,
  );
  return { value: result.detail, asOf: result.asOf };
}

export async function sshRemoteGitCommitFileDiff(
  context: SshRemoteGitContext,
  repoPath: string,
  commitId: string,
  relativePath: string,
  oldRelativePath?: string | null,
): Promise<SshRemoteGitSnapshot<SshRemoteGitDiff>> {
  const result = await request<{ diff: SshRemoteGitDiff; asOf: number }>(
    context,
    "gitCommitFileDiff",
    { repoPath, commitId, relativePath, oldRelativePath: oldRelativePath ?? null },
    true,
  );
  return { value: result.diff, asOf: result.asOf };
}

export async function sshRemoteGitDiff(
  context: SshRemoteGitContext,
  repoPath: string,
  relativePath: string,
  status: string,
  options?: GitDiffOptions,
): Promise<SshRemoteGitSnapshot<SshRemoteGitDiff>> {
  const useLegacyRequest = isDefaultGitDiffOptions(options);
  const kind = useLegacyRequest ? "gitDiff" : "gitDiffWithOptions";
  const result = await request<{ diff: SshRemoteGitDiff; asOf: number }>(
    context,
    kind,
    useLegacyRequest
      ? { repoPath, relativePath, status }
      : { repoPath, relativePath, status, options },
    true,
  );
  return { value: result.diff, asOf: result.asOf };
}

export async function sshRemoteGitBranchStatus(context: SshRemoteGitContext, repoPath = ""): Promise<SshRemoteGitSnapshot<GitBranchStatus>> {
  const result = await request<{ status: GitBranchStatus; asOf: number }>(context, "gitBranchStatus", { repoPath }, true);
  return { value: result.status, asOf: result.asOf };
}

export async function sshRemoteGitBranches(context: SshRemoteGitContext, repoPath = ""): Promise<SshRemoteGitSnapshot<GitBranchInfo[]>> {
  const result = await request<{ branches: GitBranchInfo[]; asOf: number }>(context, "gitBranches", { repoPath }, true);
  return { value: result.branches, asOf: result.asOf };
}

export const sshRemoteGitStage = (context: SshRemoteGitContext, repoPath: string, paths: string[]) =>
  request<MutationResponse>(context, "gitStage", { repoPath, paths }, false);
export const sshRemoteGitUnstage = (context: SshRemoteGitContext, repoPath: string, paths: string[]) =>
  request<MutationResponse>(context, "gitUnstage", { repoPath, paths }, false);
export const sshRemoteGitStageAll = (context: SshRemoteGitContext, repoPath: string) =>
  request<MutationResponse>(context, "gitStageAll", { repoPath }, false);
export const sshRemoteGitUnstageAll = (context: SshRemoteGitContext, repoPath: string) =>
  request<MutationResponse>(context, "gitUnstageAll", { repoPath }, false);
export const sshRemoteGitDiscard = (context: SshRemoteGitContext, repoPath: string, relativePath: string, status: string) =>
  request<MutationResponse>(context, "gitDiscardFile", { repoPath, relativePath, status }, false);
export const sshRemoteGitDeleteUntracked = (context: SshRemoteGitContext, repoPath: string, paths: string[]) =>
  request<MutationResponse>(context, "gitDeleteUntracked", { repoPath, paths }, false);
export const sshRemoteGitRevertHunk = (context: SshRemoteGitContext, repoPath: string, relativePath: string, diffText: string, hunkIndex: number) =>
  request<MutationResponse>(context, "gitRevertHunk", { repoPath, relativePath, diffText, hunkIndex }, false);
export const sshRemoteGitRevertLines = (context: SshRemoteGitContext, repoPath: string, relativePath: string, diffText: string, selectedLines: { side: "old" | "new"; lineNumber: number }[]) =>
  request<MutationResponse>(context, "gitRevertLines", { repoPath, relativePath, diffText, selectedLines }, false);
export const sshRemoteGitCommit = (context: SshRemoteGitContext, repoPath: string, message: string, paths?: string[]) =>
  request<MutationResponse>(context, paths ? "gitCommitPaths" : "gitCommit", { repoPath, message, ...(paths ? { paths } : {}) }, false);
export const sshRemoteGitFetch = (context: SshRemoteGitContext, repoPath: string) =>
  request<MutationResponse>(context, "gitFetch", { repoPath }, false);
export const sshRemoteGitPush = (context: SshRemoteGitContext, repoPath: string, setUpstream: boolean, branch: string | null) =>
  request<MutationResponse>(context, "gitPush", { repoPath, setUpstream, branch }, false);
export const sshRemoteGitCheckout = (context: SshRemoteGitContext, repoPath: string, branch: string, remote: boolean, smart = false) =>
  request<MutationResponse>(context, smart ? "gitSmartCheckout" : "gitCheckout", { repoPath, branch, remote }, false);
export const sshRemoteGitCreateBranch = (context: SshRemoteGitContext, repoPath: string, branch: string) =>
  request<MutationResponse>(context, "gitCreateBranch", { repoPath, branch }, false);
export const sshRemoteGitPull = (context: SshRemoteGitContext, repoPath: string, strategy: GitPullStrategy) =>
  request<MutationResponse>(context, "gitPull", { repoPath, strategy }, false);
export const sshRemoteGitPullAbort = (context: SshRemoteGitContext, repoPath: string) =>
  request<MutationResponse>(context, "gitPullAbort", { repoPath }, false);
export const sshRemoteGitRebaseContinue = (context: SshRemoteGitContext, repoPath: string) =>
  request<MutationResponse>(context, "gitRebaseContinue", { repoPath }, false);
export const sshRemoteGitOperationContinue = (context: SshRemoteGitContext, repoPath: string, operation: GitPendingOperation) =>
  request<MutationResponse>(context, "gitOperationContinue", { repoPath, operation }, false);
export const sshRemoteGitOperationAbort = (context: SshRemoteGitContext, repoPath: string, operation: GitPendingOperation) =>
  request<MutationResponse>(context, "gitOperationAbort", { repoPath, operation }, false);

export async function sshRemoteGitTags(
  context: SshRemoteGitContext,
  repoPath: string,
): Promise<SshRemoteGitSnapshot<GitTagInfo[]>> {
  const result = await request<{ tags: GitTagInfo[]; asOf: number }>(context, "gitTags", { repoPath }, true);
  return { value: result.tags, asOf: result.asOf };
}

export async function sshRemoteGitCompareRefs(
  context: SshRemoteGitContext,
  repoPath: string,
  baseRef: string,
  targetRef?: string | null,
): Promise<SshRemoteGitSnapshot<SshRemoteGitDiff>> {
  const result = await request<{ diff: SshRemoteGitDiff; asOf: number }>(context, "gitCompareRefs", { repoPath, baseRef, targetRef: targetRef ?? null }, true);
  return { value: result.diff, asOf: result.asOf };
}

export async function sshRemoteGitCommitPatch(
  context: SshRemoteGitContext,
  repoPath: string,
  commitId: string,
): Promise<SshRemoteGitSnapshot<string>> {
  const result = await request<{ content: string; asOf: number }>(context, "gitCommitPatch", { repoPath, commitId }, true);
  return { value: result.content, asOf: result.asOf };
}

export const sshRemoteGitExecuteOperation = (
  context: SshRemoteGitContext,
  repoPath: string,
  operation: string,
  branch?: string | null,
  target?: string | null,
  mode?: string | null,
) => request<MutationResponse>(context, "gitExecuteOperation", {
  repoPath,
  operation,
  branch: branch ?? null,
  target: target ?? null,
  mode: mode ?? null,
}, false);

export async function sshRemoteGitListStashes(context: SshRemoteGitContext, repoPath: string): Promise<SshRemoteGitSnapshot<GitStashInfo[]>> {
  const result = await request<{ stashes: GitStashInfo[]; asOf: number }>(context, "gitListStashes", { repoPath }, true);
  return { value: result.stashes, asOf: result.asOf };
}
export const sshRemoteGitStashCreate = (context: SshRemoteGitContext, repoPath: string, message: string, includeUntracked: boolean) => request<MutationResponse>(context, "gitStashCreate", { repoPath, message, includeUntracked }, false);
export const sshRemoteGitStashAction = (context: SshRemoteGitContext, repoPath: string, action: "apply" | "pop" | "drop", selector: string) => request<MutationResponse>(context, "gitStashAction", { repoPath, action, selector }, false);

export async function sshRemoteGitListRemotes(context: SshRemoteGitContext, repoPath: string): Promise<SshRemoteGitSnapshot<GitRemoteInfo[]>> {
  const result = await request<{ remotes: GitRemoteInfo[]; asOf: number }>(context, "gitListRemotes", { repoPath }, true);
  return { value: result.remotes, asOf: result.asOf };
}
export const sshRemoteGitRemoteAction = (context: SshRemoteGitContext, repoPath: string, action: "add" | "set-url" | "rename" | "remove" | "fetch", name: string, value?: string | null) => request<MutationResponse>(context, "gitRemoteAction", { repoPath, action, name, value: value ?? null }, false);
export const sshRemoteGitPushTag = (context: SshRemoteGitContext, repoPath: string, remote: string, tag: string) => request<MutationResponse>(context, "gitPushTag", { repoPath, remote, tag }, false);
export const sshRemoteGitDeleteRemoteBranch = (context: SshRemoteGitContext, repoPath: string, remote: string, branch: string) => request<MutationResponse>(context, "gitDeleteRemoteBranch", { repoPath, remote, branch }, false);
export const sshRemoteGitForcePushWithLease = (context: SshRemoteGitContext, repoPath: string, remote: string, branch: string) => request<MutationResponse>(context, "gitForcePushWithLease", { repoPath, remote, branch }, false);

export async function sshRemoteGitListReflog(context: SshRemoteGitContext, repoPath: string): Promise<SshRemoteGitSnapshot<GitReflogEntry[]>> {
  const result = await request<{ entries: GitReflogEntry[]; asOf: number }>(context, "gitListReflog", { repoPath }, true);
  return { value: result.entries, asOf: result.asOf };
}
export const sshRemoteGitRestoreReflog = (context: SshRemoteGitContext, repoPath: string, selector: string, branch: string) => request<MutationResponse>(context, "gitRestoreReflog", { repoPath, selector, branch }, false);

export async function sshRemoteGitFileHistory(context: SshRemoteGitContext, repoPath: string, path: string): Promise<SshRemoteGitSnapshot<GitFileHistoryEntry[]>> {
  const result = await request<{ entries: GitFileHistoryEntry[]; asOf: number }>(context, "gitFileHistory", { repoPath, path }, true);
  return { value: result.entries, asOf: result.asOf };
}
export async function sshRemoteGitBlameFile(context: SshRemoteGitContext, repoPath: string, path: string): Promise<SshRemoteGitSnapshot<GitBlameLine[]>> {
  const result = await request<{ lines: GitBlameLine[]; asOf: number }>(context, "gitBlameFile", { repoPath, path }, true);
  return { value: result.lines, asOf: result.asOf };
}
export async function sshRemoteGitBisectStatus(context: SshRemoteGitContext, repoPath: string): Promise<SshRemoteGitSnapshot<GitBisectStatus>> {
  const result = await request<{ status: GitBisectStatus; asOf: number }>(context, "gitBisectStatus", { repoPath }, true);
  return { value: result.status, asOf: result.asOf };
}
export const sshRemoteGitBisectAction = (context: SshRemoteGitContext, repoPath: string, action: "start" | "good" | "bad" | "skip" | "reset", good?: string | null, bad?: string | null) => request<MutationResponse>(context, "gitBisectAction", { repoPath, action, good: good ?? null, bad: bad ?? null }, false);
export async function sshRemoteGitListSubmodules(context: SshRemoteGitContext, repoPath: string): Promise<SshRemoteGitSnapshot<GitSubmoduleInfo[]>> {
  const result = await request<{ submodules: GitSubmoduleInfo[]; asOf: number }>(context, "gitListSubmodules", { repoPath }, true);
  return { value: result.submodules, asOf: result.asOf };
}
export const sshRemoteGitSubmoduleAction = (context: SshRemoteGitContext, repoPath: string, action: "init" | "update" | "sync", path?: string | null) => request<MutationResponse>(context, "gitSubmoduleAction", { repoPath, action, path: path ?? null }, false);
export const sshRemoteGitRewriteCommits = (context: SshRemoteGitContext, repoPath: string, upstream: string, steps: GitRewriteStep[]) => request<MutationResponse>(context, "gitRewriteCommits", { repoPath, upstream, steps }, false);
