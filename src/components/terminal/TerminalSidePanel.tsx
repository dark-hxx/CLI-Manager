import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, BarChart3, Cpu, Folder, GitBranch } from "../icons";
import { TERM_PANEL, getTerminalSidePanelSkinStyle, panelColorTint } from "../stats/termStatsUi";
import { SystemResourcesPanel } from "./SystemResourcesPanel";
import { useI18n } from "../../lib/i18n";
import {
  TERMINAL_PANEL_WIDTH_DEFAULTS,
  TERMINAL_PANEL_WIDTH_MAX,
  useSettingsStore,
  type TerminalPanelWidthKey,
} from "../../stores/settingsStore";

const GitChangesPanel = lazy(() =>
  import("../git/GitChangesPanel").then((module) => ({ default: module.GitChangesPanel }))
);

const TerminalStatsPanel = lazy(() =>
  import("./TerminalStatsPanel").then((module) => ({ default: module.TerminalStatsPanel }))
);

const SessionReplayPanel = lazy(() =>
  import("./SessionReplayPanel").then((module) => ({ default: module.SessionReplayPanel }))
);

export type TerminalSidePanelTab = "stats" | "replay" | "git" | "files" | "systemResources";

export const TERMINAL_SIDE_PANEL_TAB_ORDER: readonly TerminalSidePanelTab[] = [
  "stats",
  "systemResources",
  "replay",
  "git",
  "files",
];

interface TerminalSidePanelProps {
  open: boolean;
  activeTab: TerminalSidePanelTab;
  visibleTabs: readonly TerminalSidePanelTab[];
  activeSessionId: string | null;
  projectPath: string | null;
  projectId?: string | null;
  filesTabDisabled?: boolean;
  systemResourcesEnabled?: boolean;
  filesPanelContent?: ReactNode;
  onTabChange: (tab: TerminalSidePanelTab) => void;
}

const MERGED_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-side-panel-width";

const TERMINAL_STATS_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-stats-panel-width";
const TERMINAL_GIT_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-git-panel-width";
const TERMINAL_FILES_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-files-panel-width";
const TERMINAL_REPLAY_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-replay-panel-width";
const LEGACY_WIDTH_STORAGE_KEYS: Partial<Record<TerminalPanelWidthKey, string>> = {
  merged: MERGED_PANEL_WIDTH_STORAGE_KEY,
  stats: TERMINAL_STATS_PANEL_WIDTH_STORAGE_KEY,
  git: TERMINAL_GIT_PANEL_WIDTH_STORAGE_KEY,
  replay: TERMINAL_REPLAY_PANEL_WIDTH_STORAGE_KEY,
  files: TERMINAL_FILES_PANEL_WIDTH_STORAGE_KEY,
};

interface ResizableTerminalPanelFrameProps {
  widthKey: TerminalPanelWidthKey;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  resizeLabel: string;
  resizeTitle?: string;
  children: ReactNode;
}

function clampWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
}

function readLegacyStoredWidth(widthKey: TerminalPanelWidthKey, defaultWidth: number, minWidth: number, maxWidth: number): number | null {
  if (typeof window === "undefined") return null;
  const storageKey = LEGACY_WIDTH_STORAGE_KEYS[widthKey];
  if (!storageKey) return null;
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  if (storageKey === MERGED_PANEL_WIDTH_STORAGE_KEY && parsed === 243) return defaultWidth;
  return clampWidth(parsed, minWidth, maxWidth);
}

