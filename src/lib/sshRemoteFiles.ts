import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectFileContentMatch, ProjectFileEntry, ProjectFilePreviewKind, TerminalSession } from "./types";
import { buildSshAgentHostLaunch, buildSshAgentProjectLaunch, type SshAgentProjectLaunch } from "./sshAgentHistory";
import { useBackgroundOperationStore } from "../stores/backgroundOperationStore";
import type { TranslationKey } from "./i18n";

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
  launch: SshAgentProjectLaunch;
  rootPath: string;
}

export interface SshRemoteFileOperationOptions {
  silent?: boolean;
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

async function runFileOperation<T>(
  context: SshRemoteFileContext,
  detailKey: TranslationKey,
  action: () => Promise<T>,
  options?: SshRemoteFileOperationOptions,
): Promise<T> {
  if (options?.silent) return action();

  const id = `remote-files:${context.consumerId}`;
  const retry = () => { void runFileOperation(context, detailKey, action, options).catch(() => undefined); };
  useBackgroundOperationStore.getState().start({
    id,
    kind: "remoteFiles",
    titleKey: "backgroundOperations.remoteFiles.title",
    detailKey,
    contextLabel: context.rootPath,
    retry,
  });
  try {
    const result = await action();
    useBackgroundOperationStore.getState().succeed(id);
    return result;
  } catch (error) {
    useBackgroundOperationStore.getState().fail(id, error);
    throw error;
  }
}

export async function buildSshRemoteFileContext(project: Project): Promise<SshRemoteFileContext> {
  const launch = await buildSshAgentProjectLaunch(project);
  return {
    consumerId: `files:${launch.clientInstanceId}:${launch.hostId}:${project.id}`,
    launch: {
      ...launch,
      bridgeEpoch: crypto.randomUUID(),
    },
    rootPath: project.remote_path.trim(),
  };
}

export async function buildSshRemoteAttachmentContext(
  hostId: string,
): Promise<SshRemoteFileContext> {
  const launch = await buildSshAgentHostLaunch(hostId, "/");
  return {
    consumerId: `attachment-browser:${launch.clientInstanceId}:${launch.hostId}:${crypto.randomUUID()}`,
    launch,
    rootPath: "",
  };
}

export async function resolveSshRemoteAttachmentRoot(
  context: SshRemoteFileContext,
): Promise<string> {
  const result = await invoke<{ rootPath?: string }>("ssh_remote_file_attachment_root", {
    consumerId: context.consumerId,
    sshLaunch: context.launch,
    attachmentRoot: context.launch.attachmentRoot.trim() || null,
  });
  const rootPath = result.rootPath?.trim() ?? "";
  if (!rootPath.startsWith("/")) throw new Error("ssh_remote_attachment_root_invalid");
  return rootPath;
}

export type SshRemoteAttachmentInput =
  | { kind: "data"; fileName: string; dataBase64: string }
  | { kind: "localPath"; path: string };

export async function releaseSshRemoteFileContext(context: SshRemoteFileContext): Promise<void> {
  await invoke("history_remote_close", {
    hostId: context.launch.hostId,
    consumerId: context.consumerId,
  });
}

export async function sshRemoteAttachFiles(
  project: Project,
  sessionId: string,
  inputs: SshRemoteAttachmentInput[],
): Promise<string[]> {
  if (inputs.length === 0) return [];
  const context = await buildSshRemoteFileContext(project);
  return attachFilesWithContext(context, sessionId, inputs);
}

export async function sshRemoteAttachFilesForSession(
  session: Pick<TerminalSession, "id" | "sshHostId" | "remotePath">,
  inputs: SshRemoteAttachmentInput[],
): Promise<string[]> {
  if (inputs.length === 0) return [];
  if (!session.sshHostId?.trim() || !session.remotePath?.trim()) {
    throw new Error("ssh_terminal_context_invalid");
  }
  const launch = await buildSshAgentHostLaunch(session.sshHostId, session.remotePath);
  return attachFilesWithContext({
    consumerId: "",
    launch,
    rootPath: launch.remotePath,
  }, session.id, inputs);
}

export function sshHostAttachmentSessionId(hostId: string): string {
  const safeHostId = hostId.trim().replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 110);
  return `host-${safeHostId || "unknown"}`;
}

export async function sshRemoteAttachFilesForHost(
  hostId: string,
  inputs: SshRemoteAttachmentInput[],
): Promise<string[]> {
  if (inputs.length === 0) return [];
  const launch = await buildSshAgentHostLaunch(hostId, "/");
  return attachFilesWithContext({
    consumerId: "",
    launch,
    rootPath: "/",
  }, sshHostAttachmentSessionId(hostId), inputs);
}

async function attachFilesWithContext(
  context: SshRemoteFileContext,
  sessionId: string,
  inputs: SshRemoteAttachmentInput[],
): Promise<string[]> {
  context.consumerId = [
    "attachments",
    context.launch.clientInstanceId,
    context.launch.hostId,
    sessionId,
    crypto.randomUUID(),
  ].join(":");
  try {
    const paths: string[] = [];
    for (const input of inputs) {
      const common = {
        consumerId: context.consumerId,
        sshLaunch: context.launch,
        sessionId,
        ...(context.launch.attachmentRoot.trim()
          ? { attachmentRoot: context.launch.attachmentRoot.trim() }
          : {}),
      };
      const path = input.kind === "data"
        ? await invoke<string>("ssh_remote_file_attach_data", {
            ...common,
            fileName: input.fileName,
            dataBase64: input.dataBase64,
          })
        : await invoke<string>("ssh_remote_file_attach_path", {
            ...common,
            localPath: input.path,
          });
      paths.push(path);
    }
    return paths;
  } finally {
    await releaseSshRemoteFileContext(context).catch(() => undefined);
  }
}

export async function sshRemoteListDir(
  context: SshRemoteFileContext,
  relativePath = "",
  options?: SshRemoteFileOperationOptions,
): Promise<ProjectFileEntry[]> {
  const response = await runFileOperation(context, "backgroundOperations.remoteFiles.listing", () =>
    invoke<{ entries: RemoteFileEntry[] }>("ssh_remote_file_list", {
      consumerId: context.consumerId,
      sshLaunch: context.launch,
      rootPath: context.rootPath,
      relativePath,
    }), options);
  return (response.entries ?? []).map(toEntry);
}

export async function sshRemoteReadFile(
  context: SshRemoteFileContext,
  relativePath: string,
  options?: SshRemoteFileOperationOptions,
): Promise<{ content: string; previewKind: ProjectFilePreviewKind; sizeBytes: number; modifiedMs: number | null }> {
  const result = await runFileOperation(context, "backgroundOperations.remoteFiles.reading", () =>
    invoke<RemoteFileRead>("ssh_remote_file_read", {
      consumerId: context.consumerId,
      sshLaunch: context.launch,
      rootPath: context.rootPath,
      relativePath,
    }), options);
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
  const response = await runFileOperation(context, "backgroundOperations.remoteFiles.searching", () =>
    invoke<{ entries: RemoteFileEntry[] }>("ssh_remote_file_search", {
      consumerId: context.consumerId,
      sshLaunch: context.launch,
      rootPath: context.rootPath,
      query,
      content,
    }));
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
