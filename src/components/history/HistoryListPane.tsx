import { useVirtualizer } from "@tanstack/react-virtual";
import { Bot, Check, ChevronDown, ChevronRight, CircleChevronDown, CircleChevronRight, Folder, RefreshCw, Search, Star, Terminal, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import type { Group, HistorySearchHit, HistorySessionView, HistorySourceFilter, Project } from "../../lib/types";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { VendorIcon, inferVendor } from "../VendorIcon";
import { Portal } from "../ui/Portal";
import { buildHistorySessionChildMap, formatTime, makeSessionLabel } from "./historyViewUtils";

interface SessionGroup {
  label: string;
  items: HistorySessionView[];
}

type HistoryListRow =
  | { type: "loading"; id: string }
  | { type: "searching"; id: string }
  | { type: "searchHeader"; id: string; count: number }
  | { type: "searchHit"; id: string; hit: HistorySearchHit }
  | { type: "group"; id: string; label: string }
  | {
      type: "session";
      id: string;
      item: HistorySessionView;
      depth: number;
      childCount: number;
      parentSessionId: string | null;
    }
  | { type: "empty"; id: string }
  | { type: "loadMore"; id: string };

type SessionContextMenu = {
  session: HistorySessionView;
  x: number;
  y: number;
};

type HistoryProjectTreeNode =
  | { type: "group"; group: Group; children: HistoryProjectTreeNode[] }
  | { type: "project"; project: Project };

interface HistoryListPaneProps {
  historySidebarWidth: number;
  sidebarRef: RefObject<HTMLElement | null>;
  sessionListRef: RefObject<HTMLDivElement | null>;
  sourceFilter: HistorySourceFilter;
  projectPathFilter: string | null;
  projects: Project[];
  groups: Group[];
  globalQuery: string;
  activeSessionKey: string | null;
  loadingSessions: boolean;
  loadingMoreSessions: boolean;
  searching: boolean;
  normalizedGlobal: string;
  groupedSessions: SessionGroup[];
  filteredSessionCount: number;
  hasMoreSessions: boolean;
  loadMoreSessionMode: "local" | "backend";
  visibleSessionCount: number;
  searchHits: HistorySearchHit[];
  globalSearchRef: RefObject<HTMLInputElement | null>;
  selectionMode: boolean;
  selectedCount: number;
  allVisibleSelected: boolean;
  selectedSessionKeys: Set<string>;
  onRefresh: () => void;
  onClose: () => void;
  onSourceFilterChange: (value: HistorySourceFilter) => void;
  onProjectPathFilterChange: (value: string | null) => void;
  onGlobalQueryChange: (value: string) => void;
  onEnterSelectionMode: () => void;
  onCancelSelectionMode: () => void;
  onToggleSelectAllVisible: () => void;
  onToggleSessionSelection: (sessionKey: string) => void;
  onOpenSession: (sessionKey: string) => void;
  onResumeSession: (session: HistorySessionView) => void;
  onDeleteSession: (session: HistorySessionView) => void;
  onDeleteSelected: () => void;
  onOpenHit: (hit: HistorySearchHit) => void;
  onLoadMoreSessions: () => void;
  onSessionListScroll: () => void;
  onStartResize: (e: ReactMouseEvent) => void;
}

const SOURCE_FILTER_OPTIONS: { value: HistorySourceFilter; labelKey?: TranslationKey; label?: string }[] = [
  { value: "all", labelKey: "history.filter.all" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];

function rowHeight(row: HistoryListRow): number {
  if (row.type === "group" || row.type === "searchHeader" || row.type === "searching") return 32;
  if (row.type === "empty") return 88;
  if (row.type === "loading" || row.type === "loadMore") return 56;
  if (row.type === "searchHit") return 72;
  return row.depth > 0 ? 82 : 96;
}

function SelectionCheckbox({
  checked,
  title,
  ariaLabel,
  onToggle,
}: {
  checked: boolean;
  title: string;
  ariaLabel: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      title={title}
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="ui-focus-ring mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors"
      style={{
        borderColor: checked ? "var(--primary)" : "color-mix(in srgb, var(--border) 82%, transparent)",
        backgroundColor: checked ? "color-mix(in srgb, var(--primary) 16%, transparent)" : "transparent",
        color: checked ? "var(--primary)" : "var(--text-muted)",
      }}
    >
      {checked ? <Check size={12} strokeWidth={2.5} /> : null}
    </button>
  );
}

function buildSessionTreeRows(items: HistorySessionView[], collapsedParentKeys: Set<string>): HistoryListRow[] {
  const childrenByParentKey = buildHistorySessionChildMap(items);
  const childKeys = new Set<string>();
  for (const children of childrenByParentKey.values()) {
    for (const child of children) childKeys.add(child.sessionKey);
  }

  const rows: HistoryListRow[] = [];
  for (const item of items) {
    if (childKeys.has(item.sessionKey)) continue;

    const children = childrenByParentKey.get(item.sessionKey) ?? [];
    rows.push({
      type: "session",
      id: `session:${item.sessionKey}`,
      item,
      depth: 0,
      childCount: children.length,
      parentSessionId: null,
    });

    if (children.length === 0 || collapsedParentKeys.has(item.sessionKey)) continue;

    for (const child of children) {
      rows.push({
        type: "session",
        id: `session:${child.sessionKey}`,
        item: child,
        depth: 1,
        childCount: 0,
        parentSessionId: item.session_id,
      });
    }
  }
  return rows;
}

function buildHistoryProjectTree(groups: Group[], projects: Project[]): HistoryProjectTreeNode[] {
  const childGroups = new Map<string | null, Group[]>();
  const groupProjects = new Map<string | null, Project[]>();

  for (const group of groups) {
    const list = childGroups.get(group.parent_id) ?? [];
    list.push(group);
    childGroups.set(group.parent_id, list);
  }

  for (const project of projects) {
    const list = groupProjects.get(project.group_id) ?? [];
    list.push(project);
    groupProjects.set(project.group_id, list);
  }

  const buildLevel = (parentId: string | null): HistoryProjectTreeNode[] => {
    const nodes: HistoryProjectTreeNode[] = [];
    const sortedGroups = [...(childGroups.get(parentId) ?? [])].sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    );
    const sortedProjects = [...(groupProjects.get(parentId) ?? [])].sort(
      (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    );

    for (const group of sortedGroups) {
      nodes.push({ type: "group", group, children: buildLevel(group.id) });
    }
    for (const project of sortedProjects) {
      nodes.push({ type: "project", project });
    }
    return nodes;
  };

  return buildLevel(null);
}

function countProjects(node: HistoryProjectTreeNode): number {
  if (node.type === "project") return 1;
  return node.children.reduce((sum, child) => sum + countProjects(child), 0);
}

function ProjectFilterIcon({ project, size = 13 }: { project: Project; size?: number }) {
  const vendor = project.cli_tool ? inferVendor(project.cli_tool) : null;
  return vendor ? <VendorIcon vendor={vendor} size={size} /> : <Terminal size={size} strokeWidth={1.5} />;
}

function collectGroupIds(nodes: HistoryProjectTreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type !== "group") continue;
    out.push(node.group.id);
    collectGroupIds(node.children, out);
  }
  return out;
}

