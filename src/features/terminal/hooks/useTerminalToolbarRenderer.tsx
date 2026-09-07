import { useCallback, type CSSProperties, type ReactNode } from "react";
import {
  DndContext, DragOverlay, closestCenter, useSensors, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { useI18n } from "../../../shared/i18n/index";
import { CommandTemplatePanel } from "../../prompts/api/CommandTemplatePanel";
import { BackgroundTasksPanel, type BackgroundTaskMeta } from "../components/BackgroundTasksPanel";
import {
  Activity, ArrowLeftRight, Plus, ListClockIcon, Maximize2, Minimize2, BarChart3, GitBranch, Folder,
  Cpu,
} from "../../../shared/ui/icons";
import type { Project } from "../../../shared/types/index";
import { SortableToolbarButton, CpuCatIndicator } from "../components/TerminalToolbarControls";

interface TerminalToolbarContext {
  t: ReturnType<typeof useI18n>["t"];
  fullscreen: boolean;
  sessionHistoryShortcutHint: string;
  replayPanelActive: boolean;
  gitPanelActive: boolean;
  filesPanelActive: boolean;
  filePanelProject: Project | null;
  statsPanelActive: boolean;
  providersPanelActive: boolean;
  systemResourcesPanelActive: boolean;
  handleNewTab: () => void;
  terminalSidePanelSide: "left" | "right";
  terminalActionSidebarStyle: CSSProperties;
  onToggleFullscreen: (() => void) | undefined;
  handleToggleGlobalFullscreen: () => void;
  handleOpenHistoryTab: () => void;
  historyOpen: boolean;
  terminalToolbarVisibility: ReturnType<typeof useSettingsStore.getState>["terminalToolbarVisibility"];
  handleToggleReplayPanel: () => void;
  handleToggleGitChangesPanel: () => void;
  handleToggleFilesPanel: () => void;
  handleToggleStatsPanel: () => void;
  handleToggleProviderPanel: () => void;
  handleToggleSystemResourcesPanel: () => void;
  backgroundTasks: BackgroundTaskMeta[];
  refreshBackgroundTasks: () => Promise<void>;
  terminalPopoverStyle: CSSProperties;
  terminalToolbarOrder: string[];
  toolbarSensors: ReturnType<typeof useSensors>;
  handleToolbarDragStart: (event: DragStartEvent) => void;
  handleToolbarDragEnd: (event: DragEndEvent) => void;
  handleToolbarDragCancel: () => void;
  activeToolbarDragId: string | null;
  systemResourceMonitoringEnabled: boolean;
  cpuResourceCardVisible: boolean;
  sidePanelMerged: boolean;
}

export function useTerminalToolbarRenderer({
  t,
  fullscreen,
  sessionHistoryShortcutHint,
  replayPanelActive,
  gitPanelActive,
  filesPanelActive,
  filePanelProject,
  statsPanelActive,
  providersPanelActive,
  systemResourcesPanelActive,
  handleNewTab,
  terminalSidePanelSide,
  terminalActionSidebarStyle,
  onToggleFullscreen,
  handleToggleGlobalFullscreen,
  handleOpenHistoryTab,
  historyOpen,
  terminalToolbarVisibility,
  handleToggleReplayPanel,
  handleToggleGitChangesPanel,
  handleToggleFilesPanel,
  handleToggleStatsPanel,
  handleToggleProviderPanel,
  handleToggleSystemResourcesPanel,
  backgroundTasks,
  refreshBackgroundTasks,
  terminalPopoverStyle,
  terminalToolbarOrder,
  toolbarSensors,
  handleToolbarDragStart,
  handleToolbarDragEnd,
  handleToolbarDragCancel,
  activeToolbarDragId,
  systemResourceMonitoringEnabled,
  cpuResourceCardVisible,
  sidePanelMerged,
}: TerminalToolbarContext) {
  return useCallback(() => {
    const toolbarTooltips: Record<string, string> = {
      new: t("terminal.toolbar.newTerminal"),
      templates: t("commandTemplate.title"),
      fullscreen: fullscreen ? t("terminal.toolbar.exitImmersiveFullscreen") : t("terminal.toolbar.immersiveFullscreen"),
      sessionHistory: `${t("terminal.toolbar.sessionHistory")} (${sessionHistoryShortcutHint})`,
      replay: replayPanelActive ? t("terminal.toolbar.closeReplayPanel") : t("terminal.toolbar.openReplayPanel"),
      gitChanges: gitPanelActive ? t("terminal.toolbar.closeGit") : t("terminal.toolbar.openGit"),
      files:
        !filesPanelActive && !filePanelProject
          ? t("termStats.noProject")
          : filesPanelActive
            ? t("terminal.toolbar.closeFilesPanel")
            : t("terminal.toolbar.openFilesPanel"),
      stats: statsPanelActive ? t("terminal.toolbar.closeStatsPanel") : t("terminal.toolbar.openStatsPanel"),
      providers: providersPanelActive ? t("terminal.toolbar.closeProvidersPanel") : t("terminal.toolbar.openProvidersPanel"),
      systemResources: systemResourcesPanelActive
        ? t("terminal.toolbar.closeSystemResourcesPanel")
        : t("terminal.toolbar.openSystemResourcesPanel"),
      backgroundTasks: t("terminal.backgroundTasks.title"),
    };
    const buttonMap: Record<string, ReactNode> = {
      new: (
        <button
          onClick={handleNewTab}
          className="ui-focus-ring ui-icon-action ui-primary-action ui-action-new"
          aria-label={t("terminal.toolbar.newTerminal")}
        >
          <Plus size={15} strokeWidth={2} />
        </button>
      ),
      templates: (
        <CommandTemplatePanel
          popoverSide={terminalSidePanelSide === "left" ? "right" : "left"}
          toneClassName="ui-action-template"
          popoverStyle={terminalActionSidebarStyle}
        />
      ),
      fullscreen: onToggleFullscreen ? (
        <button
          onClick={handleToggleGlobalFullscreen}
          className="ui-focus-ring ui-icon-action ui-action-fullscreen"
          data-active={fullscreen ? "true" : "false"}
          aria-label={fullscreen ? t("terminal.toolbar.exitImmersiveFullscreen") : t("terminal.toolbar.enterImmersiveFullscreen")}
          aria-pressed={fullscreen}
        >
          {fullscreen ? <Minimize2 size={14} strokeWidth={1.8} /> : <Maximize2 size={14} strokeWidth={1.8} />}
        </button>
      ) : null,
      sessionHistory: (
        <button
          onClick={handleOpenHistoryTab}
          className="ui-focus-ring ui-icon-action ui-action-session-history"
          data-active={historyOpen ? "true" : "false"}
          aria-label={historyOpen ? t("terminal.toolbar.closeSessionHistory") : t("terminal.toolbar.openSessionHistory")}
          aria-controls="history-workspace"
          aria-expanded={historyOpen}
        >
          <ListClockIcon size={16} />
          {terminalToolbarVisibility.showText && <span>{t("terminal.toolbar.sessionHistory")}</span>}
        </button>
      ),
      replay: (
        <button
          onClick={handleToggleReplayPanel}
          className="ui-focus-ring ui-icon-action ui-action-replay"
          data-active={replayPanelActive ? "true" : "false"}
          aria-label={replayPanelActive ? t("terminal.toolbar.closeReplayPanel") : t("terminal.toolbar.openReplayPanel")}
          aria-pressed={replayPanelActive}
        >
          <Activity size={13} strokeWidth={1.8} />
          {terminalToolbarVisibility.showText && <span>{t("terminal.toolbar.replay")}</span>}
        </button>
      ),
      gitChanges: (
        <button
          onClick={handleToggleGitChangesPanel}
          className="ui-focus-ring ui-icon-action ui-action-git"
          data-active={gitPanelActive ? "true" : "false"}
          aria-label={gitPanelActive ? t("terminal.toolbar.closeGitPanel") : t("terminal.toolbar.openGitPanel")}
          aria-pressed={gitPanelActive}
        >
          <GitBranch size={13} strokeWidth={1.8} />
        </button>
      ),
      files: (
        <button
          onClick={handleToggleFilesPanel}
          disabled={!filesPanelActive && !filePanelProject}
          className="ui-focus-ring ui-icon-action ui-action-files"
          data-active={filesPanelActive ? "true" : "false"}
          aria-label={
            !filesPanelActive && !filePanelProject
              ? t("termStats.noProject")
              : filesPanelActive
                ? t("terminal.toolbar.closeFilesPanel")
                : t("terminal.toolbar.openFilesPanel")
          }
          aria-pressed={filesPanelActive}
        >
          <Folder size={13} strokeWidth={1.8} />
        </button>
      ),
      stats: (
        <button
          onClick={handleToggleStatsPanel}
          className="ui-focus-ring ui-icon-action ui-action-stats"
          data-active={statsPanelActive ? "true" : "false"}
          aria-label={statsPanelActive ? t("terminal.toolbar.closeStatsPanel") : t("terminal.toolbar.openStatsPanel")}
          aria-pressed={statsPanelActive}
        >
          <BarChart3 size={13} strokeWidth={1.8} />
        </button>
      ),
      providers: (
        <button
          onClick={handleToggleProviderPanel}
          className="ui-focus-ring ui-icon-action ui-action-providers"
          data-active={providersPanelActive ? "true" : "false"}
          aria-label={providersPanelActive ? t("terminal.toolbar.closeProvidersPanel") : t("terminal.toolbar.openProvidersPanel")}
          aria-pressed={providersPanelActive}
        >
          <ArrowLeftRight size={13} strokeWidth={1.8} />
        </button>
      ),
      systemResources: (
        <button
          onClick={handleToggleSystemResourcesPanel}
          className="ui-focus-ring ui-icon-action ui-action-system-resources"
          data-active={systemResourcesPanelActive ? "true" : "false"}
          aria-label={systemResourcesPanelActive ? t("terminal.toolbar.closeSystemResourcesPanel") : t("terminal.toolbar.openSystemResourcesPanel")}
          aria-pressed={systemResourcesPanelActive}
        >
          <Cpu size={13} strokeWidth={1.8} />
        </button>
      ),
      backgroundTasks: (
        <BackgroundTasksPanel
          tasks={backgroundTasks}
          onRefresh={refreshBackgroundTasks}
          showText={terminalToolbarVisibility.showText}
          popoverSide={terminalSidePanelSide === "left" ? "right" : "left"}
          popoverStyle={terminalPopoverStyle}
        />
      ),
    };

    const visibleButtons = terminalToolbarOrder
      .filter((key) => {
        if (key === "new") return true;
        if (key === "fullscreen" && !onToggleFullscreen) return false;
        if (key === "systemResources") {
          return terminalToolbarVisibility.systemResources === true;
        }
        if (key === "backgroundTasks") {
          return terminalToolbarVisibility.backgroundTasks === true;
        }
        return terminalToolbarVisibility[key as keyof typeof terminalToolbarVisibility] === true;
      })
      .map((key) => ({ id: key, element: buttonMap[key] }))
      .filter((btn): btn is { id: string; element: ReactNode } => btn.element != null);

    return (
      <DndContext
        sensors={toolbarSensors}
        collisionDetection={closestCenter}
        onDragStart={handleToolbarDragStart}
        onDragEnd={handleToolbarDragEnd}
        onDragCancel={handleToolbarDragCancel}
      >
        <nav
          className="ui-terminal-actions ui-terminal-action-sidebar flex shrink-0 flex-col items-center gap-2"
          aria-label={t("terminal.toolbar.actions")}
          data-show-text={terminalToolbarVisibility.showText ? "true" : undefined}
          data-dock-side={terminalSidePanelSide}
          style={terminalActionSidebarStyle}
        >
          <SortableContext items={visibleButtons.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            {visibleButtons.map((btn) => (
              <SortableToolbarButton
                key={btn.id}
                id={btn.id}
                isDragging={activeToolbarDragId === btn.id}
                tooltip={toolbarTooltips[btn.id]}
              >
                {btn.element}
              </SortableToolbarButton>
            ))}
          </SortableContext>
          <div className="ui-terminal-action-cat-slot">
            <CpuCatIndicator
              enabled={systemResourceMonitoringEnabled && cpuResourceCardVisible}
              active={systemResourcesPanelActive}
              onClick={handleToggleSystemResourcesPanel}
            />
          </div>
        </nav>
        <DragOverlay dropAnimation={null}>
          {activeToolbarDragId && buttonMap[activeToolbarDragId] ? (
            <div className="ui-terminal-action-drag-overlay cursor-grabbing" style={{ ...terminalActionSidebarStyle, opacity: 1 }}>
              {buttonMap[activeToolbarDragId]}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    );
  }, [
    activeToolbarDragId,
    backgroundTasks,
    cpuResourceCardVisible,
    fullscreen,
    filePanelProject,
    filesPanelActive,
    gitPanelActive,
    handleNewTab,
    handleOpenHistoryTab,
    handleToggleFilesPanel,
    handleToggleGitChangesPanel,
    handleToggleGlobalFullscreen,
    handleToggleReplayPanel,
    handleToggleStatsPanel,
    handleToggleProviderPanel,
    handleToggleSystemResourcesPanel,
    handleToolbarDragCancel,
    handleToolbarDragEnd,
    handleToolbarDragStart,
    historyOpen,
    onToggleFullscreen,
    replayPanelActive,
    refreshBackgroundTasks,
    sessionHistoryShortcutHint,
    sidePanelMerged,
    statsPanelActive,
    providersPanelActive,
    systemResourceMonitoringEnabled,
    systemResourcesPanelActive,
    t,
    terminalToolbarOrder,
    terminalToolbarVisibility,
    terminalActionSidebarStyle,
    terminalPopoverStyle,
    terminalSidePanelSide,
    toolbarSensors,
  ]);
}
