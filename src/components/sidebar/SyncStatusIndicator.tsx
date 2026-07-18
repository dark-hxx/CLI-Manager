import { useShallow } from "zustand/shallow";
import { useSyncStore } from "../../stores/syncStore";
import { Cloud } from "../icons";
import type { SettingsTab } from "../SettingsModal";
import { useI18n } from "../../lib/i18n";

interface SyncStatusIndicatorProps {
  collapsed?: boolean;
  onOpenSettings?: (tab?: SettingsTab) => void;
}

export function SyncStatusIndicator({ collapsed, onOpenSettings }: SyncStatusIndicatorProps) {
  const { language, t } = useI18n();
  // 常驻侧边栏组件：只订阅展示所需字段，避免 syncStore 其他变化触发重渲染。
  const { status, lastBackupAt, hasPassword, backupMode, localBackupDir } = useSyncStore(
    useShallow((s) => ({
      status: s.status,
      lastBackupAt: s.lastBackupAt,
      hasPassword: s.hasPassword,
      backupMode: s.backupMode,
      localBackupDir: s.localBackupDir,
    }))
  );
  const configured = backupMode === "local" ? Boolean(localBackupDir) : hasPassword;

  const openSyncSettings = () => onOpenSettings?.("sync");

  const getStatusColor = () => {
    if (!configured) return "text-on-surface-variant opacity-60";
    switch (status) {
      case "backing_up":
      case "restoring":
      case "queued":
        return "text-yellow-500";
      case "success":
        return "text-success";
      case "error":
        return "text-error";
      default:
        return "text-on-surface-variant";
    }
  };

  const getStatusText = () => {
    if (!configured) return t("sidebar.sync.notConfigured");
    switch (status) {
      case "backing_up":
      case "restoring":
        return t("sidebar.sync.syncing");
      case "queued":
        return t("sidebar.sync.queued");
      case "success":
        return t("sidebar.sync.success");
      case "error":
        return t("sidebar.sync.error");
      default:
        return lastBackupAt
          ? new Date(lastBackupAt).toLocaleTimeString(language, {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })
          : "--";
    }
  };

  if (collapsed) {
    return (
      <button
        onClick={openSyncSettings}
        className={`ui-focus-ring ui-icon-action ${getStatusColor()}`}
        title={configured ? t("sidebar.sync.configuredTitle", { status: getStatusText() }) : t("sidebar.sync.unconfiguredTitle")}
        aria-label={configured ? t("sidebar.sync.openSettings") : t("sidebar.sync.configure")}
      >
        <Cloud size={14} strokeWidth={1.5} />
      </button>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <button
        onClick={openSyncSettings}
        className={`ui-sidebar-sync-link ${getStatusColor()}`}
        title={configured ? t("sidebar.sync.openTitle") : t("sidebar.sync.configureTitle")}
        aria-label={configured ? t("sidebar.sync.openSettings") : t("sidebar.sync.configure")}
      >
        <Cloud size={12} strokeWidth={1.5} />
        <span className="text-xs">{getStatusText()}</span>
      </button>
    </div>
  );
}
