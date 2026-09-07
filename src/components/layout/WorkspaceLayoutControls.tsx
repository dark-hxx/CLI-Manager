import { useEffect, useState, type ReactNode } from "react";
import {
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PanelTopClose,
  PanelTopOpen,
} from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useI18n } from "../../lib/i18n";
import {
  SIDEBAR_STATE_CHANGE_EVENT,
  requestSidebarExpand,
  requestSidebarToggle,
  type SidebarStateChangeDetail,
} from "../../lib/sidebarCommands";
import {
  updateWorkspaceLayout,
  type WorkspaceDockSide,
  type WorkspaceLayoutPatch,
  type WorkspanTabBarPosition,
} from "../../lib/workspaceLayout";
import { WorkspaceLayoutMenu } from "./WorkspaceLayoutMenu";

function QuickLayoutButton({
  label,
  active,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="workspace-layout-control ui-focus-ring"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      data-workspace-layout-quick="true"
      data-active={active ? "true" : "false"}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

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

  const sidebarIcon = sidebarState.collapsed
    ? projectSidebarSide === "left" ? <PanelLeftOpen size={15} /> : <PanelRightOpen size={15} />
    : projectSidebarSide === "left" ? <PanelLeftClose size={15} /> : <PanelRightClose size={15} />;
  const sideIcon = terminalSidePanelVisible
    ? terminalSidePanelSide === "left" ? <PanelLeftClose size={15} /> : <PanelRightClose size={15} />
    : terminalSidePanelSide === "left" ? <PanelLeftOpen size={15} /> : <PanelRightOpen size={15} />;
  const sideLabel = terminalSidePanelVisible
    ? t("workspaceLayout.controls.hideAuxiliaryPanel")
    : t("workspaceLayout.controls.showAuxiliaryPanel");
  const tabIcon = workspanTabBarVisible
    ? workspanTabBarPosition === "top" ? <PanelTopClose size={15} /> : <PanelBottomClose size={15} />
    : workspanTabBarPosition === "top" ? <PanelTopOpen size={15} /> : <PanelBottomOpen size={15} />;
  const workspanDisabled = !workspanEnabled || !hasWorkspanTabs;
  const tabLabel = workspanDisabled
    ? t("workspaceLayout.controls.workspanUnavailable")
    : workspanTabBarVisible
      ? t("workspaceLayout.controls.hideWorkspanTabs")
      : t("workspaceLayout.controls.showWorkspanTabs");

  return (
    <div
      className="workspace-layout-controls"
      role="group"
      aria-label={t("workspaceLayout.controls.groupLabel")}
    >
      <QuickLayoutButton
        label={sidebarState.collapsed ? t("workspaceLayout.controls.showSidebar") : t("workspaceLayout.controls.hideSidebar")}
        active={!sidebarState.collapsed}
        disabled={sidebarState.compactMode || viewMode === "compact"}
        onClick={requestSidebarToggle}
      >
        {sidebarIcon}
      </QuickLayoutButton>
      <QuickLayoutButton
        label={sideLabel}
        active={terminalSidePanelVisible}
        onClick={toggleTerminalSidePanel}
      >
        {sideIcon}
      </QuickLayoutButton>
      <QuickLayoutButton
        label={tabLabel}
        active={!workspanDisabled && workspanTabBarVisible}
        disabled={workspanDisabled}
        onClick={toggleWorkspanTabBar}
      >
        {tabIcon}
      </QuickLayoutButton>
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
