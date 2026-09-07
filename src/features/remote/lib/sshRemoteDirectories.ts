import { invoke } from "@tauri-apps/api/core";
import type { SshHost } from "../../../shared/types/index";
import { buildSshConnectionSpec, type SshConnectionSpecPayload } from "../api/ssh";
import { getSshClientInstanceId } from "../api/sshClientIdentity";
import { useSshAgentIntegrationStore } from "../api/sshAgentIntegrationStore";

const DIRECTORY_CACHE_LIMIT = 96;
const REMOTE_FILE_LIST_LIMIT = 500;

export interface SshDirectoryEntry {
  name: string;
  path: string;
}

interface RemoteFileEntry {
  name: string;
  relativePath: string;
  kind: string;
}

interface RemoteFileListResponse {
  entries?: RemoteFileEntry[];
}

interface SshDirectoryAgentLaunch extends SshConnectionSpecPayload {
  hostId: string;
  remotePath: string;
  clientInstanceId: string;
  projectId: string;
  projectName: string;
  bridgeEpoch: string;
  agentPath: string;
  agentInstallationId: string;
  agentRemoteMachineId: string;
  toolSource: "codex";
  environmentOverrides: Record<string, string>;
  initializationCommand: null;
  startupCommand: null;
}

export interface SshDirectoryBrowserSession {
  connectionKey: string;
  hostId: string;
  consumerId: string;
  spec: SshConnectionSpecPayload;
  agentLaunch: SshDirectoryAgentLaunch | null;
  agentUnavailable: boolean;
  cache: Map<string, SshDirectoryEntry[]>;
}

export function normalizeSshDirectoryPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "/";
  return trimmed === "/" ? "/" : trimmed.replace(/\/+$/, "") || "/";
}

export function sshDirectoryBrowserConnectionKey(
  host: SshHost | null,
  hosts: SshHost[],
): string {
  if (!host) return "";
  const jumpHost = host.jump_host_id
    ? hosts.find((candidate) => candidate.id === host.jump_host_id)
    : null;
  return JSON.stringify([
    host.id,
    host.updated_at,
    jumpHost?.id ?? "",
    jumpHost?.updated_at ?? "",
  ]);
}

function childRemotePath(rootPath: string, relativePath: string, name: string): string {
  const child = (relativePath || name).replace(/^\/+/, "");
  return rootPath === "/" ? `/${child}` : `${rootPath}/${child}`;
}

function readCached(
  session: SshDirectoryBrowserSession,
  path: string,
): SshDirectoryEntry[] | null {
  const cached = session.cache.get(path);
  if (!cached) return null;
  session.cache.delete(path);
  session.cache.set(path, cached);
  return cached;
}

function writeCached(
  session: SshDirectoryBrowserSession,
  path: string,
  entries: SshDirectoryEntry[],
): void {
  session.cache.delete(path);
  session.cache.set(path, entries);
  while (session.cache.size > DIRECTORY_CACHE_LIMIT) {
    const oldest = session.cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    session.cache.delete(oldest);
  }
}

async function resolveAgentLaunch(
  host: SshHost,
  spec: SshConnectionSpecPayload,
): Promise<SshDirectoryAgentLaunch | null> {
  const integrationStore = useSshAgentIntegrationStore.getState();
  if (!integrationStore.loaded) await integrationStore.fetchAll();
  const installation = useSshAgentIntegrationStore.getState().installations.find(
    (candidate) => candidate.host_id === host.id && candidate.status === "installed",
  );
  if (!installation?.install_path
    || !installation.installation_id
    || !installation.remote_machine_id) {
    return null;
  }
  const clientInstanceId = getSshClientInstanceId();
  return {
    ...spec,
    hostId: host.id,
    remotePath: "/",
    clientInstanceId,
    projectId: `directory-browser:${host.id}`,
    projectName: "SSH directory browser",
    bridgeEpoch: crypto.randomUUID(),
    agentPath: installation.install_path,
    agentInstallationId: installation.installation_id,
    agentRemoteMachineId: installation.remote_machine_id,
    toolSource: "codex",
    environmentOverrides: {},
    initializationCommand: null,
    startupCommand: null,
  };
}

export async function createSshDirectoryBrowserSession(
  connectionKey: string,
  host: SshHost,
  hosts: SshHost[],
): Promise<SshDirectoryBrowserSession> {
  const spec = buildSshConnectionSpec(host, hosts);
  let agentLaunch: SshDirectoryAgentLaunch | null = null;
  try {
    agentLaunch = await resolveAgentLaunch(host, spec);
  } catch {
    // Directory browsing remains available through the existing one-shot OpenSSH path.
  }
  return {
    connectionKey,
    hostId: host.id,
    consumerId: `directories:${getSshClientInstanceId()}:${host.id}:${crypto.randomUUID()}`,
    spec,
    agentLaunch,
    agentUnavailable: false,
    cache: new Map(),
  };
}

async function listThroughAgent(
  session: SshDirectoryBrowserSession,
  path: string,
  signal?: AbortSignal,
): Promise<SshDirectoryEntry[] | null> {
  if (!session.agentLaunch || session.agentUnavailable) return null;
  try {
    const response = await invoke<RemoteFileListResponse>("ssh_remote_file_list", {
      consumerId: session.consumerId,
      sshLaunch: session.agentLaunch,
      rootPath: path,
      relativePath: "",
    });
    const remoteEntries = response.entries ?? [];
    // Agent file listings are bounded. A full page may have omitted later directories, so
    // preserve correctness by falling back to the unbounded directory-only command.
    if (remoteEntries.length >= REMOTE_FILE_LIST_LIMIT) return null;
    return remoteEntries
      .filter((entry) => entry.kind === "directory")
      .map((entry) => ({
        name: entry.name,
        path: childRemotePath(path, entry.relativePath, entry.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  } catch {
    if (signal?.aborted) throw new Error("ssh_directory_request_cancelled");
    session.agentUnavailable = true;
    await releaseSshDirectoryBrowserSession(session).catch(() => undefined);
    return null;
  }
}

export async function listSshDirectories(
  session: SshDirectoryBrowserSession,
  rawPath: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<SshDirectoryEntry[]> {
  const path = normalizeSshDirectoryPath(rawPath);
  if (!options.force) {
    const cached = readCached(session, path);
    if (cached) return cached;
  }

  const agentEntries = await listThroughAgent(session, path, options.signal);
  if (options.signal?.aborted) throw new Error("ssh_directory_request_cancelled");
  const entries = agentEntries ?? await invoke<SshDirectoryEntry[]>("ssh_list_directories", {
    spec: session.spec,
    path,
  });
  if (options.signal?.aborted) throw new Error("ssh_directory_request_cancelled");
  writeCached(session, path, entries);
  return entries;
}

export async function releaseSshDirectoryBrowserSession(
  session: SshDirectoryBrowserSession,
): Promise<void> {
  if (!session.agentLaunch) return;
  await invoke("history_remote_close", {
    hostId: session.hostId,
    consumerId: session.consumerId,
  });
}
