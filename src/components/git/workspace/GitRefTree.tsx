import {
  ChevronDown,
  ChevronRight,
  Cloud,
  FolderTree,
  GitBranch,
  GitCompare,
  Copy,
  Eye,
  GitMerge,
  Pencil,
  Plus,
  Trash2,
  Upload,
  Search,
  Star,
  Tag,
} from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import type { GitBranchInfo, GitBranchStatus, GitTagInfo } from "../../../lib/types";
import type { WorktreeRecord } from "../../../lib/types";
import { useI18n } from "../../../lib/i18n";
import { TERM, panelColorTint } from "../../stats/termStatsUi";

interface GitRefTreeProps {
  branches: GitBranchInfo[];
  status: GitBranchStatus | null;
  tags: GitTagInfo[];
  loading: boolean;
  selectedBranchName?: string | null;
  onSelectBranch?: (branch: GitBranchInfo) => void;
  onBranchAction?: (action: GitBranchAction, branch: GitBranchInfo) => void;
  worktrees?: WorktreeRecord[];
  onCreateWorktree?: () => void;
  onOpenWorktree?: (worktree: WorktreeRecord) => void;
  onFinishWorktree?: (worktree: WorktreeRecord) => void;
  onRemoveWorktree?: (worktree: WorktreeRecord) => void;
  onRenameWorktree?: (worktree: WorktreeRecord) => void;
  onTagAction?: (action: GitTagAction, tag: string) => void;
  recentBranches?: string[];
  favoriteBranches?: string[];
  onToggleFavorite?: (branch: GitBranchInfo) => void;
}

export type GitBranchAction =
  | "checkout"
  | "compare-current"
  | "compare-worktree"
  | "history"
  | "copy-name"
  | "rename"
  | "delete"
  | "set-upstream"
  | "merge"
  | "rebase"
  | "create-branch";

export type GitTagAction = "checkout" | "create-branch" | "copy-name" | "push" | "delete";

function RefSection({
  icon,
  title,
  children,
  defaultOpen = true,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <button
        type="button"
        className="ui-focus-ring flex h-7 w-full items-center gap-1.5 px-2 text-left text-[11px] font-semibold"
        style={{ color: TERM.fg }}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {icon}
        <span className="truncate">{title}</span>
      </button>
      {open && children}
    </section>
  );
}

function RefRow({
  branch,
  current = false,
  selected = false,
  onSelect,
  onContextMenu,
  favorite = false,
  onToggleFavorite,
}: {
  branch: GitBranchInfo;
  current?: boolean;
  selected?: boolean;
  onSelect?: (branch: GitBranchInfo) => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>, branch: GitBranchInfo) => void;
  favorite?: boolean;
  onToggleFavorite?: (branch: GitBranchInfo) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="ui-focus-ring flex h-7 w-full items-center gap-1.5 px-3 pl-8 text-left text-[11px]"
      style={{
        color: current || selected ? TERM.cyan : TERM.fg,
        backgroundColor: current || selected
          ? panelColorTint(TERM.cyan, 10)
          : "transparent",
      }}
      title={branch.name}
      onClick={() => onSelect?.(branch)}
      onContextMenu={(event) => onContextMenu?.(event, branch)}
    >
      <GitBranch size={11} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{branch.name}</span>
      {onToggleFavorite && (
        <span
          role="button"
          tabIndex={0}
          className="ui-focus-ring rounded p-0.5"
          style={{ color: favorite ? TERM.yellow : TERM.dim }}
          onClick={(event) => { event.stopPropagation(); onToggleFavorite(branch); }}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onToggleFavorite(branch); } }}
          title={favorite ? t("git.branch.unfavorite") : t("git.branch.favorite")}
        >
          <Star size={10} fill={favorite ? "currentColor" : "none"} />
        </span>
      )}
    </button>
  );
}

