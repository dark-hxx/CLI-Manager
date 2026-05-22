import { useState, useEffect } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Dialog } from "./ui/dialog";
import { SettingsLayout } from "./settings/SettingsLayout";
import { GeneralSettingsPage } from "./settings/pages/GeneralSettingsPage";
import { ThemeSettingsPage } from "./settings/pages/ThemeSettingsPage";
import { ShortcutSettingsPage } from "./settings/pages/ShortcutSettingsPage";
import { TemplateSettingsPage } from "./settings/pages/TemplateSettingsPage";
import { SyncSettingsPage } from "./settings/pages/SyncSettingsPage";
import { useSettingsStore } from "../stores/settingsStore";
import { cn } from "@/lib/utils";

type SettingsTab = "general" | "terminal-theme" | "shortcuts" | "templates" | "sync";

interface SettingsTabConfig {
  label: string;
  title: string;
  description: string;
  searchPlaceholder: string;
}

const SETTINGS_TAB_ORDER: SettingsTab[] = ["general", "terminal-theme", "shortcuts", "templates", "sync"];

const SETTINGS_TAB_CONFIG: Record<SettingsTab, SettingsTabConfig> = {
  general: {
    label: "通用",
    title: "通用设置",
    description: "首屏可完成主题、配色、终端、字体与侧栏密度配置。",
    searchPlaceholder: "搜索通用设置（预留）",
  },
  "terminal-theme": {
    label: "终端主题",
    title: "终端主题",
    description: "配置 auto 跟随策略，或固定为指定终端主题。",
    searchPlaceholder: "搜索终端主题（预留）",
  },
  shortcuts: {
    label: "快捷键",
    title: "快捷键",
    description: "录制、取消和恢复默认快捷键绑定。",
    searchPlaceholder: "搜索快捷键（预留）",
  },
  templates: {
    label: "命令模板",
    title: "命令模板",
    description: "管理全局模板与项目模板的新增、编辑与删除。",
    searchPlaceholder: "搜索命令模板（预留）",
  },
  sync: {
    label: "同步",
    title: "同步",
    description: "选择云端（WebDAV）或本地目录方式同步配置。",
    searchPlaceholder: "搜索同步设置（预留）",
  },
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [searchValue, setSearchValue] = useState("");
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);

  useEffect(() => {
    setSearchValue("");
  }, [activeTab]);

  const tabs = SETTINGS_TAB_ORDER.map((id) => ({ id, label: SETTINGS_TAB_CONFIG[id].label }));
  const activeConfig = SETTINGS_TAB_CONFIG[activeTab];
  const activeContent = (() => {
    if (activeTab === "general") return <GeneralSettingsPage />;
    if (activeTab === "terminal-theme") return <ThemeSettingsPage />;
    if (activeTab === "shortcuts") return <ShortcutSettingsPage searchValue={searchValue} />;
    if (activeTab === "templates") return <TemplateSettingsPage searchValue={searchValue} />;
    if (activeTab === "sync") return <SyncSettingsPage />;
    return null;
  })();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-x-0 bottom-0 top-9 z-50",
            "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out"
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "ui-surface-base fixed inset-x-0 bottom-0 top-9 z-50",
            "flex h-auto w-full overflow-hidden outline-none",
            "data-[state=open]:animate-scale-in data-[state=closed]:animate-scale-out"
          )}
          style={{ fontFamily: uiFontFamily }}
          aria-label="设置窗口"
        >
          <DialogPrimitive.Title className="sr-only">设置</DialogPrimitive.Title>
          <SettingsLayout
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            title={activeConfig.title}
            description={activeConfig.description}
            searchValue={searchValue}
            searchPlaceholder={activeConfig.searchPlaceholder}
            onSearchChange={setSearchValue}
            onClose={onClose}
          >
            {activeContent}
          </SettingsLayout>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
  );
}
