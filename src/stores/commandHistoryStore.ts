import { create } from "zustand";
import { getDb } from "../lib/db";
import type { CommandHistoryEntry } from "../lib/types";

const MAX_HISTORY = 1000;
const CLEANUP_INTERVAL = 50;
let addCounter = 0;

interface CommandHistoryStore {
  entries: CommandHistoryEntry[];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  addCommand: (projectId: string | null, command: string) => Promise<void>;
  getRecent: (projectId?: string | null, limit?: number) => Promise<CommandHistoryEntry[]>;
  fetchAll: () => Promise<void>;
  cleanup: () => Promise<void>;
}

export const useCommandHistoryStore = create<CommandHistoryStore>((set, get) => ({
  entries: [],
  searchQuery: "",

  setSearchQuery: (q) => set({ searchQuery: q }),

  addCommand: async (projectId, command) => {
    const trimmed = command.replace(/\r?\n$/, "").trim();
    if (!trimmed) return;

    const db = await getDb();
    // Deduplicate against the persisted latest command for this project.
    // The in-memory list may be filtered or truncated, so it is not a safe source of truth here.
    const last = await db.select<Pick<CommandHistoryEntry, "command">[]>(
      "SELECT command FROM command_history WHERE project_id IS $1 ORDER BY executed_at DESC LIMIT 1",
      [projectId]
    );
    if (last.length > 0 && last[0].command === trimmed) return;

    const existing = get().entries;
    const id = crypto.randomUUID();
    const executedAt = Date.now().toString();
    await db.execute(
      "INSERT INTO command_history (id, project_id, command, executed_at) VALUES ($1, $2, $3, $4)",
      [id, projectId, trimmed, executedAt]
    );

    // Increment local cache without re-querying the DB
    const newEntry: CommandHistoryEntry = {
      id,
      project_id: projectId,
      command: trimmed,
      executed_at: executedAt,
    };
    const query = get().searchQuery.trim().toLowerCase();
    if (!query || trimmed.toLowerCase().includes(query)) {
      set({ entries: [newEntry, ...existing].slice(0, 100) });
    }

    // Periodic FIFO cleanup; running it every command is wasteful
    addCounter++;
    if (addCounter >= CLEANUP_INTERVAL) {
      addCounter = 0;
      void (async () => {
        try {
          const countResult = await db.select<[{ cnt: number }]>(
            "SELECT COUNT(*) as cnt FROM command_history"
          );
          if (countResult[0]?.cnt > MAX_HISTORY) {
            await db.execute(
              `DELETE FROM command_history WHERE id IN (
                SELECT id FROM command_history ORDER BY executed_at ASC LIMIT $1
              )`,
              [countResult[0].cnt - MAX_HISTORY]
            );
          }
        } catch {
          // best effort
        }
      })();
    }
  },

  getRecent: async (projectId, limit = 50) => {
    const db = await getDb();
    if (projectId) {
      return db.select<CommandHistoryEntry[]>(
        "SELECT * FROM command_history WHERE project_id = $1 ORDER BY executed_at DESC LIMIT $2",
        [projectId, limit]
      );
    }
    return db.select<CommandHistoryEntry[]>(
      "SELECT * FROM command_history ORDER BY executed_at DESC LIMIT $1",
      [limit]
    );
  },

  fetchAll: async () => {
    const db = await getDb();
    const query = get().searchQuery.trim();
    let entries: CommandHistoryEntry[];
    if (query) {
      entries = await db.select<CommandHistoryEntry[]>(
        "SELECT * FROM command_history WHERE command LIKE $1 ORDER BY executed_at DESC LIMIT 100",
        [`%${query}%`]
      );
    } else {
      entries = await db.select<CommandHistoryEntry[]>(
        "SELECT * FROM command_history ORDER BY executed_at DESC LIMIT 100"
      );
    }
    set({ entries });
  },

  cleanup: async () => {
    const db = await getDb();
    await db.execute("DELETE FROM command_history");
    set({ entries: [] });
  },
}));
