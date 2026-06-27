import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BarChart3, Folder, GitBranch } from "../icons";
import { TERM_PANEL, getTerminalSidePanelSkinStyle, panelColorTint } from "../stats/termStatsUi";
import { TerminalStatsPanel } from "./TerminalStatsPanel";
import { useI18n } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settingsStore";

const GitChangesPanel = lazy(() =>
  import("../git/GitChangesPanel").then((module) => ({ default: module.GitChangesPanel }))
);

export type TerminalSidePanelTab = "stats" | "git" | "files";

interface TerminalSidePanelProps {
  open: boolean;
  activeTab: TerminalSidePanelTab;
  activeSessionId: string | null;
  projectPath: string | null;
  filesTabDisabled?: boolean;
  filesPanelContent?: ReactNode;
  onTabChange: (tab: TerminalSidePanelTab) => void;
}

const MERGED_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-side-panel-width";
const MERGED_PANEL_DEFAULT_WIDTH = 300;
const TERMINAL_PANEL_MAX_WIDTH = 500;

export const TERMINAL_STATS_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-stats-panel-width";
export const TERMINAL_GIT_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-git-panel-width";
export const TERMINAL_FILES_PANEL_WIDTH_STORAGE_KEY = "cli-manager:terminal-files-panel-width";
export const TERMINAL_STATS_PANEL_DEFAULT_WIDTH = 203;
export const TERMINAL_GIT_PANEL_DEFAULT_WIDTH = 196;
export const TERMINAL_FILES_PANEL_DEFAULT_WIDTH = 220;

interface ResizableTerminalPanelFrameProps {
  storageKey: string;
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

function readStoredWidth(storageKey: string, defaultWidth: number, minWidth: number, maxWidth: number): number {
  if (typeof window === "undefined") return defaultWidth;
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) return defaultWidth;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultWidth;
  if (storageKey === MERGED_PANEL_WIDTH_STORAGE_KEY && parsed === 243) return defaultWidth;
  return clampWidth(parsed, minWidth, maxWidth);
}

export function ResizableTerminalPanelFrame({
  storageKey,
  defaultWidth,
  minWidth = defaultWidth,
  maxWidth = TERMINAL_PANEL_MAX_WIDTH,
  resizeLabel,
  resizeTitle = resizeLabel,
  children,
}: ResizableTerminalPanelFrameProps) {
  const terminalSidePanelSkin = useSettingsStore((s) => s.terminalSidePanelSkin);
  const [width, setWidth] = useState(() => readStoredWidth(storageKey, defaultWidth, minWidth, maxWidth));
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
      if (panelRef.current) {
        panelRef.current.style.width = `${pendingWidthRef.current}px`;
      }
      frameRef.current = null;
    };

    const handleMouseMove = (event: MouseEvent) => {
      pendingWidthRef.current = clampWidth(dragStartWidthRef.current + dragStartXRef.current - event.clientX, minWidth, maxWidth);
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
      if (panelRef.current) {
        panelRef.current.style.width = `${finalWidth}px`;
      }
      setWidth(finalWidth);
      window.localStorage.setItem(storageKey, String(finalWidth));
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
  }, [dragging, maxWidth, minWidth, storageKey]);

  const handleResizeMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragStartXRef.current = event.clientX;
    dragStartWidthRef.current = widthRef.current;
    pendingWidthRef.current = widthRef.current;
    setDragging(true);
  }, []);

  return (
    <aside
      ref={panelRef}
      className="relative flex shrink-0 flex-col overflow-hidden border-l border-border font-mono"
      style={{
        width,
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
  activeSessionId,
  projectPath,
  filesTabDisabled = false,
  filesPanelContent = null,
  onTabChange,
}: TerminalSidePanelProps) {
  const { t } = useI18n();

  if (!open) return null;

  const tabs = [
    { key: "stats" as const, label: t("terminal.panel.sideStats"), icon: <BarChart3 size={12} strokeWidth={1.8} /> },
    { key: "git" as const, label: t("terminal.panel.gitChanges"), icon: <GitBranch size={12} strokeWidth={1.8} /> },
    { key: "files" as const, label: t("terminal.panel.files"), icon: <Folder size={12} strokeWidth={1.8} />, disabled: filesTabDisabled },
  ];

  return (
    <ResizableTerminalPanelFrame
      storageKey={MERGED_PANEL_WIDTH_STORAGE_KEY}
      defaultWidth={MERGED_PANEL_DEFAULT_WIDTH}
      resizeLabel={t("terminal.panel.resizeSideLabel")}
      resizeTitle={t("terminal.panel.resizeSideTitle")}
    >
      <div
        className="flex shrink-0 gap-1 border-b px-2 py-1.5"
        style={{ borderColor: TERM_PANEL.border }}
      >
        {tabs.map((tab) => {
          const selected = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onTabChange(tab.key)}
              disabled={tab.disabled}
              className="ui-focus-ring flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded px-2 py-1 text-[11px] font-bold transition-colors"
              style={{
                color: selected ? TERM_PANEL.cyan : TERM_PANEL.dim,
                backgroundColor: selected ? panelColorTint(TERM_PANEL.cyan, 10) : "transparent",
                border: `1px solid ${selected ? panelColorTint(TERM_PANEL.cyan, 34) : "transparent"}`,
                opacity: tab.disabled ? 0.45 : 1,
              }}
              aria-pressed={selected}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <TerminalStatsPanel activeSessionId={activeSessionId} open={open} visible={activeTab === "stats"} embedded />
        {activeTab === "git" && (
          <Suspense fallback={null}>
            <GitChangesPanel open={open} projectPath={projectPath} visible embedded />
          </Suspense>
        )}
        {activeTab === "files" ? filesPanelContent : null}
      </div>
    </ResizableTerminalPanelFrame>
  );
}
