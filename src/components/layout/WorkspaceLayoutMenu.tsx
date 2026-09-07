import type { KeyboardEvent, ReactNode } from "react";
import {
  Check,
  Ellipsis,
  PanelBottom,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  PanelTop,
  PanelTopClose,
  PanelTopOpen,
  RotateCcw,
} from "lucide-react";
import { useI18n } from "../../lib/i18n";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";
import type { WorkspaceDockSide, WorkspanTabBarPosition } from "../../lib/workspaceLayout";

interface WorkspaceLayoutMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sidebarCollapsed: boolean;
  sidebarDisabled: boolean;
  projectSidebarSide: WorkspaceDockSide;
  terminalSidePanelVisible: boolean;
  terminalSidePanelSide: WorkspaceDockSide;
  workspanTabBarVisible: boolean;
  workspanTabBarPosition: WorkspanTabBarPosition;
  workspanDisabled: boolean;
  onToggleSidebar: () => void;
  onSetProjectSidebarSide: (side: WorkspaceDockSide) => void;
  onToggleTerminalSidePanel: () => void;
  onSetTerminalSidePanelSide: (side: WorkspaceDockSide) => void;
  onToggleWorkspanTabBar: () => void;
  onSetWorkspanTabBarPosition: (position: WorkspanTabBarPosition) => void;
  onReset: () => void;
}

function LayoutMenuButton({
  children,
  icon,
  checked,
  disabled = false,
  radio = false,
  onClick,
}: {
  children: ReactNode;
  icon: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  radio?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={radio ? "menuitemradio" : checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      disabled={disabled}
      className="workspace-layout-menu-item ui-focus-ring"
      data-selected={checked ? "true" : "false"}
      onClick={onClick}
    >
      <span className="workspace-layout-menu-item-icon" aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      {checked && <Check size={14} aria-hidden="true" />}
    </button>
  );
}

export function WorkspaceLayoutMenu({
  open,
  onOpenChange,
  sidebarCollapsed,
  sidebarDisabled,
  projectSidebarSide,
  terminalSidePanelVisible,
  terminalSidePanelSide,
  workspanTabBarVisible,
  workspanTabBarPosition,
  workspanDisabled,
  onToggleSidebar,
  onSetProjectSidebarSide,
  onToggleTerminalSidePanel,
  onSetTerminalSidePanelSide,
  onToggleWorkspanTabBar,
  onSetWorkspanTabBarPosition,
  onReset,
}: WorkspaceLayoutMenuProps) {
  const { t } = useI18n();
  const runAndClose = (action: () => void) => {
    action();
    onOpenChange(false);
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
    );
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = currentIndex < 0
      ? event.key === "ArrowDown" ? 0 : items.length - 1
      : (currentIndex + offset + items.length) % items.length;
    event.preventDefault();
    items[nextIndex]?.focus();
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="workspace-layout-control ui-focus-ring"
          aria-label={t("workspaceLayout.controls.customize")}
          title={t("workspaceLayout.controls.customize")}
          aria-expanded={open}
          data-active={open ? "true" : "false"}
        >
          <Ellipsis size={15} strokeWidth={2} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        collisionPadding={8}
        className="workspace-layout-menu ui-glass w-64 p-1.5"
        role="menu"
        aria-label={t("workspaceLayout.controls.customize")}
        onKeyDown={handleMenuKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)
            ?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
            ?.focus();
        }}
      >
        <div className="workspace-layout-menu-section">{t("workspaceLayout.controls.sidebar")}</div>
        <LayoutMenuButton
          icon={sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          checked={!sidebarCollapsed}
          disabled={sidebarDisabled}
          onClick={() => runAndClose(onToggleSidebar)}
        >
          {sidebarCollapsed ? t("workspaceLayout.controls.showSidebar") : t("workspaceLayout.controls.hideSidebar")}
        </LayoutMenuButton>
        <LayoutMenuButton
          icon={<PanelLeft size={15} />}
          checked={projectSidebarSide === "left"}
          disabled={sidebarDisabled}
          radio
          onClick={() => runAndClose(() => onSetProjectSidebarSide("left"))}
        >
          {t("workspaceLayout.controls.sidebarLeft")}
        </LayoutMenuButton>
        <LayoutMenuButton
          icon={<PanelRight size={15} />}
          checked={projectSidebarSide === "right"}
          disabled={sidebarDisabled}
          radio
          onClick={() => runAndClose(() => onSetProjectSidebarSide("right"))}
        >
          {t("workspaceLayout.controls.sidebarRight")}
        </LayoutMenuButton>

        <div className="workspace-layout-menu-section">{t("workspaceLayout.controls.auxiliaryPanel")}</div>
        <LayoutMenuButton
          icon={terminalSidePanelVisible ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          checked={terminalSidePanelVisible}
          onClick={() => runAndClose(onToggleTerminalSidePanel)}
        >
          {terminalSidePanelVisible
            ? t("workspaceLayout.controls.hideAuxiliaryPanel")
            : t("workspaceLayout.controls.showAuxiliaryPanel")}
        </LayoutMenuButton>
        <LayoutMenuButton
          icon={<PanelLeft size={15} />}
          checked={terminalSidePanelSide === "left"}
          radio
          onClick={() => runAndClose(() => onSetTerminalSidePanelSide("left"))}
        >
          {t("workspaceLayout.controls.dockLeft")}
        </LayoutMenuButton>
        <LayoutMenuButton
          icon={<PanelRight size={15} />}
          checked={terminalSidePanelSide === "right"}
          radio
          onClick={() => runAndClose(() => onSetTerminalSidePanelSide("right"))}
        >
          {t("workspaceLayout.controls.dockRight")}
        </LayoutMenuButton>

        <div className="workspace-layout-menu-section">{t("workspaceLayout.controls.workspanTabs")}</div>
        <LayoutMenuButton
          icon={workspanTabBarVisible ? <PanelTopClose size={15} /> : <PanelTopOpen size={15} />}
          checked={workspanTabBarVisible}
          disabled={workspanDisabled}
          onClick={() => runAndClose(onToggleWorkspanTabBar)}
        >
          {workspanTabBarVisible
            ? t("workspaceLayout.controls.hideWorkspanTabs")
            : t("workspaceLayout.controls.showWorkspanTabs")}
        </LayoutMenuButton>
        <LayoutMenuButton
          icon={<PanelTop size={15} />}
          checked={workspanTabBarPosition === "top"}
          disabled={workspanDisabled}
          radio
          onClick={() => runAndClose(() => onSetWorkspanTabBarPosition("top"))}
        >
          {t("workspaceLayout.controls.tabsTop")}
        </LayoutMenuButton>
        <LayoutMenuButton
          icon={<PanelBottom size={15} />}
          checked={workspanTabBarPosition === "bottom"}
          disabled={workspanDisabled}
          radio
          onClick={() => runAndClose(() => onSetWorkspanTabBarPosition("bottom"))}
        >
          {t("workspaceLayout.controls.tabsBottom")}
        </LayoutMenuButton>

        {workspanDisabled && (
          <div className="workspace-layout-menu-hint">{t("workspaceLayout.controls.workspanUnavailable")}</div>
        )}
        <div className="workspace-layout-menu-separator" />
        <LayoutMenuButton
          icon={<RotateCcw size={15} />}
          onClick={() => runAndClose(onReset)}
        >
          {t("workspaceLayout.controls.reset")}
        </LayoutMenuButton>
      </PopoverContent>
    </Popover>
  );
}
