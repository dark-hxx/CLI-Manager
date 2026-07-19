import { create } from "zustand";
import { getDb } from "../lib/db";
import { validateSshToolConfigRoot } from "../lib/sshToolIntegration";
import type {
  SshAgentInstallation,
  SshAgentToolIntegration,
  SshHostToolPreference,
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
}));
