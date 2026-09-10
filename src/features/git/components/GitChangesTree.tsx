import { useEffect, useMemo, useState, type RefObject, type PointerEvent as ReactPointerEvent } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useGitStore } from "../store/gitStore";
import { collectCompactDirectoryChain, flattenGitRows, summarizeGitDirectories } from "../lib/gitTreeModel";
import { useI18n } from "../../../shared/i18n/index";
import { TERM } from "../../stats/api/termStatsUi";
import type { TerminalFileDragSource } from "../../terminal/api/useTerminalFilePointerDrag";
import type { TerminalFileDragProject } from "../../terminal/api/terminalFileDrag";
import type { GitTreeNode } from "../../../shared/types/index";
import { GitTreeNodeComponent } from "./GitTreeNode";

interface GitChangesTreeProps {
  project: TerminalFileDragProject | null;
  tree: GitTreeNode[];
  untrackedTree: GitTreeNode[];
  scrollElementRef: RefObject<HTMLDivElement | null>;
  onFileClick: (filePath: string) => void;
  onOpenSourceFile: (filePath: string, status: string) => void;
  onRequestDiscard: (path: string, name: string, status: string) => void;
  onRequestDeleteUntracked: (paths: string[], name: string) => void;
  onToggleStage: (filePath: string, staged: boolean) => void;
  onToggleStagePaths: (paths: string[], allStaged: boolean) => void;
  onFilePointerDown: (event: ReactPointerEvent<HTMLElement>, source: TerminalFileDragSource) => void;
  onFilePointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onFilePointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onFilePointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

// 两个分区共用父级滚动容器，挂载量只取决于视口；交互中的行暂留，避免菜单/拖拽被回收。
export function GitChangesTree({ tree, untrackedTree, scrollElementRef, ...actions }: GitChangesTreeProps) {
  const { t } = useI18n();
  const collapsed = useGitStore(state => state.collapsedDirs);
  const selected = useGitStore(state => state.selectedUntracked);
  const deselected = useGitStore(state => state.deselectedAdded);
  const rows = useMemo(() => flattenGitRows(tree, untrackedTree, collapsed), [tree, untrackedTree, collapsed]);
  const summaries = useMemo(() => summarizeGitDirectories([...tree, ...untrackedTree], selected, deselected),
    [tree, untrackedTree, selected, deselected]);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [pointerKey, setPointerKey] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  // 父容器与树同次挂载时，子组件布局 effect 可能早于父 ref 赋值；提交后再绑定避免首屏空白。
  useEffect(() => { setScrollElement(scrollElementRef.current); }, [scrollElementRef]);
  const pinnedIndices = useMemo(() => {
    const keys = new Set([menuKey, pointerKey, focusKey]);
    return rows.flatMap((row, index) => keys.has(row.key) ? [index] : []);
  }, [rows, menuKey, pointerKey, focusKey]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 26,
    getItemKey: index => rows[index].key,
    overscan: 8,
    rangeExtractor: range => [...new Set([...defaultRangeExtractor(range), ...pinnedIndices])].sort((a, b) => a - b),
  });
  useEffect(() => {
    const release = () => setPointerKey(null);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
  }, []);
  // 筛选/折叠使列表缩短后，把旧的大偏移夹回有效区间，避免出现空白视口。
  useEffect(() => {
    const element = scrollElementRef.current;
    if (element) element.scrollTop = Math.min(element.scrollTop, Math.max(0, rows.length * 26 - element.clientHeight));
  }, [rows, scrollElementRef]);
  return (
    <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
      {virtualizer.getVirtualItems().map(item => {
        const row = rows[item.index];
        return (
          <div key={row.key} data-git-change-row={row.key}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", height: item.size, transform: `translateY(${item.start}px)` }}
            onPointerDownCapture={() => setPointerKey(row.key)}
            onFocusCapture={() => setFocusKey(row.key)}
            onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusKey(null); }}>
            {row.kind === "section" ? (
              <div className="px-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: TERM.dim, lineHeight: "24px" }}>
                {t(row.treeId === "tracked" ? "git.section.changed" : "git.section.untracked")}
              </div>
            ) : (
              <GitTreeNodeComponent {...actions} node={row.node} depth={row.depth} treeId={row.treeId}
                summary={summaries.get(collectCompactDirectoryChain(row.node).leaf)}
                onMenuOpenChange={open => setMenuKey(open ? row.key : null)} />
            )}
          </div>
        );
      })}
    </div>
  );
}
