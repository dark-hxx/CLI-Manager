import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectFileContentMatch, ProjectFileEntry, ProjectFilePreviewKind } from "./types";
import { buildSshAgentHistoryContext, type SshAgentHistoryContext } from "./sshAgentHistory";

interface RemoteFileEntry {
  name: string;
  relativePath: string;
  kind: "file" | "directory" | string;
  sizeBytes: number;
  modifiedMs?: number | null;
}

interface RemoteFileRead {
  relativePath: string;
  kind: "text" | "image" | string;
  content: string;
  sizeBytes: number;
  modifiedMs?: number | null;
  truncated: boolean;
}

export interface SshRemoteFileContext {
  consumerId: string;
  launch: SshAgentHistoryContext["launch"];
  rootPath: string;
}

function toEntry(entry: RemoteFileEntry): ProjectFileEntry {
  return {
    name: entry.name,
    path: entry.relativePath,
    kind: entry.kind === "directory" ? "directory" : "file",
    sizeBytes: entry.sizeBytes,
    modifiedMs: entry.modifiedMs ?? null,
  };
}

export async function buildSshRemoteFileContext(project: Project): Promise<SshRemoteFileContext> {
  const history = await buildSshAgentHistoryContext(project);
  return {
    consumerId: history.consumerId.replace(/^history:/, "files:"),
    launch: {
      ...history.launch,
      bridgeEpoch: crypto.randomUUID(),
    },
    rootPath: project.remote_path.trim(),
  };
}

export async function sshRemoteListDir(
  context: SshRemoteFileContext,
  relativePath = "",
): Promise<ProjectFileEntry[]> {
  const response = await invoke<{ entries: RemoteFileEntry[] }>("ssh_remote_file_list", {
    consumerId: context.consumerId,
    sshLaunch: context.launch,
    rootPath: context.rootPath,
    relativePath,
  });
  return (response.entries ?? []).map(toEntry);
}

export async function sshRemoteReadFile(
  context: SshRemoteFileContext,
  relativePath: string,
): Promise<{ content: string; previewKind: ProjectFilePreviewKind; sizeBytes: number; modifiedMs: number | null }> {
  const result = await invoke<RemoteFileRead>("ssh_remote_file_read", {
    consumerId: context.consumerId,
    sshLaunch: context.launch,
    rootPath: context.rootPath,
    relativePath,
  });
  return {
    content: result.content,
    previewKind: result.kind === "image" ? "image" : "text",
    sizeBytes: result.sizeBytes,
    modifiedMs: result.modifiedMs ?? null,
  };
}

export async function sshRemoteSearch(
  context: SshRemoteFileContext,
  query: string,
  content = false,
): Promise<ProjectFileEntry[]> {
  const response = await invoke<{ entries: RemoteFileEntry[] }>("ssh_remote_file_search", {
    consumerId: context.consumerId,
    sshLaunch: context.launch,
    rootPath: context.rootPath,
    query,
    content,
  });
  return (response.entries ?? []).map(toEntry);
}

export function remoteEntryToSearchMatch(entry: ProjectFileEntry): ProjectFileContentMatch {
  return {
    path: entry.path,
    name: entry.name,
    lineNumber: 1,
    lineText: entry.name,
    before: [],
    after: [],
  };
}
