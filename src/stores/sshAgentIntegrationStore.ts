import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getDb } from "../lib/db";
import { validateSshToolConfigRoot } from "../lib/sshToolIntegration";
import type {
  SshAgentInstallation,
  SshAgentOperationResult,
  SshAgentProbeResult,
  SshAgentToolIntegration,
  SshHostToolPreference,
  SshRemoteHookConfigReport,
  SshRemoteHistorySyncResult,
  SshToolSource,
} from "../lib/types";

export type SshAgentInstallJobStatus = "running" | "succeeded" | "failed";

export interface SshAgentInstallJob {
  hostId: string;
  status: SshAgentInstallJobStatus;
  phase: string;
  progress: number;
  error: string;
  updatedAt: number;
}

interface SshAgentIntegrationStore {
  installations: SshAgentInstallation[];
  preferences: SshHostToolPreference[];
  integrations: SshAgentToolIntegration[];
  agentInstallJobs: Record<string, SshAgentInstallJob>;
  loaded: boolean;
  loadError: string | null;
  fetchAll: () => Promise<void>;
  saveHostPreferences: (hostId: string, roots: Record<SshToolSource, string>) => Promise<void>;
  recordAgentProbe: (hostId: string, result: SshAgentProbeResult) => Promise<void>;
  recordAgentOperation: (hostId: string, result: SshAgentOperationResult) => Promise<void>;
  updateAgentInstallJob: (hostId: string, job: Omit<SshAgentInstallJob, "hostId" | "updatedAt">) => void;
  clearAgentInstallJob: (hostId: string) => void;
  recordHookReport: (
    hostId: string,
    sshUser: string,
    configuredRoot: string,
    report: SshRemoteHookConfigReport,
    integrationId?: string,
    scopeKind?: "hostPrimary" | "projectOverride",
  ) => Promise<void>;
  recordHistorySource: (
    hostId: string,
    configuredRoot: string,
    result: SshRemoteHistorySyncResult,
    scopeKind: "hostPrimary" | "projectOverride",
  ) => Promise<void>;
}

let fetchAllPromise: Promise<void> | null = null;

