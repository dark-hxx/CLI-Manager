import { useEffect, useState } from "react";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { useTerminalStore } from "../../terminal/state";
import { useI18n } from "../../../shared/i18n/index";
import {
  SIDEBAR_STATE_CHANGE_EVENT,
  requestSidebarExpand,
  requestSidebarToggle,
  type SidebarStateChangeDetail,
} from "../../projects/api/sidebarCommands";
import {
  updateWorkspaceLayout,
  type WorkspaceDockSide,
  type WorkspaceLayoutPatch,
  type WorkspanTabBarPosition,
} from "../../../shared/lib/workspaceLayout";
import { WorkspaceLayoutMenu } from "../components/WorkspaceLayoutMenu";

function useSidebarLayoutState() {
  const [state, setState] = useState<SidebarStateChangeDetail>(() => ({
    collapsed: useSettingsStore.getState().sidebarWidth <= 64,
    compactMode: useSettingsStore.getState().viewMode === "compact",
  }));

  useEffect(() => {
    const handleStateChange = (event: Event) => {
      const detail = (event as CustomEvent<SidebarStateChangeDetail>).detail;
      if (!detail || typeof detail.collapsed !== "boolean" || typeof detail.compactMode !== "boolean") return;
      setState(detail);
    };
    window.addEventListener(SIDEBAR_STATE_CHANGE_EVENT, handleStateChange);
    return () => window.removeEventListener(SIDEBAR_STATE_CHANGE_EVENT, handleStateChange);
  }, []);

  return state;
}

export function WorkspaceLayoutControls() {
  const { t } = useI18n();
  const projectSidebarSide = useSettingsStore((state) => state.workspaceLayout.projectSidebarSide);
  const terminalSidePanelSide = useSettingsStore((state) => state.workspaceLayout.terminalSidePanelSide);
  const terminalSidePanelVisible = useSettingsStore((state) => state.workspaceLayout.terminalSidePanelVisible);
  const workspanTabBarPosition = useSettingsStore((state) => state.workspaceLayout.workspanTabBarPosition);
  const workspanTabBarVisible = useSettingsStore((state) => state.workspaceLayout.workspanTabBarVisible);
  const workspanEnabled = useSettingsStore((state) => state.workspanEnabled);
  const hasWorkspanTabs = useTerminalStore((state) => state.workspans.length > 0);
  const viewMode = useSettingsStore((state) => state.viewMode);
  const updateSettings = useSettingsStore((state) => state.update);
  const sidebarState = useSidebarLayoutState();
  const [menuOpen, setMenuOpen] = useState(false);

  const updateLayout = (patch: WorkspaceLayoutPatch) => {
    const current = useSettingsStore.getState().workspaceLayout;
    void updateSettings("workspaceLayout", updateWorkspaceLayout(current, patch));
  };

  const toggleTerminalSidePanel = () => {
    updateLayout({ terminalSidePanelVisible: !terminalSidePanelVisible });
  };

  const toggleWorkspanTabBar = () => {
    if (!workspanEnabled || !hasWorkspanTabs) return;
    updateLayout({ workspanTabBarVisible: !workspanTabBarVisible });
  };

  const resetLayout = () => {
    updateLayout({
      projectSidebarSide: "left",
      terminalSidePanelSide: "right",
      terminalSidePanelVisible: true,
      workspanTabBarPosition: "top",
      workspanTabBarVisible: true,
    });
    if (sidebarState.collapsed) requestSidebarExpand();
  };

  const workspanDisabled = !workspanEnabled || !hasWorkspanTabs;

  return (
    <div
      className="workspace-layout-controls"
      role="group"
      aria-label={t("workspaceLayout.controls.groupLabel")}
    >
      <WorkspaceLayoutMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        sidebarCollapsed={sidebarState.collapsed}
        sidebarDisabled={sidebarState.compactMode || viewMode === "compact"}
        projectSidebarSide={projectSidebarSide}
        terminalSidePanelVisible={terminalSidePanelVisible}
        terminalSidePanelSide={terminalSidePanelSide}
        workspanTabBarVisible={workspanTabBarVisible}
        workspanTabBarPosition={workspanTabBarPosition}
        workspanDisabled={workspanDisabled}
        onToggleSidebar={requestSidebarToggle}
        onSetProjectSidebarSide={(side: WorkspaceDockSide) => updateLayout({ projectSidebarSide: side })}
        onToggleTerminalSidePanel={toggleTerminalSidePanel}
        onSetTerminalSidePanelSide={(side: WorkspaceDockSide) => updateLayout({ terminalSidePanelSide: side })}
        onToggleWorkspanTabBar={toggleWorkspanTabBar}
        onSetWorkspanTabBarPosition={(position: WorkspanTabBarPosition) => updateLayout({ workspanTabBarPosition: position })}
        onReset={resetLayout}
      />
    </div>
  );
}
