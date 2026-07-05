import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Folder, Trash2 } from "../icons";
import { VendorIcon, inferVendor } from "../VendorIcon";
import { ConfirmDialog } from "../ConfirmDialog";
import { useExternalSessionSyncStore } from "../../stores/externalSessionSyncStore";
import { useProjectStore } from "../../stores/projectStore";
import { useTerminalStore } from "../../stores/terminalStore";
import {
  formatRelativeTime,
  groupSyncedExternalSessions,
  sourceLabel,
  sourceTool,
  type SyncedHistoryGroup,
} from "../../lib/externalSessionGrouping";

export function SyncedHistoryList({ fillAvailable = false }: { fillAvailable?: boolean }) {
  const sessions = useExternalSessionSyncStore((state) => state.syncedSessions);
  const removeSyncedSessions = useExternalSessionSyncStore((state) => state.removeSyncedSessions);
  const projects = useProjectStore((state) => state.projects);
  const openSyncedHistoryPane = useTerminalStore((state) => state.openSyncedHistoryPane);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [deletingKeys, setDeletingKeys] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<SyncedHistoryGroup | null>(null);
  const visibleSessions = useMemo(
    () => sessions.filter((session) => !deletingKeys.has(session.key)),
    [deletingKeys, sessions]
  );
  const groups = useMemo(
    () => groupSyncedExternalSessions(visibleSessions, projects).orphanGroups,
    [visibleSessions, projects]
  );

  if (groups.length === 0) return null;

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const openGroup = async (group: SyncedHistoryGroup) => {
    try {
      await openSyncedHistoryPane(group);
    } catch (err) {
      toast.error("打开同步记录失败", { description: String(err) });
    }
  };

  const confirmDeleteGroup = async () => {
    if (!deleteTarget) return;
    const keys = deleteTarget.sessions.map((session) => session.key);
    setDeleteTarget(null);
    setDeletingKeys((prev) => new Set([...prev, ...keys]));
    try {
      await removeSyncedSessions(keys);
      toast.success("同步项目已删除");
    } catch (err) {
      setDeletingKeys((prev) => {
        const next = new Set(prev);
        keys.forEach((key) => next.delete(key));
        return next;
      });
      toast.error("删除同步项目失败", { description: String(err) });
    }
  };

  return (
    <div className="ui-synced-history" data-fill={fillAvailable ? "true" : "false"} aria-label="同步会话">
      {groups.map((group) => {
        const collapsed = collapsedGroups.has(group.key);
        return (
          <div key={group.key} className="ui-synced-history-group">
            <div className="ui-synced-history-project">
              <button
                type="button"
                className="ui-synced-history-project-main ui-focus-ring"
                title={group.cwd}
                onClick={() => toggleGroup(group.key)}
              >
                <span className="ui-synced-history-chevron">
                  {collapsed ? <ChevronRight size={13} strokeWidth={1.8} /> : <ChevronDown size={13} strokeWidth={1.8} />}
                </span>
                <Folder size={15} strokeWidth={1.6} className="ui-synced-history-folder" />
                <span className="ui-synced-history-project-name">{group.name}</span>
                <span className="ui-synced-history-count">{group.sessions.length}</span>
              </button>
              <button
                type="button"
                className="ui-synced-history-delete ui-focus-ring"
                title="删除同步项目"
                aria-label={`删除同步项目 ${group.name}`}
                onClick={() => {
                  setDeleteTarget(group);
                }}
              >
                <Trash2 size={14} strokeWidth={1.8} />
              </button>
            </div>

            {!collapsed && (
              <div className="ui-synced-history-sessions">
                {(() => {
                  const session = group.sessions[0];
                  const vendor = inferVendor(sourceTool(session.source));
                  const sessionCount = group.sessions.length;
                  return (
                    <button
                      key={group.key}
                      type="button"
                      className="ui-synced-history-session ui-focus-ring"
                      title={`${sourceLabel(session.source)}: ${session.title}`}
                      onClick={() => {
                        void openGroup(group);
                      }}
                    >
                      <span className="ui-synced-history-vendor">
                        <VendorIcon vendor={vendor} size={16} />
                      </span>
                      <span className="ui-synced-history-title">
                        {sourceLabel(session.source)} 同步记录{sessionCount > 1 ? ` · ${sessionCount} 个会话` : ""}
                      </span>
                      <span className="ui-synced-history-time">{formatRelativeTime(session.updatedAt)}</span>
                    </button>
                  );
                })()}
              </div>
            )}
          </div>
        );
      })}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`删除同步项目“${deleteTarget?.name ?? ""}”？`}
        message="这只会从侧边栏移除记录，不会删除原始聊天文件。"
        confirmText="删除"
        cancelText="取消"
        danger
        onConfirm={() => {
          void confirmDeleteGroup();
        }}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
