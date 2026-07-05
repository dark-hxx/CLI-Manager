import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Check, RefreshCw } from "./icons";
import { useExternalSessionSyncStore, type ExternalSessionProjectCandidate } from "../stores/externalSessionSyncStore";
import type { HistorySource } from "../lib/types";

function sourceLabel(source: HistorySource): string {
  return source === "codex" ? "Codex" : "Claude";
}

function formatRelativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Math.max(0, Date.now() - ms);
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;
  const week = day * 7;
  const month = day * 30;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟前`;
  if (diff < day) return `${Math.max(1, Math.floor(diff / hour))} 小时前`;
  if (diff < week) return `${Math.max(1, Math.floor(diff / day))} 天前`;
  if (diff < month) return `${Math.max(1, Math.floor(diff / week))} 周前`;
  return `${Math.max(1, Math.floor(diff / month))} 个月前`;
}

function ProjectRow({
  project,
  checked,
  disabled,
  onToggle,
}: {
  project: ExternalSessionProjectCandidate;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const latestTitle = project.sessions[0]?.title ?? project.name;
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-surface-container-highest/70">
      <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          className="peer h-5 w-5 appearance-none rounded border border-border bg-surface-container-lowest transition-colors checked:border-[var(--color-primary)] checked:bg-[var(--color-primary)] disabled:opacity-60"
          aria-label={`同步 ${project.name}`}
        />
        <Check
          size={13}
          strokeWidth={2.4}
          className="pointer-events-none absolute text-white opacity-0 transition-opacity peer-checked:opacity-100"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-on-surface">{project.name}</span>
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-on-surface-variant ring-1 ring-border/70">
            {sourceLabel(project.source)}
          </span>
          <span className="shrink-0 text-xs text-on-surface-variant">{project.sessionCount} 条</span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-on-surface-variant" title={project.cwd}>
          {project.cwd}
        </span>
        <span className="mt-0.5 block truncate text-xs text-on-surface-variant/80" title={latestTitle}>
          {latestTitle}
        </span>
      </span>
      <span className="shrink-0 text-xs text-on-surface-variant">{formatRelativeTime(project.updatedAt)}</span>
    </label>
  );
}

export function ExternalSessionSyncDialog() {
  const open = useExternalSessionSyncStore((state) => state.dialogOpen);
  const mode = useExternalSessionSyncStore((state) => state.dialogMode);
  const candidates = useExternalSessionSyncStore((state) => state.projectCandidates);
  const scanning = useExternalSessionSyncStore((state) => state.scanningProjects);
  const syncing = useExternalSessionSyncStore((state) => state.syncingProjects);
  const closeProjectDialog = useExternalSessionSyncStore((state) => state.closeProjectDialog);
  const syncProjectCandidates = useExternalSessionSyncStore((state) => state.syncProjectCandidates);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setSelectedKeys(new Set(candidates.map((candidate) => candidate.key)));
  }, [candidates, open]);

  const groups = useMemo(() => ({
    codex: candidates.filter((candidate) => candidate.source === "codex"),
    claude: candidates.filter((candidate) => candidate.source === "claude"),
  }), [candidates]);
  const selectedCount = selectedKeys.size;
  const totalSessionCount = candidates
    .filter((candidate) => selectedKeys.has(candidate.key))
    .reduce((sum, candidate) => sum + candidate.sessionCount, 0);
  const disabled = scanning || syncing;

  const toggleProject = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => setSelectedKeys(new Set(candidates.map((candidate) => candidate.key)));
  const clearAll = () => setSelectedKeys(new Set());

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !disabled) void closeProjectDialog();
      }}
    >
      <DialogContent className="max-w-[680px] p-0" showCloseButton={!disabled}>
        <div className="border-b border-border/70 px-5 py-4">
          <DialogTitle>同步 Codex / Claude 历史</DialogTitle>
          <DialogDescription className="mt-1">
            {mode === "initial"
              ? "首次检测到本机历史项目，默认全选。"
              : "选择要同步到左侧项目列表的历史项目。"}
          </DialogDescription>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
          <div className="text-sm text-on-surface-variant">
            已选择 {selectedCount} 个项目，{totalSessionCount} 条记录
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={disabled || candidates.length === 0} onClick={selectAll}>
              全选
            </Button>
            <Button variant="ghost" size="sm" disabled={disabled || candidates.length === 0} onClick={clearAll}>
              清空
            </Button>
          </div>
        </div>

        <div className="max-h-[440px] overflow-y-auto px-3 py-3">
          {scanning ? (
            <div className="flex min-h-[180px] items-center justify-center gap-2 text-sm text-on-surface-variant">
              <RefreshCw size={15} className="animate-spin" />
              正在扫描 Codex / Claude 历史...
            </div>
          ) : candidates.length === 0 ? (
            <div className="flex min-h-[180px] items-center justify-center text-sm text-on-surface-variant">
              没有找到可同步的项目
            </div>
          ) : (
            <div className="space-y-4">
              {(["codex", "claude"] as HistorySource[]).map((source) => {
                const items = groups[source];
                if (items.length === 0) return null;
                return (
                  <section key={source} className="space-y-1">
                    <div className="px-3 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                      {sourceLabel(source)}
                    </div>
                    <div className="space-y-1">
                      {items.map((project) => (
                        <ProjectRow
                          key={project.key}
                          project={project}
                          checked={selectedKeys.has(project.key)}
                          disabled={disabled}
                          onToggle={() => toggleProject(project.key)}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-border/70 px-5 py-4">
          <Button variant="outline" disabled={disabled} onClick={() => void closeProjectDialog()}>
            取消
          </Button>
          <Button
            variant="default"
            disabled={disabled || candidates.length === 0}
            onClick={() => void syncProjectCandidates(Array.from(selectedKeys))}
          >
            {syncing ? "同步中..." : "同步"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
