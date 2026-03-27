import { useState, useEffect, useRef } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { SettingsLayout } from "./settings/SettingsLayout";
import { GeneralSettingsPage } from "./settings/pages/GeneralSettingsPage";
import { ThemeSettingsPage } from "./settings/pages/ThemeSettingsPage";
import { ShortcutSettingsPage } from "./settings/pages/ShortcutSettingsPage";
import { TemplateSettingsPage } from "./settings/pages/TemplateSettingsPage";

type SettingsTab = "general" | "terminal-theme" | "shortcuts" | "templates";

interface SettingsTabConfig {
  label: string;
  title: string;
  description: string;
  searchPlaceholder: string;
}

const SETTINGS_TAB_ORDER: SettingsTab[] = ["general", "terminal-theme", "shortcuts", "templates"];

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
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [searchValue, setSearchValue] = useState("");
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, mounted && !closing);

  useEffect(() => {
    if (open) {
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
    return <TemplateSettingsPage searchValue={searchValue} />;
  })();

  return (
    <div
      className={`fixed inset-x-0 bottom-0 top-9 z-50 ${
        closing ? "animate-fade-out" : "animate-fade-in"
      }`}
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
