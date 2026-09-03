import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, ArrowLeftRight, BarChart3, Cpu, Folder, GitBranch } from "../icons";
import { TERM_PANEL, panelColorTint } from "../stats/termStatsUi";
import { ResizableTerminalPanelFrame } from "./ResizableTerminalPanelFrame";
import { SystemResourcesPanel } from "./SystemResourcesPanel";
import { ProviderQuickSwitchPanel } from "./ProviderQuickSwitchPanel";
import type { NativeProviderAppType } from "../settings/providers/nativeProviderTypes";
import { useI18n } from "../../lib/i18n";
import type { WorkspaceDockSide } from "../../lib/workspaceLayout";
import { TERMINAL_PANEL_WIDTH_DEFAULTS } from "../../stores/settingsStore";

const GitChangesPanel = lazy(() =>
  import("../git/GitChangesPanel").then((module) => ({ default: module.GitChangesPanel }))
);

const TerminalStatsPanel = lazy(() =>
  import("./TerminalStatsPanel").then((module) => ({ default: module.TerminalStatsPanel }))
);

const SessionReplayPanel = lazy(() =>
  import("./SessionReplayPanel").then((module) => ({ default: module.SessionReplayPanel }))
);

export type TerminalSidePanelTab = "stats" | "replay" | "git" | "files" | "providers" | "systemResources";

export const TERMINAL_SIDE_PANEL_TAB_ORDER: readonly TerminalSidePanelTab[] = [
  "stats",
  "systemResources",
  "replay",
  "git",
  "files",
  "providers",
];

interface TerminalSidePanelProps {
  open: boolean;
  dockSide: WorkspaceDockSide;
  activeTab: TerminalSidePanelTab;
  visibleTabs: readonly TerminalSidePanelTab[];
  activeSessionId: string | null;
  projectPath: string | null;
  projectId?: string | null;
  filesTabDisabled?: boolean;
  systemResourcesEnabled?: boolean;
  providerDefaultAppType?: NativeProviderAppType;
  filesPanelContent?: ReactNode;
  onTabChange: (tab: TerminalSidePanelTab) => void;
  onOpenProviderSettings?: () => void;
}

