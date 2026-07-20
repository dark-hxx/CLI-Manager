import { create } from "zustand";
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

interface SshAgentIntegrationStore {
  installations: SshAgentInstallation[];
  preferences: SshHostToolPreference[];
  integrations: SshAgentToolIntegration[];
  loaded: boolean;
  loadError: string | null;
  fetchAll: () => Promise<void>;
  saveHostPreferences: (hostId: string, roots: Record<SshToolSource, string>) => Promise<void>;
  recordAgentProbe: (hostId: string, result: SshAgentProbeResult) => Promise<void>;
  recordAgentOperation: (hostId: string, result: SshAgentOperationResult) => Promise<void>;
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
    const db = await getDb();
    await db.execute("BEGIN IMMEDIATE");
    try {
      for (const source of ["claude", "codex"] as const) {
        const normalizedRoot = normalizedRoots[source];
        if (!normalizedRoot) {
          await db.execute("DELETE FROM ssh_host_tool_preferences WHERE host_id = $1 AND source = $2", [normalizedHostId, source]);
          continue;
        }
        await db.execute(
          `INSERT INTO ssh_host_tool_preferences (host_id, source, configured_root, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT(host_id, source) DO UPDATE SET
             configured_root = excluded.configured_root,
             updated_at = excluded.updated_at`,
          [normalizedHostId, source, normalizedRoot, Date.now().toString()],
        );
      }
      await db.execute("COMMIT");
    } catch (error) {
      await db.execute("ROLLBACK").catch(() => undefined);
      throw error;
    }
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

