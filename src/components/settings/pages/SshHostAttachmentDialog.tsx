import { useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
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

interface Props {
  open: boolean;
  host: SshHost | null;
  onOpenChange: (open: boolean) => void;
}

type TransferStatus = "queued" | "uploading" | "success" | "error";

interface TransferItem {
  id: string;
  path: string;
  name: string;
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
  ssh_attachment_root_invalid: "settings.sshHosts.attachmentDialog.error.rootInvalid",
  remote_file_path_invalid: "settings.sshHosts.attachmentDialog.error.rootInvalid",
  attachment_target_exists: "settings.sshHosts.attachmentDialog.error.targetExists",
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

function statusIcon(status: TransferStatus) {
  if (status === "uploading") return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
  if (status === "success") return <CheckCircle2 className="h-4 w-4 text-primary" />;
  if (status === "error") return <CircleAlert className="h-4 w-4 text-danger" />;
  return <File className="h-4 w-4 text-text-muted" />;
}

export function SshHostAttachmentDialog({ open, host, onOpenChange }: Props) {
  const { t } = useI18n();
  const hostId = host?.id ?? "";
  const [context, setContext] = useState<SshRemoteFileContext | null>(null);
  const [rootPath, setRootPath] = useState("");
  const [remotePathDraft, setRemotePathDraft] = useState("");
  const [entries, setEntries] = useState<ProjectFileEntry[]>([]);
  const [queue, setQueue] = useState<TransferItem[]>([]);
  const [initializing, setInitializing] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let activeContext: SshRemoteFileContext | null = null;

    setContext(null);
    setRootPath("");
    setRemotePathDraft("");
    setEntries([]);
    setRootError(null);
    setRemoteError(null);
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

  const rootLabel = rootPath || host?.attachment_root?.trim() || t("settings.sshHosts.attachmentDialog.defaultRoot");
  const displayedRemotePath = rootPath || rootLabel;
  const pendingCount = useMemo(() => queue.filter((item) => item.status === "queued").length, [queue]);
  const canUpload = Boolean(hostId && context && rootPath) && !initializing && !uploading && pendingCount > 0;
  const remoteEntries = useMemo(
    () => [...entries].sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory") || left.name.localeCompare(right.name, undefined, { sensitivity: "base" })),
    [entries],
  );

  const chooseFiles = async () => {
    setError(null);
    const selected = await openFileDialog({
      multiple: true,
      directory: false,
      title: t("settings.sshHosts.attachmentDialog.chooseFiles"),
    });
    const paths = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
    if (paths.length === 0) return;
    setQueue((current) => {
      const existing = new Set(current.map((item) => item.path));
      const additions = paths
        .filter((path) => !existing.has(path))
        .map((path) => ({
          id: crypto.randomUUID(),
          path,
          name: fileNameFromPath(path),
          status: "queued" as const,
        }));
      return [...current, ...additions];
    });
  };

  const removeQueueItem = (id: string) => {
    if (uploading) return;
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

  const uploadQueuedFiles = async () => {
    if (!canUpload) return;
    setUploading(true);
    setError(null);
    const pending = queue.filter((item) => item.status === "queued");
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
              <div className="flex items-center gap-2 border-b border-border bg-surface-low px-3 py-2.5">
                <FolderOpen className="h-4 w-4 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-text-primary">{t("settings.sshHosts.attachmentDialog.localPane")}</div>
                  <div className="truncate text-[11px] text-text-muted">{t("settings.sshHosts.attachmentDialog.localDescription")}</div>
                </div>
                <Button type="button" size="sm" onClick={() => void chooseFiles()} disabled={uploading}>
                  <Upload className="h-3.5 w-3.5" />
                  {t("settings.sshHosts.attachmentDialog.chooseFiles")}
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2 ui-thin-scroll">
                {queue.length === 0 ? (
                  <div className="flex h-full min-h-36 flex-col items-center justify-center gap-2 text-center text-xs text-text-muted">
                    <File className="h-7 w-7 opacity-50" />
                    <span>{t("settings.sshHosts.attachmentDialog.localEmpty")}</span>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {queue.map((item) => (
                      <div key={item.id} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-surface-high">
                        <File className="h-4 w-4 shrink-0 text-text-muted" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs text-text-primary" title={item.path}>{item.name}</div>
                          <div className="truncate text-[10px] text-text-muted" title={item.path}>{item.path}</div>
                        </div>
                        {item.status === "queued" && <button type="button" className="ui-icon-button h-7 w-7 text-text-muted" aria-label={t("settings.sshHosts.attachmentDialog.removeFile")} title={t("settings.sshHosts.attachmentDialog.removeFile")} onClick={() => removeQueueItem(item.id)}><Trash2 className="h-3.5 w-3.5" /></button>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="flex min-h-[300px] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-lowest" aria-label={t("settings.sshHosts.attachmentDialog.remotePane")}>
              <div className="flex items-center gap-2 border-b border-border bg-surface-low px-3 py-2.5">
                <Folder className="h-4 w-4 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-text-primary">{t("settings.sshHosts.attachmentDialog.remotePane")}</div>
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
                      disabled={initializing || uploading}
                    />
                    <button
                      type="button"
                      className="ui-icon-button h-7 w-7"
                      aria-label={t("settings.sshHosts.attachmentDialog.goToRemotePath")}
                      title={t("settings.sshHosts.attachmentDialog.goToRemotePath")}
                      disabled={!remotePathDraft.trim() || initializing || uploading || remoteLoading}
                      onClick={goToRemotePath}
                    >
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="truncate text-[10px] text-text-muted" title={displayedRemotePath}>{displayedRemotePath}</div>
                </div>
                <button type="button" className="ui-icon-button h-7 w-7" aria-label={t("settings.sshHosts.attachmentDialog.parentDirectory")} title={t("settings.sshHosts.attachmentDialog.parentDirectory")} disabled={!rootPath || rootPath === "/" || rootPath === "~" || remoteLoading || uploading} onClick={goToParent}><ChevronLeft className="h-4 w-4" /></button>
                <button type="button" className="ui-icon-button h-7 w-7" aria-label={t("settings.sshHosts.attachmentDialog.refreshRemote")} title={t("settings.sshHosts.attachmentDialog.refreshRemote")} disabled={!rootPath || remoteLoading || uploading} onClick={refreshRemote}><RefreshCw className={`h-4 w-4 ${remoteLoading ? "animate-spin" : ""}`} /></button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2 ui-thin-scroll" aria-busy={initializing || remoteLoading}>
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
                      <button key={entry.path} type="button" className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-surface-high disabled:cursor-default" disabled={entry.kind !== "directory"} onClick={() => openRemoteDirectory(entry)}>
                        {entry.kind === "directory" ? <Folder className="h-4 w-4 shrink-0 text-primary" /> : <File className="h-4 w-4 shrink-0 text-text-muted" />}
                        <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{entry.name}</span>
                        <span className="shrink-0 text-[10px] text-text-muted">{entry.kind === "directory" ? t("settings.sshHosts.attachmentDialog.directory") : formatBytes(entry.sizeBytes)}</span>
                      </button>
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
  );
}