function RefContextMenu({
  branch,
  x,
  y,
  t,
  onAction,
  onClose,
}: {
  branch: GitBranchInfo;
  x: number;
  y: number;
  t: ReturnType<typeof useI18n>["t"];
  onAction: (action: GitBranchAction) => void;
  onClose: () => void;
}) {
  const local = branch.branchType === "local";
  const items: { action: GitBranchAction; label: string; icon: React.ReactNode; disabled?: boolean; group: string }[] = [
    { action: "checkout", label: t("git.branch.context.checkout"), icon: <GitBranch size={12} />, group: "navigation" },
    { action: "history", label: t("git.branch.context.history"), icon: <Search size={12} />, group: "navigation" },
    { action: "compare-current", label: t("git.branch.context.compareCurrent"), icon: <GitCompare size={12} />, group: "compare" },
    { action: "compare-worktree", label: t("git.branch.context.compareWorktree"), icon: <Eye size={12} />, group: "compare" },
    { action: "merge", label: t("git.branch.context.merge"), icon: <GitMerge size={12} />, group: "integrate" },
    { action: "rebase", label: t("git.branch.context.rebase"), icon: <GitMerge size={12} />, group: "integrate" },
    { action: "create-branch", label: t("git.branch.context.createBranch"), icon: <GitBranch size={12} />, group: "manage" },
    { action: "rename", label: t("git.branch.context.rename"), icon: <Pencil size={12} />, disabled: !local, group: "manage" },
    { action: "set-upstream", label: t("git.branch.context.setUpstream"), icon: <Upload size={12} />, disabled: !local, group: "manage" },
    { action: "copy-name", label: t("git.branch.context.copyName"), icon: <Copy size={12} />, group: "manage" },
    { action: "delete", label: t("git.branch.context.delete"), icon: <Trash2 size={12} />, disabled: !local || branch.current, group: "danger" },
  ];
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} aria-hidden="true" />
      <div
        className="fixed z-50 min-w-[210px] overflow-hidden rounded border py-1 shadow-xl"
        style={{
          left: Math.min(x, window.innerWidth - 226),
          top: Math.max(8, Math.min(y, window.innerHeight - 390)),
          backgroundColor: TERM.bg,
          borderColor: TERM.dim,
        }}
        role="menu"
      >
        {items.map((item, index) => (
          <div key={item.action} className={index > 0 && items[index - 1].group !== item.group ? "mt-1 border-t pt-1" : ""} style={{ borderColor: TERM.border }}>
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35"
            style={{ color: item.action === "delete" ? TERM.red : TERM.fg }}
            onClick={() => { if (item.disabled) return; onAction(item.action); onClose(); }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
          </div>
        ))}
      </div>
    </>
  );
}

