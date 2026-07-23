import { invoke } from "@tauri-apps/api/core";
import type { Project, GitBranchInfo, GitBranchStatus, GitFileChange, GitPullStrategy } from "./types";
import { buildSshConnectionSpec, type SshConnectionSpecPayload } from "./ssh";
import { getSshClientInstanceId } from "./sshClientIdentity";
import { useBackgroundOperationStore } from "../stores/backgroundOperationStore";
import { useSshAgentIntegrationStore } from "../stores/sshAgentIntegrationStore";
import { useSshHostStore } from "../stores/sshHostStore";

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
}

type ReadKind = "gitListRepositories" | "gitChanges" | "gitDiff" | "gitBranchStatus" | "gitBranches";
type WriteKind =
  | "gitStage" | "gitUnstage" | "gitStageAll" | "gitUnstageAll"
  | "gitDiscardFile" | "gitDeleteUntracked" | "gitRevertHunk" | "gitRevertLines"
  | "gitCommit" | "gitCommitPaths" | "gitFetch" | "gitPush" | "gitCheckout"
  | "gitSmartCheckout" | "gitCreateBranch" | "gitPull" | "gitPullAbort" | "gitRebaseContinue";

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
  return {
    contextKey: [project.id, host.id, rootPath, installation.installation_id].join(":"),
    consumerId: `git:${clientInstanceId}:${host.id}:${project.id}`,
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

export async function sshRemoteGitDiff(context: SshRemoteGitContext, repoPath: string, relativePath: string, status: string): Promise<SshRemoteGitSnapshot<SshRemoteGitDiff>> {
  const result = await request<{ diff: SshRemoteGitDiff; asOf: number }>(context, "gitDiff", { repoPath, relativePath, status }, true);
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
