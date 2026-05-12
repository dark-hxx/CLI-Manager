import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export interface UpdateInfo {
  version: string;
  releaseDate: string;
  releaseNotes: string;
  downloadUrl: string;
}

interface UpdateState {
  currentVersion: string | null;
  checking: boolean;
  updateAvailable: boolean;
  updateInfo: UpdateInfo | null;
  downloading: boolean;
  downloadProgress: number;
  error: string | null;
  fetchVersion: () => Promise<void>;
  checkUpdate: (options?: { silent?: boolean }) => Promise<UpdateInfo | null>;
  reset: () => void;
}

function parseVersion(version: string | null): number[] | null {
  const normalized = version?.trim().replace(/^[vV]/, "");
  if (!normalized) return null;

  const match = normalized.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;

  return [match[1], match[2] ?? "0", match[3] ?? "0"].map(Number);
}

function isNewerVersion(latestVersion: string, currentVersion: string | null): boolean {
  const latestParts = parseVersion(latestVersion);
  const currentParts = parseVersion(currentVersion);

  if (!latestParts || !currentParts) return false;

  for (let i = 0; i < latestParts.length; i++) {
    if (latestParts[i] > currentParts[i]) return true;
    if (latestParts[i] < currentParts[i]) return false;
  }

  return false;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  currentVersion: null,
  checking: false,
  updateAvailable: false,
  updateInfo: null,
  downloading: false,
  downloadProgress: 0,
  error: null,

  fetchVersion: async () => {
    try {
      const result = await invoke<{ version: string; name: string }>("get_app_version");
      set({ currentVersion: result.version });
    } catch (e) {
      console.error("Failed to fetch version:", e);
    }
  },

  checkUpdate: async (options) => {
    const silent = options?.silent ?? false;
    set({ checking: true, error: null });

    try {
      // 调用 GitHub API 检查更新
      const response = await fetch(
        "https://api.github.com/repos/dark-hxx/CLI-Manager/releases/latest"
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const latestVersion = data.tag_name?.replace(/^[vV]/, "") || "";
      const currentVersion = get().currentVersion;

      if (isNewerVersion(latestVersion, currentVersion)) {
        const updateInfo: UpdateInfo = {
          version: latestVersion,
          releaseDate: data.published_at || "",
          releaseNotes: (data.body || "").slice(0, 500),
          downloadUrl: data.html_url || "",
        };
        set({
          checking: false,
          updateAvailable: true,
          updateInfo,
        });
        return updateInfo;
      } else {
        set({ checking: false, updateAvailable: false, updateInfo: null });
        return null;
      }
    } catch (e) {
      set({
        checking: false,
        error: silent ? null : e instanceof Error ? e.message : "检查更新失败",
      });
      return null;
    }
  },

  reset: () => {
    set({
      checking: false,
      updateAvailable: false,
      updateInfo: null,
      downloading: false,
      downloadProgress: 0,
      error: null,
    });
  },
}));
