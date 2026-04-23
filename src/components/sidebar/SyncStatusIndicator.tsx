import { useSyncStore } from "../../stores/syncStore";
import { Cloud, Upload, Download } from "../icons";

interface SyncStatusIndicatorProps {
  collapsed?: boolean;
  onOpenSettings?: () => void;
}

export function SyncStatusIndicator({ collapsed, onOpenSettings }: SyncStatusIndicatorProps) {
  const { status, lastSyncAt, hasPassword, upload, download } = useSyncStore();

  const getStatusColor = () => {
    if (!hasPassword) return "text-on-surface-variant opacity-60";
    switch (status) {
      case "syncing":
        return "text-yellow-500";
      case "success":
        return "text-success";
      case "error":
        return "text-error";
      case "conflict":
        return "text-yellow-500";
      default:
        return "text-on-surface-variant";
    }
  };

  const getStatusText = () => {
    if (!hasPassword) return "未配置";
    switch (status) {
      case "syncing":
        return "同步中...";
      case "success":
        return "已同步";
      case "error":
        return "同步失败";
      case "conflict":
        return "冲突";
      default:
        return lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "--";
    }
  };

  const handleUpload = async () => {
    if (!hasPassword) {
      onOpenSettings?.();
      return;
    }
    await upload();
  };

  const handleDownload = async () => {
    if (!hasPassword) {
      onOpenSettings?.();
      return;
    }
    await download();
  };

  if (collapsed) {
    return (
      <button
        onClick={handleUpload}
        disabled={hasPassword && status === "syncing"}
        className={`ui-focus-ring ui-icon-action ${getStatusColor()}`}
        title={hasPassword ? `云同步: ${getStatusText()} (点击上传)` : "云同步未配置 (点击设置)"}
        aria-label={hasPassword ? "上传配置到云端" : "配置云同步"}
      >
        <Cloud size={14} strokeWidth={1.5} />
      </button>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <button
        onClick={onOpenSettings}
        className={`ui-sidebar-sync-link ${getStatusColor()}`}
        title={hasPassword ? undefined : "点击配置云同步"}
        aria-label={hasPassword ? undefined : "配置云同步"}
      >
        <Cloud size={12} strokeWidth={1.5} />
        <span className="text-xs">{getStatusText()}</span>
      </button>
      <div className="ui-sidebar-sync-actions">
        <button
          onClick={handleUpload}
          disabled={hasPassword && status === "syncing"}
          className="ui-focus-ring rounded p-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-50"
          title={hasPassword ? "上传到云端" : "点击配置云同步"}
          aria-label={hasPassword ? "上传配置到云端" : "配置云同步"}
        >
          <Upload size={12} strokeWidth={1.5} />
        </button>
        <button
          onClick={handleDownload}
          disabled={hasPassword && status === "syncing"}
          className="ui-focus-ring rounded p-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-50"
          title={hasPassword ? "从云端下载" : "点击配置云同步"}
          aria-label={hasPassword ? "从云端下载配置" : "配置云同步"}
        >
          <Download size={12} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}