export function TerminalSidePanel({
  open,
  dockSide,
  activeTab,
  visibleTabs,
  activeSessionId,
  projectPath,
  projectId,
  filesTabDisabled = false,
  systemResourcesEnabled = false,
  providerDefaultAppType = "claude",
  filesPanelContent = null,
  onTabChange,
  onOpenProviderSettings,
}: TerminalSidePanelProps) {
  const { t } = useI18n();
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const expandedTabsWidthRef = useRef<number | null>(null);
  const [compactTabs, setCompactTabs] = useState(false);
  const statsEnabled = visibleTabs.includes("stats");
  const replayEnabled = visibleTabs.includes("replay");
  const gitEnabled = visibleTabs.includes("git");
  const filesEnabled = visibleTabs.includes("files");
  const providersEnabled = visibleTabs.includes("providers");
  const allTabs = [
    { key: "stats" as const, label: t("terminal.panel.sideStats"), color: TERM_PANEL.cyan, icon: <BarChart3 size={12} strokeWidth={1.8} /> },
    ...(systemResourcesEnabled
      ? [{ key: "systemResources" as const, label: t("terminal.panel.systemResources"), color: TERM_PANEL.green, icon: <Cpu size={12} strokeWidth={1.8} /> }]
      : []),
    { key: "replay" as const, label: t("terminal.panel.replay"), color: TERM_PANEL.magenta, icon: <Activity size={12} strokeWidth={1.8} /> },
    { key: "git" as const, label: t("terminal.panel.gitChanges"), color: TERM_PANEL.yellow, icon: <GitBranch size={12} strokeWidth={1.8} /> },
    { key: "files" as const, label: t("terminal.panel.files"), color: TERM_PANEL.blue, icon: <Folder size={12} strokeWidth={1.8} />, disabled: filesTabDisabled },
    { key: "providers" as const, label: t("terminal.panel.providers"), color: TERM_PANEL.green, icon: <ArrowLeftRight size={12} strokeWidth={1.8} /> },
  ];
  const tabs = allTabs.filter((tab) => visibleTabs.includes(tab.key));
  const tabLayoutKey = tabs.map((tab) => `${tab.key}:${tab.label}`).join("|");

  useEffect(() => {
    expandedTabsWidthRef.current = null;
    setCompactTabs(false);
  }, [tabLayoutKey]);

  useEffect(() => {
    if (!open) return;
    const tabList = tabListRef.current;
    if (!tabList || tabs.length === 0) return;

    const updateTabLayout = () => {
      if (compactTabs) {
        const expandedWidth = expandedTabsWidthRef.current;
        if (expandedWidth !== null && tabList.clientWidth >= expandedWidth) {
          setCompactTabs(false);
        }
        return;
      }

      const buttons = Array.from(tabList.querySelectorAll<HTMLElement>("[data-terminal-side-panel-tab]"));
      if (buttons.length === 0) return;

      const style = window.getComputedStyle(tabList);
      const gap = Number.parseFloat(style.columnGap) || 0;
      const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
      const requiredButtonWidth = Math.max(...buttons.map((button) => {
        const buttonStyle = window.getComputedStyle(button);
        const icon = button.querySelector<HTMLElement>("[data-terminal-side-panel-tab-icon]");
        const label = button.querySelector<HTMLElement>("[data-terminal-side-panel-tab-label]");
        const horizontalInsets =
          (Number.parseFloat(buttonStyle.paddingLeft) || 0)
          + (Number.parseFloat(buttonStyle.paddingRight) || 0)
          + (Number.parseFloat(buttonStyle.borderLeftWidth) || 0)
          + (Number.parseFloat(buttonStyle.borderRightWidth) || 0);
        const contentGap = Number.parseFloat(buttonStyle.columnGap) || 0;
        return horizontalInsets + (icon?.scrollWidth ?? 0) + contentGap + (label?.scrollWidth ?? 0);
      }));
      const requiredWidth = padding + requiredButtonWidth * buttons.length + gap * Math.max(0, buttons.length - 1);
      expandedTabsWidthRef.current = requiredWidth;

      if (tabList.clientWidth + 1 < requiredWidth) {
        setCompactTabs(true);
      }
    };

    updateTabLayout();
    const observer = new ResizeObserver(updateTabLayout);
    observer.observe(tabList);
    return () => observer.disconnect();
  }, [compactTabs, open, tabLayoutKey, tabs.length]);

  if (!open) return null;

  return (
    <ResizableTerminalPanelFrame
      widthKey="merged"
      defaultWidth={TERMINAL_PANEL_WIDTH_DEFAULTS.merged}
      dockSide={dockSide}
      resizeLabel={t("terminal.panel.resizeSideLabel")}
      resizeTitle={t("terminal.panel.resizeSideTitle")}
    >
      <div
        ref={tabListRef}
        className="flex shrink-0 gap-1 border-b px-2 py-1.5"
        style={{ backgroundColor: TERM_PANEL.bg, borderColor: TERM_PANEL.border }}
      >
        {tabs.map((tab) => {
          const selected = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              data-terminal-side-panel-tab
              type="button"
              onClick={() => onTabChange(tab.key)}
              disabled={tab.disabled}
              className="ui-focus-ring flex min-w-0 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded px-1.5 py-1 text-[11px] font-bold transition-colors"
              style={{
                color: selected ? tab.color : TERM_PANEL.dim,
                backgroundColor: selected ? panelColorTint(tab.color, 10) : "transparent",
                border: `1px solid ${selected ? panelColorTint(tab.color, 34) : "transparent"}`,
                opacity: tab.disabled ? 0.45 : 1,
              }}
              aria-pressed={selected}
              title={compactTabs ? tab.label : undefined}
            >
              <span data-terminal-side-panel-tab-icon className="shrink-0" style={{ color: tab.color }}>{tab.icon}</span>
              {!compactTabs && <span data-terminal-side-panel-tab-label className="min-w-0 truncate">{tab.label}</span>}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {statsEnabled && (
          <Suspense fallback={null}>
            <TerminalStatsPanel activeSessionId={activeSessionId} open={open} visible={activeTab === "stats"} embedded />
          </Suspense>
        )}
        {systemResourcesEnabled && (
          <SystemResourcesPanel open={open} visible={activeTab === "systemResources"} embedded />
        )}
        {replayEnabled && (
          <Suspense fallback={null}>
            <SessionReplayPanel activeSessionId={activeSessionId} open={open} visible={activeTab === "replay"} />
          </Suspense>
        )}
        {gitEnabled && activeTab === "git" && (
          <Suspense fallback={null}>
            <GitChangesPanel open={open} projectPath={projectPath} projectId={projectId} visible embedded />
          </Suspense>
        )}
        {filesEnabled && activeTab === "files" ? filesPanelContent : null}
        {providersEnabled && activeTab === "providers" && (
          <ProviderQuickSwitchPanel open={open} defaultAppType={providerDefaultAppType} onOpenSettings={onOpenProviderSettings} />
        )}
      </div>
    </ResizableTerminalPanelFrame>
  );
}
