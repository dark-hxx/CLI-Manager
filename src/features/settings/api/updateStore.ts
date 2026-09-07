import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";

const RELEASES_URL = "https://github.com/dark-hxx/CLI-Manager/releases";
const AUR_PACKAGE_URL = "https://aur.archlinux.org/packages/cli-manager-bin";
const MAX_RELEASE_NOTES_LENGTH = 1200;
export type AppDistribution = "standalone" | "portable" | "aur";

export interface UpdateInfo {
  version: string;
  releaseDate: string;
  releaseNotes: string;
  downloadUrl: string;
}

interface UpdateState {
  currentVersion: string | null;
  distribution: AppDistribution;
  checking: boolean;
  updateAvailable: boolean;
  updateInfo: UpdateInfo | null;
  pendingUpdate: Update | null;
  downloading: boolean;
  downloadProgress: number;
  downloadTotalBytes: number | null;
  downloadedBytes: number;
  readyToInstall: boolean;
  installing: boolean;
  lastCheckedAt: string | null;
  error: string | null;
  releaseFallbackUrl: string;
  fetchVersion: () => Promise<void>;
  checkUpdate: (options?: { silent?: boolean }) => Promise<UpdateInfo | null>;
  downloadUpdate: () => Promise<boolean>;
  installAndRelaunch: () => Promise<void>;
  reset: () => void;
}

function normalizeVersion(version: string | null | undefined): string {
  return version?.trim().replace(/^[vV]/, "") ?? "";
}

function buildReleaseUrl(version: string | null | undefined): string {
  const normalized = normalizeVersion(version);
  return normalized ? `${RELEASES_URL}/tag/V${normalized}` : `${RELEASES_URL}/latest`;
}

function trimReleaseNotes(notes: string | undefined): string {
  if (!notes) return "";
  return notes.length > MAX_RELEASE_NOTES_LENGTH
    ? `${notes.slice(0, MAX_RELEASE_NOTES_LENGTH).trimEnd()}...`
    : notes;
}

const UPDATE_MANIFEST_UNAVAILABLE_MESSAGE =
  "当前 Release 还没有自动更新清单，请在下一次发布后再试，或先查看 Release 页面手动安装。";
const UPDATE_GENERIC_ERROR_SUFFIX = "请稍后重试，或查看 Release 页面手动安装。";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error.trim();
  return "";
}

function isUpdaterManifestError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("valid release json") ||
    normalized.includes("release json") ||
    normalized.includes("manifest") ||
    (normalized.includes("could not fetch") && normalized.includes("release"))
  );
}

function formatUpdateError(error: unknown, fallback: string): string {
  const message = getErrorMessage(error);
  if (message && isUpdaterManifestError(message)) {
    return UPDATE_MANIFEST_UNAVAILABLE_MESSAGE;
  }
  return `${fallback}，${UPDATE_GENERIC_ERROR_SUFFIX}`;
}

function toUpdateInfo(update: Update): UpdateInfo {
  const version = normalizeVersion(update.version);
  return {
    version,
    releaseDate: update.date ?? "",
    releaseNotes: trimReleaseNotes(update.body),
    downloadUrl: buildReleaseUrl(version),
  };
}