function TagContextMenu({
  tag,
  x,
  y,
  t,
  onAction,
  onClose,
}: {
  tag: string;
  x: number;
  y: number;
  t: ReturnType<typeof useI18n>["t"];
  onAction: (action: GitTagAction) => void;
  onClose: () => void;
}) {
  const items: { action: GitTagAction; label: string; icon: React.ReactNode; danger?: boolean }[] = [
    { action: "checkout", label: t("git.tag.checkout"), icon: <GitBranch size={12} /> },
    { action: "create-branch", label: t("git.tag.createBranch"), icon: <GitBranch size={12} /> },
    { action: "copy-name", label: t("git.branch.context.copyName"), icon: <Copy size={12} /> },
    { action: "push", label: t("git.tag.push"), icon: <Upload size={12} /> },
    { action: "delete", label: t("git.tag.delete"), icon: <Trash2 size={12} />, danger: true },
  ];
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} aria-hidden="true" />
      <div
        className="fixed z-50 min-w-[190px] overflow-hidden rounded border py-1 shadow-xl"
        style={{
          left: Math.min(x, window.innerWidth - 206),
          top: Math.max(8, Math.min(y, window.innerHeight - 196)),
          backgroundColor: TERM.bg,
          borderColor: TERM.dim,
        }}
        role="menu"
        aria-label={tag}
      >
        {items.map((item) => (
          <button
            key={item.action}
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-opacity hover:opacity-80"
            style={{ color: item.danger ? TERM.red : TERM.fg }}
            onClick={() => { onAction(item.action); onClose(); }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}

export function GitRefTree({
  branches,
  status,
  tags,
  loading,
  selectedBranchName,
  onSelectBranch,
  onBranchAction,
  worktrees = [],
  onCreateWorktree,
  onOpenWorktree,
  onFinishWorktree,
  onRemoveWorktree,
  onRenameWorktree,
  onTagAction,
  recentBranches = [],
  favoriteBranches = [],
  onToggleFavorite,
}: GitRefTreeProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  const [contextMenu, setContextMenu] = useState<{ branch: GitBranchInfo; x: number; y: number } | null>(null);
  const [tagContextMenu, setTagContextMenu] = useState<{ tag: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!contextMenu && !tagContextMenu) return;
    const close = () => { setContextMenu(null); setTagContextMenu(null); };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu, tagContextMenu]);
  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>, branch: GitBranchInfo) => {
    event.preventDefault();
    event.stopPropagation();
    onSelectBranch?.(branch);
    setContextMenu({ branch, x: event.clientX, y: event.clientY });
  };
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleBranches = useMemo(
    () =>
      normalizedFilter
        ? branches.filter((branch) =>
            branch.name.toLocaleLowerCase().includes(normalizedFilter),
          )
        : branches,
    [branches, normalizedFilter],
  );
  const visibleTags = useMemo(
    () =>
      normalizedFilter
        ? tags.filter((tag) =>
            tag.name.toLocaleLowerCase().includes(normalizedFilter),
          )
        : tags,
    [normalizedFilter, tags],
  );
  const localBranches = useMemo(
    () => visibleBranches.filter((branch) => branch.branchType === "local"),
    [visibleBranches],
  );
  const branchByName = useMemo(() => new Map(branches.map((branch) => [branch.name, branch])), [branches]);
  const favoriteSet = useMemo(() => new Set(favoriteBranches), [favoriteBranches]);
  const recentItems = useMemo(() => recentBranches.map((name) => branchByName.get(name)).filter((item): item is GitBranchInfo => Boolean(item)), [branchByName, recentBranches]);
  const favoriteItems = useMemo(() => favoriteBranches.map((name) => branchByName.get(name)).filter((item): item is GitBranchInfo => Boolean(item)), [branchByName, favoriteBranches]);
  const remoteGroups = useMemo(() => {
    const groups = new Map<string, GitBranchInfo[]>();
    visibleBranches
      .filter((branch) => branch.branchType === "remote")
      .forEach((branch) => {
        const remote =
          branch.remote ||
          branch.name.split("/")[0] ||
          t("git.workspace.remoteFallback");
        groups.set(remote, [...(groups.get(remote) ?? []), branch]);
      });
    return [...groups.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
  }, [t, visibleBranches]);

  return (
    <aside
      className="ui-thin-scroll h-full min-h-0 overflow-y-auto border-r"
      style={{ borderColor: TERM.border, backgroundColor: TERM.card }}
    >
      <div className="border-b px-3 py-2" style={{ borderColor: TERM.border }}>
        <div
          className="text-[10px] font-semibold uppercase"
          style={{ color: TERM.dim }}
        >
          {t("git.workspace.currentBranch")}
        </div>
        <div
          className="mt-1 flex items-center gap-1.5 text-xs"
          style={{ color: TERM.cyan }}
        >
          <GitBranch size={13} />
          <span className="truncate">
            {status?.detached
              ? t("git.workspace.detached")
              : status?.branch || t("git.workspace.noBranch")}
          </span>
        </div>
        <label
          className="mt-2 flex items-center rounded-sm border px-2"
          style={{ borderColor: TERM.border, backgroundColor: TERM.bg }}
        >
          <Search size={11} className="shrink-0" style={{ color: TERM.dim }} />
          <input
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-[10px] outline-none"
            placeholder={t("git.workspace.filterRefs")}
            aria-label={t("git.workspace.filterRefs")}
            style={{ color: TERM.fg }}
          />
        </label>
      </div>

      {loading && branches.length === 0 ? (
        <div className="px-3 py-4 text-[11px]" style={{ color: TERM.dim }}>
          {t("common.loading")}
        </div>
      ) : (
        <>
          {favoriteItems.length > 0 && (
            <RefSection icon={<Star size={12} />} title={t("git.workspace.favoriteBranches")}>
              {favoriteItems.map((branch) => <RefRow key={`favorite:${branch.name}`} branch={branch} current={branch.current} selected={selectedBranchName === branch.name} onSelect={onSelectBranch} onContextMenu={handleContextMenu} favorite onToggleFavorite={onToggleFavorite} />)}
            </RefSection>
          )}
          {recentItems.length > 0 && (
            <RefSection icon={<GitBranch size={12} />} title={t("git.workspace.recentBranches")} defaultOpen={false}>
              {recentItems.map((branch) => <RefRow key={`recent:${branch.name}`} branch={branch} current={branch.current} selected={selectedBranchName === branch.name} onSelect={onSelectBranch} onContextMenu={handleContextMenu} favorite={favoriteSet.has(branch.name)} onToggleFavorite={onToggleFavorite} />)}
            </RefSection>
          )}
          <RefSection
            icon={<GitBranch size={12} />}
            title={t("git.workspace.localBranches")}
          >
            {localBranches.length > 0 ? (
              localBranches.map((branch) => (
                <RefRow
                  key={branch.name}
                  branch={branch}
                  current={branch.current}
                  selected={selectedBranchName === branch.name}
                  onSelect={onSelectBranch}
                  onContextMenu={handleContextMenu}
                  favorite={favoriteSet.has(branch.name)}
                  onToggleFavorite={onToggleFavorite}
                />
              ))
            ) : (
              <div
                className="px-3 py-2 pl-8 text-[10px]"
                style={{ color: TERM.dim }}
              >
                {t("git.workspace.noRefs")}
              </div>
            )}
          </RefSection>

          <RefSection
            icon={<Cloud size={12} />}
            title={t("git.workspace.remotes")}
          >
            {remoteGroups.length > 0 ? (
              remoteGroups.map(([remote, remoteBranches]) => (
                <RefSection
                  key={remote}
                  icon={<Cloud size={11} />}
                  title={remote}
                  defaultOpen={false}
                >
                  {remoteBranches.map((branch) => (
                    <RefRow
                      key={branch.name}
                      branch={branch}
                      selected={selectedBranchName === branch.name}
                      onSelect={onSelectBranch}
                      onContextMenu={handleContextMenu}
                      favorite={favoriteSet.has(branch.name)}
                      onToggleFavorite={onToggleFavorite}
                    />
                  ))}
                </RefSection>
              ))
            ) : (
              <div
                className="px-3 py-2 pl-8 text-[10px]"
                style={{ color: TERM.dim }}
              >
                {t("git.workspace.noRefs")}
              </div>
            )}
          </RefSection>

          {visibleTags.length > 0 && (
            <RefSection
              icon={<Tag size={12} />}
              title={t("git.workspace.tags")}
              defaultOpen={false}
            >
              {visibleTags.map((tag) => (
                <div
                  key={tag.name}
                   className="group flex h-7 items-center gap-1.5 px-3 pl-8 text-[11px]"
                  style={{ color: TERM.fg }}
                  title={tag.message || tag.name}
                >
                  <Tag size={11} className="shrink-0" />
                   <button
                     type="button"
                     className="ui-focus-ring min-w-0 flex-1 truncate text-left"
                     style={{ color: TERM.fg }}
                     onContextMenu={(event) => {
                       event.preventDefault();
                       event.stopPropagation();
                       setTagContextMenu({ tag: tag.name, x: event.clientX, y: event.clientY });
                     }}
                     onClick={() => onTagAction?.("checkout", tag.name)}
                   >
                     {tag.name}
                   </button>
                   {onTagAction && (
                     <button
                       type="button"
                       className="ui-focus-ring rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                       style={{ color: TERM.red }}
                       onClick={() => onTagAction("delete", tag.name)}
                       title={t("git.tag.delete")}
                       aria-label={t("git.tag.delete")}
                     >
                       <Trash2 size={10} />
                     </button>
                   )}
                </div>
              ))}
            </RefSection>
          )}
          <RefSection
            icon={<FolderTreeIcon />}
            title={t("git.workspace.worktrees")}
          >
            <button
              type="button"
              className="ui-focus-ring flex w-full items-center gap-1.5 px-3 py-1.5 pl-8 text-left text-[11px]"
              style={{ color: TERM.green }}
              onClick={onCreateWorktree}
              disabled={!onCreateWorktree}
            >
              <PlusIcon />
              <span>{t("git.workspace.createWorktree")}</span>
            </button>
            {worktrees.length === 0 ? (
              <div className="px-3 py-2 pl-8 text-[10px]" style={{ color: TERM.dim }}>
                {t("git.workspace.noWorktrees")}
              </div>
            ) : worktrees.map((worktree) => (
              <div key={worktree.id} className="group flex min-w-0 items-center gap-1.5 px-3 py-1.5 pl-8 text-[10px]" title={worktree.path}>
                <GitBranch size={11} className="shrink-0" style={{ color: TERM.yellow }} />
                <button type="button" className="ui-focus-ring min-w-0 flex-1 truncate text-left" style={{ color: TERM.fg }} onClick={() => onOpenWorktree?.(worktree)}>
                  {worktree.name}
                </button>
                <button type="button" className="ui-focus-ring rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100" style={{ color: TERM.cyan }} onClick={() => onFinishWorktree?.(worktree)} title={t("git.workspace.finishWorktree")} aria-label={t("git.workspace.finishWorktree")}>
                  <GitMerge size={11} />
                </button>
                <button type="button" className="ui-focus-ring rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100" style={{ color: TERM.yellow }} onClick={() => onRenameWorktree?.(worktree)} title={t("git.workspace.renameWorktree")} aria-label={t("git.workspace.renameWorktree")}>
                  <Pencil size={11} />
                </button>
                <button type="button" className="ui-focus-ring rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100" style={{ color: TERM.red }} onClick={() => onRemoveWorktree?.(worktree)} title={t("git.workspace.removeWorktree")} aria-label={t("git.workspace.removeWorktree")}>
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </RefSection>
        </>
      )}
      {contextMenu && onBranchAction && (
        <RefContextMenu
          branch={contextMenu.branch}
          x={contextMenu.x}
          y={contextMenu.y}
          t={t}
          onAction={(action) => onBranchAction(action, contextMenu.branch)}
          onClose={() => setContextMenu(null)}
        />
      )}
      {tagContextMenu && onTagAction && (
        <TagContextMenu
          tag={tagContextMenu.tag}
          x={tagContextMenu.x}
          y={tagContextMenu.y}
          t={t}
          onAction={(action) => onTagAction(action, tagContextMenu.tag)}
          onClose={() => setTagContextMenu(null)}
        />
      )}
    </aside>
  );
}

function FolderTreeIcon() {
  return <FolderTree size={12} />;
}

function PlusIcon() {
  return <Plus size={12} />;
}
