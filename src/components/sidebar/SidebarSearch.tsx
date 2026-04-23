import { Play, Search, X } from "../icons";

interface SidebarSearchProps {
  collapsed: boolean;
  density: "compact" | "comfortable";
  searchQuery: string;
  selectedCount: number;
  filteredCount: number;
  onSearchChange: (value: string) => void;
  onStartFiltered: () => void;
  onStartSelected: () => void;
  onClearSelected: () => void;
  onExpandSidebar: () => void;
}

export function SidebarSearch({
  collapsed,
  density,
  searchQuery,
  selectedCount,
  filteredCount,
  onSearchChange,
  onStartFiltered,
  onStartSelected,
  onClearSelected,
  onExpandSidebar,
}: SidebarSearchProps) {
  const compact = density === "compact";
  if (collapsed) {
    return (
      <div className={`flex flex-col items-center ${compact ? "gap-1 px-1.5 py-0.5" : "gap-1.5 px-2 py-1"}`}>
        <button
          onClick={onExpandSidebar}
          className={`ui-flat-action px-0 ${compact ? "h-7 w-7" : "h-8 w-8"}`}
          title="展开并搜索"
          aria-label="展开并搜索项目"
        >
          <Search size={14} strokeWidth={1.6} />
        </button>
        <button
          onClick={onStartSelected}
          disabled={selectedCount === 0}
          className={`ui-flat-action px-0 ${compact ? "h-7 w-7" : "h-8 w-8"}`}
          title="启动已选"
          aria-label="启动已选项目"
        >
          <Play size={13} strokeWidth={1.7} />
        </button>
      </div>
    );
  }

  return (
    <div className={compact ? "px-2.5 py-1.5" : "px-2.5 py-2"}>
      <div className={`mb-2 flex flex-wrap items-center ${compact ? "gap-1.5" : "gap-2"}`}>
        <button
          onClick={onStartFiltered}
          disabled={filteredCount === 0}
          className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact ui-primary-action"
          title="启动筛选结果"
          aria-label="启动筛选结果"
        >
          <Play size={12} strokeWidth={1.8} />
          启动筛选
        </button>
        <button
          onClick={onStartSelected}
          disabled={selectedCount === 0}
          className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
          title="启动已选"
          aria-label="启动已选项目"
        >
          <Play size={12} strokeWidth={1.8} />
          启动已选 ({selectedCount})
        </button>
        {selectedCount > 0 && (
          <button
            onClick={onClearSelected}
            className="ui-flat-action ui-toolbar-button ui-toolbar-button-compact"
            title="清空已选"
            aria-label="清空已选项目"
          >
            <span className="inline-flex items-center gap-1.5">
              <X size={11} strokeWidth={2} />
              清空
            </span>
          </button>
        )}
      </div>
      <div className={`ui-sidebar-search-shell ${compact ? "gap-1.5 px-2 py-1.5" : "gap-2 px-2.5 py-1.5"}`}>
        <span className="text-on-surface-variant">
          <Search size={14} strokeWidth={1.5} />
        </span>
        <input
          type="text"
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="flex-1 bg-transparent text-sm text-on-surface outline-none"
          aria-label="搜索项目"
        />
      </div>
    </div>
  );
}
