import { useState, useEffect, useRef } from "react";
import "@mantine/core/styles.css";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { AppMantineThemeProvider } from "./ui/MantineThemeProvider";
import { SettingsLayout } from "./settings/SettingsLayout";
import { GeneralSettingsPage } from "./settings/pages/GeneralSettingsPage";
import { SidebarSettingsPage } from "./settings/pages/SidebarSettingsPage";
import { ThemeSettingsPage } from "./settings/pages/ThemeSettingsPage";
import { ShortcutSettingsPage } from "./settings/pages/ShortcutSettingsPage";
import { TemplateSettingsPage } from "./settings/pages/TemplateSettingsPage";
import { SyncSettingsPage } from "./settings/pages/SyncSettingsPage";
import { HookSettingsPage } from "./settings/pages/HookSettingsPage";
import { ProviderSettingsPage } from "./settings/pages/ProviderSettingsPage";
import { ModelPricingSettingsPage } from "./settings/pages/ModelPricingSettingsPage";
import { AboutSettingsPage } from "./settings/pages/AboutSettingsPage";
import { useSettingsStore } from "../stores/settingsStore";
import { useI18n, type TranslationKey } from "../lib/i18n";

export type SettingsTab =
  | "general"
  | "sidebar"
  | "terminal-theme"
  | "shortcuts"
  | "templates"
  | "providers"
  | "model-pricing"
  | "sync"
  | "hooks"
  | "about";

interface SettingsTabConfig {
  label: TranslationKey;
  title: TranslationKey;
  description: TranslationKey;
  searchPlaceholder?: TranslationKey;
}

const SETTINGS_TAB_ORDER: SettingsTab[] = [
  "general",
  "terminal-theme",
  "shortcuts",
  "templates",
  "providers",
  "model-pricing",
  "sync",
  "hooks",
  "sidebar",
  "about",
];

const SETTINGS_TAB_CONFIG: Record<SettingsTab, SettingsTabConfig> = {
  general: {
    label: "settings.tabs.general.label",
    title: "settings.tabs.general.title",
    description: "settings.tabs.general.description",
  },
  sidebar: {
    label: "settings.tabs.sidebar.label",
    title: "settings.tabs.sidebar.title",
    description: "settings.tabs.sidebar.description",
  },
  "terminal-theme": {
    label: "settings.tabs.terminal.label",
    title: "settings.tabs.terminal.title",
    description: "settings.tabs.terminal.description",
  },
  shortcuts: {
    label: "settings.tabs.shortcuts.label",
    title: "settings.tabs.shortcuts.title",
    description: "settings.tabs.shortcuts.description",
    searchPlaceholder: "settings.tabs.shortcuts.search",
  },
  templates: {
    label: "settings.tabs.templates.label",
    title: "settings.tabs.templates.title",
    description: "settings.tabs.templates.description",
    searchPlaceholder: "settings.tabs.templates.search",
  },
  providers: {
    label: "settings.tabs.providers.label",
    title: "settings.tabs.providers.title",
    description: "settings.tabs.providers.description",
    searchPlaceholder: "settings.tabs.providers.search",
  },
  "model-pricing": {
    label: "settings.tabs.modelPricing.label",
    title: "settings.tabs.modelPricing.title",
    description: "settings.tabs.modelPricing.description",
    searchPlaceholder: "settings.tabs.modelPricing.search",
  },
  sync: {
    label: "settings.tabs.sync.label",
    title: "settings.tabs.sync.title",
    description: "settings.tabs.sync.description",
  },
  hooks: {
    label: "settings.tabs.hooks.label",
    title: "settings.tabs.hooks.title",
    description: "settings.tabs.hooks.description",
  },
  about: {
    label: "settings.tabs.about.label",
    title: "settings.tabs.about.title",
    description: "settings.tabs.about.description",
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
  const { t } = useI18n();
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

  const tabs = SETTINGS_TAB_ORDER.map((id) => ({ id, label: t(SETTINGS_TAB_CONFIG[id].label) }));
  const activeConfig = SETTINGS_TAB_CONFIG[activeTab];
  const activeContent = (() => {
    if (activeTab === "general") return <GeneralSettingsPage />;
    if (activeTab === "sidebar") return <SidebarSettingsPage />;
    if (activeTab === "terminal-theme") return <ThemeSettingsPage />;
    if (activeTab === "shortcuts") return <ShortcutSettingsPage searchValue={searchValue} />;
    if (activeTab === "templates") return <TemplateSettingsPage searchValue={searchValue} />;
    if (activeTab === "providers") return <ProviderSettingsPage searchValue={searchValue} />;
    if (activeTab === "model-pricing") return <ModelPricingSettingsPage searchValue={searchValue} />;
    if (activeTab === "sync") return <SyncSettingsPage />;
    if (activeTab === "hooks") return <HookSettingsPage />;
    if (activeTab === "about") return <AboutSettingsPage />;
    return null;
  })();

  return (
    <AppMantineThemeProvider>
      <div
        className={`fixed inset-x-0 bottom-0 top-[26px] z-50 ${
          closing ? "animate-fade-out" : "animate-fade-in"
        }`}
        style={{ fontFamily: uiFontFamily }}
        onClick={onClose}
      >
        <div
          ref={dialogRef}
          className={`ui-surface-base flex h-full w-full overflow-hidden${
            closing ? "" : " animate-slide-down"
          }`}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={t("settings.dialogLabel")}
        >
          <SettingsLayout
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            title={t(activeConfig.title)}
            description={t(activeConfig.description)}
            searchValue={searchValue}
            searchPlaceholder={activeConfig.searchPlaceholder ? t(activeConfig.searchPlaceholder) : undefined}
            onSearchChange={setSearchValue}
            onClose={onClose}
          >
            {activeContent}
          </SettingsLayout>
        </div>
      </div>
    </AppMantineThemeProvider>
  );
}