  recordHookReport: async (hostId, sshUser, configuredRoot, report, integrationId, scopeKind = "hostPrimary") => {
    if (fetchAllPromise) await fetchAllPromise;
    const normalizedHostId = hostId.trim();
    const normalizedUser = sshUser.trim();
    if (!normalizedHostId) throw new Error("ssh_host_not_found");
    if (!normalizedUser) throw new Error("ssh_user_required");
    if (report.source !== "claude" && report.source !== "codex") throw new Error("hook_source_invalid");
    const db = await getDb();
    const existing = integrationId
      ? await db.select<Array<{ integration_id: string; canonical_root: string; hook_record_json: string; history_source_instance_id: string }>>(
        `SELECT integration_id, canonical_root, hook_record_json, history_source_instance_id
         FROM ssh_agent_tool_integrations WHERE integration_id = $1 AND host_id = $2 LIMIT 1`,
        [integrationId, normalizedHostId],
      )
      : scopeKind === "projectOverride"
        ? await db.select<Array<{ integration_id: string; canonical_root: string; hook_record_json: string; history_source_instance_id: string }>>(
          `SELECT integration_id, canonical_root, hook_record_json, history_source_instance_id
           FROM ssh_agent_tool_integrations
           WHERE host_id = $1 AND source = $2 AND scope_kind = 'projectOverride' AND configured_root = $3
           LIMIT 1`,
          [normalizedHostId, report.source, configuredRoot.trim()],
        )
        : await db.select<Array<{ integration_id: string; canonical_root: string; hook_record_json: string; history_source_instance_id: string }>>(
      `SELECT integration_id, canonical_root, hook_record_json, history_source_instance_id FROM ssh_agent_tool_integrations
       WHERE host_id = $1 AND source = $2 AND scope_kind = 'hostPrimary'
       LIMIT 1`,
      [normalizedHostId, report.source],
    );
    if (integrationId && !existing[0]) throw new Error("ssh_hook_integration_not_found");
    let persistedReport = report;
    let previousHookRecordJson = existing[0]?.canonical_root === report.canonicalConfigRoot
      ? existing[0].hook_record_json
      : "";
    if (report.action === "inspect" && !report.installation && !previousHookRecordJson) {
      const sameRoot = await db.select<Array<{ hook_record_json: string }>>(
        `SELECT hook_record_json FROM ssh_agent_tool_integrations
         WHERE host_id = $1 AND source = $2 AND canonical_root = $3
         LIMIT 1`,
        [normalizedHostId, report.source, report.canonicalConfigRoot],
      );
      previousHookRecordJson = sameRoot[0]?.hook_record_json ?? "";
    }
    if (report.action === "inspect" && !report.installation && previousHookRecordJson) {
      try {
        const previous = JSON.parse(previousHookRecordJson) as SshRemoteHookConfigReport;
        if (previous.installation && previous.canonicalConfigRoot === report.canonicalConfigRoot) {
          persistedReport = { ...report, installation: previous.installation };
        }
      } catch {
        // A fresh validated report replaces malformed local metadata.
      }
    }
    const values = [
      report.installationId,
      report.remoteMachineId,
      normalizedUser,
      configuredRoot.trim(),
      report.canonicalConfigRoot,
      report.configRootHash,
      JSON.stringify(persistedReport),
      Date.now().toString(),
    ];
    if (integrationId && existing[0]) {
      await db.execute(
        `UPDATE ssh_agent_tool_integrations SET
           installation_id = $1, remote_machine_id = $2, ssh_user = $3,
           configured_root = $4, canonical_root = $5, config_root_hash = $6,
           hook_record_json = $7, validation_state = 'valid',
           cleanup_state = $8, checked_at = $9
         WHERE integration_id = $10`,
        [
          report.installationId,
          report.remoteMachineId,
          normalizedUser,
          configuredRoot.trim(),
          report.canonicalConfigRoot,
          report.configRootHash,
          JSON.stringify(persistedReport),
          report.status === "notInstalled" ? "retained" : "cleanupAvailable",
          Date.now().toString(),
          integrationId,
        ],
      );
    } else if (existing[0]) {
      let managedEntries = 0;
      try {
        managedEntries = Number((JSON.parse(existing[0].hook_record_json) as { managedEntries?: number }).managedEntries ?? 0);
      } catch {
        managedEntries = 0;
      }
      const retainExisting = existing[0].canonical_root
        && existing[0].canonical_root !== report.canonicalConfigRoot
        && (managedEntries > 0 || Boolean(existing[0].history_source_instance_id));
      if (retainExisting) {
        await db.execute("BEGIN IMMEDIATE");
        try {
          await db.execute(
            `UPDATE ssh_agent_tool_integrations
             SET scope_kind = 'retainedRoot', cleanup_state = 'cleanupAvailable', checked_at = $1
             WHERE integration_id = $2`,
            [Date.now().toString(), existing[0].integration_id],
          );
          await db.execute(
            `INSERT INTO ssh_agent_tool_integrations (
               integration_id, host_id, installation_id, remote_machine_id, ssh_user,
               source, scope_kind, configured_root, canonical_root, config_root_hash,
               hook_record_json, validation_state, cleanup_state, checked_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'valid', 'active', $12)`,
            [
              crypto.randomUUID(), normalizedHostId, report.installationId, report.remoteMachineId,
              normalizedUser, report.source, scopeKind, configuredRoot.trim(), report.canonicalConfigRoot,
              report.configRootHash, JSON.stringify(persistedReport), Date.now().toString(),
            ],
          );
          await db.execute("COMMIT");
        } catch (error) {
          await db.execute("ROLLBACK").catch(() => undefined);
          throw error;
        }
      } else {
        await db.execute(
          `UPDATE ssh_agent_tool_integrations SET
             installation_id = $1,
             remote_machine_id = $2,
             ssh_user = $3,
             configured_root = $4,
             canonical_root = $5,
             config_root_hash = $6,
             hook_record_json = $7,
             validation_state = 'valid',
             cleanup_state = 'active',
             checked_at = $8
           WHERE integration_id = $9`,
          [...values, existing[0].integration_id],
        );
      }
    } else {
      await db.execute(
        `INSERT INTO ssh_agent_tool_integrations (
           integration_id, host_id, installation_id, remote_machine_id, ssh_user,
           source, scope_kind, configured_root, canonical_root, config_root_hash,
           hook_record_json, validation_state, cleanup_state, checked_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'valid', 'active', $12)`,
        [
          crypto.randomUUID(),
          normalizedHostId,
          report.installationId,
          report.remoteMachineId,
          normalizedUser,
          report.source,
          scopeKind,
          configuredRoot.trim(),
          report.canonicalConfigRoot,
          report.configRootHash,
          JSON.stringify(persistedReport),
          Date.now().toString(),
        ],
      );
    }
    const mirrors = await db.select<Array<{ integration_id: string; configured_root: string }>>(
      `SELECT integration_id, configured_root FROM ssh_agent_tool_integrations
       WHERE host_id = $1 AND source = $2 AND canonical_root = $3`,
      [normalizedHostId, report.source, report.canonicalConfigRoot],
    );
    await db.execute("BEGIN IMMEDIATE");
    try {
      const checkedAt = Date.now().toString();
      for (const mirror of mirrors) {
        await db.execute(
          `UPDATE ssh_agent_tool_integrations SET
             installation_id = $1, remote_machine_id = $2, ssh_user = $3,
             config_root_hash = $4, hook_record_json = $5,
             validation_state = 'valid', checked_at = $6
           WHERE integration_id = $7`,
          [
            report.installationId,
            report.remoteMachineId,
            normalizedUser,
            report.configRootHash,
            JSON.stringify({ ...persistedReport, configuredConfigRoot: mirror.configured_root }),
            checkedAt,
            mirror.integration_id,
          ],
        );
      }
      await db.execute("COMMIT");
    } catch (error) {
      await db.execute("ROLLBACK").catch(() => undefined);
      throw error;
    }
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
