import type { useSidebarController } from "../hooks/useSidebarController";
import { sanitizeWorktreeTaskName, validateWorktreeTaskName } from "../../../stores/worktreeStore";
import { ConfigModal } from "../../../components/ConfigModal";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { ProviderSwitchModal } from "../../../components/ProviderSwitchModal";
import { WorktreeFinishDialog } from "../../../components/worktree/WorktreeFinishDialog";
import { getProviderSwitchAppType } from "../../../lib/providerSwitching";
import { projectSupportsCapability } from "../../../lib/projectCapabilities";
import { TreeContext } from "../../../components/sidebar/TreeContext";
import { Portal } from "../../../components/ui/Portal";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { toast } from "sonner";
import { logError } from "../../../lib/logger";
import { SidebarHeader } from "../../../components/sidebar/SidebarHeader";
import { ProjectTree } from "../../../components/sidebar/ProjectTree";
import { BatchShellDialog } from "../../../components/sidebar/BatchShellDialog";
import { GroupEditDialog } from "../../../components/sidebar/GroupEditDialog";
import { NodeAppearancePanel } from "../../../components/sidebar/NodeAppearancePanel";
import { SidebarFooter } from "../../../components/sidebar/SidebarFooter";
import { FileExplorerSidebar } from "../../../components/files/FileExplorerSidebar";
import { ArrowLeftRight, Check, CircleStop, Copy, FileCode, FolderOpen, FolderPlus, ListClockIcon, Palette, Pencil, Play, Plus, Settings, SquareSplitHorizontal, SquareSplitVertical, Terminal, TerminalSquare, Trash2, X } from "../../../components/icons";
import { buildProjectSplitOptions } from "../lib/sidebarModel";

