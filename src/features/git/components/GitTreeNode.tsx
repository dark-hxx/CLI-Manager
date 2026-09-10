import { ChevronRight, Undo2, Check, Minus, FileCode, Trash2 } from "../../../shared/ui/icons";
import { useMemo, type PointerEvent as ReactPointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { collectFileChanges, collectCompactDirectoryChain, type GitDirectorySummary } from "../lib/gitTreeModel";
import { isTerminalFilePointerDragClickHandled, type TerminalFileDragSource } from "../../terminal/api/useTerminalFilePointerDrag";
import type { TerminalFileDragProject } from "../../terminal/api/terminalFileDrag";
import type { GitTreeNode } from "../../../shared/types/index";
import { GitStatusIcon } from "../api/GitStatusIcon";
import { useGitStore } from "../store/gitStore";
import { TERM, panelColorTint } from "../../stats/api/termStatsUi";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "../../../shared/ui/context-menu";
import { getMaterialFileIcon, getMaterialFolderIcon } from "@baybreezy/file-extension-icon";
import { StageCheckbox, type StageState } from "./StageCheckbox";
import { useI18n } from "../../../shared/i18n/index";
import { PathCopyMenu } from "../../files/api/PathCopyMenu";

interface GitTreeNodeProps {
  project: TerminalFileDragProject | null;
  node: GitTreeNode;
  depth: number;
  treeId: string;
  summary?: GitDirectorySummary;
  onMenuOpenChange: (open: boolean) => void;
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

export function GitTreeNodeComponent({ project, node, depth, treeId, summary, onMenuOpenChange, onFileClick, onOpenSourceFile, onRequestDiscard, onRequestDeleteUntracked, onToggleStage, onToggleStagePaths, onFilePointerDown, onFilePointerMove, onFilePointerUp, onFilePointerCancel }: GitTreeNodeProps) {
  const { t } = useI18n();
  const { suffixParts, leaf: displayNode } = useMemo(() => collectCompactDirectoryChain(node), [node]);
  const displayCollapseKey = `${treeId}:${displayNode.path}`;
  // 每行仅订阅自身的选择/折叠状态和稳定动作，不随分支状态或其它文件选择重绘。
  const { displayCollapsed, untrackedSelected, addedSelected, toggleDir, toggleUntrackedSelection,
    toggleAddedDeselection, setAddedDeselection } = useGitStore(useShallow(state => ({
    displayCollapsed: state.collapsedDirs.has(displayCollapseKey),
    untrackedSelected: state.selectedUntracked.has(node.path),
    addedSelected: !state.deselectedAdded.has(node.path),
    toggleDir: state.toggleDir,
    toggleUntrackedSelection: state.toggleUntrackedSelection,
    toggleAddedDeselection: state.toggleAddedDeselection,
    setAddedDeselection: state.setAddedDeselection,
  })));
  const iconDataUri = useMemo(() => node.type === "file" ? getMaterialFileIcon(node.name) : null, [node.type, node.name]);
  // 折叠 key 按分区前缀隔离：已跟踪树与未跟踪树同名目录互不影响。
  const indentPx = depth * 12 + 4;

  if (node.type === "file") {
    // 根据 Git 状态给文件名着色
    let fileNameColor = TERM.fg;
    if (node.change) {
      switch (node.change.status) {
        case "M":
          fileNameColor = TERM.blue;
          break;
        case "A":
          fileNameColor = TERM.green;
          break;
        case "D":
          fileNameColor = "#808080";
          break;
        case "U":
        case "??":
          fileNameColor = TERM.red;
          break;
        case "R":
          fileNameColor = TERM.magenta;
          break;
        default:
          fileNameColor = TERM.fg;
      }
    }

    // 已跟踪文件才可回滚；未跟踪(U/??)排除。
    const canDiscard = !!node.change && node.change.status !== "U" && node.change.status !== "??";
    // 未跟踪文件：复选框走前端「选中」态，勾选不立即 git add，提交时再统一 add。
    const isUntracked = node.change?.status === "U" || node.change?.status === "??";

    // 已加入跟踪(A)文件：复选框为「本次是否提交」选择态，取消勾选不会 unstage（保持跟踪）。
    const isAdded = node.change?.status === "A";

    return (
      <ContextMenu onOpenChange={onMenuOpenChange}>
        <ContextMenuTrigger asChild>
          <div
            className="group flex items-center gap-1.5 rounded py-0.5 px-1 cursor-pointer text-[13px]"
            draggable={false}
            style={{ paddingLeft: indentPx, backgroundColor: "transparent", height: 24 }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = panelColorTint(TERM.cyan, 13))}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
            onPointerDown={(event) => {
              if (event.target instanceof Element && event.target.closest("button")) return;
              onFilePointerDown(event, { path: node.path, kind: "file" });
            }}
            onPointerMove={onFilePointerMove}
            onPointerUp={onFilePointerUp}
            onPointerCancel={onFilePointerCancel}
            onClick={(event) => {
              if (isTerminalFilePointerDragClickHandled(event.currentTarget)) return;
              onFileClick(node.path);
            }}
          >
            {/* 占位对齐：文件行无 chevron，补一个等宽占位让复选框列与目录行对齐 */}
            <span className="inline-flex shrink-0" style={{ width: 10 }} aria-hidden="true" />
            <StageCheckbox
              state={
                isUntracked
                  ? untrackedSelected
                    ? "checked"
                    : "unchecked"
                  : isAdded
                    ? addedSelected
                      ? "checked"
                      : "unchecked"
                    : node.change?.staged
                      ? "checked"
                      : "unchecked"
              }
              onToggle={() => {
                if (!node.change) return;
                if (isUntracked) toggleUntrackedSelection([node.path]);
                else if (isAdded) toggleAddedDeselection([node.path]);
                else onToggleStage(node.path, node.change.staged);
              }}
              title={
                isUntracked
                  ? t("git.tree.includeOnCommit")
                  : isAdded
                    ? addedSelected
                      ? t("git.tree.uncheckAdded")
                      : t("git.tree.includeThisCommit")
                    : node.change?.staged
                      ? t("git.tree.unstageFile")
                      : t("git.tree.stageFile")
              }
            />
            <img
              src={iconDataUri ?? undefined}
              alt=""
              width={14}
              height={14}
              className="shrink-0"
              draggable={false}
              style={{ objectFit: "contain" }}
            />
            <span className="flex-1 truncate" style={{ color: fileNameColor }}>{node.name}</span>
            {canDiscard && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestDiscard(node.path, node.name, node.change!.status);
                }}
                className="ui-focus-ring shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                style={{ color: TERM.dim }}
                title={t("git.tree.revertFile")}
                aria-label={t("git.tree.revertFile")}
              >
                <Undo2 size={11} />
              </button>
            )}
            {node.change && (
              <>
                <GitStatusIcon status={node.change.status} size={12} />
                {(node.change.added > 0 || node.change.deleted > 0) && (
                  <span className="text-[11px]" style={{ color: TERM.dim }}>
                    {node.change.added > 0 && (
                      <span style={{ color: TERM.green }}>+{node.change.added}</span>
                    )}
                    {node.change.added > 0 && node.change.deleted > 0 && " "}
                    {node.change.deleted > 0 && (
                      <span style={{ color: TERM.red }}>-{node.change.deleted}</span>
                    )}
                  </span>
                )}
              </>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            className="flex items-center gap-2"
            disabled={!project || !node.change || node.change.status === "D"}
            onSelect={() => {
              if (project && node.change && node.change.status !== "D") onOpenSourceFile(node.path, node.change.status);
            }}
          >
            <FileCode size={12} />
            {t("git.tree.openSourceFile")}
          </ContextMenuItem>
          {project && <PathCopyMenu project={project} relativePath={node.path} kind="file" />}
          {isUntracked ? (
            <>
              {/* 未跟踪文件右键：真实「加入跟踪（git add）」立即操作（与复选框的「选中」区分开）。 */}
              <ContextMenuItem
                className="flex items-center gap-2"
                onSelect={() => {
                  if (node.change) onToggleStage(node.path, false);
                }}
              >
                <Check size={12} />
                {t("git.tree.trackFile")}
              </ContextMenuItem>
              <ContextMenuItem
                danger
                className="flex items-center gap-2"
                onSelect={() => onRequestDeleteUntracked([node.path], node.name)}
              >
                <Trash2 size={12} />
                {t("git.tree.deleteUntracked")}
              </ContextMenuItem>
            </>
          ) : (
            <ContextMenuItem
              className="flex items-center gap-2"
              onSelect={() => {
                if (node.change) onToggleStage(node.path, node.change.staged);
              }}
            >
              {node.change?.staged ? <Minus size={12} /> : <Check size={12} />}
              {node.change?.staged ? t("git.tree.unstageFile") : t("git.tree.stage")}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            danger
            disabled={!canDiscard}
            className="flex items-center gap-2"
            onSelect={() => {
              if (canDiscard) onRequestDiscard(node.path, node.name, node.change!.status);
            }}
          >
            <Undo2 size={12} />
            {t("git.tree.revertChanges")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  // 目录节点 - 使用 Material Design 文件夹图标。连续单子目录链在渲染层压缩，行为仍以链尾目录为准。
  // 模块根节点不压缩后缀（单独显示模块名），只压缩其内部的子目录链。
  const isModuleRoot = node.isModuleRoot === true;
  const hasChildren = !!displayNode.children?.length;
  const folderIconDataUri = getMaterialFolderIcon(node.name, !displayCollapsed);
  const total = summary?.total ?? 0;
  const dirAllUntracked = total > 0 && summary?.untracked === total;
  const checked = summary?.checked ?? 0;
  const dirTrackedState: StageState = checked === 0 ? "unchecked" : checked === total ? "checked" : "indeterminate";
  const dirState = dirTrackedState;

  // 目录级切换：未跟踪→切选中；改动→M/D/R 真实暂存切换 + A 文件仅切换勾选（不 unstage）。
  const handleDirToggle = () => {
    const dirFiles = collectFileChanges(displayNode);
    const dirModFiles = dirFiles.filter(f => f.status !== "A" && f.status !== "U" && f.status !== "??");
    const dirAddedFiles = dirFiles.filter(f => f.status === "A");
    if (dirFiles.length === 0) return;
    if (dirAllUntracked) {
      toggleUntrackedSelection(dirFiles.map((f) => f.path));
      return;
    }
    const makeChecked = dirTrackedState !== "checked"; // 部分/未选 → 全选；全选 → 全不选
    if (dirModFiles.length > 0) {
      // onToggleStagePaths(paths, allStaged): allStaged=true → 取消暂存；false → 暂存。
      onToggleStagePaths(dirModFiles.map((f) => f.path), !makeChecked);
    }
    if (dirAddedFiles.length > 0) {
      setAddedDeselection(dirAddedFiles.map((f) => f.path), !makeChecked);
    }
  };
  const directoryLabel = suffixParts.length > 0 ? `${node.name}/${suffixParts.join("/")}` : node.name;


  return (
    <div>
      <ContextMenu onOpenChange={onMenuOpenChange}>
        <ContextMenuTrigger asChild>
          <div
            className="flex items-center gap-1.5 rounded py-0.5 px-1 hover:bg-opacity-10 cursor-pointer text-[13px]"
            draggable={false}
            style={{
              paddingLeft: indentPx,
              height: 24,
              backgroundColor: "transparent",
              fontWeight: isModuleRoot ? 600 : 500,
            }}
            onPointerDown={(event) => {
              if (event.target instanceof Element && event.target.closest("button")) return;
              onFilePointerDown(event, { path: displayNode.path, kind: "directory" });
            }}
            onPointerMove={onFilePointerMove}
            onPointerUp={onFilePointerUp}
            onPointerCancel={onFilePointerCancel}
            onClick={(event) => {
              if (isTerminalFilePointerDragClickHandled(event.currentTarget)) return;
              toggleDir(displayCollapseKey);
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = panelColorTint(TERM.cyan, 13))}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
          >
            <span
              className="inline-flex items-center justify-center shrink-0 transition-transform"
              style={{
                transform: displayCollapsed ? "rotate(0deg)" : "rotate(90deg)",
                color: TERM.dim,
              }}
            >
              <ChevronRight size={10} strokeWidth={2} />
            </span>
            {total > 0 && (
              <StageCheckbox
                state={dirState}
                onToggle={handleDirToggle}
                title={dirAllUntracked ? t("git.tree.includeOnCommit") : dirState === "checked" ? t("git.tree.uncheckDirectory") : t("git.tree.checkDirectory")}
              />
            )}
            <img
              src={folderIconDataUri}
              alt=""
              width={14}
              height={14}
              className="shrink-0"
              draggable={false}
              style={{ objectFit: "contain" }}
            />
            <span className="flex min-w-0 flex-1 items-baseline gap-1 truncate">
              <span className="truncate" style={{ color: TERM.fg }}>{node.name}</span>
              {suffixParts.length > 0 && (
                <span className="truncate text-[12px] font-normal" style={{ color: TERM.dim }}>
                  /{suffixParts.join("/")}
                </span>
              )}
            </span>
            {hasChildren && (
              <span className="text-[11px] rounded px-1 py-0" style={{ color: TERM.dim, backgroundColor: panelColorTint(TERM.dim, 13) }}>
                {displayNode.children!.length}
              </span>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {project && <PathCopyMenu project={project} relativePath={displayNode.path} kind="directory" />}
          <ContextMenuItem
            className="flex items-center gap-2"
            disabled={total === 0}
            onSelect={() => {
              if (dirAllUntracked) {
                // 未跟踪目录右键：真实「加入跟踪」立即 git add 全部文件。
                onToggleStagePaths(collectFileChanges(displayNode).map((f) => f.path), false);
              } else {
                // 改动目录：M/D/R 真实切换暂存，A 文件仅切换勾选（不 unstage，保持跟踪）。
                handleDirToggle();
              }
            }}
          >
            {dirAllUntracked ? (
              <Check size={12} />
            ) : dirTrackedState === "checked" ? (
              <Minus size={12} />
            ) : (
              <Check size={12} />
            )}
            {dirAllUntracked
              ? t("git.tree.trackDirectory")
              : dirTrackedState === "checked"
                ? t("git.tree.uncheckDirectory")
                : t("git.tree.checkDirectory")}
          </ContextMenuItem>
          {dirAllUntracked && (
            <ContextMenuItem
              danger
              className="flex items-center gap-2"
              onSelect={() => onRequestDeleteUntracked(collectFileChanges(displayNode).map(f => f.path), directoryLabel)}
            >
              <Trash2 size={12} />
              {t("git.tree.deleteUntrackedDirectory")}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

    </div>
  );
}
