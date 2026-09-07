import { ChevronRight, Filter, FolderPlus, Plus } from "../icons";
import { useI18n } from "../../lib/i18n";
import type { WorkspaceDockSide } from "../../lib/workspaceLayout";

export type ProjectListFilter = "all" | "open";

interface SidebarHeaderProps {
  collapsed: boolean;
  density: "compact" | "comfortable";
  projectFilter: ProjectListFilter;
  showProjectFilter: boolean;
  totalProjectCount: number;
  openProjectCount: number;
  dockSide: WorkspaceDockSide;
  onToggleCollapse: () => void;
  onProjectFilterChange: (filter: ProjectListFilter) => void;
  onCreateGroup: () => void;
  onCreateProject: () => void;
}

export function SidebarHeader({
  collapsed,
  density,
  projectFilter,
  showProjectFilter,
  totalProjectCount,
  openProjectCount,
  dockSide,
  onToggleCollapse,
  onProjectFilterChange,
  onCreateGroup,
  onCreateProject,
}: SidebarHeaderProps) {
  const { t } = useI18n();
  const compact = density === "compact";
  const collapseIconClassName = dockSide === "right" ? "" : "rotate-180";
  const expandIconClassName = dockSide === "right" ? "rotate-180" : "";
  if (collapsed) {
    return (
      <div className={`flex flex-col items-center ${compact ? "gap-1 px-1.5 pb-1.5 pt-2.5" : "gap-1.5 px-2 pb-2 pt-3"}`}>
        <button
          onClick={onToggleCollapse}
          className={`ui-flat-action ui-toolbar-button-compact px-0 ${compact ? "h-7 w-7" : "h-8 w-8"}`}
          title={t("sidebar.expand")}
          aria-label={t("sidebar.expand")}
        >
          <ChevronRight size={14} strokeWidth={1.8} className={expandIconClassName} />
        </button>
        {showProjectFilter && (
          <button
            onClick={() => onProjectFilterChange(projectFilter === "open" ? "all" : "open")}
            className={`ui-flat-action ui-toolbar-button-compact px-0 ${compact ? "h-7 w-7" : "h-8 w-8"} ${
              projectFilter === "open" ? "text-primary" : ""
            }`}
            title={projectFilter === "open" ? t("sidebar.filter.showAll") : t("sidebar.filter.showOpen")}
            aria-label={projectFilter === "open" ? t("sidebar.filter.showAll") : t("sidebar.filter.showOpen")}
            aria-pressed={projectFilter === "open"}
          >
            <Filter size={14} strokeWidth={1.7} />
          </button>
        )}
        <button
          onClick={onCreateGroup}
          className={`ui-flat-action ui-toolbar-button-compact px-0 ${compact ? "h-7 w-7" : "h-8 w-8"}`}
          title={t("sidebar.newGroup")}
          aria-label={t("sidebar.newGroup")}
        >
          <FolderPlus size={14} strokeWidth={1.5} />
        </button>
        <button
          onClick={onCreateProject}
          className={`ui-flat-action ui-primary-action px-0 ${compact ? "h-7 w-7" : "h-8 w-8"}`}
          title={t("sidebar.newTerminal")}
          aria-label={t("sidebar.newTerminal")}
        >
          <Plus size={13} strokeWidth={2} />
        </button>
      </div>
    );
  }

  return (
    <div className={compact ? "pb-1.5 pt-2.5" : "pb-2 pt-3"}>
      <div className={`flex items-center justify-between ${compact ? "px-2.5" : "px-3"}`}>
        <span className="text-[12px] font-semibold tracking-[0.03em] text-primary">{t("sidebar.projects")}</span>
        <div className={`flex items-center ${compact ? "gap-0.5" : "gap-1"}`}>
          <button
            onClick={onToggleCollapse}
            className={`ui-flat-action ui-toolbar-button-compact px-0 ${compact ? "h-7 w-7" : "h-8 w-8"}`}
            title={t("sidebar.collapse")}
            aria-label={t("sidebar.collapse")}
          >
            <ChevronRight size={14} strokeWidth={1.8} className={collapseIconClassName} />
          </button>
          <button
            onClick={onCreateGroup}
            className={`ui-flat-action ui-toolbar-button-compact ${compact ? "h-7 w-7 px-0" : "px-2.5 text-xs"}`}
            title={t("sidebar.newGroup")}
            aria-label={t("sidebar.newGroup")}
          >
            <FolderPlus size={14} strokeWidth={1.5} />
          </button>
          <button
            onClick={onCreateProject}
            className={`ui-flat-action ui-primary-action ui-toolbar-button-compact ${compact ? "h-7 px-2 text-[12px]" : "px-2.5 text-[12px]"}`}
            aria-label={t("sidebar.newTerminal")}
          >
            {t("sidebar.new")}
          </button>
        </div>
      </div>

      {showProjectFilter && (
        <div
          className={`mt-1 flex bg-transparent ${compact ? "mx-2" : "mx-2.5"}`}
          role="group"
          aria-label={t("sidebar.projects")}
        >
          {(["all", "open"] as const).map((filter) => {
            const active = projectFilter === filter;
            const label = filter === "all"
              ? t("sidebar.filter.all", { count: totalProjectCount })
              : t("sidebar.filter.open", { count: openProjectCount });
            return (
              <button
                key={filter}
                type="button"
                className={`ui-focus-ring h-7 min-w-0 flex-1 rounded-lg px-2 text-[11px] font-medium transition-colors ${
                  active
                    ? "bg-surface-container-high text-primary"
                    : "text-text-muted hover:bg-surface-container-high hover:text-on-surface"
                }`}
                aria-pressed={active}
                onClick={() => onProjectFilterChange(filter)}
              >
                <span className="block truncate">{label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