export function SidebarView({
  sidebarElementRef,
  compactMode,
  sidebarResizing,
  sidebarDensity,
  dockSide,
  sidebarWidth,
  appConfirmDialog,
  sidebarCollapsed,
  projectFilter,
  sidebarProjectFilterVisible,
  projects,
  openProjectIds,
  toggleSidebarCollapsed,
  setProjectFilter,
  ensureSidebarExpanded,
  setNewGroupParentId,
  setAddToGroupId,
  setShowAdd,
  showFileExplorer,
  fileProject,
  handleBackToProjectTree,
  treeActions,
  displayedTree,
  initialLoading,
  loadError,
  newGroupParentId,
  projectScopedTerminalViewEnabled,
  terminalScope,
  handleSelectAllTerminalScope,
  handleCreateGroup,
  handleCancelNewGroup,
  setInitialLoading,
  loadProjects,
  expandSidebar,
  onOpenSettings,
  onOpenStats,
  sidebarToolbarVisibility,
  contextMenu,
  menuPos,
  contextMenuRef,
  showProjectBatchContextMenu,
  handleOpen,
  setContextMenu,
  t,
  useExternalTerminal,
  openProjectExternally,
  handleNewProjectTerminal,
  activeSessionId,
  handleSplitProject,
  handleCloneProject,
  handleToggleSelection,
  selectedProjectIds,
  openProjects,
  selectedProjects,
  setBatchShellPreselected,
  handleOpenProjectDirectory,
  handleOpenProjectFiles,
  handleOpenProjectHistory,
  setProviderSwitchTarget,
  setRenamingProjectId,
  setEditingProject,
  appearanceMenuOpen,
  setAppearanceMenuOpen,
  contextMenuProject,
  handleUpdateAppearance,
  selectedGroupIds,
  handleRequestDeleteSelection,
  handleRequestDeleteProject,
  handleOpenWorktree,
  handleNewWorktreeTerminal,
  rejectMissingWorktree,
  setFinishTarget,
  handleOpenWorktreeHistory,
  handleInstallWorktreeDeps,
  handleOpenWorktreeDirectory,
  handleOpenWorktreeFiles,
  handleToggleWorktreeSelection,
  selectedWorktreeIds,
  handleRequestDiscardSelectedWorktrees,
  setDiscardTarget,
  handleStartGroup,
  contextMenuGroupTerminalTargets,
  handleStopGroup,
  handleSelectGroupScope,
  handleToggleGroupSelection,
  handleAddProjectToGroup,
  handleRenameGroup,
  setEditingGroup,
  contextMenuGroup,
  handleRequestDeleteGroup,
  worktreePrompt,
  setWorktreePrompt,
  splitTerminal,
  closeHistory,
  openProjectDirect,
  updateProject,
  createAndSplitWorktree,
  createAndOpenWorktree,
  depsPrompt,
  depsPromptingWorktreeIdsRef,
  dismissWorktreeDepsPrompt,
  setDepsPrompt,
  openWorktreeSession,
  finishTarget,
  discardTarget,
  removeWorktree,
  discardTargets,
  setDiscardTargets,
  setSelectedWorktreeIds,
  showAdd,
  addToGroupId,
  cloningProject,
  setCloningProject,
  editingProject,
  editingGroup,
  groups,
  batchShellPreselected,
  providerSwitchTarget,
  providerSwitchProject,
  providerSwitchWorktree,
  confirmDialog,
  setConfirmAction,
  startResize,
}: ReturnType<typeof useSidebarController>) {
  return (
    <aside
      ref={sidebarElementRef}
      className={`ui-sidebar-shell relative flex select-none flex-col overflow-hidden ${
        compactMode ? "min-w-0 flex-1" : "shrink-0"
      } ${sidebarResizing ? "transition-none" : "transition-[width] duration-150"}`}
      data-sidebar-density={sidebarDensity}
      data-sidebar-side={dockSide}
      style={{ width: compactMode ? "100%" : sidebarWidth }}
    >
      {appConfirmDialog}
      <div className="ui-sidebar-top">
        <SidebarHeader
          collapsed={compactMode ? false : sidebarCollapsed}
          density={sidebarDensity}
          projectFilter={projectFilter}
          showProjectFilter={sidebarProjectFilterVisible}
          totalProjectCount={projects.length}
          openProjectCount={openProjectIds.size}
          onToggleCollapse={toggleSidebarCollapsed}
          dockSide={dockSide}
          onProjectFilterChange={setProjectFilter}
          onCreateGroup={() => {
            ensureSidebarExpanded();
            setNewGroupParentId("__root__");
          }}
          onCreateProject={() => {
            ensureSidebarExpanded();
            setAddToGroupId(null);
            setShowAdd(true);
          }}
        />
      </div>

      <div className={`${compactMode ? "min-h-[220px]" : "min-h-0"} flex-1 overflow-hidden`}>
        {showFileExplorer && fileProject && !sidebarCollapsed ? (
          <FileExplorerSidebar onBackToProjects={handleBackToProjectTree} />
        ) : (
          <TreeContext.Provider value={treeActions}>
            <div className="ui-sidebar-combined-list h-full min-h-0 overflow-y-auto overflow-x-hidden">
              <ProjectTree
                tree={displayedTree}
                initialLoading={initialLoading}
                loadError={loadError}
                collapsed={compactMode ? false : sidebarCollapsed}
                density={sidebarDensity}
                newGroupParentId={newGroupParentId}
                projectScopedTerminalViewEnabled={projectScopedTerminalViewEnabled}
                terminalScope={terminalScope}
                onSelectAllTerminalScope={handleSelectAllTerminalScope}
                onCreateRootGroup={(name, appearance) => handleCreateGroup(null, name, appearance)}
                onCancelRootGroup={handleCancelNewGroup}
                onQuickAddProject={() => {
                  ensureSidebarExpanded();
                  setAddToGroupId(null);
                  setShowAdd(true);
                }}
                onRetry={() => {
                  setInitialLoading(true);
                  void loadProjects();
                }}
                onExpandSidebar={expandSidebar}
                projectFilterActive={projectFilter === "open"}
                onClearProjectFilter={() => setProjectFilter("all")}
              />
            </div>
          </TreeContext.Provider>
        )}
      </div>

      <div className="ui-sidebar-footer shrink-0">
        <SidebarFooter
          collapsed={compactMode ? false : sidebarCollapsed}
          onOpenSettings={onOpenSettings}
          onOpenStats={onOpenStats}
          toolbarVisibility={sidebarToolbarVisibility}
        />
      </div>

      {contextMenu && (
        <Portal>
          <div
            className="context-menu"
            style={{
              left: menuPos?.left ?? 0,
              top: menuPos?.top ?? 0,
              visibility: menuPos ? "visible" : "hidden",
            }}
            ref={contextMenuRef}
            role="menu"
            onMouseDown={(event) => {
              // Radix Popover content is portalled, but its React event still bubbles
              // through this menu. Only suppress native menu handling for nodes that
              // are physically inside the context menu; otherwise Emoji Mart cannot
              // receive its category-navigation clicks.
              const target = event.target;
              if (!(target instanceof Node) || !event.currentTarget.contains(target)) return;
              event.preventDefault();
              event.stopPropagation();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {contextMenu.kind === "project" && (
              <>
                <button
                  className="context-menu-item"
                  hidden={showProjectBatchContextMenu}
                  role="menuitem"
                  onClick={() => {
                    void handleOpen(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <Play size={14} strokeWidth={1.5} />
                  {compactMode ? t("sidebar.menu.openExternalTerminal") : t("sidebar.menu.openTerminal")}
                </button>
                {!compactMode && !useExternalTerminal && !showProjectBatchContextMenu && (
                  <button
                    className="context-menu-item"
                    role="menuitem"
                    onClick={() => {
                      void openProjectExternally([contextMenu.project]);
                      setContextMenu(null);
                    }}
                  >
                    <TerminalSquare size={14} strokeWidth={1.5} />
                    {t("sidebar.menu.openExternalTerminal")}
                  </button>
                )}
                <button
                  className="context-menu-item"
                  hidden={showProjectBatchContextMenu}
                  role="menuitem"
                  onClick={() => {
                    void handleNewProjectTerminal(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <Plus size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.newProjectTerminal")}
                </button>
                <button
                  className="context-menu-item"
                  hidden={showProjectBatchContextMenu}
                  role="menuitem"
                  disabled={compactMode || useExternalTerminal || !activeSessionId}
                  onClick={() => {
                    void handleSplitProject(contextMenu.project, "horizontal");
                    setContextMenu(null);
                  }}
                >
                  <SquareSplitHorizontal size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.splitRight")}
                </button>
                <button
                  className="context-menu-item"
                  hidden={showProjectBatchContextMenu}
                  role="menuitem"
                  disabled={compactMode || useExternalTerminal || !activeSessionId}
                  onClick={() => {
                    void handleSplitProject(contextMenu.project, "vertical");
                    setContextMenu(null);
                  }}
                >
                  <SquareSplitVertical size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.splitDown")}
                </button>
                <div className="context-menu-separator" role="separator" hidden={showProjectBatchContextMenu} />
                <button
                  className="context-menu-item"
                  hidden={showProjectBatchContextMenu}
                  role="menuitem"
                  onClick={() => {
                    handleCloneProject(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <Copy size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.clone")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    handleToggleSelection(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <Check size={14} strokeWidth={1.5} />
                  {selectedProjectIds.has(contextMenu.project.id) ? t("sidebar.menu.deselect") : t("sidebar.menu.addToSelection")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void openProjects(selectedProjects);
                    setContextMenu(null);
                  }}
                  disabled={selectedProjects.length === 0}
                >
                  <TerminalSquare size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.launchSelected", { count: selectedProjects.length })}
                </button>
                {selectedProjectIds.size > 1 && (
                  <button
                    className="context-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setBatchShellPreselected(new Set(selectedProjectIds));
                      setContextMenu(null);
                    }}
                  >
                    <Terminal size={14} strokeWidth={1.5} />
                    {t("sidebar.menu.batchShell")}
                  </button>
                )}
                <button
                  className="context-menu-item"
                  hidden={showProjectBatchContextMenu}
                  role="menuitem"
                  onClick={() => {
                    void handleOpenProjectDirectory(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <FolderOpen size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.openDirectory")}
                </button>
                <button
                  className="context-menu-item"
                  hidden={showProjectBatchContextMenu}
                  role="menuitem"
                  onClick={() => {
                    void handleOpenProjectFiles(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <FileCode size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.browseFiles")}
                </button>
                <button
                  className="context-menu-item"
                  hidden={showProjectBatchContextMenu}
                  role="menuitem"
                  onClick={() => {
                    handleOpenProjectHistory(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <ListClockIcon size={14} />
                  {t("sidebar.menu.sessionHistory")}
                </button>
                  {!showProjectBatchContextMenu && getProviderSwitchAppType(contextMenu.project) && projectSupportsCapability(contextMenu.project, "providerSwitch") && (
                  <button
                    className="context-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setProviderSwitchTarget({ kind: "project", project: contextMenu.project });
                      setContextMenu(null);
                    }}
                  >
                    <ArrowLeftRight size={14} strokeWidth={1.5} />
                    {t("sidebar.menu.switchProvider")}
                  </button>
                )}
                <button
                  className="context-menu-item"
                  hidden={showProjectBatchContextMenu}
                  role="menuitem"
                  onClick={() => {
                    ensureSidebarExpanded();
                    setRenamingProjectId(contextMenu.project.id);
                    setContextMenu(null);
                  }}
                >
                  <Pencil size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.rename")}
                </button>
                <button
                  className="context-menu-item"
                  hidden={showProjectBatchContextMenu}
                  role="menuitem"
                  onClick={() => {
                    setEditingProject(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <Settings size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.edit")}
                </button>
                <button
                  className="context-menu-item"
                  hidden={showProjectBatchContextMenu}
                  role="menuitem"
                  aria-expanded={appearanceMenuOpen}
                  onClick={() => setAppearanceMenuOpen((prev) => !prev)}
                >
                  <Palette size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.appearance")}
                </button>
                {appearanceMenuOpen && !showProjectBatchContextMenu && (
                  <NodeAppearancePanel
                    icon={contextMenuProject?.icon ?? ""}
                    color={contextMenuProject?.color ?? ""}
                    onChange={(next) => handleUpdateAppearance({ kind: "project", id: contextMenu.project.id }, next)}
                    onAfterPick={() => setContextMenu(null)}
                  />
                )}
                <div className="context-menu-separator" role="separator" />
                {selectedProjectIds.size + selectedGroupIds.size > 1 && (
                  <button
                    className="context-menu-item danger"
                    role="menuitem"
                    onClick={() => {
                      handleRequestDeleteSelection();
                      setContextMenu(null);
                    }}
                  >
                    <Trash2 size={14} strokeWidth={1.5} />
                    {t("sidebar.menu.deleteSelected", { count: selectedProjectIds.size + selectedGroupIds.size })}
                  </button>
                )}
                <button
                  className="context-menu-item danger"
                  hidden={showProjectBatchContextMenu}
                  onClick={() => {
                    handleRequestDeleteProject(contextMenu.project);
                    setContextMenu(null);
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.delete")}
                </button>
              </>
            )}
            {contextMenu.kind === "worktree" && (
              <>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    handleOpenWorktree(contextMenu.project, contextMenu.worktree);
                    setContextMenu(null);
                  }}
                >
                  <Play size={14} strokeWidth={1.5} />
                  {t("worktree.menu.open")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void handleNewWorktreeTerminal(contextMenu.project, contextMenu.worktree);
                    setContextMenu(null);
                  }}
                >
                  <Plus size={14} strokeWidth={1.5} />
                  {t("worktree.menu.newTerminal")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    if (rejectMissingWorktree(contextMenu.worktree)) {
                      setContextMenu(null);
                      return;
                    }
                    setFinishTarget({ project: contextMenu.project, worktree: contextMenu.worktree });
                    setContextMenu(null);
                  }}
                >
                  <Check size={14} strokeWidth={1.5} />
                  {t("worktree.menu.finish")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    handleOpenWorktreeHistory(contextMenu.project, contextMenu.worktree);
                    setContextMenu(null);
                  }}
                >
                  <ListClockIcon size={14} />
                  {t("worktree.menu.viewHistory")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    handleInstallWorktreeDeps(contextMenu.project, contextMenu.worktree);
                    setContextMenu(null);
                  }}
                >
                  <TerminalSquare size={14} strokeWidth={1.5} />
                  {t("worktree.menu.installDeps")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void handleOpenWorktreeDirectory(contextMenu.worktree);
                    setContextMenu(null);
                  }}
                >
                  <FolderOpen size={14} strokeWidth={1.5} />
                  {t("worktree.menu.openDirectory")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void handleOpenWorktreeFiles(contextMenu.project, contextMenu.worktree);
                    setContextMenu(null);
                  }}
                >
                  <FileCode size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.browseFiles")}
                </button>
                {getProviderSwitchAppType(contextMenu.project) && projectSupportsCapability(contextMenu.project, "providerSwitch") && (
                  <button
                    className="context-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setProviderSwitchTarget({
                        kind: "worktree",
                        project: contextMenu.project,
                        worktree: contextMenu.worktree,
                      });
                      setContextMenu(null);
                    }}
                  >
                    <ArrowLeftRight size={14} strokeWidth={1.5} />
                    {t("sidebar.menu.switchProvider")}
                  </button>
                )}
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    handleToggleWorktreeSelection(contextMenu.worktree);
                    setContextMenu(null);
                  }}
                >
                  <Check size={14} strokeWidth={1.5} />
                  {selectedWorktreeIds.has(contextMenu.worktree.id) ? t("sidebar.menu.deselect") : t("sidebar.menu.addToSelection")}
                </button>
                <div className="context-menu-separator" role="separator" />
                {selectedWorktreeIds.size > 0 && (
                  <button
                    className="context-menu-item danger"
                    role="menuitem"
                    onClick={() => {
                      handleRequestDiscardSelectedWorktrees();
                      setContextMenu(null);
                    }}
                  >
                    <Trash2 size={14} strokeWidth={1.5} />
                    {t("sidebar.menu.discardSelectedWorktrees", { count: selectedWorktreeIds.size })}
                  </button>
                )}
                <button
                  className="context-menu-item danger"
                  role="menuitem"
                  onClick={() => {
                    setDiscardTarget({ project: contextMenu.project, worktree: contextMenu.worktree });
                    setContextMenu(null);
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                  {t("worktree.menu.discard")}
                </button>
              </>
            )}
            {contextMenu.kind === "group" && (
              <>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    void handleStartGroup(contextMenu.groupId);
                    setContextMenu(null);
                  }}
                >
                  <Play size={14} strokeWidth={1.5} />
                  {compactMode ? t("sidebar.menu.openGroupExternal") : t("sidebar.menu.startGroup")}
                </button>
                <button
                  className="context-menu-item danger"
                  role="menuitem"
                  disabled={contextMenuGroupTerminalTargets.terminalSessionIds.length === 0}
                  onClick={() => {
                    void handleStopGroup(contextMenu.groupId);
                    setContextMenu(null);
                  }}
                >
                  <CircleStop size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.stopGroup", { count: contextMenuGroupTerminalTargets.terminalSessionIds.length })}
                </button>
                {projectScopedTerminalViewEnabled && (
                  <button
                    className="context-menu-item"
                    role="menuitem"
                    onClick={() => {
                      handleSelectGroupScope(contextMenu.groupId);
                      setContextMenu(null);
                    }}
                  >
                    <TerminalSquare size={14} strokeWidth={1.5} />
                    {t("sidebar.menu.focusGroupTerminals")}
                  </button>
                )}
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    handleToggleGroupSelection(contextMenu.groupId);
                    setContextMenu(null);
                  }}
                >
                  <Check size={14} strokeWidth={1.5} />
                  {selectedGroupIds.has(contextMenu.groupId) ? t("sidebar.menu.deselect") : t("sidebar.menu.addToSelection")}
                </button>
                <div className="context-menu-separator" role="separator" />
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    ensureSidebarExpanded();
                    setNewGroupParentId(contextMenu.groupId);
                    setContextMenu(null);
                  }}
                >
                  <FolderPlus size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.newChildGroup")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    ensureSidebarExpanded();
                    handleAddProjectToGroup(contextMenu.groupId);
                    setContextMenu(null);
                  }}
                >
                  <Plus size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.newTerminal")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    ensureSidebarExpanded();
                    handleRenameGroup(contextMenu.groupId, contextMenu.groupName);
                    setContextMenu(null);
                  }}
                >
                  <Pencil size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.rename")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  onClick={() => {
                    ensureSidebarExpanded();
                    setEditingGroup(contextMenuGroup ?? null);
                    setContextMenu(null);
                  }}
                >
                  <Settings size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.edit")}
                </button>
                <button
                  className="context-menu-item"
                  role="menuitem"
                  aria-expanded={appearanceMenuOpen}
                  onClick={() => setAppearanceMenuOpen((prev) => !prev)}
                >
                  <Palette size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.appearance")}
                </button>
                {appearanceMenuOpen && (
                  <NodeAppearancePanel
                    icon={contextMenuGroup?.icon ?? ""}
                    color={contextMenuGroup?.color ?? ""}
                    onChange={(next) => handleUpdateAppearance({ kind: "group", id: contextMenu.groupId }, next)}
                    onAfterPick={() => setContextMenu(null)}
                  />
                )}
                <div className="context-menu-separator" role="separator" />
                {selectedProjectIds.size + selectedGroupIds.size > 1 && (
                  <button
                    className="context-menu-item danger"
                    role="menuitem"
                    onClick={() => {
                      handleRequestDeleteSelection();
                      setContextMenu(null);
                    }}
                  >
                    <Trash2 size={14} strokeWidth={1.5} />
                    {t("sidebar.menu.deleteSelected", { count: selectedProjectIds.size + selectedGroupIds.size })}
                  </button>
                )}
                <button
                  className="context-menu-item danger"
                  onClick={() => {
                    handleRequestDeleteGroup(contextMenu.groupId, contextMenu.groupName);
                    setContextMenu(null);
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                  {t("sidebar.menu.delete")}
                </button>
              </>
            )}
          </div>
        </Portal>
      )}

      <Dialog open={!!worktreePrompt} onOpenChange={(next) => { if (!next) setWorktreePrompt(null); }}>
        <DialogContent className="ui-worktree-prompt-dialog max-w-[440px]" showCloseButton={false}>
          <button
            type="button"
            className="ui-worktree-prompt-close"
            aria-label={t("common.close")}
            onClick={() => setWorktreePrompt(null)}
          >
            <X size={15} strokeWidth={2} />
          </button>
          <div className="pr-10">
            <DialogTitle>{t("worktree.prompt.title")}</DialogTitle>
            <DialogDescription className="mt-2">
              {worktreePrompt ? t("worktree.prompt.description", { name: worktreePrompt.project.name }) : ""}
            </DialogDescription>
          </div>
          <div className="mt-4">
            <label className="mb-1 block text-xs text-text-muted">{t("worktree.prompt.taskName")}</label>
            <Input
              value={worktreePrompt?.taskName ?? ""}
              onChange={(event) => setWorktreePrompt((current) => current ? { ...current, taskName: sanitizeWorktreeTaskName(event.currentTarget.value) } : current)}
              className="text-sm"
            />
            {worktreePrompt && !validateWorktreeTaskName(worktreePrompt.taskName) && (
              <p className="mt-1 text-[11px] text-danger">{t("worktree.prompt.invalidName")}</p>
            )}
          </div>
          <DialogFooter className="ui-worktree-prompt-footer">
            <Button
              variant="outline"
              className="ui-worktree-prompt-action ui-worktree-prompt-action-neutral"
              onClick={() => {
                if (worktreePrompt?.direction && activeSessionId) {
                  void splitTerminal(activeSessionId, worktreePrompt.direction!, buildProjectSplitOptions(worktreePrompt.project))
                    .then(() => closeHistory());
                } else if (worktreePrompt) {
                  void openProjectDirect(worktreePrompt.project, worktreePrompt.targetPaneId);
                }
                setWorktreePrompt(null);
              }}
            >
              {t("worktree.prompt.direct")}
            </Button>
            <Button
              variant="outline"
              className="ui-worktree-prompt-action ui-worktree-prompt-action-accent"
              onClick={() => {
                if (worktreePrompt) {
                  void updateProject(worktreePrompt.project.id, { worktree_strategy: "autoParallel" }).then(() => {
                    if (worktreePrompt.direction) {
                      return createAndSplitWorktree(worktreePrompt.project, worktreePrompt.direction, worktreePrompt.taskName);
                    }
                    return createAndOpenWorktree(worktreePrompt.project, worktreePrompt.targetPaneId, worktreePrompt.taskName);
                  }).catch((err) => {
                    logError("Failed to enable automatic worktree isolation", err);
                    toast.error(t("worktree.toast.createFailed"), { description: String(err) });
                  });
                }
                setWorktreePrompt(null);
              }}
              disabled={!worktreePrompt || !validateWorktreeTaskName(worktreePrompt.taskName)}
            >
              {t("worktree.prompt.autoParallel")}
            </Button>
            <Button
              className="ui-worktree-prompt-action ui-worktree-prompt-action-primary"
              onClick={() => {
                if (worktreePrompt?.direction) {
                  void createAndSplitWorktree(worktreePrompt.project, worktreePrompt.direction, worktreePrompt.taskName);
                } else if (worktreePrompt) {
                  void createAndOpenWorktree(worktreePrompt.project, worktreePrompt.targetPaneId, worktreePrompt.taskName);
                }
                setWorktreePrompt(null);
              }}
              disabled={!worktreePrompt || !validateWorktreeTaskName(worktreePrompt.taskName)}
            >
              {t("worktree.prompt.isolate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!depsPrompt}
        onOpenChange={(next) => {
          if (next) return;
          if (depsPrompt) {
            depsPromptingWorktreeIdsRef.current.delete(depsPrompt.worktree.id);
            void dismissWorktreeDepsPrompt(depsPrompt.worktree.id);
          }
          setDepsPrompt(null);
        }}
      >
        <DialogContent className="max-w-[420px]" showCloseButton={false}>
          <DialogTitle>{t("worktree.deps.title")}</DialogTitle>
          <DialogDescription className="mt-2">
            {depsPrompt ? t("worktree.deps.description", { name: depsPrompt.worktree.name, command: depsPrompt.command }) : ""}
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (depsPrompt) {
                  depsPromptingWorktreeIdsRef.current.delete(depsPrompt.worktree.id);
                  void dismissWorktreeDepsPrompt(depsPrompt.worktree.id);
                }
                setDepsPrompt(null);
              }}
            >
              {t("worktree.deps.skip")}
            </Button>
            <Button
              onClick={() => {
                if (depsPrompt) {
                  depsPromptingWorktreeIdsRef.current.delete(depsPrompt.worktree.id);
                  void dismissWorktreeDepsPrompt(depsPrompt.worktree.id);
                  void openWorktreeSession(
                    depsPrompt.project,
                    depsPrompt.worktree,
                    undefined,
                    depsPrompt.command,
                    t("worktree.deps.installTitle", { name: depsPrompt.worktree.name }),
                  );
                }
                setDepsPrompt(null);
              }}
            >
              {t("worktree.deps.install")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <ConfirmDialog
        open={!!discardTargets}
        title={t("worktree.discard.batchTitle", { count: discardTargets?.length ?? 0 })}
        message={t("worktree.discard.batchMessage", { count: discardTargets?.length ?? 0 })}
        confirmText={t("worktree.discard.confirm")}
        cancelText={t("common.cancel")}
        danger
        onConfirm={() => {
          const targets = discardTargets;
          setDiscardTargets(null);
          if (!targets || targets.length === 0) return;
          void (async () => {
            let failed = 0;
            for (const target of targets) {
              try {
                await removeWorktree(target.worktree, true);
              } catch (err) {
                failed += 1;
                logError("Failed to discard worktree", err);
              }
            }
            setSelectedWorktreeIds(new Set());
            if (failed > 0) {
              toast.error(t("worktree.toast.discardFailed"), {
                description: t("worktree.toast.batchDiscardPartial", { failed, total: targets.length }),
              });
            } else {
              toast.success(t("worktree.toast.batchDiscardSuccess", { count: targets.length }));
            }
          })();
        }}
        onClose={() => setDiscardTargets(null)}
      />

      {showAdd && (
        <ConfigModal
          defaultGroupId={addToGroupId}
          onManageSshHosts={() => {
            setShowAdd(false);
            setAddToGroupId(null);
            onOpenSettings("ssh-hosts");
          }}
          onClose={() => {
            setShowAdd(false);
            setAddToGroupId(null);
          }}
        />
      )}
      {cloningProject && (
        <ConfigModal
          cloneFrom={cloningProject}
          onManageSshHosts={() => {
            setCloningProject(null);
            onOpenSettings("ssh-hosts");
          }}
          onClose={() => setCloningProject(null)}
        />
      )}
      {editingProject && (
        <ConfigModal
          project={editingProject}
          onManageSshHosts={() => {
            setEditingProject(null);
            onOpenSettings("ssh-hosts");
          }}
          onClose={() => setEditingProject(null)}
        />
      )}
      {editingGroup && (
        <GroupEditDialog
          group={editingGroup}
          groups={groups}
          projects={projects}
          onClose={() => setEditingGroup(null)}
        />
      )}
      {batchShellPreselected && (
        <BatchShellDialog
          preselectedIds={batchShellPreselected}
          onClose={() => setBatchShellPreselected(null)}
        />
      )}
      {providerSwitchTarget && providerSwitchProject && (
        <ProviderSwitchModal
          project={providerSwitchProject}
          worktree={providerSwitchWorktree}
          onClose={() => setProviderSwitchTarget(null)}
        />
      )}
      <ConfirmDialog
        open={!!confirmDialog}
        title={confirmDialog?.title ?? ""}
        message={confirmDialog?.message}
        confirmText={confirmDialog?.confirmText ?? "删除"}
        danger={confirmDialog?.danger ?? false}
        onConfirm={confirmDialog?.onConfirm ?? (() => {})}
        onClose={() => setConfirmAction(null)}
      />

      {!compactMode && (
        <div
          onMouseDown={startResize}
          className={`ui-sidebar-resize-handle absolute bottom-0 top-0 z-10 w-1.5 cursor-col-resize transition-colors ${
            dockSide === "right" ? "left-0" : "right-0"
          }`}
          style={{ opacity: 0.8 }}
        />
      )}
    </aside>
  );
}