function normalizeProjectSearch(value: string): string {
  return value.trim().toLowerCase();
}

function projectMatchesSearch(project: Project, query: string): boolean {
  if (!query) return true;
  return (
    project.name.toLowerCase().includes(query) ||
    project.path.toLowerCase().includes(query) ||
    project.cli_tool.toLowerCase().includes(query)
  );
}

function filterHistoryProjectTree(nodes: HistoryProjectTreeNode[], query: string): HistoryProjectTreeNode[] {
  if (!query) return nodes;

  const result: HistoryProjectTreeNode[] = [];
  for (const node of nodes) {
    if (node.type === "project") {
      if (projectMatchesSearch(node.project, query)) result.push(node);
      continue;
    }

    const groupMatches = node.group.name.toLowerCase().includes(query);
    const children = groupMatches
      ? node.children
      : filterHistoryProjectTree(node.children, query);
    if (groupMatches || children.length > 0) {
      result.push({ ...node, children });
    }
  }
  return result;
}

export function HistoryListPane({
  historySidebarWidth,
  sidebarRef,
  sessionListRef,
  sourceFilter,
  projectPathFilter,
  projects,
  groups,
  globalQuery,
  activeSessionKey,
  loadingSessions,
  loadingMoreSessions,
  searching,
  normalizedGlobal,
  groupedSessions,
  filteredSessionCount,
  hasMoreSessions,
  loadMoreSessionMode,
  visibleSessionCount,
  searchHits,
  globalSearchRef,
  selectionMode,
  selectedCount,
  allVisibleSelected,
  selectedSessionKeys,
  onRefresh,
  onClose,
  onSourceFilterChange,
  onProjectPathFilterChange,
  onGlobalQueryChange,
  onEnterSelectionMode,
  onCancelSelectionMode,
  onToggleSelectAllVisible,
  onToggleSessionSelection,
  onOpenSession,
  onResumeSession,
  onDeleteSession,
  onDeleteSelected,
  onOpenHit,
  onLoadMoreSessions,
  onSessionListScroll,
  onStartResize,
}: HistoryListPaneProps) {
  const { t, language } = useI18n();
  const sessionHistoryShortcut = useSettingsStore((s) => s.keyboardShortcuts.sessionHistory);
  const sessionHistoryShortcutHint = sessionHistoryShortcut.trim() || t("history.shortcut.notSet");
  const [contextMenu, setContextMenu] = useState<SessionContextMenu | null>(null);
  const [collapsedFilterGroups, setCollapsedFilterGroups] = useState<Set<string>>(new Set());
  const [collapsedSessionParents, setCollapsedSessionParents] = useState<Set<string>>(new Set());
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const projectDropdownRef = useRef<HTMLDivElement | null>(null);
  const projectMenuWasOpenRef = useRef(false);

  const projectTree = useMemo(() => buildHistoryProjectTree(groups, projects), [groups, projects]);
  const selectedProject = useMemo(
    () => projects.find((project) => project.path === projectPathFilter) ?? null,
    [projectPathFilter, projects]
  );
  const projectGroupIds = useMemo(() => collectGroupIds(projectTree), [projectTree]);
  const normalizedProjectSearch = useMemo(() => normalizeProjectSearch(projectSearchQuery), [projectSearchQuery]);
  const filteredProjectTree = useMemo(
    () => filterHistoryProjectTree(projectTree, normalizedProjectSearch),
    [normalizedProjectSearch, projectTree]
  );
  const filteredProjectCount = useMemo(
    () => filteredProjectTree.reduce((sum, node) => sum + countProjects(node), 0),
    [filteredProjectTree]
  );
  const selectedProjectLabel = useMemo(() => {
    if (selectedProject) return selectedProject.name;
    if (!projectPathFilter) return t("history.allProjects");
    return projectPathFilter.split(/[\\/]/).pop() || projectPathFilter;
  }, [projectPathFilter, selectedProject, t]);

  const emptySessionCopy = useMemo(() => {
    const sourceLabel = sourceFilter === "all" ? "Claude/Codex" : sourceFilter === "claude" ? "Claude" : "Codex";
    if (normalizedGlobal) {
      return {
        title: t("history.empty.noMatchesTitle"),
        description: t("history.empty.noMatchesDescription"),
      };
    }
    if (projectPathFilter) {
      return {
        title: t("history.empty.noHistoryTitle"),
        description: t("history.empty.projectNoSessions", { project: selectedProjectLabel, source: sourceLabel }),
      };
    }
    return {
      title: t("history.empty.noHistoryTitle"),
      description: t("history.empty.sourceNoSessions", { source: sourceLabel }),
    };
  }, [normalizedGlobal, projectPathFilter, selectedProjectLabel, sourceFilter, t]);

  const toggleFilterGroup = useCallback((groupId: string) => {
    setCollapsedFilterGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const toggleSessionParent = useCallback((sessionKey: string) => {
    setCollapsedSessionParents((prev) => {
      const next = new Set(prev);
      if (next.has(sessionKey)) next.delete(sessionKey);
      else next.add(sessionKey);
      return next;
    });
  }, []);

  const handleProjectFilterChange = useCallback(
    (projectPath: string | null) => {
      onProjectPathFilterChange(projectPath);
      setProjectMenuOpen(false);
    },
    [onProjectPathFilterChange]
  );

  const handleSessionContextMenu = useCallback((e: ReactMouseEvent, session: HistorySessionView) => {
    e.preventDefault();
    setContextMenu({ session, x: e.clientX, y: e.clientY });
  }, []);

  const handleContextMenuDelete = useCallback(() => {
    if (!contextMenu) return;
    const session = contextMenu.session;
    setContextMenu(null);
    onDeleteSession(session);
  }, [contextMenu, onDeleteSession]);

  const handleContextMenuResume = useCallback(() => {
    if (!contextMenu) return;
    const session = contextMenu.session;
    setContextMenu(null);
    onResumeSession(session);
  }, [contextMenu, onResumeSession]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: Event) => {
      if (contextMenuRef.current && contextMenuRef.current.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    window.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
      window.removeEventListener("keydown", keyHandler);
    };
  }, [contextMenu]);

  useEffect(() => {
    const wasOpen = projectMenuWasOpenRef.current;
    projectMenuWasOpenRef.current = projectMenuOpen;

    if (!projectMenuOpen) {
      setProjectSearchQuery("");
      return;
    }

    if (!wasOpen) {
      setCollapsedFilterGroups(new Set(projectGroupIds));
    }
  }, [projectGroupIds, projectMenuOpen]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (projectDropdownRef.current?.contains(e.target as Node)) return;
      setProjectMenuOpen(false);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProjectMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    window.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", keyHandler);
    };
  }, [projectMenuOpen]);

  const rows = useMemo<HistoryListRow[]>(() => {
    if (loadingSessions) return [{ type: "loading", id: "loading" }];

    const next: HistoryListRow[] = [];
    if (normalizedGlobal && searching) {
      next.push({ type: "searching", id: "searching" });
    }
    if (normalizedGlobal && searchHits.length > 0) {
      next.push({ type: "searchHeader", id: "search-header", count: searchHits.length });
      searchHits.forEach((hit, index) => {
        next.push({ type: "searchHit", id: `hit:${hit.file_path}:${index}`, hit });
      });
    }

    for (const group of groupedSessions) {
      next.push({ type: "group", id: `group:${group.label}`, label: group.label });
      next.push(...buildSessionTreeRows(group.items, collapsedSessionParents));
    }

    if (filteredSessionCount === 0) {
      next.push({ type: "empty", id: "empty" });
    }
    if (hasMoreSessions) {
      next.push({ type: "loadMore", id: "load-more" });
    }
    return next;
  }, [collapsedSessionParents, filteredSessionCount, groupedSessions, hasMoreSessions, loadingSessions, normalizedGlobal, searchHits, searching]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => sessionListRef.current,
    estimateSize: (index) => rowHeight(rows[index] ?? { type: "loading", id: "fallback" }),
    overscan: 10,
    getItemKey: (index) => rows[index]?.id ?? index,
  });

  const menuX = contextMenu ? Math.max(8, Math.min(contextMenu.x, window.innerWidth - 200)) : 0;
  const menuY = contextMenu ? Math.max(8, Math.min(contextMenu.y, window.innerHeight - 80)) : 0;

  const renderProjectNode = (node: HistoryProjectTreeNode, depth = 0): ReactNode => {
    const paddingLeft = 8 + depth * 14;
    if (node.type === "group") {
      const isOpen = Boolean(normalizedProjectSearch) || !collapsedFilterGroups.has(node.group.id);
      return (
        <div key={`group:${node.group.id}`}>
          <button
            type="button"
            onClick={() => toggleFilterGroup(node.group.id)}
            className="ui-tree-node ui-tree-group ui-focus-ring flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-[11px] font-semibold"
            style={{ paddingLeft }}
            aria-expanded={isOpen}
          >
            <ChevronRight size={12} className="shrink-0" style={{ transform: isOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms" }} />
            <Folder size={13} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{node.group.name}</span>
            <span className="ui-tree-count-badge rounded-full px-1.5 text-[10px] font-medium">{countProjects(node)}</span>
          </button>
          {isOpen && node.children.length > 0 && (
            <div className="mt-0.5 space-y-0.5">
              {node.children.map((child) => renderProjectNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    const selected = projectPathFilter === node.project.path;
    return (
      <button
        key={`project:${node.project.id}`}
        type="button"
        onClick={() => handleProjectFilterChange(selected ? null : node.project.path)}
        className="ui-tree-node ui-tree-project ui-focus-ring flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-[12px]"
        data-selected={selected ? "true" : "false"}
        style={{ paddingLeft }}
        title={node.project.path}
      >
        <span className="ui-tree-leading-icon">
          <ProjectFilterIcon project={node.project} size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{node.project.name}</span>
      </button>
    );
  };

  return (
    <aside
      ref={sidebarRef}
      className="ui-history-sidebar relative flex min-h-0 min-w-[220px] max-w-[70%] flex-col"
      style={{ width: historySidebarWidth }}
    >
      <div className="ui-history-sidebar-top p-3">
        <div className="flex items-center gap-2">
          <div className="grid min-w-0 flex-1 grid-cols-3 gap-1 rounded-xl border border-border/60 bg-surface-container-lowest p-1">
            {SOURCE_FILTER_OPTIONS.map((option) => {
              const active = sourceFilter === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onSourceFilterChange(option.value)}
                  className="ui-focus-ring rounded-lg px-1.5 py-1 text-[11px] font-semibold transition-colors"
                  style={{
                    backgroundColor: active ? "var(--interactive-selected-bg)" : "transparent",
                    color: active ? "var(--on-surface)" : "var(--text-muted)",
                  }}
                  aria-pressed={active}
                >
                  {option.labelKey ? t(option.labelKey) : option.label}
                </button>
              );
            })}
          </div>

          <button
            onClick={onRefresh}
            aria-label={t("history.refreshList")}
            className="ui-flat-action ui-toolbar-button-compact ui-history-list-action h-8 w-8 shrink-0 px-0"
            title={t("history.refreshList")}
          >
            <RefreshCw size={12} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("history.close")}
            className="ui-flat-action ui-toolbar-button-compact ui-history-close-action h-8 w-8 shrink-0 px-0"
            title={t("history.close")}
          >
            <X size={14} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>

        <div className="ui-history-search-shell mt-2 gap-2 px-2.5 py-1.5 text-text-secondary">
          <Search size={13} />
          <input
            ref={globalSearchRef}
            value={globalQuery}
            onChange={(e) => onGlobalQueryChange(e.target.value)}
            aria-label={t("history.search.globalAria")}
            placeholder={t("history.search.globalPlaceholder")}
            className="flex-1 bg-transparent text-[12px] outline-none"
          />
        </div>

        <div ref={projectDropdownRef} className="relative mt-2">
          <button
            type="button"
            onClick={() => setProjectMenuOpen((open) => !open)}
            className="ui-focus-ring flex h-9 w-full items-center gap-2 rounded-xl border border-border/60 bg-surface-container-lowest px-2.5 text-left text-[12px] transition-colors hover:bg-surface-container-high"
            aria-haspopup="tree"
            aria-expanded={projectMenuOpen}
            title={projectPathFilter ?? t("history.allProjects")}
          >
            {selectedProject ? (
              <span className="ui-tree-leading-icon">
                <ProjectFilterIcon project={selectedProject} size={13} />
              </span>
            ) : (
              <Folder size={13} className="shrink-0 text-text-muted" />
            )}
            <span className="min-w-0 flex-1 truncate">
              <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">{t("history.projectFilter.source")}</span>
              <span className="font-semibold text-text-primary">{selectedProjectLabel}</span>
            </span>
            <ChevronDown
              size={13}
              className="shrink-0 text-text-muted transition-transform"
              style={{ transform: projectMenuOpen ? "rotate(180deg)" : "rotate(0deg)" }}
            />
          </button>

          {projectMenuOpen && (
            <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-xl border border-border/70 bg-surface-container-lowest p-1 shadow-lg">
              <div className="ui-history-search-shell mb-1 gap-2 px-2 py-1.5 text-text-secondary">
                <Search size={13} />
                <input
                  value={projectSearchQuery}
                  onChange={(e) => setProjectSearchQuery(e.target.value)}
                  aria-label={t("history.projectFilter.searchAria")}
                  placeholder={t("history.projectFilter.searchPlaceholder")}
                  className="flex-1 bg-transparent text-[12px] outline-none"
                />
                {projectSearchQuery && (
                  <button
                    type="button"
                    onClick={() => setProjectSearchQuery("")}
                    className="ui-flat-action inline-flex h-5 w-5 items-center justify-center rounded-md px-0 text-text-muted"
                    aria-label={t("history.projectFilter.clearSearch")}
                    title={t("history.projectFilter.clearSearch")}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <div className="ui-thin-scroll max-h-52 space-y-0.5 overflow-y-auto pr-1" role="tree" aria-label={t("history.projectFilter.treeAria")}>
                <button
                  type="button"
                  onClick={() => handleProjectFilterChange(null)}
                  className="ui-tree-node ui-tree-project ui-focus-ring flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-left text-[12px]"
                  data-selected={!projectPathFilter ? "true" : "false"}
                >
                  <Folder size={13} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-medium">{t("history.allProjects")}</span>
                  <span className="ui-tree-count-badge rounded-full px-1.5 text-[10px] font-medium">{projects.length}</span>
                </button>
                {filteredProjectTree.length > 0 ? (
                  filteredProjectTree.map((node) => renderProjectNode(node))
                ) : (
                  <div className="px-2 py-1.5 text-[11px] text-text-muted">
                    {normalizedProjectSearch ? t("history.projectFilter.noMatches") : t("history.projectFilter.empty")}
                  </div>
                )}
                {normalizedProjectSearch && filteredProjectTree.length > 0 && (
                  <div className="px-2 py-1 text-[10px] text-text-muted">{t("history.projectFilter.matchCount", { count: filteredProjectCount })}</div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="mt-1 text-[12px] text-text-muted">{t("history.search.openGlobal", { shortcut: sessionHistoryShortcutHint })}</div>
        {selectionMode ? (
          <div className="mt-2 rounded-xl border border-border/60 bg-surface-container-lowest p-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold text-text-secondary">{t("history.bulk.selectedCount", { count: selectedCount })}</div>
              <button type="button" onClick={onCancelSelectionMode} className="ui-flat-action h-6 px-1.5 text-[10px]">
                {t("history.bulk.cancelSelection")}
              </button>
            </div>
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={onToggleSelectAllVisible}
                disabled={visibleSessionCount === 0}
                className="ui-btn ui-btn-outline min-w-0 flex-1 px-1.5 py-0.5 text-[10px]"
              >
                {allVisibleSelected
                  ? t("history.bulk.clearVisibleSelection")
                  : t("history.bulk.selectVisible")}
              </button>
              <button
                type="button"
                onClick={onDeleteSelected}
                disabled={selectedCount === 0}
                className="ui-btn ui-btn-destructive min-w-0 flex-1 px-1.5 py-0.5 text-[10px]"
              >
                {t("history.bulk.deleteSelected", { count: selectedCount })}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={onEnterSelectionMode}
              disabled={filteredSessionCount === 0}
              className="ui-flat-action h-8 px-2.5 text-[11px]"
            >
              {t("history.bulk.enterSelection")}
            </button>
          </div>
        )}
      </div>

      <div ref={sessionListRef} onScroll={onSessionListScroll} className="flex-1 overflow-y-auto">
        <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            return (
              <div
                key={virtualRow.key}
                className="absolute left-0 top-0 w-full"
                style={{
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {row.type === "loading" && <div className="px-3 py-4 text-xs text-text-muted">{t("history.loadingSessions")}</div>}

                {row.type === "searching" && (
                  <div className="px-3 py-2 text-[11px] text-text-muted">{t("history.searching")}</div>
                )}

                {row.type === "searchHeader" && (
                  <div className="px-3 py-2 text-[11px] font-semibold text-text-muted">
                    {t("history.searchHits", { count: row.count })}
                  </div>
                )}

                {row.type === "searchHit" && (
                  <button
                    onClick={() => onOpenHit(row.hit)}
                    className="ui-list-row w-full border-t border-border px-3 py-2 text-left"
                  >
                    <div className="truncate text-xs font-semibold text-text-primary">{row.hit.title}</div>
                    <div className="mt-0.5 truncate text-[11px] text-text-secondary">{row.hit.snippet}</div>
                    <div className="ui-dev-label mt-1 text-[10px] text-text-muted">
                      {row.hit.source} · {row.hit.project_key} · {row.hit.role}
                    </div>
                  </button>
                )}

                {row.type === "group" && (
                  <div className="ui-history-section-label ui-dev-label px-3 py-1.5 text-[11px] font-semibold tracking-[0.04em] text-text-muted">
                    {row.label}
                  </div>
                )}

                {row.type === "session" && (
                  <div className={row.depth > 0 ? "relative py-0.5 pr-2 pl-12" : "py-1 pr-2 pl-2"}>
                    {row.depth > 0 && (
                      <>
                        <span className="absolute bottom-0 left-[24px] top-[-8px] w-px bg-border/70" aria-hidden="true" />
                        <span className="absolute left-[24px] top-1/2 h-px w-4 bg-border/70" aria-hidden="true" />
                        <span className="absolute left-[38px] top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-text-muted/70" aria-hidden="true" />
                      </>
                    )}
                    <div
                      onContextMenu={(e) => handleSessionContextMenu(e, row.item)}
                      onClick={selectionMode ? () => onToggleSessionSelection(row.item.sessionKey) : undefined}
                      className={[
                        "ui-list-row flex w-full items-start gap-2 border text-left",
                        row.depth > 0
                          ? "min-h-[72px] rounded-lg border-border/45 bg-surface-container-low px-2 py-1.5"
                          : "min-h-[88px] rounded-xl border-border/70 bg-surface-container-lowest px-2.5 py-2",
                        selectionMode ? "cursor-pointer" : "",
                      ].join(" ")}
                      style={{ backgroundColor: row.item.sessionKey === activeSessionKey ? "var(--bg-tertiary)" : undefined }}
                    >
                      {row.childCount > 0 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSessionParent(row.item.sessionKey);
                          }}
                          className="ui-flat-action mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-surface-container-high text-text-secondary"
                          aria-expanded={!collapsedSessionParents.has(row.item.sessionKey)}
                          aria-label={t(
                            collapsedSessionParents.has(row.item.sessionKey)
                              ? "history.tree.expandChildren"
                              : "history.tree.collapseChildren",
                            { count: row.childCount }
                          )}
                          title={t(
                            collapsedSessionParents.has(row.item.sessionKey)
                              ? "history.tree.expandChildren"
                              : "history.tree.collapseChildren",
                            { count: row.childCount }
                          )}
                        >
                          {collapsedSessionParents.has(row.item.sessionKey) ? (
                            <CircleChevronRight size={19} strokeWidth={2.1} className="text-primary/90" />
                          ) : (
                            <CircleChevronDown size={19} strokeWidth={2.1} className="text-primary/90" />
                          )}
                        </button>
                      )}
                      {selectionMode && (
                        <SelectionCheckbox
                          checked={selectedSessionKeys.has(row.item.sessionKey)}
                          title={t("history.bulk.selectSessionNamed", { title: row.item.displayTitle })}
                          ariaLabel={t("history.bulk.selectSessionNamed", { title: row.item.displayTitle })}
                          onToggle={() => onToggleSessionSelection(row.item.sessionKey)}
                        />
                      )}
                      {selectionMode ? (
                        <div className="min-w-0 flex-1 overflow-hidden text-left">
                          <div className="flex min-w-0 items-center gap-1.5">
                            {row.item.starred && <Star size={12} className="shrink-0" style={{ color: "var(--warning)" }} fill="currentColor" />}
                            {row.depth > 0 && (
                              <span
                                className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em]"
                                style={{
                                  backgroundColor: "color-mix(in srgb, var(--primary) 16%, var(--surface-container-high) 84%)",
                                  border: "1px solid color-mix(in srgb, var(--primary) 34%, transparent)",
                                  color: "color-mix(in srgb, var(--primary) 72%, var(--text-primary) 28%)",
                                }}
                              >
                                <Bot size={10} strokeWidth={2.2} />
                                {t("history.tree.subagent")}
                              </span>
                            )}
                            <span className="truncate text-[13px] font-semibold text-text-primary">{row.item.displayTitle}</span>
                            {row.childCount > 0 && (
                              <span className="shrink-0 rounded-full border border-border/70 px-1.5 text-[10px] font-medium text-text-muted">
                                {t("history.tree.childCount", { count: row.childCount })}
                              </span>
                            )}
                          </div>
                          <div className="ui-dev-label mt-1 truncate text-[11px] text-text-muted">
                            {row.item.source} · {makeSessionLabel(row.item)} · {t("history.messageCount", { count: row.item.message_count })}
                          </div>
                          <div className="ui-dev-label mt-1 truncate text-[11px] text-text-muted">
                            {t("history.updatedAt", { time: formatTime(row.item.updated_at, language) })}
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onOpenSession(row.item.sessionKey)}
                          className="min-w-0 flex-1 overflow-hidden text-left"
                        >
                          <div className="flex min-w-0 items-center gap-1.5">
                            {row.item.starred && <Star size={12} className="shrink-0" style={{ color: "var(--warning)" }} fill="currentColor" />}
                            {row.depth > 0 && (
                              <span
                                className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em]"
                                style={{
                                  backgroundColor: "color-mix(in srgb, var(--primary) 16%, var(--surface-container-high) 84%)",
                                  border: "1px solid color-mix(in srgb, var(--primary) 34%, transparent)",
                                  color: "color-mix(in srgb, var(--primary) 72%, var(--text-primary) 28%)",
                                }}
                              >
                                <Bot size={10} strokeWidth={2.2} />
                                {t("history.tree.subagent")}
                              </span>
                            )}
                            <span className="truncate text-[13px] font-semibold text-text-primary">{row.item.displayTitle}</span>
                            {row.childCount > 0 && (
                              <span className="shrink-0 rounded-full border border-border/70 px-1.5 text-[10px] font-medium text-text-muted">
                                {t("history.tree.childCount", { count: row.childCount })}
                              </span>
                            )}
                          </div>
                          <div className="ui-dev-label mt-1 truncate text-[11px] text-text-muted">
                            {row.item.source} · {makeSessionLabel(row.item)} · {t("history.messageCount", { count: row.item.message_count })}
                          </div>
                          <div className="ui-dev-label mt-1 truncate text-[11px] text-text-muted">
                            {t("history.updatedAt", { time: formatTime(row.item.updated_at, language) })}
                          </div>
                        </button>
                      )}
                      {!selectionMode && (
                        <button
                          type="button"
                          onClick={() => onDeleteSession(row.item)}
                          className="ui-flat-action mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-danger/25 bg-danger/10 text-danger/85 hover:border-danger/40 hover:bg-danger/18 hover:text-danger"
                          aria-label={t("history.deleteSessionNamed", { title: row.item.displayTitle })}
                          title={t("history.deleteSession")}
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {row.type === "empty" && (
                  <div className="px-3 py-5 text-center">
                    <div className="text-xs font-semibold text-text-secondary">{emptySessionCopy.title}</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-text-muted">{emptySessionCopy.description}</div>
                  </div>
                )}

                {row.type === "loadMore" && (
                  <div className="p-2">
                    <button
                      onClick={onLoadMoreSessions}
                      className="ui-btn w-full"
                      aria-label={t("history.loadMore")}
                      disabled={loadingMoreSessions}
                    >
                      {loadingMoreSessions
                        ? t("history.loadingMore")
                        : loadMoreSessionMode === "local"
                          ? t("history.showMoreMatches", { visible: visibleSessionCount, total: filteredSessionCount })
                          : t("history.scanMore", { count: filteredSessionCount })}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {contextMenu && (
        <Portal>
          <div className="context-menu" style={{ left: menuX, top: menuY }} ref={contextMenuRef} role="menu">
            <button className="context-menu-item" role="menuitem" onClick={handleContextMenuResume}>
              <RefreshCw size={13} aria-hidden="true" />
              <span>{t("history.menu.resumeInTerminal")}</span>
            </button>
            <button className="context-menu-item danger" role="menuitem" onClick={handleContextMenuDelete}>
              <Trash2 size={13} aria-hidden="true" />
              <span>{t("common.delete")}</span>
            </button>
          </div>
        </Portal>
      )}

      <div
        onMouseDown={onStartResize}
        className="ui-history-resize-handle absolute bottom-0 right-0 top-0 z-10 w-1.5 cursor-col-resize transition-colors"
        style={{ opacity: 0.6 }}
      />
    </aside>
  );
}
