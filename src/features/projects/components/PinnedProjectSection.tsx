import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Project } from "../../../shared/types/index";
import { useI18n } from "../../../shared/i18n/index";
import { AlertTriangle, ChevronRight, Folder, Pin, Play } from "../../../shared/ui/icons";
import { NodeAppearanceIcon } from "../api/NodeAppearanceIcon";
import { resolveNodeAppearance } from "../api/nodeAppearance";
import { ProviderBadgeChip, preventSecondaryPointerFocus } from "./TreeNodeItem";
import { useTreeActions } from "./TreeContext";

interface PinnedProjectSectionProps {
  projects: Project[];
  density: "compact" | "comfortable";
}

// 置顶区复用 TreeActions，项目行不参加普通树拖拽，保证快捷入口与原项目行为一致。
export function PinnedProjectSection({ projects, density }: PinnedProjectSectionProps) {
  const { t } = useI18n();
  const actions = useTreeActions();
  const compact = density === "compact";
  const collapsed = actions.pinnedSectionCollapsed;

  if (projects.length === 0) return null;

  return (
    <section
      className={"ui-pinned-project-section ui-tree-group-shell " + (compact ? "is-compact" : "")}
      aria-label={t("sidebar.pinned.title")}
    >
      <button
        type="button"
        className={"ui-pinned-project-header ui-tree-node ui-tree-group ui-focus-ring flex items-center font-semibold cursor-pointer " + (
          compact ? "gap-1.5 py-1 text-[11px]" : "gap-2 py-1.5 text-[12px]"
        )}
        data-open={!collapsed ? "true" : "false"}
        aria-expanded={!collapsed}
        title={collapsed ? t("sidebar.pinned.expand") : t("sidebar.pinned.collapse")}
        onClick={actions.onTogglePinnedSection}
      >
        <span className="ui-tree-chevron">
          <ChevronRight
            size={12}
            strokeWidth={2}
            style={{ transition: "transform 150ms", transform: collapsed ? "rotate(0deg)" : "rotate(90deg)" }}
            aria-hidden="true"
          />
        </span>
        <span className="ui-tree-leading-icon ui-pinned-project-folder" aria-hidden="true">
          <Folder size={16} strokeWidth={1.6} />
          <Pin size={8} strokeWidth={2} fill="currentColor" />
        </span>
        <span className="ui-pinned-project-title flex-1 truncate text-left">{t("sidebar.pinned.title")}</span>
        <span
          className="ui-tree-meta-chip ui-tree-count-chip inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] leading-none font-normal"
          title={t("sidebar.tree.directoryProjectCount", { name: t("sidebar.pinned.title"), count: projects.length })}
          aria-label={t("sidebar.tree.directoryProjectCount", { name: t("sidebar.pinned.title"), count: projects.length })}
        >
          {projects.length > 99 ? "99+" : projects.length}
        </span>
      </button>

      {!collapsed && (
        <div className="ui-pinned-project-list tree-collapse" role="group" aria-label={t("sidebar.pinned.title")}>
          <div className={compact ? "ml-2 space-y-0.5 pb-0.5" : "ml-2.5 space-y-0.5 pb-1"}>
            {projects.map((project) => (
              <PinnedProjectItem key={"pinned:" + project.id} project={project} density={density} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function PinnedProjectItem({ project, density }: { project: Project; density: "compact" | "comfortable" }) {
  const { t } = useI18n();
  const actions = useTreeActions();
  const compact = density === "compact";
  const selected = actions.selectedId === project.id || actions.selectedProjectIds.has(project.id);
  const status = actions.getProjectStatus(project.id);
  const terminalCount = actions.getProjectTerminalCount(project.id);
  const pathInvalid = actions.isPathInvalid(project.id);
  const projectPinned = actions.isProjectPinned(project.id);
  const appearance = resolveNodeAppearance({ icon: project.icon, color: project.color });
  const providerBadge = actions.providerBadges[project.id];
  const rowStyle = {
    paddingLeft: compact ? 8 : 10,
    paddingRight: compact ? 8 : 10,
    ...(appearance.hasColor ? { "--node-accent": appearance.colorVar } : {}),
  } as CSSProperties;

  // 置顶行保留 Enter 打开、Space 选择的树节点语义；操作按钮单独处理点击。
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter") {
      event.preventDefault();
      actions.onOpenProject(project);
    } else if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      actions.onSelectProjectByKeyboard(project);
    }
  };

  return (
    <div
      className="ui-pinned-project-item"
      role="treeitem"
      data-tree-key={"pin:p:" + project.id}
      aria-level={1}
      aria-selected={selected}
      aria-label={t("sidebar.pinned.openProject", { name: project.name })}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDownCapture={preventSecondaryPointerFocus}
    >
      <div
        className={"ui-tree-node ui-tree-project ui-focus-ring flex items-center rounded-xl cursor-pointer group/item " + (
          compact ? "gap-1.5 py-1 text-[12px]" : "gap-2 py-1.5 text-[13px]"
        )}
        data-selected={selected ? "true" : "false"}
        data-status={status ?? "idle"}
        data-invalid={pathInvalid ? "true" : "false"}
        data-accent={appearance.hasColor ? "true" : undefined}
        style={rowStyle}
        title={project.path}
        onMouseDown={(event) => {
          if (event.button === 2) event.preventDefault();
        }}
        onClick={(event) => actions.onSelectProject(event, project)}
        onDoubleClick={() => actions.onOpenProject(project)}
        onContextMenu={(event) => actions.onContextMenuProject(event, project)}
      >
        <span className="ui-tree-leading-icon">
          <NodeAppearanceIcon
            mark={appearance.emoji}
            iconKey={appearance.iconKey}
            cliTool={project.cli_tool}
            fallback="terminal"
            size={14}
          />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="block truncate font-medium">{project.name}</span>
          {project.environment_type === "ssh" && !project.ssh_host_id && (
            <span
              className="ui-tree-warning-chip inline-flex shrink-0 items-center justify-center rounded-full"
              title={t("terminal.ssh.rebindRequired")}
              aria-label={t("terminal.ssh.rebindRequired")}
            >
              <AlertTriangle size={12} strokeWidth={1.5} />
            </span>
          )}
          {providerBadge && <ProviderBadgeChip badge={providerBadge} />}
          {terminalCount > 0 && (
            <span
              className="ui-tree-meta-chip inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] leading-none"
              title={t("sidebar.tree.terminalCount", { count: terminalCount })}
              aria-label={t("sidebar.tree.terminalCount", { count: terminalCount })}
            >
              {terminalCount}
            </span>
          )}
          {pathInvalid && (
            <span
              className="ui-tree-warning-chip inline-flex shrink-0 items-center justify-center rounded-full"
              title={t("sidebar.tree.pathMissing")}
              aria-label={t("sidebar.tree.pathMissing")}
            >
              <AlertTriangle size={12} strokeWidth={1.5} />
            </span>
          )}
        </span>
        <span
          className="ui-tree-item-actions flex shrink-0 items-center gap-0.5"
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className={"icon-btn ui-pinned-project-toggle " + (projectPinned ? "is-pinned" : "")}
            onClick={(event) => {
              event.stopPropagation();
              void actions.onToggleProjectPinned(project.id);
            }}
            title={projectPinned ? t("sidebar.pinned.unpin") : t("sidebar.pinned.pin")}
            aria-label={projectPinned ? t("sidebar.pinned.unpin") : t("sidebar.pinned.pin")}
            aria-pressed={projectPinned}
          >
            <Pin size={13} strokeWidth={1.7} fill={projectPinned ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              actions.onOpenProject(project);
            }}
            className="icon-btn"
            style={{ color: "var(--success)", opacity: 0.7 }}
            title={t("sidebar.tree.openTerminal")}
            aria-label={t("sidebar.tree.openTerminal")}
          >
            <Play size={14} strokeWidth={1.5} />
          </button>
        </span>
      </div>
    </div>
  );
}
