import type { Project, SshHistorySource, SshHost, SshToolSource } from "./types";
import { buildSshConnectionSpec, type SshConnectionSpecPayload } from "./ssh";
import { getSshClientInstanceId } from "./sshClientIdentity";
import { resolveSshHistorySource } from "./sshToolIntegration";
import { useSshAgentIntegrationStore } from "../stores/sshAgentIntegrationStore";
import { useSshHostStore } from "../stores/sshHostStore";

export interface SshAgentProjectLaunch extends SshConnectionSpecPayload {
  hostId: string;
  remotePath: string;
  clientInstanceId: string;
  projectId: string;
  projectName: string;
  bridgeEpoch: string;
  agentPath: string;
  agentInstallationId: string;
  agentRemoteMachineId: string;
  toolSource: SshToolSource | "";
  environmentOverrides: Record<string, string>;
  initializationCommand: null;
  startupCommand: null;
  attachmentRoot: string;
}

export interface SshAgentHistoryLaunch extends SshAgentProjectLaunch {
  toolSource: SshHistorySource;
}

export interface SshAgentHistoryContext {
  hostId: string;
  source: SshHistorySource;
  configuredConfigRoot: string;
  sourceInstanceId: string;
  cursor: string;
  generation: number;
  hasMore: boolean;
  scopeKind: "hostPrimary" | "projectOverride";
  consumerId: string;
  projectPaths: string[];
  launch: SshAgentHistoryLaunch;
}

export function buildSshAgentProjectLaunch(
  project: Project,
  toolSource: SshHistorySource,
): Promise<SshAgentHistoryLaunch>;
export function buildSshAgentProjectLaunch(
  project: Project,
  toolSource?: "",
): Promise<SshAgentProjectLaunch>;
export async function buildSshAgentProjectLaunch(
  project: Project,
  toolSource: SshToolSource | "" = "",
): Promise<SshAgentProjectLaunch> {
  if (project.environment_type !== "ssh" || !project.ssh_host_id?.trim() || !project.remote_path.trim()) {
    throw new Error("ssh_project_configuration_invalid");
  }

  const { host, hosts } = await resolveSshHost(project.ssh_host_id.trim());
  return buildSshAgentLaunchForHost(
    host,
    hosts,
    project.remote_path.trim(),
    project.id,
    project.name,
    toolSource,
  );
}

export async function buildSshAgentHostLaunch(
  hostId: string,
  remotePath: string,
): Promise<SshAgentProjectLaunch> {
  const normalizedHostId = hostId.trim();
  const normalizedRemotePath = remotePath.trim();
  if (!normalizedHostId || !normalizedRemotePath) {
    throw new Error("ssh_terminal_context_invalid");
  }
  const { host, hosts } = await resolveSshHost(normalizedHostId);
  return buildSshAgentLaunchForHost(host, hosts, normalizedRemotePath, "", "", "");
}

async function resolveSshHost(hostId: string): Promise<{ host: SshHost; hosts: SshHost[] }> {
  const hostStore = useSshHostStore.getState();
  if (!hostStore.loaded) await hostStore.fetchHosts();
  const hosts = useSshHostStore.getState().hosts;
  const host = hosts.find((candidate) => candidate.id === hostId);
  if (!host) throw new Error("ssh_host_not_found");
  return { host, hosts };
}

async function buildSshAgentLaunchForHost(
  host: SshHost,
  hosts: SshHost[],
  remotePath: string,
  projectId: string,
  projectName: string,
  toolSource: SshToolSource | "",
): Promise<SshAgentProjectLaunch> {
  const integrationStore = useSshAgentIntegrationStore.getState();
  if (!integrationStore.loaded) await integrationStore.fetchAll();
  const state = useSshAgentIntegrationStore.getState();
  const installation = state.installations.find(
    (candidate) => candidate.host_id === host.id && candidate.status === "installed",
  );
  if (!installation?.install_path || !installation.installation_id || !installation.remote_machine_id) {
    throw new Error("ssh_agent_not_installed");
  }
  const clientInstanceId = getSshClientInstanceId();
  return {
    ...buildSshConnectionSpec(host, hosts),
    hostId: host.id,
    remotePath,
    clientInstanceId,
    projectId,
    projectName,
    bridgeEpoch: crypto.randomUUID(),
    agentPath: installation.install_path,
    agentInstallationId: installation.installation_id,
    agentRemoteMachineId: installation.remote_machine_id,
    toolSource,
    environmentOverrides: {},
    initializationCommand: null,
    startupCommand: null,
    attachmentRoot: host.attachment_root?.trim() ?? "",
  };
}

export async function buildSshAgentHistoryContext(project: Project): Promise<SshAgentHistoryContext> {
  if (project.environment_type !== "ssh" || !project.ssh_host_id?.trim() || !project.remote_path.trim()) {
    throw new Error("ssh_project_configuration_invalid");
  }
  const source = resolveSshHistorySource(project.cli_tool);
  if (!source) throw new Error("history_remote_source_required");

  const launch = await buildSshAgentProjectLaunch(project, source);
  const state = useSshAgentIntegrationStore.getState();
  const hostRoot = state.preferences.find(
    (preference) => preference.host_id === launch.hostId && preference.source === source,
  )?.configured_root.trim() ?? "";
  const configuredConfigRoot = project.cli_config_root.trim() || hostRoot;
  const integration = state.integrations.find((candidate) => (
    candidate.host_id === launch.hostId
    && candidate.source === source
    && candidate.configured_root === configuredConfigRoot
    && candidate.cleanup_state === "active"
  ));
  return {
    hostId: launch.hostId,
    source,
    configuredConfigRoot,
    sourceInstanceId: integration?.history_source_instance_id ?? "",
    cursor: "",
    generation: 0,
    hasMore: true,
    scopeKind: project.cli_config_root.trim() ? "projectOverride" : "hostPrimary",
    consumerId: `history:${launch.clientInstanceId}:${launch.hostId}:${source}:${project.id}`,
    projectPaths: [project.remote_path.trim()],
    launch,
  };
}
