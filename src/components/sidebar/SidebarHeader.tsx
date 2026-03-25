import { ChevronRight, FolderPlus, Plus } from "../icons";

interface SidebarHeaderProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onCreateGroup: () => void;
  onCreateProject: () => void;
}

export function SidebarHeader({
  collapsed,
  onToggleCollapse,
  onCreateGroup,
  onCreateProject,
}: SidebarHeaderProps) {
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 px-2 pb-1 pt-2">
        <button
          onClick={onToggleCollapse}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-bg-tertiary text-text-muted transition-opacity hover:opacity-90"
          title="展开侧边栏"
        >
          <ChevronRight size={14} strokeWidth={1.8} />
        </button>
        <button
          onClick={onCreateGroup}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-bg-tertiary text-text-muted transition-opacity hover:opacity-90"
          title="新建分组"
        >
          <FolderPlus size={14} strokeWidth={1.5} />
        </button>
        <button
          onClick={onCreateProject}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-white transition-opacity hover:opacity-90"
          title="新建终端"
        >
          <Plus size={13} strokeWidth={2} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-3">
      <span className="text-xs font-bold uppercase tracking-widest text-text-muted">Projects</span>
      <div className="flex items-center gap-1">
        <button
          onClick={onToggleCollapse}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-bg-tertiary text-text-muted transition-opacity hover:opacity-90"
          title="折叠侧边栏"
        >
          <ChevronRight size={14} strokeWidth={1.8} className="rotate-180" />
        </button>
        <button
          onClick={onCreateGroup}
          className="flex items-center gap-1 rounded-md bg-bg-tertiary px-2 py-1 text-xs text-text-muted transition-opacity hover:opacity-90"
          title="新建分组"
        >
          <FolderPlus size={14} strokeWidth={1.5} />
        </button>
        <button
          onClick={onCreateProject}
          className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs text-white transition-opacity hover:opacity-90"
        >
          + New
        </button>
      </div>
    </div>
  );
}
