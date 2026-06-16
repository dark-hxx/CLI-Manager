import { useEffect } from "react";
import { RefreshCw, GitBranch } from "lucide-react";
import { useGitStore } from "../../stores/gitStore";
import { GitChangesTree } from "./GitChangesTree";
import { TERM, EmptyHint } from "../stats/termStatsUi";

interface GitChangesPanelProps {
  open: boolean;
  projectPath: string | null;
}

export function GitChangesPanel({ open, projectPath }: GitChangesPanelProps) {
  const { fetchChanges, reset, changes, loading } = useGitStore();

  useEffect(() => {
    if (open && projectPath) {
      fetchChanges(projectPath);
    } else if (!open) {
      reset();
    }
  }, [open, projectPath, fetchChanges, reset]);

  if (!open) return null;

  const handleRefresh = () => {
    if (projectPath) {
      fetchChanges(projectPath);
    }
  };

  const addedCount = changes.filter((c) => c.status === "A" || c.status === "U").length;
  const deletedCount = changes.filter((c) => c.status === "D").length;
  const modifiedCount = changes.filter((c) => c.status === "M").length;

  return (
    <aside
      className="flex w-[290px] shrink-0 flex-col border-l border-border overflow-hidden font-mono"
      style={{ backgroundColor: TERM.bg }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b" style={{ borderColor: TERM.dim }}>
        <span className="flex items-center gap-2 text-[11px] font-bold" style={{ color: TERM.fg }}>
          <GitBranch size={12} strokeWidth={2} />
          Git 变更
        </span>
        <button
          onClick={handleRefresh}
          className={`ui-focus-ring rounded p-0.5 ${loading ? "animate-spin" : ""}`}
          style={{ color: TERM.cyan }}
          title="刷新"
          aria-label="刷新 Git 变更"
        >
          <RefreshCw size={11} />
        </button>
      </div>

      {/* Summary */}
      {changes.length > 0 && (
        <div className="shrink-0 px-2 py-1.5 text-[10px] border-b" style={{ borderColor: TERM.dim, color: TERM.dim }}>
          <span style={{ color: TERM.fg }}>{changes.length}</span> 个文件
          {modifiedCount > 0 && (
            <>
              {" · "}
              <span style={{ color: "#ff9e64" }}>{modifiedCount}</span> 修改
            </>
          )}
          {addedCount > 0 && (
            <>
              {" · "}
              <span style={{ color: TERM.green }}>{addedCount}</span> 新增
            </>
          )}
          {deletedCount > 0 && (
            <>
              {" · "}
              <span style={{ color: TERM.red }}>{deletedCount}</span> 删除
            </>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-2">
        {!projectPath ? (
          <EmptyHint text="当前终端未关联项目" />
        ) : loading && changes.length === 0 ? (
          <EmptyHint text="加载中…" />
        ) : changes.length === 0 ? (
          <EmptyHint text="无文件变更" />
        ) : (
          <GitChangesTree />
        )}
      </div>
    </aside>
  );
}
