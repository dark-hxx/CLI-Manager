import { ChevronRight, Folder, Search, Terminal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Group, Project } from "../../lib/types";
import { useI18n } from "../../lib/i18n";
import { VendorIcon, inferVendor } from "../VendorIcon";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

interface HistoryResumeProjectDialogProps {
  open: boolean;
  projects: Project[];
  groups: Group[];
  onUseNewWindow?: () => void;
  useOriginalRemoteLocation?: boolean;
  onSelect: (project: Project) => void;
  onClose: () => void;
}

interface ProjectGroup {
  id: string;
  name: string;
  projects: Project[];
}

function ProjectIcon({ project }: { project: Project }) {
  const vendor = inferVendor(project.cli_tool);
  return vendor ? <VendorIcon vendor={vendor} size={15} /> : <Terminal size={15} strokeWidth={1.5} />;
}

export function HistoryResumeProjectDialog({ open, projects, groups, onUseNewWindow, useOriginalRemoteLocation = false, onSelect, onClose }: HistoryResumeProjectDialogProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(() => new Set());
  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => {
    if (!open) {
      setQuery("");
      setCollapsedGroupIds(new Set());
    }
  }, [open]);

  useEffect(() => {
    if (normalizedQuery) setCollapsedGroupIds(new Set());
  }, [normalizedQuery]);

  const toggleGroup = (groupId: string) => {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const groupedProjects = useMemo<ProjectGroup[]>(() => {
    const groupById = new Map(groups.map((group) => [group.id, group]));
    const buckets = new Map<string, ProjectGroup>();

    for (const project of projects) {
      const projectPath = project.environment_type === "ssh" ? project.remote_path : project.path;
      const haystack = `${project.name}\n${projectPath}\n${project.cli_tool}\n${project.cli_args}`.toLowerCase();
      if (normalizedQuery && !haystack.includes(normalizedQuery)) continue;

      const group = project.group_id ? groupById.get(project.group_id) : null;
      const id = group?.id ?? "__other__";
      const bucket = buckets.get(id) ?? {
        id,
        name: group?.name ?? t("history.resumeProject.otherGroup"),
        projects: [],
      };
      bucket.projects.push(project);
      buckets.set(id, bucket);
    }

    return [...buckets.values()]
      .map((bucket) => ({
        ...bucket,
        projects: bucket.projects.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [groups, normalizedQuery, projects, t]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="w-[360px] max-w-[calc(100vw-32px)] p-2" showCloseButton={false}>
        <DialogHeader className="px-2 pb-2 pt-1">
          <div className="flex items-center gap-2">
            <Folder size={15} className="text-text-muted" />
            <DialogTitle className="min-w-0 flex-1 text-sm">{t("history.resumeProject.title")}</DialogTitle>
            <DialogClose asChild>
              <button
                type="button"
                className="ui-focus-ring inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-[var(--interactive-hover-bg)] hover:text-text-primary"
                aria-label={t("common.close")}
                title={t("common.close")}
              >
                <X size={14} />
              </button>
            </DialogClose>
          </div>
          <DialogDescription className="text-xs">
            {t(onUseNewWindow ? "history.resumeProject.noMatchDescription" : "history.resumeProject.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="ui-history-search-shell mb-1 gap-2 px-2 py-2 text-text-secondary">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("history.resumeProject.searchAria")}
            placeholder={t("history.projectFilter.searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-xs outline-none"
            autoFocus
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="ui-flat-action inline-flex h-5 w-5 items-center justify-center rounded-md px-0 text-text-muted"
              aria-label={t("history.projectFilter.clearSearch")}
              title={t("history.projectFilter.clearSearch")}
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="ui-thin-scroll max-h-72 space-y-1 overflow-y-auto pr-1" role="listbox" aria-label={t("history.resumeProject.listAria")}>
          {onUseNewWindow && (
            <button
              type="button"
              role="option"
              aria-selected="false"
              onClick={onUseNewWindow}
              className="ui-tree-node ui-tree-project ui-focus-ring flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs"
              title={t(useOriginalRemoteLocation ? "history.resumeProject.useOriginalRemoteLocationDescription" : "history.resumeProject.useNewWindowDescription")}
            >
              <span className="ui-tree-leading-icon"><Terminal size={15} strokeWidth={1.5} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-text-primary">{t(useOriginalRemoteLocation ? "history.resumeProject.useOriginalRemoteLocation" : "history.resumeProject.useNewWindow")}</span>
                <span className="block truncate text-[10px] text-text-muted">{t(useOriginalRemoteLocation ? "history.resumeProject.useOriginalRemoteLocationDescription" : "history.resumeProject.useNewWindowDescription")}</span>
              </span>
            </button>
          )}
          {groupedProjects.length > 0 ? groupedProjects.map((group) => {
            const collapsed = collapsedGroupIds.has(group.id);
            return (
              <div key={group.id}>
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id)}
                  className="ui-tree-node ui-focus-ring flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-left text-xs font-medium text-text-secondary"
                  aria-expanded={!collapsed}
                >
                  <ChevronRight
                    size={12}
                    className="shrink-0 transition-transform duration-150"
                    style={{ transform: collapsed ? "rotate(0deg)" : "rotate(90deg)" }}
                  />
                  <Folder size={13} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  <span className="ui-tree-count-badge rounded-full px-1.5 text-[10px] font-medium">{group.projects.length}</span>
                </button>
                {!collapsed && <div className="space-y-0.5">
                  {group.projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    role="option"
                    aria-selected="false"
                    onClick={() => onSelect(project)}
                    className="ui-tree-node ui-tree-project ui-focus-ring flex min-h-9 w-full items-center gap-2 rounded-lg py-1.5 pl-7 pr-2 text-left text-xs"
                    title={`${project.name}\n${project.environment_type === "ssh" ? project.remote_path : project.path}\n${project.cli_tool} ${project.cli_args}`.trim()}
                  >
                    <span className="ui-tree-leading-icon"><ProjectIcon project={project} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-text-primary">{project.name}</span>
                      <span className="block truncate text-[10px] text-text-muted">{project.cli_tool} {project.cli_args}</span>
                    </span>
                  </button>
                  ))}
                </div>}
              </div>
            );
          }) : (
            <div className="px-2 py-5 text-center text-xs text-text-muted">{t("history.projectFilter.noMatches")}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
