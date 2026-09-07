import type { useTerminalTabsController } from "../hooks/useTerminalTabsController";
import { Suspense } from "react";
import { toast } from "sonner";
import { DndContext } from "@dnd-kit/core";
import { TERMINAL_PANEL_WIDTH_DEFAULTS } from "../../../stores/settingsStore";
import { SplitTerminalView } from "../../../components/SplitTerminalView";
import { SystemResourcesPanel } from "../../../components/terminal/SystemResourcesPanel";
import { TerminalSidePanel } from "../../../components/terminal/TerminalSidePanel";
import { ResizableTerminalPanelFrame } from "../../../components/terminal/ResizableTerminalPanelFrame";
import { TerminalWorkspaceFrame } from "../../../components/terminal/TerminalWorkspaceFrame";
import { ProviderQuickSwitchPanel } from "../../../components/terminal/ProviderQuickSwitchPanel";
import { WorktreeFinishDialog } from "../../../components/worktree/WorktreeFinishDialog";
import { FileExplorerSidebar } from "../../../components/files/FileExplorerSidebar";
import { Terminal } from "../../../components/icons";
import { EmptyState } from "../../../components/ui/EmptyState";
import { canSaveSessionToSidebar } from "../../../lib/saveSessionToSidebar";
import { ContextMenuItem } from "../../../components/ui/context-menu";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { WorkspanTabBar } from "../../../components/workspace/WorkspanTabBar";
import { WorkspanTerminalLayout } from "../../../components/workspace/WorkspanTerminalLayout";
import {
  HistoryWorkspace, GitChangesPanel, GitWorkspace, TerminalStatsPanel, SessionReplayPanel,
} from "./lazyTerminalPanels";
import { buildTerminalTabHoverInfo, terminalTabCollisionDetection } from "../lib/terminalTabsModel";
import { SortableWorkspanTab } from "./SortableTerminalTabs";
import { TerminalTabDragOverlay } from "./TerminalTabDragOverlay";
import { SplitProjectPicker, TerminalCloseConfirmBubble } from "./TerminalTabDialogs";

