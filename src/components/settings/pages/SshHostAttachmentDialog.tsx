import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { dirname as localDirname, desktopDir, join as joinLocalPath } from "@tauri-apps/api/path";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { getMaterialFileIcon, getMaterialFolderIcon } from "@baybreezy/file-extension-icon";
import {
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  Download,
  File,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { isValidSshAttachmentRoot } from "../../../lib/sshAttachment";
import { useI18n, type TranslationKey } from "../../../lib/i18n";
import type { ProjectFileEntry, SshHost } from "../../../lib/types";
import {
  buildSshRemoteAttachmentContext,
  releaseSshRemoteFileContext,
  resolveSshRemoteAttachmentRoot,
  sshRemoteDeleteFile,
  sshRemoteDownloadFile,
  sshRemoteListDir,
  sshRemotePutFilesForHost,
  type SshRemoteFileContext,
} from "../../../lib/sshRemoteFiles";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { useAppConfirm } from "../../ui/useAppConfirm";

interface Props {
  open: boolean;
  host: SshHost | null;
  onOpenChange: (open: boolean) => void;
}

type TransferStatus = "queued" | "uploading" | "downloading" | "success" | "error";
type TransferDirection = "upload" | "download";

interface TransferItem {
  id: string;
  path: string;
  name: string;
  direction: TransferDirection;
  status: TransferStatus;
  remotePath?: string;
  error?: string;
}

const ERROR_LABELS: Record<string, TranslationKey> = {
  ssh_agent_not_installed: "settings.sshHosts.attachmentDialog.error.agentNotInstalled",
  "ssh_agent_capability_missing:fileAttachmentRoot": "settings.sshHosts.attachmentDialog.error.rootCapability",
  "ssh_agent_capability_missing:fileAttachAny": "settings.sshHosts.attachmentDialog.error.fileCapability",
  "ssh_agent_capability_missing:fileAttachCustomRoot": "settings.sshHosts.attachmentDialog.error.customRootCapability",
  ssh_remote_attachment_root_invalid: "settings.sshHosts.attachmentDialog.error.rootInvalid",
  remote_file_root_invalid: "settings.sshHosts.attachmentDialog.error.rootInvalid",
  remote_file_root_unavailable: "settings.sshHosts.attachmentDialog.error.rootUnavailable",
  remote_file_root_not_directory: "settings.sshHosts.attachmentDialog.error.rootUnavailable",
  remote_file_not_directory: "settings.sshHosts.attachmentDialog.error.rootUnavailable",
  remote_file_list_failed: "settings.sshHosts.attachmentDialog.error.listFailed",
  daemon_unavailable: "settings.sshHosts.attachmentDialog.error.connectionFailed",
  ssh_agent_bridge_response_timeout: "settings.sshHosts.attachmentDialog.error.connectionFailed",
  ssh_agent_unreachable: "settings.sshHosts.attachmentDialog.error.connectionFailed",
  attachment_local_file_unavailable: "settings.sshHosts.attachmentDialog.error.localFileUnavailable",
  attachment_local_path_invalid: "settings.sshHosts.attachmentDialog.error.localFileUnavailable",
  attachment_empty: "settings.sshHosts.attachmentDialog.error.fileInvalid",
  attachment_too_large: "settings.sshHosts.attachmentDialog.error.fileTooLarge",
  "ssh_agent_capability_missing:filePut": "settings.sshHosts.attachmentDialog.error.fileCapability",
  "ssh_agent_capability_missing:fileGet": "settings.sshHosts.attachmentDialog.error.downloadCapability",
  "ssh_agent_capability_missing:fileDelete": "settings.sshHosts.attachmentDialog.error.deleteCapability",
  ssh_attachment_root_invalid: "settings.sshHosts.attachmentDialog.error.rootInvalid",
  remote_file_path_invalid: "settings.sshHosts.attachmentDialog.error.rootInvalid",
  remote_file_path_confined: "settings.sshHosts.attachmentDialog.error.rootInvalid",
  remote_file_not_file: "settings.sshHosts.attachmentDialog.error.downloadFailed",
  remote_file_read_failed: "settings.sshHosts.attachmentDialog.error.downloadFailed",
  remote_file_download_too_large: "settings.sshHosts.attachmentDialog.error.fileTooLarge",
  remote_file_download_invalid: "settings.sshHosts.attachmentDialog.error.downloadFailed",
  remote_file_download_write_failed: "settings.sshHosts.attachmentDialog.error.downloadWriteFailed",
  remote_file_not_found: "settings.sshHosts.attachmentDialog.error.remoteNotFound",
  remote_file_directory_not_empty: "settings.sshHosts.attachmentDialog.error.directoryNotEmpty",
  remote_file_delete_failed: "settings.sshHosts.attachmentDialog.error.deleteFailed",
  remote_file_delete_unsupported: "settings.sshHosts.attachmentDialog.error.deleteFailed",
  attachment_target_exists: "settings.sshHosts.attachmentDialog.error.targetExists",
  local_directory_unavailable: "settings.sshHosts.attachmentDialog.error.localDirectoryUnavailable",
};

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function parentRemotePath(path: string): string {
  if (path === "/" || path === "~") return path;
  const index = path.lastIndexOf("/");
  if (index < 0 || index === 0) return "/";
  if (path.startsWith("~/") && index === 1) return "~";
  return path.slice(0, index);
}

function joinRemotePath(parent: string, child: string): string {
  if (parent === "/") return `/${child}`;
  return `${parent.replace(/\/$/u, "")}/${child}`;
}

function isFilesystemRoot(path: string): boolean {
  const normalized = path.trim().replace(/[\\/]+$/u, "");
  return normalized === ""
    || normalized === "/"
    || /^[A-Za-z]:$/u.test(normalized)
    || /^[\\/]{2}[^\\/]+[\\/][^\\/]+$/u.test(normalized);
}

function localEntryPath(parent: string, child: string): string {
  const trimmedParent = parent.replace(/[\\/]+$/u, "");
  const separator = parent.includes("\\") ? "\\" : "/";
  return trimmedParent ? `${trimmedParent}${separator}${child}` : `${separator}${child}`;
}

function localPathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

function statusIcon(status: TransferStatus) {
  if (status === "uploading" || status === "downloading") return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
  if (status === "success") return <CheckCircle2 className="h-4 w-4 text-primary" />;
  if (status === "error") return <CircleAlert className="h-4 w-4 text-danger" />;
  return <File className="h-4 w-4 text-text-muted" />;
}

export function SshHostAttachmentDialog({ open, host, onOpenChange }: Props) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm({ zIndex: 80 });
  const hostId = host?.id ?? "";
  const [context, setContext] = useState<SshRemoteFileContext | null>(null);
  const [rootPath, setRootPath] = useState("");
  const [remotePathDraft, setRemotePathDraft] = useState("");
  const [remoteDirectoryPickerOpen, setRemoteDirectoryPickerOpen] = useState(false);
  const [remotePickerPath, setRemotePickerPath] = useState("");
  const [remotePickerPathDraft, setRemotePickerPathDraft] = useState("");
  const [remotePickerEntries, setRemotePickerEntries] = useState<ProjectFileEntry[]>([]);
  const [remotePickerLoading, setRemotePickerLoading] = useState(false);
  const [remotePickerError, setRemotePickerError] = useState<string | null>(null);
  const [remotePickerRefreshToken, setRemotePickerRefreshToken] = useState(0);
  const [entries, setEntries] = useState<ProjectFileEntry[]>([]);
  const [localPath, setLocalPath] = useState("");
  const [localPathDraft, setLocalPathDraft] = useState("");
  const [localEntries, setLocalEntries] = useState<ProjectFileEntry[]>([]);
  const [queue, setQueue] = useState<TransferItem[]>([]);
  const [initializing, setInitializing] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [localLoading, setLocalLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [localRefreshToken, setLocalRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let activeContext: SshRemoteFileContext | null = null;

    setContext(null);
    setRootPath("");
    setRemotePathDraft("");
    setRemoteDirectoryPickerOpen(false);
    setRemotePickerPath("");
    setRemotePickerPathDraft("");
    setRemotePickerEntries([]);
    setRemotePickerError(null);
    setEntries([]);
    setLocalPath("");
    setLocalPathDraft("");
    setLocalEntries([]);
    setRootError(null);
    setRemoteError(null);
    setLocalError(null);
    setError(null);
    setQueue([]);

    if (!open || !hostId) {
      setInitializing(false);
      return () => undefined;
    }

    setInitializing(true);
    void (async () => {
      try {
        const nextContext = await buildSshRemoteAttachmentContext(hostId);
        activeContext = nextContext;
        if (cancelled) {
          await releaseSshRemoteFileContext(nextContext).catch(() => undefined);
          return;
        }
        setContext(nextContext);
        try {
          const configuredRoot = host?.attachment_root?.trim() ?? "";
          const nextRoot = configuredRoot || await resolveSshRemoteAttachmentRoot(nextContext);
          if (!cancelled) {
            setRootPath(nextRoot);
            setRemotePathDraft(nextRoot);
            setContext({ ...nextContext, rootPath: nextRoot });
          }
        } catch (nextError) {
          if (!cancelled) setRootError(errorCode(nextError));
        }
      } catch (nextError) {
        if (!cancelled) setError(errorCode(nextError));
      } finally {
        if (!cancelled) setInitializing(false);
      }
    })();

    return () => {
      cancelled = true;
      if (activeContext) void releaseSshRemoteFileContext(activeContext).catch(() => undefined);
    };
  }, [hostId, open]);

  useEffect(() => {
    let cancelled = false;

    setLocalPath("");
    setLocalPathDraft("");
    setLocalEntries([]);
    setLocalError(null);

    if (!open || !hostId) {
      setLocalLoading(false);
      return () => undefined;
    }

    setLocalLoading(true);
    void desktopDir()
      .then((nextPath) => {
        if (cancelled) return;
        setLocalPath(nextPath);
        setLocalPathDraft(nextPath);
      })
      .catch(() => {
        if (cancelled) return;
        setLocalError("local_directory_unavailable");
        setLocalLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hostId, open]);

  useEffect(() => {
    if (!context || !rootPath) return undefined;
    let cancelled = false;
    const listContext = { ...context, rootPath };
    setRemoteLoading(true);
    setRemoteError(null);
    void sshRemoteListDir(listContext, "", { silent: true })
      .then((nextEntries) => {
        if (!cancelled) setEntries(nextEntries);
      })
      .catch((nextError) => {
        if (!cancelled) setRemoteError(errorCode(nextError));
      })
      .finally(() => {
        if (!cancelled) setRemoteLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [context, refreshToken, rootPath]);

  useEffect(() => {
    if (!remoteDirectoryPickerOpen || !context || !remotePickerPath) return undefined;
    let cancelled = false;
    setRemotePickerLoading(true);
    setRemotePickerError(null);
    void sshRemoteListDir({ ...context, rootPath: remotePickerPath }, "", { silent: true })
      .then((nextEntries) => {
        if (!cancelled) setRemotePickerEntries(nextEntries.filter((entry) => entry.kind === "directory"));
      })
      .catch((nextError) => {
        if (!cancelled) {
          setRemotePickerEntries([]);
          setRemotePickerError(errorCode(nextError));
        }
      })
      .finally(() => {
        if (!cancelled) setRemotePickerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [context, remoteDirectoryPickerOpen, remotePickerPath, remotePickerRefreshToken]);

  useEffect(() => {
    if (!localPath) return undefined;
    let cancelled = false;
    setLocalLoading(true);
    setLocalError(null);
    void invoke<ProjectFileEntry[]>("file_list_dir", { rootPath: localPath, relativePath: "" })
      .then((nextEntries) => {
        if (!cancelled) setLocalEntries(nextEntries);
      })
      .catch(() => {
        if (!cancelled) {
          setLocalEntries([]);
          setLocalError("local_directory_unavailable");
        }
      })
      .finally(() => {
        if (!cancelled) setLocalLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [localPath, localRefreshToken]);

  const rootLabel = rootPath || host?.attachment_root?.trim() || t("settings.sshHosts.attachmentDialog.defaultRoot");
  const displayedRemotePath = rootPath || rootLabel;
  const pendingCount = useMemo(() => queue.filter((item) => item.direction === "upload" && item.status === "queued").length, [queue]);
  const transferring = uploading || downloading || deletingPath !== null;
  const canUpload = Boolean(hostId && context && rootPath) && !initializing && !transferring && pendingCount > 0;
  const remoteEntries = useMemo(
    () => [...entries].sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory") || left.name.localeCompare(right.name, undefined, { sensitivity: "base" })),
    [entries],
  );
  const localEntriesSorted = useMemo(
    () => [...localEntries].sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory") || left.name.localeCompare(right.name, undefined, { sensitivity: "base" })),
    [localEntries],
  );
  const queuedPathKeys = useMemo(
    () => new Set(queue.filter((item) => item.direction === "upload").map((item) => localPathKey(item.path))),
    [queue],
  );

  const addPathsToQueue = (paths: string[]) => {
    setQueue((current) => {
      const existing = new Set(current.map((item) => item.path));
      const additions = paths
        .filter((path) => !existing.has(path))
        .map((path) => ({
          id: crypto.randomUUID(),
          path,
          name: fileNameFromPath(path),
          direction: "upload" as const,
          status: "queued" as const,
        }));
      return [...current, ...additions];
    });
  };

  const chooseFiles = async () => {
    setError(null);
    const selected = await openFileDialog({
      multiple: true,
      directory: false,
      title: t("settings.sshHosts.attachmentDialog.chooseFiles"),
    });
    const paths = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
    if (paths.length === 0) return;
    addPathsToQueue(paths);
  };

  const chooseLocalDirectory = async () => {
    const selected = await openFileDialog({
      multiple: false,
      directory: true,
      title: t("settings.sshHosts.attachmentDialog.chooseDirectory"),
    });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return;
    setLocalError(null);
    setLocalPath(path);
    setLocalPathDraft(path);
    setLocalRefreshToken((current) => current + 1);
  };

  const goToLocalPath = () => {
    const nextPath = localPathDraft.trim();
    if (!nextPath) {
      setLocalError("local_directory_unavailable");
      return;
    }
    setLocalError(null);
    setLocalPath(nextPath);
    setLocalPathDraft(nextPath);
    setLocalRefreshToken((current) => current + 1);
  };

  const refreshLocal = () => setLocalRefreshToken((current) => current + 1);

  const openLocalDirectory = async (entry: ProjectFileEntry) => {
    if (entry.kind !== "directory" || !localPath) return;
    try {
      const nextPath = await joinLocalPath(localPath, entry.name);
      setLocalPath(nextPath);
      setLocalPathDraft(nextPath);
      setLocalError(null);
    } catch {
      setLocalError("local_directory_unavailable");
    }
  };

  const addLocalFile = async (entry: ProjectFileEntry) => {
    if (entry.kind !== "file" || !localPath || transferring) return;
    try {
      const path = await joinLocalPath(localPath, entry.name);
      addPathsToQueue([path]);
    } catch {
      setLocalError("local_directory_unavailable");
    }
  };

  const goToLocalParent = async () => {
    if (!localPath || isFilesystemRoot(localPath)) return;
    try {
      const nextPath = await localDirname(localPath);
      if (nextPath === localPath) return;
      setLocalPath(nextPath);
      setLocalPathDraft(nextPath);
      setLocalError(null);
    } catch {
      setLocalError("local_directory_unavailable");
    }
  };

  const removeQueueItem = (id: string) => {
    if (transferring) return;
    setQueue((current) => current.filter((item) => item.id !== id));
  };

  const refreshRemote = () => setRefreshToken((current) => current + 1);

  const goToRemotePath = () => {
    const nextPath = remotePathDraft.trim();
    if (!nextPath || !isValidSshAttachmentRoot(nextPath)) {
      setRemoteError("remote_file_root_invalid");
      return;
    }
    setRemoteError(null);
    setRootError(null);
    setRootPath(nextPath);
    setRemotePathDraft(nextPath);
    refreshRemote();
  };

  const openRemoteDirectoryPicker = () => {
    if (!context || !rootPath || initializing || transferring) return;
    setRemotePickerPath(rootPath);
    setRemotePickerPathDraft(rootPath);
    setRemotePickerEntries([]);
    setRemotePickerError(null);
    setRemoteDirectoryPickerOpen(true);
  };

  const goToRemotePickerPath = () => {
    const nextPath = remotePickerPathDraft.trim();
    if (!nextPath || !isValidSshAttachmentRoot(nextPath)) {
      setRemotePickerError("remote_file_root_invalid");
      return;
    }
    setRemotePickerError(null);
    setRemotePickerPath(nextPath);
    setRemotePickerPathDraft(nextPath);
    setRemotePickerRefreshToken((current) => current + 1);
  };

  const openRemotePickerDirectory = (entry: ProjectFileEntry) => {
    if (entry.kind !== "directory" || !remotePickerPath) return;
    const nextPath = joinRemotePath(remotePickerPath, entry.path);
    setRemotePickerPath(nextPath);
    setRemotePickerPathDraft(nextPath);
    setRemotePickerError(null);
  };

  const goToRemotePickerParent = () => {
    const nextPath = parentRemotePath(remotePickerPath);
    if (nextPath === remotePickerPath) return;
    setRemotePickerPath(nextPath);
    setRemotePickerPathDraft(nextPath);
    setRemotePickerError(null);
  };

  const selectRemotePickerPath = () => {
    const nextPath = remotePickerPath.trim();
    if (!nextPath || !isValidSshAttachmentRoot(nextPath) || remotePickerLoading || remotePickerError) return;
    setRootPath(nextPath);
    setRemotePathDraft(nextPath);
    setRemoteError(null);
    setRemoteDirectoryPickerOpen(false);
    refreshRemote();
  };

  const uploadQueuedFiles = async () => {
    if (!canUpload) return;
    setUploading(true);
    setError(null);
    const pending = queue.filter((item) => item.direction === "upload" && item.status === "queued");
    for (const item of pending) {
      setQueue((current) => current.map((candidate) => candidate.id === item.id
        ? { ...candidate, status: "uploading", error: undefined }
        : candidate));
      try {
        const [remotePath] = await sshRemotePutFilesForHost(hostId, rootPath, [{ kind: "localPath", path: item.path }]);
        setQueue((current) => current.map((candidate) => candidate.id === item.id
          ? { ...candidate, status: "success", remotePath }
          : candidate));
        refreshRemote();
      } catch (nextError) {
        setQueue((current) => current.map((candidate) => candidate.id === item.id
          ? { ...candidate, status: "error", error: errorCode(nextError) }
          : candidate));
      }
    }
    setUploading(false);
  };

  const downloadRemoteFile = async (entry: ProjectFileEntry) => {
    if (entry.kind !== "file" || !context || !rootPath || transferring) return;
    const selected = await saveFileDialog({
      title: t("settings.sshHosts.attachmentDialog.downloadFile"),
      defaultPath: entry.name,
    });
    if (!selected) return;
    const id = crypto.randomUUID();
    setQueue((current) => [...current, {
      id,
      path: selected,
      name: entry.name,
      direction: "download",
      status: "downloading",
      remotePath: joinRemotePath(rootPath, entry.path),
    }]);
    setDownloading(true);
    setRemoteError(null);
    try {
      await sshRemoteDownloadFile({ ...context, rootPath }, entry.path, selected);
      setQueue((current) => current.map((candidate) => candidate.id === id
        ? { ...candidate, status: "success" }
        : candidate));
    } catch (nextError) {
      setQueue((current) => current.map((candidate) => candidate.id === id
        ? { ...candidate, status: "error", error: errorCode(nextError) }
        : candidate));
    } finally {
      setDownloading(false);
    }
  };

  const deleteRemoteEntry = async (entry: ProjectFileEntry) => {
    if (!context || !rootPath || transferring) return;
    const confirmed = await confirm({
      title: t("settings.sshHosts.attachmentDialog.confirmDeleteTitle"),
      message: t("settings.sshHosts.attachmentDialog.confirmDeleteMessage", { name: entry.name }),
      confirmText: t("common.delete"),
      cancelText: t("common.cancel"),
      danger: true,
    });
    if (!confirmed) return;
    setDeletingPath(entry.path);
    setRemoteError(null);
    try {
      await sshRemoteDeleteFile({ ...context, rootPath }, entry.path);
      refreshRemote();
    } catch (nextError) {
      setRemoteError(errorCode(nextError));
    } finally {
      setDeletingPath(null);
    }
  };

  const openRemoteDirectory = (entry: ProjectFileEntry) => {
    if (entry.kind !== "directory" || !rootPath) return;
    const nextPath = joinRemotePath(rootPath, entry.path);
    setRootPath(nextPath);
    setRemotePathDraft(nextPath);
    setRemoteError(null);
  };

  const goToParent = () => {
    const nextPath = parentRemotePath(rootPath);
    setRootPath(nextPath);
    setRemotePathDraft(nextPath);
    setRemoteError(null);
  };

  const formatError = (value: string | null): string | null => {
    if (!value) return null;
    const key = ERROR_LABELS[value];
    return key ? t(key) : t("settings.sshHosts.attachmentDialog.error.generic", { code: value });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] w-[min(1100px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4 text-primary" />
            {t("settings.sshHosts.attachmentDialog.title", { name: host?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>
            {t("settings.sshHosts.attachmentDialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5 ui-thin-scroll">
          {(error || rootError) && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning" role="alert">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{formatError(error ?? rootError)}</span>
            </div>
          )}

          <div className="grid min-h-[300px] gap-3 md:grid-cols-2">
            <section className="flex min-h-[300px] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-lowest" aria-label={t("settings.sshHosts.attachmentDialog.localPane")}>
              <div className="h-[108px] shrink-0 flex flex-wrap items-start gap-2 border-b border-border bg-surface-low px-3 py-2.5">
                <FolderOpen className="mt-1 h-4 w-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-text-primary">{t("settings.sshHosts.attachmentDialog.localPane")}</div>
                  <div className="truncate text-[11px] text-text-muted">{t("settings.sshHosts.attachmentDialog.localDescription")}</div>
                  <div className="mt-1 flex min-w-0 items-center gap-1">
                    <input
                      className="ui-input h-7 min-w-0 flex-1 px-2 font-mono text-[11px]"
                      aria-label={t("settings.sshHosts.attachmentDialog.localPath")}
                      placeholder={t("settings.sshHosts.attachmentDialog.localPathPlaceholder")}
                      value={localPathDraft}
                      onChange={(event) => setLocalPathDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          goToLocalPath();
                        }
                      }}
                      disabled={transferring}
                    />
                    <button
                      type="button"
                      className="ui-icon-button h-7 w-7"
                      aria-label={t("settings.sshHosts.attachmentDialog.goToLocalPath")}
                      title={t("settings.sshHosts.attachmentDialog.goToLocalPath")}
                      disabled={!localPathDraft.trim() || transferring || localLoading}
                      onClick={goToLocalPath}
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="ui-icon-button h-7 w-7"
                      aria-label={t("settings.sshHosts.attachmentDialog.parentLocalDirectory")}
                      title={t("settings.sshHosts.attachmentDialog.parentLocalDirectory")}
                      disabled={!localPath || isFilesystemRoot(localPath) || localLoading || transferring}
                      onClick={() => void goToLocalParent()}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className="ui-icon-button h-7 w-7"
                      aria-label={t("settings.sshHosts.attachmentDialog.refreshLocal")}
                      title={t("settings.sshHosts.attachmentDialog.refreshLocal")}
                      disabled={!localPath || localLoading || transferring}
                      onClick={refreshLocal}
                    >
                      <RefreshCw className={`h-4 w-4 ${localLoading ? "animate-spin" : ""}`} />
                    </button>
                  </div>
                  <div className="truncate text-[10px] text-text-muted" title={localPath}>{localPath || t("settings.sshHosts.attachmentDialog.localPathUnavailable")}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    className="ui-icon-button h-8 w-8"
                    aria-label={t("settings.sshHosts.attachmentDialog.chooseDirectory")}
                    title={t("settings.sshHosts.attachmentDialog.chooseDirectory")}
                    disabled={transferring}
                    onClick={() => void chooseLocalDirectory()}
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </button>
                  <Button type="button" size="sm" onClick={() => void chooseFiles()} disabled={transferring}>
                    <Upload className="h-3.5 w-3.5" />
                    {t("settings.sshHosts.attachmentDialog.chooseFiles")}
                  </Button>
                </div>
              </div>
              <div className="h-[360px] shrink-0 overflow-y-auto p-2 ui-thin-scroll" aria-busy={localLoading}>
                {localLoading ? (
                  <div className="flex h-full min-h-36 items-center justify-center gap-2 text-xs text-text-muted"><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}</div>
                ) : localError ? (
                  <div className="flex h-full min-h-36 items-center justify-center px-4 text-center text-xs text-danger">{formatError(localError)}</div>
                ) : localEntriesSorted.length === 0 ? (
                  <div className="flex h-full min-h-36 items-center justify-center px-4 text-center text-xs text-text-muted">{t("settings.sshHosts.attachmentDialog.localDirectoryEmpty")}</div>
                ) : (
                  <div className="space-y-1">
                    {localEntriesSorted.map((entry) => {
                      const selected = entry.kind === "file" && queuedPathKeys.has(localPathKey(localEntryPath(localPath, entry.name)));
                      return (
                        <button
                          key={entry.path}
                          type="button"
                          className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-high disabled:cursor-default ${selected ? "bg-primary/10" : ""}`}
                          disabled={transferring}
                          aria-label={entry.kind === "directory"
                            ? t("settings.sshHosts.attachmentDialog.openLocalDirectory", { name: entry.name })
                            : selected
                              ? t("settings.sshHosts.attachmentDialog.fileSelected", { name: entry.name })
                              : t("settings.sshHosts.attachmentDialog.addLocalFile", { name: entry.name })}
                          aria-pressed={entry.kind === "file" ? selected : undefined}
                          onClick={() => entry.kind === "directory" ? void openLocalDirectory(entry) : void addLocalFile(entry)}
                        >
                          <img
                            src={entry.kind === "directory" ? getMaterialFolderIcon(entry.name, false) : getMaterialFileIcon(entry.name)}
                            alt=""
                            width={16}
                            height={16}
                            className="shrink-0"
                            draggable={false}
                          />
                          <span className="min-w-0 flex-1 truncate text-xs text-text-primary" title={entry.name}>{entry.name}</span>
                          <span className="shrink-0 text-[10px] text-text-muted">{entry.kind === "directory" ? t("settings.sshHosts.attachmentDialog.directory") : formatBytes(entry.sizeBytes)}</span>
                          {selected && <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            <section className="flex min-h-[300px] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-lowest" aria-label={t("settings.sshHosts.attachmentDialog.remotePane")}>
              <div className="h-[108px] shrink-0 flex flex-wrap items-start gap-2 border-b border-border bg-surface-low px-3 py-2.5">
                <Folder className="mt-1 h-4 w-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-text-primary">{t("settings.sshHosts.attachmentDialog.remotePane")}</div>
                  <div className="h-4" aria-hidden="true" />
                  <div className="mt-1 flex min-w-0 items-center gap-1">
                    <input
                      className="ui-input h-7 min-w-0 flex-1 px-2 font-mono text-[11px]"
                      aria-label={t("settings.sshHosts.attachmentDialog.remotePath")}
                      placeholder={t("settings.sshHosts.attachmentDialog.remotePathPlaceholder")}
                      value={remotePathDraft}
                      onChange={(event) => setRemotePathDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          goToRemotePath();
                        }
                      }}
                      disabled={initializing || transferring}
                    />
                    <button
                      type="button"
                      className="ui-icon-button h-7 w-7"
                      aria-label={t("settings.sshHosts.attachmentDialog.goToRemotePath")}
                      title={t("settings.sshHosts.attachmentDialog.goToRemotePath")}
                      disabled={!remotePathDraft.trim() || initializing || transferring || remoteLoading}
                      onClick={goToRemotePath}
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="truncate text-[10px] text-text-muted" title={displayedRemotePath}>{displayedRemotePath}</div>
                  </div>
                <button type="button" className="ui-icon-button h-7 w-7" aria-label={t("settings.sshHosts.attachmentDialog.chooseRemoteDirectory")} title={t("settings.sshHosts.attachmentDialog.chooseRemoteDirectory")} disabled={!rootPath || initializing || remoteLoading || transferring} onClick={openRemoteDirectoryPicker}><FolderOpen className="h-4 w-4" /></button>
                <button type="button" className="ui-icon-button h-7 w-7" aria-label={t("settings.sshHosts.attachmentDialog.parentDirectory")} title={t("settings.sshHosts.attachmentDialog.parentDirectory")} disabled={!rootPath || rootPath === "/" || rootPath === "~" || remoteLoading || transferring} onClick={goToParent}><ChevronLeft className="h-4 w-4" /></button>
                <button type="button" className="ui-icon-button h-7 w-7" aria-label={t("settings.sshHosts.attachmentDialog.refreshRemote")} title={t("settings.sshHosts.attachmentDialog.refreshRemote")} disabled={!rootPath || remoteLoading || transferring} onClick={refreshRemote}><RefreshCw className={`h-4 w-4 ${remoteLoading ? "animate-spin" : ""}`} /></button>
              </div>
              <div className="h-[360px] shrink-0 overflow-y-auto p-2 ui-thin-scroll" aria-busy={initializing || remoteLoading}>
                {initializing || remoteLoading ? (
                  <div className="flex h-full min-h-36 items-center justify-center gap-2 text-xs text-text-muted"><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}</div>
                ) : rootError && !rootPath ? (
                  <div className="flex h-full min-h-36 items-center justify-center px-4 text-center text-xs text-text-muted">{formatError(rootError)}</div>
                ) : remoteError ? (
                  <div className="flex h-full min-h-36 items-center justify-center px-4 text-center text-xs text-danger">{formatError(remoteError)}</div>
                ) : remoteEntries.length === 0 ? (
                  <div className="flex h-full min-h-36 items-center justify-center px-4 text-center text-xs text-text-muted">{t("settings.sshHosts.attachmentDialog.remoteEmpty")}</div>
                ) : (
                  <div className="space-y-1">
                    {remoteEntries.map((entry) => (
                      <div key={entry.path} className="flex w-full items-center gap-1 rounded-lg hover:bg-surface-high">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left disabled:cursor-default"
                          disabled={entry.kind !== "directory" || transferring}
                          aria-label={entry.kind === "directory"
                            ? t("settings.sshHosts.attachmentDialog.openRemoteDirectory", { name: entry.name })
                            : t("settings.sshHosts.attachmentDialog.remoteFile", { name: entry.name })}
                          onClick={() => openRemoteDirectory(entry)}
                        >
                          <img
                            src={entry.kind === "directory" ? getMaterialFolderIcon(entry.name, false) : getMaterialFileIcon(entry.name)}
                            alt=""
                            width={16}
                            height={16}
                            className="shrink-0"
                            draggable={false}
                          />
                          <span className="min-w-0 flex-1 truncate text-xs text-text-primary" title={entry.name}>{entry.name}</span>
                          <span className="shrink-0 text-[10px] text-text-muted">{entry.kind === "directory" ? t("settings.sshHosts.attachmentDialog.directory") : formatBytes(entry.sizeBytes)}</span>
                        </button>
                        <div className="flex shrink-0 items-center gap-0.5 pr-1">
                          {entry.kind === "file" && (
                            <button
                              type="button"
                              className="ui-icon-button h-7 w-7 text-text-muted"
                              aria-label={t("settings.sshHosts.attachmentDialog.downloadRemoteFile", { name: entry.name })}
                              title={t("settings.sshHosts.attachmentDialog.downloadRemoteFile", { name: entry.name })}
                              disabled={transferring}
                              onClick={() => void downloadRemoteFile(entry)}
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            className="ui-icon-button h-7 w-7 text-text-muted hover:text-danger"
                            aria-label={t("settings.sshHosts.attachmentDialog.deleteRemoteFile", { name: entry.name })}
                            title={t("settings.sshHosts.attachmentDialog.deleteRemoteFile", { name: entry.name })}
                            disabled={transferring}
                            onClick={() => void deleteRemoteEntry(entry)}
                          >
                            {deletingPath === entry.path
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Trash2 className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>

          <section className="overflow-hidden rounded-xl border border-border bg-surface-lowest" aria-label={t("settings.sshHosts.attachmentDialog.queueTitle")}>
            <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-low px-3 py-2.5">
              <div className="flex items-center gap-2"><Upload className="h-4 w-4 text-primary" /><span className="text-sm font-semibold text-text-primary">{t("settings.sshHosts.attachmentDialog.queueTitle")}</span></div>
              <span className="text-xs text-text-muted">{t("settings.sshHosts.attachmentDialog.queueCount", { count: queue.length })}</span>
            </div>
            {queue.length === 0 ? (
              <div className="px-3 py-5 text-center text-xs text-text-muted">{t("settings.sshHosts.attachmentDialog.queueEmpty")}</div>
            ) : (
              <div className="max-h-44 overflow-y-auto p-2 ui-thin-scroll">
                {queue.map((item) => (
                  <div key={item.id} className="flex items-center gap-2 border-b border-border/60 px-2 py-2 last:border-b-0">
                    {statusIcon(item.status)}
                    <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{item.name}</span>
                    <span className={item.status === "error" ? "text-[10px] text-danger" : "text-[10px] text-text-muted"}>
                      {item.status === "error" ? formatError(item.error ?? "") : t(`settings.sshHosts.attachmentDialog.status.${item.status}` as const)}
                    </span>
                    {item.remotePath && <span className="max-w-[38%] truncate text-[10px] text-text-muted" title={item.remotePath}>{item.remotePath}</span>}
                    {item.status === "queued" && <button type="button" className="ui-icon-button h-7 w-7 text-text-muted" aria-label={t("settings.sshHosts.attachmentDialog.removeFile")} title={t("settings.sshHosts.attachmentDialog.removeFile")} onClick={() => removeQueueItem(item.id)}><Trash2 className="h-3.5 w-3.5" /></button>}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-3">
          <div className="mr-auto min-w-0 truncate text-[11px] text-text-muted" title={rootLabel}>{t("settings.sshHosts.attachmentDialog.target", { path: rootLabel })}</div>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("common.close")}</Button>
          <Button type="button" onClick={() => void uploadQueuedFiles()} disabled={!canUpload}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {uploading ? t("settings.sshHosts.attachmentDialog.uploading") : t("settings.sshHosts.attachmentDialog.upload")}
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>
      <Dialog open={remoteDirectoryPickerOpen && open} onOpenChange={setRemoteDirectoryPickerOpen}>
        <DialogContent
          className="z-[60] flex max-h-[calc(100vh-2rem)] w-[min(620px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden p-0"
          overlayClassName="z-[60]"
        >
          <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
            <DialogTitle className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4 text-primary" />
              {t("settings.sshHosts.attachmentDialog.remoteDirectoryPicker")}
            </DialogTitle>
            <DialogDescription>
              {t("settings.sshHosts.attachmentDialog.remoteDirectoryPickerDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 p-5">
            <div className="flex min-w-0 items-center gap-1">
              <input
                className="ui-input h-8 min-w-0 flex-1 px-2 font-mono text-xs"
                aria-label={t("settings.sshHosts.attachmentDialog.remotePath")}
                value={remotePickerPathDraft}
                onChange={(event) => setRemotePickerPathDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    goToRemotePickerPath();
                  }
                }}
                disabled={remotePickerLoading || transferring}
              />
              <button
                type="button"
                className="ui-icon-button h-8 w-8"
                aria-label={t("settings.sshHosts.attachmentDialog.goToRemotePath")}
                title={t("settings.sshHosts.attachmentDialog.goToRemotePath")}
                disabled={!remotePickerPathDraft.trim() || remotePickerLoading || transferring}
                onClick={goToRemotePickerPath}
              >
                <ArrowRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="ui-icon-button h-8 w-8"
                aria-label={t("settings.sshHosts.attachmentDialog.parentDirectory")}
                title={t("settings.sshHosts.attachmentDialog.parentDirectory")}
                disabled={!remotePickerPath || remotePickerPath === "/" || remotePickerPath === "~" || remotePickerLoading || transferring}
                onClick={goToRemotePickerParent}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="ui-icon-button h-8 w-8"
                aria-label={t("settings.sshHosts.attachmentDialog.refreshRemote")}
                title={t("settings.sshHosts.attachmentDialog.refreshRemote")}
                disabled={!remotePickerPath || remotePickerLoading || transferring}
                onClick={() => setRemotePickerRefreshToken((current) => current + 1)}
              >
                <RefreshCw className={`h-4 w-4 ${remotePickerLoading ? "animate-spin" : ""}`} />
              </button>
            </div>
            <div className="truncate text-[10px] text-text-muted" title={remotePickerPath}>{remotePickerPath}</div>
            <div className="h-[300px] overflow-y-auto rounded-xl border border-border p-2 ui-thin-scroll" aria-busy={remotePickerLoading}>
              {remotePickerLoading ? (
                <div className="flex h-full min-h-36 items-center justify-center gap-2 text-xs text-text-muted"><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading")}</div>
              ) : remotePickerError ? (
                <div className="flex h-full min-h-36 items-center justify-center px-4 text-center text-xs text-danger">{formatError(remotePickerError)}</div>
              ) : remotePickerEntries.length === 0 ? (
                <div className="flex h-full min-h-36 items-center justify-center px-4 text-center text-xs text-text-muted">{t("settings.sshHosts.attachmentDialog.remoteDirectoriesEmpty")}</div>
              ) : (
                <div className="space-y-1">
                  {remotePickerEntries.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-high"
                      disabled={transferring}
                      aria-label={t("settings.sshHosts.attachmentDialog.openRemoteDirectory", { name: entry.name })}
                      onClick={() => openRemotePickerDirectory(entry)}
                    >
                      <img
                        src={getMaterialFolderIcon(entry.name, false)}
                        alt=""
                        width={16}
                        height={16}
                        className="shrink-0"
                        draggable={false}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs text-text-primary" title={entry.name}>{entry.name}</span>
                      <span className="shrink-0 text-[10px] text-text-muted">{t("settings.sshHosts.attachmentDialog.directory")}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter className="shrink-0 border-t border-border px-5 py-3">
            <Button type="button" variant="outline" onClick={() => setRemoteDirectoryPickerOpen(false)}>{t("common.cancel")}</Button>
            <Button type="button" onClick={selectRemotePickerPath} disabled={!remotePickerPath || remotePickerLoading || Boolean(remotePickerError) || transferring}>
              <FolderOpen className="h-4 w-4" />
              {t("settings.sshHosts.attachmentDialog.selectRemoteDirectory")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </>
  );
}
