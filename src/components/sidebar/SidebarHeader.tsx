import { ChevronRight, FolderPlus, Plus } from "../icons";

interface SidebarHeaderProps {
  collapsed: boolean;
  density: "compact" | "comfortable";
  onToggleCollapse: () => void;
  onCreateGroup: () => void;
  onCreateProject: () => void;
}

export function SidebarHeader({
  collapsed,
  density,
  onToggleCollapse,
  onCreateGroup,
  onCreateProject,
}: SidebarHeaderProps) {
  const compact = density === "compact";
  if (collapsed) {
    return (
      <div className={`flex flex-col items-center ${compact ? "gap-1 px-1.5 pb-1.5 pt-2.5" : "gap-1.5 px-2 pb-2 pt-3"}`}>
        <button
          onClick={onToggleCollapse}
          className={`ui-flat-action px-0 ${compact ? "h-7 w-7" : "h-8 w-8"}`}
          title="展开侧边栏"
          aria-label="展开侧边栏"
        >
          <ChevronRight size={14} strokeWidth={1.8} />
        </button>
        <button
          onClick={onCreateGroup}
          className={`ui-flat-action px-0 ${compact ? "h-7 w-7" : "h-8 w-8"}`}
          title="新建分组"
          aria-label="新建分组"
        >
          <FolderPlus size={14} strokeWidth={1.5} />
        </button>
        <button
          onClick={onCreateProject}
          className={`ui-flat-action ui-primary-action px-0 ${compact ? "h-7 w-7" : "h-8 w-8"}`}
          title="新建终端"
          aria-label="新建终端"
        >
          <Plus size={13} strokeWidth={2} />
        </button>
      </div>
    );
  }

  return (
    <div className={`flex items-center justify-between ${compact ? "px-2.5 pb-1 pt-2.5" : "px-3 pb-1 pt-3"}`}>
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-on-surface-variant">Projects</span>
      <div className={`flex items-center ${compact ? "gap-0.5" : "gap-1"}`}>
        <button
          onClick={onToggleCollapse}
          className={`ui-flat-action px-0 ${compact ? "h-7 w-7" : "h-8 w-8"}`}
          title="折叠侧边栏"
          aria-label="折叠侧边栏"
        >
          <ChevronRight size={14} strokeWidth={1.8} className="rotate-180" />
        </button>
        <button
          onClick={onCreateGroup}
          className={`ui-flat-action ${compact ? "h-7 w-7 px-0" : "text-xs"}`}
          title="新建分组"
          aria-label="新建分组"
        >
          <FolderPlus size={14} strokeWidth={1.5} />
        </button>
        <button
          onClick={onCreateProject}
          className={`ui-flat-action ui-primary-action ${compact ? "h-7 px-2 text-[11px]" : "px-2.5 text-xs"}`}
          aria-label="新建终端"
        >
          + 新建
        </button>
      </div>
    </div>
  );
}
