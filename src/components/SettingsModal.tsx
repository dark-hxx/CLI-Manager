import { useState, useEffect, useRef } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { SettingsLayout } from "./settings/SettingsLayout";
import { GeneralSettingsPage } from "./settings/pages/GeneralSettingsPage";
import { ThemeSettingsPage } from "./settings/pages/ThemeSettingsPage";
import { ShortcutSettingsPage } from "./settings/pages/ShortcutSettingsPage";
import { TemplateSettingsPage } from "./settings/pages/TemplateSettingsPage";
import { SyncSettingsPage } from "./settings/pages/SyncSettingsPage";
import { useSettingsStore } from "../stores/settingsStore";

export type SettingsTab = "general" | "terminal-theme" | "shortcuts" | "templates" | "sync";

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
    description: "配置应用主题、配色、字体、侧栏与行为偏好。",
    searchPlaceholder: "搜索通用设置（预留）",
  },
  "terminal-theme": {
    label: "终端设置",
    title: "终端设置",
    description: "配置默认 Shell、终端字体、主题与背景。",
    searchPlaceholder: "搜索终端设置（预留）",
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
  initialTab?: SettingsTab;
}

export function SettingsModal({ open, onClose, initialTab }: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? "general");
  const [searchValue, setSearchValue] = useState("");
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
  useFocusTrap(dialogRef, mounted && !closing);

  useEffect(() => {
    if (open) {
      if (initialTab) setActiveTab(initialTab);
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, 180);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  useEffect(() => {
    setSearchValue("");
  }, [activeTab]);

  useEffect(() => {
    if (!mounted || closing) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [mounted, closing, onClose]);

  if (!mounted) return null;

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
    <div
      className={`fixed inset-x-0 bottom-0 top-9 z-50 ${
        closing ? "animate-fade-out" : "animate-fade-in"
      }`}
      style={{ fontFamily: uiFontFamily }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className={`ui-surface-base flex h-full w-full overflow-hidden ${
          closing ? "animate-scale-out" : "animate-scale-in"
        }`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="设置窗口"
      >
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
      </div>
    </div>
  );
}