export const useSshAgentIntegrationStore = create<SshAgentIntegrationStore>((set, get) => ({
  installations: [],
  preferences: [],
  integrations: [],
  agentInstallJobs: {},
  loaded: false,
  loadError: null,

  fetchAll: async () => {
    if (fetchAllPromise) return fetchAllPromise;
    fetchAllPromise = (async () => {
      const db = await getDb();
      try {
        const [installations, preferences, integrations] = await Promise.all([
          db.select<SshAgentInstallation[]>("SELECT * FROM ssh_agent_installations ORDER BY host_id"),
          db.select<SshHostToolPreference[]>("SELECT * FROM ssh_host_tool_preferences ORDER BY host_id, source"),
          db.select<SshAgentToolIntegration[]>(
            "SELECT * FROM ssh_agent_tool_integrations ORDER BY host_id, source, scope_kind, checked_at DESC",
          ),
        ]);
        set({ installations, preferences, integrations, loaded: true, loadError: null });
      } catch (error) {
        set({
          installations: [],
          preferences: [],
          integrations: [],
          loaded: true,
          loadError: error instanceof Error ? error.message : String(error),
        });
      }
    })().finally(() => {
      fetchAllPromise = null;
    });
    return fetchAllPromise;
  },

  saveHostPreferences: async (hostId, roots) => {
    if (fetchAllPromise) await fetchAllPromise;
    const normalizedHostId = hostId.trim();
    if (!normalizedHostId) throw new Error("ssh_host_not_found");
    const normalizedRoots = {
      claude: roots.claude.trim(),
      codex: roots.codex.trim(),
    } satisfies Record<SshToolSource, string>;
    for (const source of ["claude", "codex"] as const) {
      const validationError = validateSshToolConfigRoot(normalizedRoots[source]);
      if (validationError) throw new Error(validationError);
    }
    await invoke("ssh_db_save_host_preferences", {
      hostId: normalizedHostId,
      claudeRoot: normalizedRoots.claude,
      codexRoot: normalizedRoots.codex,
      updatedAt: Date.now().toString(),
    });
    await get().fetchAll();
  },

  recordAgentProbe: async (hostId, result) => {
    if (fetchAllPromise) await fetchAllPromise;
    const normalizedHostId = hostId.trim();
    if (!normalizedHostId) throw new Error("ssh_host_not_found");
    const db = await getDb();
    await db.execute(
      `INSERT INTO ssh_agent_installations (
         host_id, installation_id, remote_machine_id, agent_version,
         protocol_version, target, install_path, status, checked_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT(host_id) DO UPDATE SET
         installation_id = CASE
           WHEN excluded.status = 'notInstalled' THEN ''
           WHEN excluded.installation_id <> '' THEN excluded.installation_id
           ELSE ssh_agent_installations.installation_id
         END,
         remote_machine_id = CASE
           WHEN excluded.status = 'notInstalled' THEN ''
           WHEN excluded.remote_machine_id <> '' THEN excluded.remote_machine_id
           ELSE ssh_agent_installations.remote_machine_id
         END,
         agent_version = CASE
           WHEN excluded.status = 'notInstalled' THEN ''
           WHEN excluded.agent_version <> '' THEN excluded.agent_version
           ELSE ssh_agent_installations.agent_version
         END,
         protocol_version = CASE
           WHEN excluded.status = 'notInstalled' THEN ''
           WHEN excluded.protocol_version <> '' THEN excluded.protocol_version
           ELSE ssh_agent_installations.protocol_version
         END,
         target = CASE
           WHEN excluded.status = 'notInstalled' THEN ''
           WHEN excluded.target <> '' THEN excluded.target
           ELSE ssh_agent_installations.target
         END,
         install_path = CASE
           WHEN excluded.status = 'notInstalled' THEN ''
           WHEN excluded.install_path <> '' THEN excluded.install_path
           ELSE ssh_agent_installations.install_path
         END,
         status = excluded.status,
         checked_at = excluded.checked_at`,
      [
        normalizedHostId,
        result.installationId,
        result.remoteMachineId,
        result.agentVersion,
        result.protocolVersion,
        result.target,
        result.installPath,
        result.status,
        Date.now().toString(),
      ],
    );
    await get().fetchAll();
  },

  recordAgentOperation: async (hostId, result) => {
    if (fetchAllPromise) await fetchAllPromise;
    const normalizedHostId = hostId.trim();
    if (!normalizedHostId) throw new Error("ssh_host_not_found");
    const db = await getDb();
    if (result.action === "uninstalled" || result.action === "purged") {
      await db.execute("DELETE FROM ssh_agent_installations WHERE host_id = $1", [normalizedHostId]);
      await get().fetchAll();
      return;
    }
    await db.execute(
      `INSERT INTO ssh_agent_installations (
         host_id, installation_id, remote_machine_id, agent_version,
         protocol_version, target, install_path, install_root, source,
         manifest_url, artifact_sha256, previous_version, status, checked_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'installed', $13)
       ON CONFLICT(host_id) DO UPDATE SET
         installation_id = excluded.installation_id,
         remote_machine_id = excluded.remote_machine_id,
         agent_version = excluded.agent_version,
         protocol_version = excluded.protocol_version,
         target = excluded.target,
         install_path = excluded.install_path,
         install_root = excluded.install_root,
         source = excluded.source,
         manifest_url = excluded.manifest_url,
         artifact_sha256 = excluded.artifact_sha256,
         previous_version = excluded.previous_version,
         status = excluded.status,
         checked_at = excluded.checked_at`,
      [
        normalizedHostId,
        result.installationId,
        result.remoteMachineId,
        result.agentVersion,
        result.protocolVersion,
        result.target,
        result.installPath,
        result.installRoot,
        result.source,
        result.manifestUrl,
        result.artifactSha256,
        result.previousVersion,
        Date.now().toString(),
      ],
    );
    await get().fetchAll();
  },

  updateAgentInstallJob: (hostId, job) => {
    const normalizedHostId = hostId.trim();
    if (!normalizedHostId) return;
    set((state) => ({
      agentInstallJobs: {
        ...state.agentInstallJobs,
        [normalizedHostId]: {
          hostId: normalizedHostId,
          ...job,
          progress: Math.max(0, Math.min(100, Math.round(job.progress))),
          updatedAt: Date.now(),
        },
      },
    }));
  },

  clearAgentInstallJob: (hostId) => {
    const normalizedHostId = hostId.trim();
    if (!normalizedHostId) return;
    set((state) => {
      if (!state.agentInstallJobs[normalizedHostId]) return state;
      const agentInstallJobs = { ...state.agentInstallJobs };
      delete agentInstallJobs[normalizedHostId];
      return { agentInstallJobs };
    });
  },

  recordHookReport: async (hostId, sshUser, configuredRoot, report, integrationId, scopeKind = "hostPrimary") => {
    if (fetchAllPromise) await fetchAllPromise;
    const normalizedHostId = hostId.trim();
    const normalizedUser = sshUser.trim();
    if (!normalizedHostId) throw new Error("ssh_host_not_found");
    if (!normalizedUser) throw new Error("ssh_user_required");
    if (report.source !== "claude" && report.source !== "codex") throw new Error("hook_source_invalid");
    await invoke("ssh_db_record_hook_report", {
      input: {
        hostId: normalizedHostId,
        sshUser: normalizedUser,
        configuredRoot: configuredRoot.trim(),
        source: report.source,
        installationId: report.installationId,
        remoteMachineId: report.remoteMachineId,
        canonicalConfigRoot: report.canonicalConfigRoot,
        configRootHash: report.configRootHash,
        action: report.action,
        status: report.status,
        report,
        integrationId: integrationId ?? null,
        scopeKind,
      },
    });
    await get().fetchAll();
  },

  recordHistorySource: async (hostId, configuredRoot, result, scopeKind) => {
    if (fetchAllPromise) await fetchAllPromise;
    const normalizedHostId = hostId.trim();
    if (!normalizedHostId) throw new Error("ssh_host_not_found");
    if (!result.sourceInstanceId || !result.remoteMachineId || !result.sshUser || !result.configRootHash) {
      throw new Error("history_remote_identity_invalid");
    }
    const normalizedRoot = configuredRoot.trim();
    const db = await getDb();
    const existing = await db.select<Array<{ integration_id: string }>>(
      `SELECT integration_id FROM ssh_agent_tool_integrations
       WHERE host_id = $1 AND source = $2 AND configured_root = $3
         AND scope_kind IN ('hostPrimary', 'projectOverride')
       ORDER BY CASE WHEN scope_kind = $4 THEN 0 ELSE 1 END
       LIMIT 1`,
      [normalizedHostId, result.source, normalizedRoot, scopeKind],
    );
    const checkedAt = Date.now().toString();
    if (existing[0]) {
      await db.execute(
        `UPDATE ssh_agent_tool_integrations SET
           installation_id = $1, remote_machine_id = $2, ssh_user = $3,
           canonical_root = $4, config_root_hash = $5,
           history_source_instance_id = $6, validation_state = 'valid',
           cleanup_state = 'active', checked_at = $7
         WHERE integration_id = $8`,
        [
          result.installationId,
          result.remoteMachineId,
          result.sshUser,
          result.canonicalConfigRoot,
          result.configRootHash,
          result.sourceInstanceId,
          checkedAt,
          existing[0].integration_id,
        ],
      );
    } else {
      await db.execute(
        `INSERT INTO ssh_agent_tool_integrations (
           integration_id, host_id, installation_id, remote_machine_id, ssh_user,
           source, scope_kind, configured_root, canonical_root, config_root_hash,
           hook_record_json, history_source_instance_id, validation_state,
           cleanup_state, checked_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '{}', $11, 'valid', 'active', $12)`,
        [
          crypto.randomUUID(),
          normalizedHostId,
          result.installationId,
          result.remoteMachineId,
          result.sshUser,
          result.source,
          scopeKind,
          normalizedRoot,
          result.canonicalConfigRoot,
          result.configRootHash,
          result.sourceInstanceId,
          checkedAt,
        ],
      );
    }
    await get().fetchAll();
  },
}));
