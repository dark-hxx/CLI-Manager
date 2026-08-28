import type { Project, SshHistorySource, SshToolSource } from "./types";
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

  const hostStore = useSshHostStore.getState();
  if (!hostStore.loaded) await hostStore.fetchHosts();
  const hosts = useSshHostStore.getState().hosts;
  const host = hosts.find((candidate) => candidate.id === project.ssh_host_id);
  if (!host) throw new Error("ssh_host_not_found");

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
    remotePath: project.remote_path.trim(),
    clientInstanceId,
    projectId: project.id,
    projectName: project.name,
    bridgeEpoch: crypto.randomUUID(),
    agentPath: installation.install_path,
    agentInstallationId: installation.installation_id,
    agentRemoteMachineId: installation.remote_machine_id,
    toolSource,
    environmentOverrides: {},
    initializationCommand: null,
    startupCommand: null,
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
