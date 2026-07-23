import { invoke } from "@tauri-apps/api/core";
import type { Project, GitBranchInfo, GitBranchStatus, GitFileChange } from "./types";
import { buildSshRemoteFileContext, type SshRemoteFileContext } from "./sshRemoteFiles";
import { useBackgroundOperationStore } from "../stores/backgroundOperationStore";

export interface SshRemoteGitContext extends SshRemoteFileContext {}

export interface SshRemoteGitRepository {
  repoId: string;
  relativePath: string;
  branch: string | null;
}

export interface SshRemoteGitSnapshot<T> {
  value: T;
  asOf: number;
}

type RemoteGitKind = "gitListRepositories" | "gitChanges" | "gitDiff" | "gitBranchStatus" | "gitBranches";

export async function buildSshRemoteGitContext(project: Project): Promise<SshRemoteGitContext> {
  const context = await buildSshRemoteFileContext(project);
  return { ...context, consumerId: context.consumerId.replace(/^files:/, "git:") };
}

async function request<T>(
  context: SshRemoteGitContext,
  kind: RemoteGitKind,
  repoPath = "",
  relativePath = "",
): Promise<T> {
  const id = `remote-git:${context.consumerId}`;
  const action = () => request<T>(context, kind, repoPath, relativePath);
  useBackgroundOperationStore.getState().start({
    id,
    kind: "remoteGit",
    titleKey: "backgroundOperations.remoteGit.title",
    detailKey: "backgroundOperations.remoteGit.loading",
    contextLabel: context.rootPath,
    retry: () => { void action().catch(() => undefined); },
  });
  try {
    const result = await invoke<T>("ssh_remote_git_request", {
      consumerId: context.consumerId,
      sshLaunch: context.launch,
      kind,
      rootPath: context.rootPath,
      repoPath,
      relativePath,
    });
    useBackgroundOperationStore.getState().succeed(id);
    return result;
  } catch (error) {
    useBackgroundOperationStore.getState().fail(id, error);
    throw error;
  }
}

export async function sshRemoteGitListRepositories(context: SshRemoteGitContext): Promise<SshRemoteGitSnapshot<SshRemoteGitRepository[]>> {
  const result = await request<{ repositories: SshRemoteGitRepository[]; asOf: number }>(context, "gitListRepositories");
  return { value: result.repositories, asOf: result.asOf };
}

export async function sshRemoteGitChanges(context: SshRemoteGitContext, repoPath = ""): Promise<SshRemoteGitSnapshot<GitFileChange[]>> {
  const result = await request<{ changes: GitFileChange[]; asOf: number }>(context, "gitChanges", repoPath);
  return { value: result.changes, asOf: result.asOf };
}

export const sshRemoteGitDiff = async (context: SshRemoteGitContext, repoPath: string, relativePath: string) =>
  (await request<{ content: string }>(context, "gitDiff", repoPath, relativePath)).content;

export async function sshRemoteGitBranchStatus(context: SshRemoteGitContext, repoPath = ""): Promise<SshRemoteGitSnapshot<GitBranchStatus>> {
  const result = await request<{ status: GitBranchStatus; asOf: number }>(context, "gitBranchStatus", repoPath);
  return { value: result.status, asOf: result.asOf };
}

export async function sshRemoteGitBranches(context: SshRemoteGitContext, repoPath = ""): Promise<SshRemoteGitSnapshot<GitBranchInfo[]>> {
  const result = await request<{ branches: GitBranchInfo[]; asOf: number }>(context, "gitBranches", repoPath);
  return { value: result.branches, asOf: result.asOf };
}
