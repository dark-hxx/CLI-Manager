import { ChevronRight, Undo2, Check, Minus } from "../icons";
import type { GitTreeNode, GitFileChange } from "../../lib/types";
import { GitStatusIcon } from "./GitStatusIcon";
import { useGitStore } from "../../stores/gitStore";
import { TERM, panelColorTint } from "../stats/termStatsUi";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "../ui/context-menu";
import { getMaterialFileIcon, getMaterialFolderIcon } from "@baybreezy/file-extension-icon";
import { StageCheckbox, type StageState } from "./StageCheckbox";
import { useI18n } from "../../lib/i18n";

// 收集某节点下所有文件变更（含子目录），用于目录级三态勾选框与批量操作。
function collectFileChanges(node: GitTreeNode): GitFileChange[] {
  if (node.type === "file") return node.change ? [node.change] : [];
  return (node.children ?? []).flatMap(collectFileChanges);
}

// 压缩连续单子目录链：只改变显示层级，不改变原始树与真实文件路径。
// JetBrains 风格：当前目录独立成行，从它的唯一子目录开始向下收集连续单子目录链作为下一行的压缩后缀。
function collectCompactDirectoryChain(node: GitTreeNode): { suffixParts: string[]; leaf: GitTreeNode } {
  const suffixParts: string[] = [];
  let leaf = node;

  // 如果当前目录只有一个子目录（不是文件），开始收集压缩链
  if (leaf.type === "directory" && leaf.children?.length === 1 && leaf.children[0].type === "directory") {
    let current = leaf.children[0];
    suffixParts.push(current.name);
    leaf = current;

    // 继续向下收集，直到遇到分叉或文件
    while (leaf.children?.length === 1 && leaf.children[0].type === "directory") {
      const next = leaf.children[0];
      suffixParts.push(next.name);
      leaf = next;
    }
  }

  return { suffixParts, leaf };
}

interface GitTreeNodeProps {
  node: GitTreeNode;
  depth: number;
  treeId: string;
  onFileClick: (filePath: string) => void;
  onRequestDiscard: (path: string, name: string, status: string) => void;
  onToggleStage: (filePath: string, staged: boolean) => void;
  onToggleStagePaths: (paths: string[], allStaged: boolean) => void;
}

export function GitTreeNodeComponent({ node, depth, treeId, onFileClick, onRequestDiscard, onToggleStage, onToggleStagePaths }: GitTreeNodeProps) {
  const { t } = useI18n();
  const { collapsedDirs, toggleDir, selectedUntracked, toggleUntrackedSelection, deselectedAdded, toggleAddedDeselection, setAddedDeselection } = useGitStore();
  // 折叠 key 按分区前缀隔离：已跟踪树与未跟踪树同名目录互不影响。
  const indentPx = depth * 12 + 4;

  if (node.type === "file") {
    // 获取 Material Design 文件图标（base64 data URI）
    const iconDataUri = getMaterialFileIcon(node.name);

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
    const untrackedSelected = isUntracked && selectedUntracked.has(node.path);
    // 已加入跟踪(A)文件：复选框为「本次是否提交」选择态，取消勾选不会 unstage（保持跟踪）。
    const isAdded = node.change?.status === "A";
    const addedSelected = isAdded && !deselectedAdded.has(node.path);

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="group flex items-center gap-1.5 rounded py-0.5 px-1 cursor-pointer text-[13px]"
            style={{ paddingLeft: indentPx, backgroundColor: "transparent" }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = panelColorTint(TERM.cyan, 13))}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
            onClick={() => onFileClick(node.path)}
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
              src={iconDataUri}
              alt=""
              width={14}
              height={14}
              className="shrink-0"
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
          {isUntracked ? (
            // 未跟踪文件右键：真实「加入跟踪（git add）」立即操作（与复选框的「选中」区分开）。
            <ContextMenuItem
              className="flex items-center gap-2"
              onSelect={() => {
                if (node.change) onToggleStage(node.path, false);
              }}
            >
              <Check size={12} />
              {t("git.tree.trackFile")}
            </ContextMenuItem>
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
  const { suffixParts, leaf: displayNode } = isModuleRoot
    ? { suffixParts: [], leaf: node } // 模块根不压缩
    : collectCompactDirectoryChain(node);
  const displayCollapseKey = `${treeId}:${displayNode.path}`;
  const displayCollapsed = collapsedDirs.has(displayCollapseKey);
  const hasChildren = displayNode.children && displayNode.children.length > 0;
  const folderIconDataUri = getMaterialFolderIcon(node.name, !displayCollapsed);
  const dirFiles = collectFileChanges(displayNode);
  // 目录下全部为未跟踪文件时，复选框走「选中」态（与文件行一致）。
  const dirAllUntracked =
    dirFiles.length > 0 && dirFiles.every((f) => f.status === "U" || f.status === "??");
  const dirSelectedCount = dirAllUntracked
    ? dirFiles.filter((f) => selectedUntracked.has(f.path)).length
    : 0;
  const dirUntrackedState: StageState =
    dirSelectedCount === 0 ? "unchecked" : dirSelectedCount === dirFiles.length ? "checked" : "indeterminate";

  // 「改动」树目录：M/D/R 走真实暂存态，A 文件走「本次是否提交」选择态（取消不 unstage，保持跟踪）。
  const dirModFiles = dirFiles.filter((f) => f.status !== "A" && f.status !== "U" && f.status !== "??");
  const dirAddedFiles = dirFiles.filter((f) => f.status === "A");
  const dirCheckedCount =
    dirModFiles.filter((f) => f.staged).length + dirAddedFiles.filter((f) => !deselectedAdded.has(f.path)).length;
  const dirTrackedState: StageState =
    dirCheckedCount === 0 ? "unchecked" : dirCheckedCount === dirFiles.length ? "checked" : "indeterminate";
  // 目录复选框最终三态：未跟踪目录用选中态，否则用「改动」组合态。
  const dirState: StageState = dirAllUntracked ? dirUntrackedState : dirTrackedState;

  // 目录级切换：未跟踪→切选中；改动→M/D/R 真实暂存切换 + A 文件仅切换勾选（不 unstage）。
  const handleDirToggle = () => {
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

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="flex items-center gap-1.5 rounded py-0.5 px-1 hover:bg-opacity-10 cursor-pointer text-[13px]"
            style={{
              paddingLeft: indentPx,
              backgroundColor: "transparent",
              fontWeight: isModuleRoot ? 600 : 500,
            }}
            onClick={() => toggleDir(displayCollapseKey)}
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
            {dirFiles.length > 0 && (
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
          <ContextMenuItem
            className="flex items-center gap-2"
            disabled={dirFiles.length === 0}
            onSelect={() => {
              if (dirAllUntracked) {
                // 未跟踪目录右键：真实「加入跟踪」立即 git add 全部文件。
                onToggleStagePaths(dirFiles.map((f) => f.path), false);
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
        </ContextMenuContent>
      </ContextMenu>

      {!displayCollapsed && hasChildren && (
        <div>
          {displayNode.children!.map((child) => (
            <GitTreeNodeComponent key={child.path} node={child} depth={depth + 1} treeId={treeId} onFileClick={onFileClick} onRequestDiscard={onRequestDiscard} onToggleStage={onToggleStage} onToggleStagePaths={onToggleStagePaths} />
          ))}
        </div>
      )}
    </div>
  );
}
