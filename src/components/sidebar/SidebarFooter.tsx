import { Settings } from "../icons";
import { SyncStatusIndicator } from "./SyncStatusIndicator";
import type { SettingsTab } from "../SettingsModal";

interface SidebarFooterProps {
  collapsed: boolean;
  onOpenSettings: (tab?: SettingsTab) => void;
}

export function SidebarFooter({ collapsed, onOpenSettings }: SidebarFooterProps) {
  const settingsButton = (
    <button
      onClick={() => onOpenSettings()}
      className="ui-focus-ring ui-icon-action"
      title="设置"
      aria-label="打开设置"
    >
      <Settings size={14} strokeWidth={1.5} />
    </button>
  );

  if (collapsed) {
    return (
      <div className="px-2 py-2">
        <div className="flex flex-col items-center gap-1.5">
          <SyncStatusIndicator collapsed onOpenSettings={onOpenSettings} />
          {settingsButton}
        </div>
      </div>
    );
  }

  return (
    <div className="px-2.5 py-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <SyncStatusIndicator onOpenSettings={onOpenSettings} />
        </div>
        {settingsButton}
      </div>
    </div>
  );
}
