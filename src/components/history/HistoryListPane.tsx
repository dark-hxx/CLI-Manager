import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowRightLeft, Bot, Check, ChevronDown, ChevronRight, Clock3, Folder, MessageSquare, RefreshCw, Search, Star, Terminal, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import type { Group, HistoryIndexStatus, HistorySearchHit, HistorySessionView, HistorySourceFilter, Project } from "../../lib/types";
import { useI18n } from "../../lib/i18n";
import { HISTORY_SOURCE_DESCRIPTORS, HISTORY_SOURCE_DESCRIPTOR_BY_ID } from "../../lib/historySources";
import { resolveCliToolIconKey, resolveHistorySourceIconKey } from "../../lib/cliTools";
import { findWorktreeByPath } from "../../lib/terminalProject";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { CliToolIcon } from "../CliToolIcon";
import { Portal } from "../ui/Portal";
import { Select } from "../ui/select";
import { buildHistorySessionChildMap, formatTime } from "./historyViewUtils";

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

function historyProjectPath(project: Project): string {
  return project.environment_type === "ssh" ? project.remote_path : project.path;
}

interface HistoryListPaneProps {
  historySidebarWidth: number;
  sidebarRef: RefObject<HTMLElement | null>;
  sessionListRef: RefObject<HTMLDivElement | null>;
  sourceFilter: HistorySourceFilter;
  projectPathFilter: string | null;
  projectIdFilter: string | null;
  scopedProjectPathFilter: string | null;
  projects: Project[];
  groups: Group[];
  globalQuery: string;
  favoriteOnly: boolean;
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
  indexStatus: HistoryIndexStatus;
  globalSearchRef: RefObject<HTMLInputElement | null>;
  selectionMode: boolean;
  selectedCount: number;
  allVisibleSelected: boolean;
  selectedSessionKeys: Set<string>;
  onRefresh: () => void;
  onClose: () => void;
  onSourceFilterChange: (value: HistorySourceFilter) => void;
  onProjectPathFilterChange: (value: string | null, projectId?: string | null) => void;
  onGlobalQueryChange: (value: string) => void;
  onFavoriteOnlyChange: (value: boolean) => void;
  onEnterSelectionMode: () => void;
  onCancelSelectionMode: () => void;
  onToggleSelectAllVisible: () => void;
  onToggleSessionSelection: (sessionKey: string) => void;
  onOpenSession: (sessionKey: string) => void;
  onResumeSession: (session: HistorySessionView) => void;
  canConvertSession: (session: HistorySessionView) => boolean;
  onConvertSession: (session: HistorySessionView) => void;
  onDeleteSession: (session: HistorySessionView) => void;
  onDeleteSelected: () => void;
  onOpenHit: (hit: HistorySearchHit) => void;
  onLoadMoreSessions: () => void;
  onSessionListScroll: () => void;
  onStartResize: (e: ReactMouseEvent) => void;
}

function rowHeight(row: HistoryListRow): number {
  if (row.type === "group" || row.type === "searchHeader" || row.type === "searching") return 32;
  if (row.type === "empty") return 88;
  if (row.type === "loading" || row.type === "loadMore") return 56;
  if (row.type === "searchHit") return 72;
  return row.depth > 0 ? 68 : 78;
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
  const icon = resolveCliToolIconKey(project.cli_tool);
  return icon ? <CliToolIcon icon={icon} size={size} /> : <Terminal size={size} strokeWidth={1.5} />;
}

function SessionSourceIcon({ source, size = 14 }: { source: string; size?: number }) {
  const icon = resolveHistorySourceIconKey(source);
  return icon ? <CliToolIcon icon={icon} size={size} /> : <Terminal size={size} strokeWidth={1.5} />;
}

function collectGroupIds(nodes: HistoryProjectTreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type !== "group") continue;
    out.push(node.group.id);
    collectGroupIds(node.children, out);
  }
  return out;
}

/** 找到选中项目的祖先分组 id，用于展开父节点。 */
function findAncestorGroupIds(
  nodes: HistoryProjectTreeNode[],
  match: (project: Project) => boolean,
  trail: string[] = [],
): string[] | null {
  for (const node of nodes) {
    if (node.type === "project") {
      if (match(node.project)) return trail;
      continue;
    }
    const found = findAncestorGroupIds(node.children, match, [...trail, node.group.id]);
    if (found) return found;
  }
  return null;
}