function closeUpdateResource(update: Update | null): void {
  if (!update) return;
  void update.close().catch(() => {});
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  currentVersion: null,
  distribution: "standalone",
  checking: false,
  updateAvailable: false,
  updateInfo: null,
  pendingUpdate: null,
  downloading: false,
  downloadProgress: 0,
  downloadTotalBytes: null,
  downloadedBytes: 0,
  readyToInstall: false,
  installing: false,
  lastCheckedAt: null,
  error: null,
  releaseFallbackUrl: `${RELEASES_URL}/latest`,

  fetchVersion: async () => {
    try {
      const result = await invoke<{ version: string; name: string; distribution?: string }>("get_app_version");
      const distribution: AppDistribution = result.distribution === "aur"
        ? "aur"
        : result.distribution === "portable"
          ? "portable"
          : "standalone";
      set({
        currentVersion: result.version,
        distribution,
        releaseFallbackUrl: distribution === "aur" ? AUR_PACKAGE_URL : `${RELEASES_URL}/latest`,
      });
    } catch (e) {
      console.error("Failed to fetch version:", e);
    }
  },

  checkUpdate: async (options) => {
    const silent = options?.silent ?? false;
    if (get().distribution === "aur") {
      set({
        checking: false,
        updateAvailable: false,
        updateInfo: null,
        pendingUpdate: null,
        error: null,
        lastCheckedAt: silent ? get().lastCheckedAt : new Date().toISOString(),
        releaseFallbackUrl: AUR_PACKAGE_URL,
      });
      return null;
    }
    set({ checking: true, error: null });

    try {
      const update = await check();
      const previousUpdate = get().pendingUpdate;
      if (previousUpdate && previousUpdate !== update) {
        closeUpdateResource(previousUpdate);
      }

      if (!update) {
        set({
          checking: false,
          updateAvailable: false,
          updateInfo: null,
          pendingUpdate: null,
          downloading: false,
          downloadProgress: 0,
          downloadTotalBytes: null,
          downloadedBytes: 0,
          readyToInstall: false,
          installing: false,
          lastCheckedAt: new Date().toISOString(),
        });
        return null;
      }

      const updateInfo = toUpdateInfo(update);
      set({
        checking: false,
        updateAvailable: true,
        updateInfo,
        pendingUpdate: update,
        downloading: false,
        downloadProgress: 0,
        downloadTotalBytes: null,
        downloadedBytes: 0,
        readyToInstall: false,
        installing: false,
        lastCheckedAt: new Date().toISOString(),
        releaseFallbackUrl: updateInfo.downloadUrl,
      });
      return updateInfo;
    } catch (e) {
      set({
        checking: false,
        lastCheckedAt: silent ? get().lastCheckedAt : new Date().toISOString(),
        error: silent ? null : formatUpdateError(e, "检查更新失败"),
      });
      return null;
    }
  },

  downloadUpdate: async () => {
    if (get().distribution === "aur" || get().distribution === "portable") return false;
    let update = get().pendingUpdate;
    if (!update) {
      await get().checkUpdate();
      update = get().pendingUpdate;
    }

    if (!update) {
      set({ error: "没有可下载的更新" });
      return false;
    }

    let totalBytes: number | null = null;
    let receivedBytes = 0;
    set({
      downloading: true,
      downloadProgress: 0,
      downloadTotalBytes: null,
      downloadedBytes: 0,
      readyToInstall: false,
      installing: false,
      error: null,
    });

    try {
      await update.download((event: DownloadEvent) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? null;
          receivedBytes = 0;
          set({ downloadTotalBytes: totalBytes, downloadedBytes: 0, downloadProgress: 0 });
          return;
        }
        if (event.event === "Progress") {
          receivedBytes += event.data.chunkLength;
          const progress = totalBytes ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100)) : 0;
          set({ downloadedBytes: receivedBytes, downloadProgress: progress });
          return;
        }
        set({ downloadProgress: 100 });
      });

      set({
        downloading: false,
        downloadProgress: 100,
        downloadedBytes: receivedBytes,
        readyToInstall: true,
        error: null,
      });
      return true;
    } catch (e) {
      set({
        downloading: false,
        readyToInstall: false,
        error: formatUpdateError(e, "下载更新失败"),
      });
      return false;
    }
  },

  installAndRelaunch: async () => {
    if (get().distribution === "aur" || get().distribution === "portable") return;
    const update = get().pendingUpdate;
    if (!update || !get().readyToInstall) {
      set({ error: "请先下载更新" });
      return;
    }

    set({ installing: true, error: null });
    try {
      await update.install();
      await relaunch();
    } catch (e) {
      set({
        installing: false,
        error: formatUpdateError(e, "安装更新失败"),
      });
    }
  },

  reset: () => {
    closeUpdateResource(get().pendingUpdate);
    set({
      checking: false,
      updateAvailable: false,
      updateInfo: null,
      pendingUpdate: null,
      downloading: false,
      downloadProgress: 0,
      downloadTotalBytes: null,
      downloadedBytes: 0,
      readyToInstall: false,
      installing: false,
      error: null,
      releaseFallbackUrl: get().distribution === "aur" ? AUR_PACKAGE_URL : `${RELEASES_URL}/latest`,
    });
  },
}));