export function ResizableTerminalPanelFrame({
  widthKey,
  defaultWidth,
  minWidth = defaultWidth,
  maxWidth = TERMINAL_PANEL_WIDTH_MAX,
  resizeLabel,
  resizeTitle = resizeLabel,
  children,
}: ResizableTerminalPanelFrameProps) {
  const terminalSidePanelSkin = useSettingsStore((s) => s.terminalSidePanelSkin);
  const persistedWidth = useSettingsStore((s) => s.terminalPanelWidths[widthKey]);
  const updateSettings = useSettingsStore((s) => s.update);
  const [width, setWidth] = useState(() => clampWidth(persistedWidth ?? defaultWidth, minWidth, maxWidth));
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(defaultWidth);
  const pendingWidthRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (!dragging && persistedWidth !== widthRef.current) {
      setWidth(clampWidth(persistedWidth, minWidth, maxWidth));
    }
  }, [dragging, maxWidth, minWidth, persistedWidth]);

  useEffect(() => {
    if (persistedWidth !== defaultWidth) return;
    const legacyWidth = readLegacyStoredWidth(widthKey, defaultWidth, minWidth, maxWidth);
    if (legacyWidth === null || legacyWidth === persistedWidth) return;
    setWidth(legacyWidth);
    const current = useSettingsStore.getState().terminalPanelWidths;
    void updateSettings("terminalPanelWidths", { ...current, [widthKey]: legacyWidth });
  }, [defaultWidth, maxWidth, minWidth, persistedWidth, updateSettings, widthKey]);

  useEffect(() => {
    if (panelRef.current) {
      panelRef.current.style.width = `${width}px`;
    }
  }, [width]);

  useEffect(() => {
    if (!dragging) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const commitPendingWidth = () => {
      if (pendingWidthRef.current === null) return;
      widthRef.current = pendingWidthRef.current;
      if (panelRef.current) {
        panelRef.current.style.width = `${pendingWidthRef.current}px`;
      }
      frameRef.current = null;
    };

    const handleMouseMove = (event: MouseEvent) => {
      const rawWidth = dragStartWidthRef.current + dragStartXRef.current - event.clientX;
      const nextWidth = clampWidth(rawWidth, minWidth, maxWidth);
      pendingWidthRef.current = nextWidth;
      // Rebase at an edge so pointer overshoot never accumulates into a dead
      // zone. Reversing by one pixel must immediately move the panel away from
      // min/max instead of appearing stuck and then snapping back.
      if (rawWidth !== nextWidth) {
        dragStartWidthRef.current = nextWidth;
        dragStartXRef.current = event.clientX;
      }
      if (frameRef.current === null) {
        frameRef.current = window.requestAnimationFrame(commitPendingWidth);
      }
    };

    const handleMouseUp = () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      const finalWidth = clampWidth(pendingWidthRef.current ?? widthRef.current, minWidth, maxWidth);
      pendingWidthRef.current = null;
      widthRef.current = finalWidth;
      if (panelRef.current) {
        panelRef.current.style.width = `${finalWidth}px`;
      }
      setWidth(finalWidth);
      const current = useSettingsStore.getState().terminalPanelWidths;
      void updateSettings("terminalPanelWidths", { ...current, [widthKey]: finalWidth });
      setDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [dragging, maxWidth, minWidth, updateSettings, widthKey]);

  const handleResizeMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragStartXRef.current = event.clientX;
    const renderedWidth = panelRef.current?.getBoundingClientRect().width ?? widthRef.current;
    const initialWidth = clampWidth(renderedWidth, minWidth, maxWidth);
    dragStartWidthRef.current = initialWidth;
    pendingWidthRef.current = initialWidth;
    widthRef.current = initialWidth;
    setDragging(true);
  }, [maxWidth, minWidth]);

  return (
    <aside
      ref={panelRef}
      className="ui-terminal-side-panel-frame relative flex shrink-0 flex-col overflow-hidden border-l border-border font-mono"
      data-dragging={dragging ? "true" : undefined}
      style={{
        // Parent/content updates can re-render several times per second while
        // dragging. Always feed React the live imperative width so it never
        // writes the stale persisted width back and makes the panel bounce.
        width: dragging ? (pendingWidthRef.current ?? widthRef.current) : width,
        minWidth,
        maxWidth,
        ...getTerminalSidePanelSkinStyle(terminalSidePanelSkin),
        backgroundColor: TERM_PANEL.bg,
        borderColor: TERM_PANEL.border,
      }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={resizeLabel}
        title={resizeTitle}
        className={`absolute left-0 top-0 z-20 h-full w-2 -translate-x-1/2 cursor-col-resize transition-colors ${dragging ? "bg-primary/35" : "hover:bg-primary/25"}`}
        onMouseDown={handleResizeMouseDown}
      />
      {children}
    </aside>
  );
}

export function TerminalSidePanel({
  open,
  activeTab,
  visibleTabs,
  activeSessionId,
  projectPath,
  projectId,
  filesTabDisabled = false,
  systemResourcesEnabled = false,
  filesPanelContent = null,
  onTabChange,
}: TerminalSidePanelProps) {
  const { t } = useI18n();
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const expandedTabsWidthRef = useRef<number | null>(null);
  const [compactTabs, setCompactTabs] = useState(false);
  const statsEnabled = visibleTabs.includes("stats");
  const replayEnabled = visibleTabs.includes("replay");
  const gitEnabled = visibleTabs.includes("git");
  const filesEnabled = visibleTabs.includes("files");
  const allTabs = [
    { key: "stats" as const, label: t("terminal.panel.sideStats"), color: TERM_PANEL.cyan, icon: <BarChart3 size={12} strokeWidth={1.8} /> },
    ...(systemResourcesEnabled
      ? [{ key: "systemResources" as const, label: t("terminal.panel.systemResources"), color: TERM_PANEL.green, icon: <Cpu size={12} strokeWidth={1.8} /> }]
      : []),
    { key: "replay" as const, label: t("terminal.panel.replay"), color: TERM_PANEL.magenta, icon: <Activity size={12} strokeWidth={1.8} /> },
    { key: "git" as const, label: t("terminal.panel.gitChanges"), color: TERM_PANEL.yellow, icon: <GitBranch size={12} strokeWidth={1.8} /> },
    { key: "files" as const, label: t("terminal.panel.files"), color: TERM_PANEL.blue, icon: <Folder size={12} strokeWidth={1.8} />, disabled: filesTabDisabled },
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
      resizeLabel={t("terminal.panel.resizeSideLabel")}
      resizeTitle={t("terminal.panel.resizeSideTitle")}
    >
      <div
        ref={tabListRef}
        className="flex shrink-0 gap-1 border-b px-2 py-1.5"
        style={{ borderColor: TERM_PANEL.border }}
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
      </div>
    </ResizableTerminalPanelFrame>
  );
}