function normalizeProjectSearch(value: string): string {
  return value.trim().toLowerCase();
}

const IMAGE_TITLE_TOKEN_PATTERN = /<image\b[^>\r\n]*(?:>|$)|\[Image #\d+\]/gi;
const IMAGE_CLOSE_TOKEN_PATTERN = /<\/image>/gi;

function formatSessionListTitle(title: string, imageLabel: string): string {
  const normalizedTitle = title.replace(IMAGE_CLOSE_TOKEN_PATTERN, " ");
  const imageTokens = normalizedTitle.match(IMAGE_TITLE_TOKEN_PATTERN);
  if (!imageTokens || imageTokens.length === 0) return title;

  const onlyImages = normalizedTitle.replace(IMAGE_TITLE_TOKEN_PATTERN, "").trim().length === 0;
  let index = 0;
  const replacement = () => {
    index += 1;
    return `[${imageTokens.length === 1 ? imageLabel : `${imageLabel}${index}`}]`;
  };

  if (onlyImages) {
    return imageTokens.map(replacement).join("");
  }
  return normalizedTitle.replace(IMAGE_TITLE_TOKEN_PATTERN, replacement).replace(/\s+/g, " ").trim();
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
  projectIdFilter,
  scopedProjectPathFilter,
  projects,
  groups,
  globalQuery,
  favoriteOnly,
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
  indexStatus,
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
  onFavoriteOnlyChange,
  onEnterSelectionMode,
  onCancelSelectionMode,
  onToggleSelectAllVisible,
  onToggleSessionSelection,
  onOpenSession,
  onResumeSession,
  canConvertSession,
  onConvertSession,
  onDeleteSession,
  onDeleteSelected,
  onOpenHit,
  onLoadMoreSessions,
  onSessionListScroll,
  onStartResize,
}: HistoryListPaneProps) {
  const { t, language } = useI18n();
  const [contextMenu, setContextMenu] = useState<SessionContextMenu | null>(null);
  const [collapsedFilterGroups, setCollapsedFilterGroups] = useState<Set<string>>(new Set());
  const [collapsedSessionParents, setCollapsedSessionParents] = useState<Set<string>>(new Set());
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState("");
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const projectDropdownRef = useRef<HTMLDivElement | null>(null);
  const projectTreeScrollRef = useRef<HTMLDivElement | null>(null);
  const selectedProjectNodeRef = useRef<HTMLButtonElement | null>(null);
  const projectMenuWasOpenRef = useRef(false);
  const worktrees = useWorktreeStore((state) => state.worktrees);
  const globalQueryLength = [...globalQuery.trim()].length;
  const globalQueryTooShort = globalQueryLength > 0 && globalQueryLength < 3;
  const indexBusy = ["seeding", "scanning", "indexing"].includes(indexStatus.phase);
  const selectedSourceIcon = sourceFilter === "all" ? null : resolveHistorySourceIconKey(sourceFilter);

  const projectTree = useMemo(() => buildHistoryProjectTree(groups, projects), [groups, projects]);
  const selectedProject = useMemo(() => {
    if (projectIdFilter) {
      return projects.find((project) => project.id === projectIdFilter) ?? null;
    }
    if (!projectPathFilter) return null;
    return projects.find((project) => historyProjectPath(project) === projectPathFilter) ?? null;
  }, [projectIdFilter, projectPathFilter, projects]);
  const selectedWorktree = useMemo(
    () => findWorktreeByPath(worktrees, scopedProjectPathFilter ?? projectPathFilter),
    [projectPathFilter, scopedProjectPathFilter, worktrees]
  );
  const getSessionWorktree = useCallback(
    (session: HistorySessionView) => findWorktreeByPath(worktrees, session.cwd) ?? selectedWorktree,
    [selectedWorktree, worktrees]
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
  const selectedProjectMatch = useCallback((project: Project) => {
    if (projectIdFilter) return project.id === projectIdFilter;
    if (!projectPathFilter) return false;
    return historyProjectPath(project) === projectPathFilter;
  }, [projectIdFilter, projectPathFilter]);
  const selectedAncestorGroupIds = useMemo(() => {
    if (!projectPathFilter && !projectIdFilter) return [] as string[];
    return findAncestorGroupIds(projectTree, selectedProjectMatch) ?? [];
  }, [projectIdFilter, projectPathFilter, projectTree, selectedProjectMatch]);

  const emptySessionCopy = useMemo(() => {
    const sourceDescriptor = sourceFilter === "all" ? null : HISTORY_SOURCE_DESCRIPTOR_BY_ID.get(sourceFilter);
    const sourceLabel = sourceDescriptor ? t(sourceDescriptor.labelKey) : t("common.allSources");
    if (normalizedGlobal) {
      return {
        title: t("history.empty.noMatchesTitle"),
        description: t("history.empty.noMatchesDescription"),
      };
    }
    if (favoriteOnly) {
      return {
        title: t("history.empty.noFavoritesTitle"),
        description: t("history.empty.noFavoritesDescription"),
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
  }, [favoriteOnly, normalizedGlobal, projectPathFilter, selectedProjectLabel, sourceFilter, t]);

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
    (projectPath: string | null, projectId?: string | null) => {
      onProjectPathFilterChange(projectPath, projectId);
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

  const handleContextMenuConvert = useCallback(() => {
    if (!contextMenu) return;
    const session = contextMenu.session;
    setContextMenu(null);
    onConvertSession(session);
  }, [contextMenu, onConvertSession]);

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
      // 默认折叠全部，再展开选中项目的祖先链，方便一眼看到高亮项。
      const nextCollapsed = new Set(projectGroupIds);
      for (const groupId of selectedAncestorGroupIds) {
        nextCollapsed.delete(groupId);
      }
      setCollapsedFilterGroups(nextCollapsed);
    }
  }, [projectGroupIds, projectMenuOpen, selectedAncestorGroupIds]);

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

  useEffect(() => {
    if (!projectMenuOpen || normalizedProjectSearch) return;
    if (!projectPathFilter && !projectIdFilter) return;

    const frame = window.requestAnimationFrame(() => {
      const node = selectedProjectNodeRef.current;
      const scroller = projectTreeScrollRef.current;
      if (!node || !scroller) return;

      const nodeTop = node.offsetTop - scroller.offsetTop;
      const targetTop = nodeTop - Math.max(0, (scroller.clientHeight - node.offsetHeight) / 2);
      scroller.scrollTo({
        top: Math.max(0, targetTop),
        behavior: "auto",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [normalizedProjectSearch, projectIdFilter, projectMenuOpen, projectPathFilter, selectedAncestorGroupIds]);

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
    measureElement: (element) => element.getBoundingClientRect().height,
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

    const projectPath = historyProjectPath(node.project);
    const selected = selectedProjectMatch(node.project);
    return (
      <button
        key={`project:${node.project.id}`}
        ref={selected ? selectedProjectNodeRef : undefined}
        type="button"
        onClick={() => handleProjectFilterChange(
          selected ? null : projectPath,
          selected ? null : node.project.id,
        )}
        className="ui-tree-node ui-tree-project ui-focus-ring flex h-7 w-full items-center gap-1.5 rounded-lg pr-2 text-left text-[12px]"
        data-selected={selected ? "true" : "false"}
        style={{ paddingLeft }}
        title={projectPath}
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
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xl border border-border/60 bg-surface-container-lowest p-1">
            {selectedSourceIcon && (
              <span className="ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-primary">
                <CliToolIcon icon={selectedSourceIcon} size={13} />
              </span>
            )}
            <Select
              value={sourceFilter}
              onChange={(event) => onSourceFilterChange(event.target.value as HistorySourceFilter)}
              aria-label={t("history.filter.source")}
              className="h-8 min-w-0 flex-1 border-0 bg-transparent px-2 text-[11px] font-semibold shadow-none"
            >
              <option value="all">{t("history.filter.all")}</option>
              {HISTORY_SOURCE_DESCRIPTORS.map((descriptor) => (
                <option key={descriptor.id} value={descriptor.id}>
                  {t(descriptor.labelKey)}
                </option>
              ))}
            </Select>
          </div>

          <button
            onClick={onRefresh}
            aria-label={t("history.refreshList")}
            className="ui-flat-action ui-toolbar-button-compact ui-history-list-action h-8 w-8 shrink-0 px-0"
            title={t("history.refreshList")}
          >
            <RefreshCw size={12} className={indexBusy ? "animate-spin" : undefined} />
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
        {globalQueryTooShort && (
          <div className="px-3 pt-1 text-[10px] text-text-muted">{t("history.search.minimumChars")}</div>
        )}
        {indexBusy && (
          <div className="px-3 pt-1 text-[10px] text-text-muted">
            {t("history.index.progress", {
              indexed: indexStatus.indexedFiles,
              total: indexStatus.totalFiles,
            })}
          </div>
        )}
        {indexStatus.phase === "error" && (
          <div className="px-3 pt-1 text-[10px] text-danger">{t("history.index.error")}</div>
        )}

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
              <div
                ref={projectTreeScrollRef}
                className="ui-thin-scroll max-h-52 space-y-0.5 overflow-y-auto pr-1"
                role="tree"
                aria-label={t("history.projectFilter.treeAria")}
              >
                <button
                  type="button"
                  onClick={() => handleProjectFilterChange(null)}
                  className="ui-tree-node ui-tree-project ui-focus-ring flex h-7 w-full items-center gap-1.5 rounded-lg px-2 text-left text-[12px]"
                  data-selected={!projectPathFilter && !projectIdFilter ? "true" : "false"}
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
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => onFavoriteOnlyChange(!favoriteOnly)}
              aria-label={favoriteOnly ? t("history.favoriteFilter.showAll") : t("history.favoriteFilter.showOnly")}
              aria-pressed={favoriteOnly}
              className="ui-flat-action h-8 px-2 text-[11px]"
              title={favoriteOnly ? t("history.favoriteFilter.showAll") : t("history.favoriteFilter.showOnly")}
              style={{
                color: favoriteOnly ? "var(--warning)" : undefined,
                backgroundColor: favoriteOnly ? "color-mix(in srgb, var(--warning) 12%, transparent)" : undefined,
              }}
            >
              <Star size={12} fill={favoriteOnly ? "currentColor" : "none"} />
            </button>
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
            const sessionDisplayTitle =
              row.type === "session"
                ? formatSessionListTitle(row.item.displayTitle, t("history.imagePlaceholder"))
                : "";
            const sessionWorktree = row.type === "session" ? getSessionWorktree(row.item) : null;
            return (
              <div
                key={virtualRow.key}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute left-0 top-0 w-full"
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {row.type === "loading" && <div className="px-3 py-4 text-xs text-text-muted">{t("history.loadingSessions")}</div>}

                {row.type === "searching" && (
                  <div className="px-3 py-2 text-[11px] text-text-muted">{t("history.searching")}</div>
                )}

                {row.type === "searchHeader" && (
                  <div className="px-3 py-2 text-[11px] font-semibold text-text-muted">
                    {indexStatus.partial
                      ? t("history.searchHitsPartial", { count: row.count })
                      : t("history.searchHits", { count: row.count })}
                  </div>
                )}

                {row.type === "searchHit" && (
                  <button
                    onClick={() => onOpenHit(row.hit)}
                    className="ui-list-row w-full border-t border-border px-3 py-2 text-left"
                  >
                    <div className="truncate text-xs font-semibold text-text-primary">{row.hit.title}</div>
                    <div className="mt-0.5 truncate text-[11px] text-text-secondary">{row.hit.snippet}</div>
                    <div className="ui-dev-label mt-1 flex items-center gap-1.5 text-[10px] text-text-muted">
                      <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center text-primary">
                        <SessionSourceIcon source={row.hit.source} size={11} />
                      </span>
                      <span className="truncate">
                        {row.hit.source} · {row.hit.project_key} · {row.hit.role}
                      </span>
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
                        "ui-list-row group/session-row flex w-full items-center gap-2 border text-left",
                        row.depth > 0
                          ? "min-h-[58px] rounded-lg border-border/45 bg-surface-container-low px-2 py-1.5"
                          : "min-h-[68px] rounded-xl border-border/70 bg-surface-container-lowest px-2.5 py-2",
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
                          className="ui-history-tree-toggle mt-0.5"
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
                            <ChevronRight size={15} strokeWidth={2} />
                          ) : (
                            <ChevronDown size={15} strokeWidth={2} />
                          )}
                        </button>
                      )}
                      {selectionMode && (
                        <SelectionCheckbox
                          checked={selectedSessionKeys.has(row.item.sessionKey)}
                          title={t("history.bulk.selectSessionNamed", { title: sessionDisplayTitle })}
                          ariaLabel={t("history.bulk.selectSessionNamed", { title: sessionDisplayTitle })}
                          onToggle={() => onToggleSessionSelection(row.item.sessionKey)}
                        />
                      )}
                      {selectionMode ? (
                        <div className="min-w-0 flex-1 overflow-hidden text-left">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-primary">
                              <SessionSourceIcon source={row.item.source} size={14} />
                            </span>
                            {row.item.starred && <Star size={12} className="shrink-0" style={{ color: "var(--warning)" }} fill="currentColor" />}
                            {row.depth > 0 && (
                              <span
                                className="ui-history-subagent-badge"
                                role="img"
                                aria-label={t("history.tree.subagent")}
                                title={t("history.tree.subagent")}
                              >
                                <Bot size={12} strokeWidth={1.8} />
                              </span>
                            )}
                            {sessionWorktree && (
                              <span
                                className="shrink-0 rounded-full border border-primary/35 px-1.5 py-px text-[10px] font-semibold text-primary"
                                title={t("history.worktreeBadgeTitle", { name: sessionWorktree.name })}
                              >
                                {t("history.worktreeBadge")}
                              </span>
                            )}
                            <span className="truncate text-[13px] font-semibold text-text-primary">{sessionDisplayTitle}</span>
                            {row.childCount > 0 && (
                              <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-px text-[10px] font-medium text-text-muted">
                                {t("history.tree.childCount", { count: row.childCount })}
                              </span>
                            )}
                          </div>
                          <div className="ui-dev-label mt-1.5 flex min-w-0 items-center gap-2 text-[11px] text-text-muted">
                            <span className="inline-flex min-w-0 items-center gap-1">
                              <Clock3 size={11} className="shrink-0" />
                              <span className="truncate">{formatTime(row.item.updated_at, language)}</span>
                            </span>
                            <span className="inline-flex shrink-0 items-center gap-1">
                              <MessageSquare size={11} className="shrink-0" />
                              {t("history.messageCount", { count: row.item.message_count })}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onOpenSession(row.item.sessionKey)}
                          className="min-w-0 flex-1 overflow-hidden text-left"
                        >
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-primary">
                              <SessionSourceIcon source={row.item.source} size={14} />
                            </span>
                            {row.item.starred && <Star size={12} className="shrink-0" style={{ color: "var(--warning)" }} fill="currentColor" />}
                            {row.depth > 0 && (
                              <span
                                className="ui-history-subagent-badge"
                                role="img"
                                aria-label={t("history.tree.subagent")}
                                title={t("history.tree.subagent")}
                              >
                                <Bot size={12} strokeWidth={1.8} />
                              </span>
                            )}
                            {sessionWorktree && (
                              <span
                                className="shrink-0 rounded-full border border-primary/35 px-1.5 py-px text-[10px] font-semibold text-primary"
                                title={t("history.worktreeBadgeTitle", { name: sessionWorktree.name })}
                              >
                                {t("history.worktreeBadge")}
                              </span>
                            )}
                            <span className="truncate text-[13px] font-semibold text-text-primary">{sessionDisplayTitle}</span>
                            {row.childCount > 0 && (
                              <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-px text-[10px] font-medium text-text-muted">
                                {t("history.tree.childCount", { count: row.childCount })}
                              </span>
                            )}
                          </div>
                          <div className="ui-dev-label mt-1.5 flex min-w-0 items-center gap-2 text-[11px] text-text-muted">
                            <span className="inline-flex min-w-0 items-center gap-1">
                              <Clock3 size={11} className="shrink-0" />
                              <span className="truncate">{formatTime(row.item.updated_at, language)}</span>
                            </span>
                            <span className="inline-flex shrink-0 items-center gap-1">
                              <MessageSquare size={11} className="shrink-0" />
                              {t("history.messageCount", { count: row.item.message_count })}
                            </span>
                          </div>
                        </button>
                      )}
                      {!selectionMode && (
                        <button
                          type="button"
                          onClick={() => onDeleteSession(row.item)}
                          className="ui-history-row-delete"
                          aria-label={t("history.deleteSessionNamed", { title: sessionDisplayTitle })}
                          title={t("history.deleteSession")}
                        >
                          <X size={13} strokeWidth={1.9} />
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
            {canConvertSession(contextMenu.session) ? (
              <button className="context-menu-item" role="menuitem" onClick={handleContextMenuConvert}>
                <ArrowRightLeft size={13} aria-hidden="true" />
                <span>
                  {contextMenu.session.source === "claude"
                    ? t("history.menu.convertToCodex")
                    : t("history.menu.convertToClaude")}
                </span>
              </button>
            ) : null}
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