export function TerminalTabsView({
  fullscreen,
  historyActive,
  terminalWellStyle,
  promptDialog,
  confirmDialog,
  saveSessionDialog,
  splitPicker,
  projectTree,
  splitPickerMenuStyle,
  handleSplitEmpty,
  handleSplitProject,
  handleCloseSplitPicker,
  shouldIgnoreSplitPickerOutsideInteraction,
  closeConfirm,
  confirmCloseSessions,
  cancelCloseSessions,
  shouldIgnoreCloseConfirmOutsideInteraction,
  finishTarget,
  setFinishTarget,
  discardTarget,
  t,
  removeWorktree,
  setDiscardTarget,
  historyOpen,
  onOpenHistorySettings,
  gitWorkspaceOpen,
  gitWorkspaceHeight,
  beginGitWorkspaceResize,
  gitWorkspaceProject,
  gitWorkspaceProjectPath,
  closeGitWorkspace,
  handleOpenGitWorkspaceWorktree,
  terminalThemeTone,
  terminalSidePanelVisible,
  terminalSidePanelSide,
  sidePanelMerged,
  sidePanelOpen,
  sidePanelTab,
  visibleSidePanelTabs,
  panelSessionId,
  sidePanelProjectPath,
  panelSession,
  filePanelProject,
  panelProviderAppType,
  closeFilesPanel,
  handleSidePanelTabChange,
  onOpenProviderSettings,
  statsOpen,
  panelCapabilities,
  gitOpen,
  panelGitSupported,
  replayOpen,
  filesOpen,
  systemResourcesOpen,
  providersOpen,
  renderToolbarActions,
  visibleWorkspanLayouts,
  sensors,
  handleDragStart,
  handleDragOver,
  clearDragState,
  handleDragEnd,
  workspanTabBarPosition,
  workspanTabBarVisible,
  workspanEnabled,
  workspanTabModels,
  workspanTabOverflow,
  workspanTabListOpen,
  effectiveActiveWorkspanId,
  hasScopedTerminalFilter,
  workspanTabBarRef,
  workspanTabScrollRef,
  workspanDetachPreview,
  setWorkspanTabListOpen,
  activateWorkspanTab,
  handleCloseSessions,
  projectById,
  handleSubmitTabEdit,
  prompt,
  renameWorkspan,
  scopedSessionIds,
  handleRestoreWorkspanToSinglePane,
  handleSaveSessionToSidebar,
  mountedWorkspanLayouts,
  effectiveActiveSessionId,
  renderWorkspanLeaf,
  activeFullscreenPaneId,
  visibleSessions,
  useExternalTerminal,
  scopedEmptyState,
  sessions,
  handleNewTab,
}: ReturnType<typeof useTerminalTabsController>) {
  return (
    <div
      className="ui-terminal-tabs-shell flex h-full min-h-0 flex-col"
      data-fullscreen={fullscreen ? "true" : "false"}
      data-workspace-view={historyActive ? "history" : "terminal"}
      style={terminalWellStyle}
    >
      {promptDialog}
      {confirmDialog}
      {saveSessionDialog}
      <SplitProjectPicker
        picker={splitPicker}
        tree={projectTree}
        menuStyle={splitPickerMenuStyle}
        onSelectEmpty={handleSplitEmpty}
        onSelectProject={handleSplitProject}
        onClose={handleCloseSplitPicker}
        shouldIgnoreOutsideInteraction={shouldIgnoreSplitPickerOutsideInteraction}
      />
      <TerminalCloseConfirmBubble
        confirm={closeConfirm}
        menuStyle={splitPickerMenuStyle}
        onConfirm={confirmCloseSessions}
        onClose={cancelCloseSessions}
        shouldIgnoreOutsideInteraction={shouldIgnoreCloseConfirmOutsideInteraction}
      />
      <WorktreeFinishDialog
        open={!!finishTarget}
        project={finishTarget?.project ?? null}
        worktree={finishTarget?.worktree ?? null}
        onClose={() => setFinishTarget(null)}
      />
      <ConfirmDialog
        open={!!discardTarget}
        title={t("worktree.discard.title", { name: discardTarget?.worktree.name ?? "" })}
        message={t("worktree.discard.message", { branch: discardTarget?.worktree.branch ?? "" })}
        confirmText={t("worktree.discard.confirm")}
        cancelText={t("common.cancel")}
        danger
        onConfirm={() => {
          if (discardTarget) {
            void removeWorktree(discardTarget.worktree, true).catch((err) => {
              toast.error(t("worktree.toast.discardFailed"), { description: String(err) });
            });
          }
          setDiscardTarget(null);
        }}
        onClose={() => setDiscardTarget(null)}
      />

      <div className="relative flex-1 min-h-0 overflow-hidden">
        {historyOpen && (
          <div
            className={`absolute min-h-0 overflow-hidden ${fullscreen ? "inset-x-0 bottom-0 top-0" : "inset-x-3 bottom-3 top-3"}`}
            style={{ display: historyActive ? "block" : "none" }}
          >
            <Suspense fallback={null}>
              <HistoryWorkspace active={historyActive} onOpenSettings={onOpenHistorySettings} />
            </Suspense>
          </div>
        )}
        {gitWorkspaceOpen && (
          <div
            className={`absolute z-[2] min-h-0 overflow-hidden border-t shadow-2xl ${fullscreen ? "inset-x-0 bottom-0" : "inset-x-3 bottom-3"}`}
            style={{ height: gitWorkspaceHeight, borderColor: "var(--border-subtle, rgba(255,255,255,0.12))" }}
          >
            <div
              className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
              onPointerDown={beginGitWorkspaceResize}
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("git.workspace.resizeHeight")}
            />
            <Suspense fallback={null}>
              <GitWorkspace
                active={gitWorkspaceOpen}
                project={gitWorkspaceProject}
                projectPath={gitWorkspaceProjectPath}
                onClose={closeGitWorkspace}
                onOpenWorktreeSession={handleOpenGitWorkspaceWorktree}
              />
            </Suspense>
          </div>
        )}
        <div
          className="ui-terminal-well absolute inset-0 min-h-0 flex"
          data-terminal-mode="independent"
          data-terminal-theme-tone={terminalThemeTone}
          data-terminal-side-panel-visible={terminalSidePanelVisible ? "true" : "false"}
          style={{ display: historyActive ? "none" : "flex" }}
        >
          <TerminalWorkspaceFrame
            dockSide={terminalSidePanelSide}
            panels={[
              sidePanelMerged ? (
                <TerminalSidePanel
                  key="merged"
                  open={sidePanelOpen}
                  dockSide={terminalSidePanelSide}
                  activeTab={sidePanelTab}
                  visibleTabs={visibleSidePanelTabs}
                  activeSessionId={panelSessionId}
                  projectPath={sidePanelProjectPath}
                  projectId={panelSession?.projectId}
                  filesTabDisabled={!filePanelProject}
                  systemResourcesEnabled
                  providerDefaultAppType={panelProviderAppType}
                  filesPanelContent={<FileExplorerSidebar mode="panel" onClosePanel={closeFilesPanel} />}
                  onTabChange={handleSidePanelTabChange}
                  onOpenProviderSettings={onOpenProviderSettings}
                />
              ) : null,
              !sidePanelMerged && statsOpen && panelCapabilities.statistics ? (
                <ResizableTerminalPanelFrame
                  key="stats"
                  widthKey="stats"
                  defaultWidth={TERMINAL_PANEL_WIDTH_DEFAULTS.stats}
                  dockSide={terminalSidePanelSide}
                  resizeLabel={t("terminal.panel.resizeStatsLabel")}
                  resizeTitle={t("terminal.panel.resizeStatsTitle")}
                >
                  <Suspense fallback={null}>
                    <TerminalStatsPanel activeSessionId={panelSessionId} open={statsOpen} embedded />
                  </Suspense>
                </ResizableTerminalPanelFrame>
              ) : null,
              !sidePanelMerged && gitOpen && panelGitSupported ? (
                <ResizableTerminalPanelFrame
                  key="git"
                  widthKey="git"
                  defaultWidth={TERMINAL_PANEL_WIDTH_DEFAULTS.git}
                  dockSide={terminalSidePanelSide}
                  resizeLabel={t("terminal.panel.resizeGitLabel")}
                  resizeTitle={t("terminal.panel.resizeGitTitle")}
                >
                  <Suspense fallback={null}>
                    <GitChangesPanel open={gitOpen} projectPath={sidePanelProjectPath} projectId={panelSession?.projectId} embedded />
                  </Suspense>
                </ResizableTerminalPanelFrame>
              ) : null,
              !sidePanelMerged && replayOpen && panelCapabilities.history ? (
                <ResizableTerminalPanelFrame
                  key="replay"
                  widthKey="replay"
                  defaultWidth={TERMINAL_PANEL_WIDTH_DEFAULTS.replay}
                  dockSide={terminalSidePanelSide}
                  resizeLabel={t("terminal.panel.resizeReplayLabel")}
                  resizeTitle={t("terminal.panel.resizeReplayTitle")}
                >
                  <Suspense fallback={null}>
                    <SessionReplayPanel activeSessionId={panelSessionId} open={replayOpen} />
                  </Suspense>
                </ResizableTerminalPanelFrame>
              ) : null,
              !sidePanelMerged && filesOpen && panelCapabilities.files ? (
                <ResizableTerminalPanelFrame
                  key="files"
                  widthKey="files"
                  defaultWidth={TERMINAL_PANEL_WIDTH_DEFAULTS.files}
                  dockSide={terminalSidePanelSide}
                  resizeLabel={t("terminal.panel.resizeFilesLabel")}
                  resizeTitle={t("terminal.panel.resizeFilesTitle")}
                >
                  <FileExplorerSidebar mode="panel" onClosePanel={closeFilesPanel} />
                </ResizableTerminalPanelFrame>
              ) : null,
              !sidePanelMerged && systemResourcesOpen ? (
                <ResizableTerminalPanelFrame
                  key="systemResources"
                  widthKey="systemResources"
                  defaultWidth={TERMINAL_PANEL_WIDTH_DEFAULTS.systemResources}
                  dockSide={terminalSidePanelSide}
                  resizeLabel={t("terminal.panel.resizeSystemResourcesLabel")}
                  resizeTitle={t("terminal.panel.resizeSystemResourcesTitle")}
                >
                  <SystemResourcesPanel open={systemResourcesOpen} embedded />
                </ResizableTerminalPanelFrame>
              ) : null,
              !sidePanelMerged && providersOpen ? (
                <ResizableTerminalPanelFrame
                  key="providers"
                  widthKey="providers"
                  defaultWidth={TERMINAL_PANEL_WIDTH_DEFAULTS.providers}
                  dockSide={terminalSidePanelSide}
                  resizeLabel={t("terminal.panel.resizeProvidersLabel")}
                  resizeTitle={t("terminal.panel.resizeProvidersTitle")}
                >
                  <ProviderQuickSwitchPanel open={providersOpen} defaultAppType={panelProviderAppType} onOpenSettings={onOpenProviderSettings} />
                </ResizableTerminalPanelFrame>
              ) : null,
            ]}
            actions={renderToolbarActions()}
          >
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {visibleWorkspanLayouts.length > 0 ? (
              <DndContext
                sensors={sensors}
                collisionDetection={terminalTabCollisionDetection}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragCancel={clearDragState}
                onDragEnd={handleDragEnd}
              >
                <WorkspanTerminalLayout
                  position={workspanTabBarPosition}
                  tabBarVisible={workspanTabBarVisible}
                  tabBar={workspanEnabled ? (
                    <WorkspanTabBar
                    position={workspanTabBarPosition}
                    models={workspanTabModels}
                    overflow={workspanTabOverflow}
                    listOpen={workspanTabListOpen}
                    activeWorkspanId={effectiveActiveWorkspanId}
                    hasScopedTerminalFilter={hasScopedTerminalFilter}
                    menuStyle={splitPickerMenuStyle}
                    tabBarRef={workspanTabBarRef}
                    tabScrollRef={workspanTabScrollRef}
                    detachPreview={workspanDetachPreview}
                    onToggleList={setWorkspanTabListOpen}
                    onActivate={activateWorkspanTab}
                    onClose={(model, anchor) => handleCloseSessions(model.closeSessionIds, anchor)}
                    renderTab={(model, index) => (
                      <SortableWorkspanTab
                        key={model.workspan.id}
                        workspan={model.workspan}
                        title={model.title}
                        notification={model.notification}
                        vendor={model.vendor}
                        cliToolIcon={model.cliToolIcon}
                        hoverInfo={model.singleSession ? buildTerminalTabHoverInfo(model.singleSession, model.singleSession.projectId ? projectById.get(model.singleSession.projectId) : undefined) : undefined}
                        isActive={model.workspan.id === effectiveActiveWorkspanId}
                        dragDisabled={hasScopedTerminalFilter}
                        renameDisabled={!model.singleSession}
                        onActivate={() => activateWorkspanTab(model.workspan.id)}
                        onClose={(anchor) => handleCloseSessions(model.closeSessionIds, anchor)}
                        onRename={(title) => {
                          if (model.singleSession) void handleSubmitTabEdit(model.singleSession.id, title);
                        }}
                        menuStyle={splitPickerMenuStyle}
                        menuContent={(getAnchor) => (
                          <>
                            <ContextMenuItem onSelect={() => handleCloseSessions(model.closeSessionIds, getAnchor())}>
                              {t("terminal.workspan.closeCurrent")}
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => window.setTimeout(() => {
                              void prompt({
                                title: t("terminal.workspan.renamePrompt"),
                                initialValue: model.workspan.customTitle ?? "",
                                placeholder: t("terminal.workspan.renamePlaceholder"),
                                allowEmpty: true,
                              }).then((title) => {
                                if (title !== null) renameWorkspan(model.workspan.id, title);
                              });
                            }, 0)}>
                              {t("terminal.workspan.rename")}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={model.sessionIds.length <= 1 || Boolean(scopedSessionIds)}
                              title={scopedSessionIds ? t("terminal.workspan.restoreSinglePaneScopedDisabled") : undefined}
                              onSelect={() => handleRestoreWorkspanToSinglePane(model.workspan.id)}
                            >
                              {t("terminal.workspan.restoreSinglePane")}
                            </ContextMenuItem>
                            {/*
                              Reachability: in the default single-pane layout the pane-level tab bar
                              is hidden (hideTabBar when the workspan carries a single visible session),
                              so the pane-tab context menu that hosts the primary "Save session to
                              sidebar" item is unreachable. Mirror the item on the workspan-tab context
                              menu whenever the workspan carries a single session, so the feature stays
                              reachable from the visible tab in the default layout. Disabled with the
                              same tooltip semantics as the pane-menu twin.
                            */}
                            {(() => {
                              const singleSession = model.singleSession;
                              if (!singleSession) return null;
                              const saveProject = singleSession.projectId ? projectById.get(singleSession.projectId) ?? null : null;
                              const canSave = canSaveSessionToSidebar(singleSession, saveProject);
                              return (
                                <ContextMenuItem
                                  disabled={!canSave}
                                  onSelect={() => {
                                    // Same setTimeout(0) deferral as the pane-menu twin at
                                    // TerminalTabs.tsx ~line 1402 — avoids the Radix focus-restore
                                    // race that would blur the useAppPrompt Modal's autofocused input.
                                    window.setTimeout(() => handleSaveSessionToSidebar(singleSession), 0);
                                  }}
                                  title={!canSave ? t("saveSession.noSessionId") : undefined}
                                >
                                  {t("terminal.tab.saveSession")}
                                </ContextMenuItem>
                              );
                            })()}
                            <ContextMenuItem
                              disabled={workspanTabModels.length <= 1}
                              onSelect={() => handleCloseSessions(
                                workspanTabModels
                                  .filter((item) => item.workspan.id !== model.workspan.id)
                                  .flatMap((item) => item.closeSessionIds),
                                getAnchor()
                              )}
                            >
                              {t("terminal.workspan.closeOthers")}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={index === 0}
                              onSelect={() => handleCloseSessions(
                                workspanTabModels.slice(0, index).flatMap((item) => item.closeSessionIds),
                                getAnchor()
                              )}
                            >
                              {t("terminal.workspan.closeLeft")}
                            </ContextMenuItem>
                            <ContextMenuItem
                              disabled={index === workspanTabModels.length - 1}
                              onSelect={() => handleCloseSessions(
                                workspanTabModels.slice(index + 1).flatMap((item) => item.closeSessionIds),
                                getAnchor()
                              )}
                            >
                              {t("terminal.workspan.closeRight")}
                            </ContextMenuItem>
                          </>
                        )}
                      />
                    )}
                    />
                  ) : null}
                >
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  {mountedWorkspanLayouts.map((layout) => {
                    const layoutVisible = Boolean(layout.visiblePaneTree)
                      && layout.workspan.id === effectiveActiveWorkspanId;
                    const layoutActiveSessionId = layoutVisible
                      ? effectiveActiveSessionId
                      : layout.visiblePaneTree
                        ? layout.workspan.activeSessionId
                        : null;
                    return (
                      <div
                        key={layout.workspan.id}
                        className="absolute inset-0 min-h-0 min-w-0 overflow-hidden"
                        style={{ display: layoutVisible ? "block" : "none" }}
                        aria-hidden={layoutVisible ? undefined : "true"}
                      >
                        <SplitTerminalView
                          node={layout.paneTree}
                          visibleNode={layout.visiblePaneTree}
                          renderLeaf={(pane) => renderWorkspanLeaf(
                            pane,
                            layout.visiblePanes,
                            layoutActiveSessionId,
                            layoutVisible && layout.visiblePaneIds.has(pane.id)
                          )}
                          fullscreenLeafId={layoutVisible ? activeFullscreenPaneId : null}
                        />
                      </div>
                    );
                  })}
                </div>
                </WorkspanTerminalLayout>
                <TerminalTabDragOverlay style={terminalWellStyle} themeTone={terminalThemeTone} />
              </DndContext>
            ) : null}
            {hasScopedTerminalFilter && visibleSessions.length === 0 && !useExternalTerminal && scopedEmptyState && (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  icon={<Terminal size={40} strokeWidth={1} />}
                  title={scopedEmptyState.title}
                  description={scopedEmptyState.description}
                  tone="inverse"
                  action={scopedEmptyState.action}
                />
              </div>
            )}
            {sessions.length === 0 && !useExternalTerminal && !hasScopedTerminalFilter && (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  icon={<Terminal size={40} strokeWidth={1} />}
                  title={t("terminal.empty.title")}
                  description={t("terminal.empty.description")}
                  tone="inverse"
                  action={{ label: t("terminal.empty.action"), onClick: handleNewTab }}
                />
              </div>
            )}
          </div>
          </TerminalWorkspaceFrame>
        </div>
      </div>
    </div>
  );
}
