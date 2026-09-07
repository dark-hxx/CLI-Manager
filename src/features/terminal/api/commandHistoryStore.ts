import { create } from "zustand";
import { getDb } from "../../../shared/platform/db";
import type { CommandHistoryEntry } from "../../../shared/types/index";

const MAX_HISTORY = 1000;
const CLEANUP_INTERVAL = 50;
let addCounter = 0;

const COMMON_COMMAND_ROOTS = new Set([
  "cd",
  "clear",
  "cls",
  "cmd",
  "copy",
  "cp",
  "cargo",
  "cat",
  "choco",
  "claude",
  "codex",
  "code",
  "del",
  "deno",
  "dir",
  "docker",
  "docker-compose",
  "dotnet",
  "echo",
  "gemini",
  "git",
  "go",
  "grep",
  "kubectl",
  "ll",
  "ls",
  "make",
  "mkdir",
  "move",
  "mv",
  "node",
  "npm",
  "npx",
  "pnpm",
  "poetry",
  "powershell",
  "pwsh",
  "pip",
  "pipx",
  "python",
  "py",
  "rm",
  "rmdir",
  "rustc",
  "scoop",
  "ssh",
  "tauri",
  "tar",
  "touch",
  "type",
  "uv",
  "vim",
  "where",
  "winget",
  "yarn",
]);

const NATURAL_LANGUAGE_STARTERS = new Set([
  "add",
  "can",
  "could",
  "create",
  "explain",
  "fix",
  "help",
  "how",
  "implement",
  "please",
  "should",
  "what",
  "when",
  "where",
  "why",
  "write",
]);

const NON_COMMAND_SCRIPT_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Cyrillic}\p{Script=Hebrew}]/u;
const PATH_OR_INVOCATION_PATTERN = /^(?:\.{1,2}[\\/]|~[\\/]|[a-z]:[\\/]|&\s*["']?|\.\s+)/iu;
const SHELL_OPERATOR_PATTERN = /(?:&&|\|\||[|<>;`])/u;
const ENV_ASSIGNMENT_PATTERN = /^[a-z_][\w.-]*=/iu;
const SLASH_COMMAND_PATTERN = /^\/[a-z][\w-]*(?:\s|$)/iu;

export interface CommandHistoryStorageStats {
  commandCount: number;
  storageBytes: number;
}

interface CommandHistoryStore {
  entries: CommandHistoryEntry[];
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  addCommand: (projectId: string | null, command: string) => Promise<void>;
  getRecent: (projectId?: string | null, limit?: number) => Promise<CommandHistoryEntry[]>;
  getStorageStats: () => Promise<CommandHistoryStorageStats>;
  fetchAll: () => Promise<void>;
  cleanup: () => Promise<void>;
}

function commandRoot(command: string): string {
  const first = command.trim().match(/^(?:&\s*)?(?:"([^"]+)"|'([^']+)'|(\S+))/u);
  const token = (first?.[1] ?? first?.[2] ?? first?.[3] ?? "").trim();
  const basename = token.split(/[\\/]/u).pop() ?? token;
  return basename.replace(/\.(?:cmd|exe|ps1|bat)$/iu, "").toLowerCase();
}

function isLikelyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r")) return false;
  if (SLASH_COMMAND_PATTERN.test(trimmed)) return true;
  if (PATH_OR_INVOCATION_PATTERN.test(trimmed)) return true;
  if (SHELL_OPERATOR_PATTERN.test(trimmed)) return true;
  if (ENV_ASSIGNMENT_PATTERN.test(trimmed)) return true;

  const root = commandRoot(trimmed);
  if (!root) return false;
  if (COMMON_COMMAND_ROOTS.has(root)) return true;
  if (NATURAL_LANGUAGE_STARTERS.has(root)) return false;

  const firstToken = trimmed.split(/\s+/u)[0] ?? "";
  if (NON_COMMAND_SCRIPT_PATTERN.test(firstToken)) return false;
  if (/[?？。！]/u.test(trimmed)) return false;

  const words = trimmed.split(/\s+/u);
  const allPlainWords = words.every((word) => /^[a-z]+$/iu.test(word));
  return !(words.length >= 3 && allPlainWords);
}

function normalizeCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export const useCommandHistoryStore = create<CommandHistoryStore>((set, get) => ({
  entries: [],
  searchQuery: "",

  setSearchQuery: (q) => set({ searchQuery: q }),

  addCommand: async (projectId, command) => {
    const trimmed = command.replace(/\r?\n$/, "").trim();
    if (!trimmed) return;
    if (!isLikelyShellCommand(trimmed)) return;

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

  getStorageStats: async () => {
    const db = await getDb();
    const rows = await db.select<Array<{ command_count?: number | string; storage_bytes?: number | string }>>(
      `SELECT
        COUNT(*) AS command_count,
        COALESCE(SUM(
          length(CAST(id AS BLOB)) +
          length(CAST(COALESCE(project_id, '') AS BLOB)) +
          length(CAST(command AS BLOB)) +
          length(CAST(executed_at AS BLOB))
        ), 0) AS storage_bytes
      FROM command_history`
    );
    const row = rows[0] ?? {};
    return {
      commandCount: normalizeCount(row.command_count),
      storageBytes: normalizeCount(row.storage_bytes),
    };
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
