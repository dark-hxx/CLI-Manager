import { useState, useEffect, useRef, useCallback } from "react";
import {
  ClipboardList,
  Coins,
  Code2,
  History,
  Info,
  Keyboard,
  PanelLeft,
  PawPrint,
  RadioTower,
  Server,
  RefreshCw,
  ServerCog,
  Settings2,
  Sparkles,
  Terminal,
  Webhook,
  PanelsTopLeft,
  type LucideIcon,
} from "lucide-react";
import "@mantine/core/styles.css";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { AppMantineThemeProvider } from "./ui/MantineThemeProvider";
import { SettingsLayout } from "./settings/SettingsLayout";
import { GeneralSettingsPage } from "./settings/pages/GeneralSettingsPage";
import { DeveloperSettingsPage } from "./settings/pages/DeveloperSettingsPage";
import { SidebarSettingsPage } from "./settings/pages/SidebarSettingsPage";
import { ThemeSettingsPage } from "./settings/pages/ThemeSettingsPage";
import { ShortcutSettingsPage } from "./settings/pages/ShortcutSettingsPage";
import { TemplateSettingsPage } from "./settings/pages/TemplateSettingsPage";
import { SyncSettingsPage } from "./settings/pages/SyncSettingsPage";
import { HistorySourceSettingsPage } from "./settings/pages/HistorySourceSettingsPage";
import { HookSettingsPage } from "./settings/pages/HookSettingsPage";
import { StatuslineSettingsPage } from "./settings/pages/StatuslineSettingsPage";
import { CommandSuggestionSettingsPage } from "./settings/pages/CommandSuggestionSettingsPage";
import { ProviderSettingsPage } from "./settings/pages/ProviderSettingsPage";
import { ModelPricingSettingsPage } from "./settings/pages/ModelPricingSettingsPage";
import { AboutSettingsPage } from "./settings/pages/AboutSettingsPage";
import { DesktopPetSettingsPage } from "./settings/pages/DesktopPetSettingsPage";
import { CcConnectSettingsPage } from "./settings/pages/CcConnectSettingsPage";
import { SshHostsSettingsPage } from "./settings/pages/SshHostsSettingsPage";
import { useSettingsStore } from "../stores/settingsStore";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { normalizeFontFamilyStack } from "../lib/systemFonts";

export type SettingsTab =
  | "general"
  | "desktop-pet"
  | "developer"
  | "sidebar"
  | "terminal-theme"
  | "shortcuts"
  | "templates"
  | "providers"
  | "model-pricing"
  | "cc-connect"
  | "ssh-hosts"
  | "sync"
  | "history-sources"
  | "hooks"
  | "statusline"
  | "command-suggestions"
  | "about";

interface SettingsTabConfig {
  label: TranslationKey;
  title: TranslationKey;
  description: TranslationKey;
  icon: LucideIcon;
  searchPlaceholder?: TranslationKey;
}

const SETTINGS_TAB_ORDER: SettingsTab[] = [
  "general",
  "terminal-theme",
  "shortcuts",
  "templates",
  "providers",
  "model-pricing",
  "cc-connect",
  "ssh-hosts",
  "sync",
  "history-sources",
  "hooks",
  "statusline",
  "command-suggestions",
  "sidebar",
  "desktop-pet",
  "developer",
  "about",
];

const SETTINGS_TAB_CONFIG: Record<SettingsTab, SettingsTabConfig> = {
  general: {
    label: "settings.tabs.general.label",
    title: "settings.tabs.general.title",
    description: "settings.tabs.general.description",
    icon: Settings2,
  },
  "desktop-pet": {
    label: "settings.tabs.desktopPet.label",
    title: "settings.tabs.desktopPet.title",
    description: "settings.tabs.desktopPet.description",
    icon: PawPrint,
  },
  developer: {
    label: "settings.tabs.developer.label",
    title: "settings.tabs.developer.title",
    description: "settings.tabs.developer.description",
    icon: Code2,
  },
  sidebar: {
    label: "settings.tabs.sidebar.label",
    title: "settings.tabs.sidebar.title",
    description: "settings.tabs.sidebar.description",
    icon: PanelLeft,
  },
  "terminal-theme": {
    label: "settings.tabs.terminal.label",
    title: "settings.tabs.terminal.title",
    description: "settings.tabs.terminal.description",
    icon: Terminal,
  },
  shortcuts: {
    label: "settings.tabs.shortcuts.label",
    title: "settings.tabs.shortcuts.title",
    description: "settings.tabs.shortcuts.description",
    icon: Keyboard,
    searchPlaceholder: "settings.tabs.shortcuts.search",
  },
  templates: {
    label: "settings.tabs.templates.label",
    title: "settings.tabs.templates.title",
    description: "settings.tabs.templates.description",
    icon: ClipboardList,
    searchPlaceholder: "settings.tabs.templates.search",
  },
  providers: {
    label: "settings.tabs.providers.label",
    title: "settings.tabs.providers.title",
    description: "settings.tabs.providers.description",
    icon: ServerCog,
    searchPlaceholder: "settings.tabs.providers.search",
  },
  "model-pricing": {
    label: "settings.tabs.modelPricing.label",
    title: "settings.tabs.modelPricing.title",
    description: "settings.tabs.modelPricing.description",
    icon: Coins,
    searchPlaceholder: "settings.tabs.modelPricing.search",
  },
  "cc-connect": {
    label: "settings.tabs.ccConnect.label",
    title: "settings.tabs.ccConnect.title",
    description: "settings.tabs.ccConnect.description",
    icon: RadioTower,
  },
  "ssh-hosts": {
    label: "settings.tabs.sshHosts.label",
    title: "settings.tabs.sshHosts.title",
    description: "settings.tabs.sshHosts.description",
    icon: Server,
    searchPlaceholder: "settings.tabs.sshHosts.search",
  },
  sync: {
    label: "settings.tabs.sync.label",
    title: "settings.tabs.sync.title",
    description: "settings.tabs.sync.description",
    icon: RefreshCw,
  },
  "history-sources": {
    label: "settings.tabs.historySources.label",
    title: "settings.tabs.historySources.title",
    description: "settings.tabs.historySources.description",
    icon: History,
  },
  hooks: {
    label: "settings.tabs.hooks.label",
    title: "settings.tabs.hooks.title",
    description: "settings.tabs.hooks.description",
    icon: Webhook,
  },
  statusline: {
    label: "settings.tabs.statusline.label",
    title: "settings.tabs.statusline.title",
    description: "settings.tabs.statusline.description",
    icon: PanelsTopLeft,
    searchPlaceholder: "settings.tabs.statusline.search",
  },
  "command-suggestions": {
    label: "settings.tabs.commandSuggestions.label",
    title: "settings.tabs.commandSuggestions.title",
    description: "settings.tabs.commandSuggestions.description",
    icon: Sparkles,
  },
  about: {
    label: "settings.tabs.about.label",
    title: "settings.tabs.about.title",
    description: "settings.tabs.about.description",
    icon: Info,
  },
};

interface Props {
  open: boolean;
  onClose: () => void;
  onAfterClose?: () => void;
  initialTab?: SettingsTab;
  onActiveTabChange?: (tab: SettingsTab) => void;
}

function isLikelyMacOs() {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

export function SettingsModal({ open, onClose, onAfterClose, initialTab, onActiveTabChange }: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? "general");
  const [searchValue, setSearchValue] = useState("");
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(open);
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
  const effectiveUiFontFamily = normalizeFontFamilyStack(uiFontFamily);
  const { t } = useI18n();
  useFocusTrap(dialogRef, mounted && !closing);

  const requestClose = useCallback((_reason: "topbar" | "backdrop" | "escape") => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      if (initialTab) setActiveTab(initialTab);
      setMounted(true);
      setClosing(false);
    }
    wasOpenRef.current = open;
  }, [open, initialTab]);

  useEffect(() => {
    if (open) return;
    if (!mounted) return;
    setMounted(false);
    setClosing(false);
    onAfterClose?.();
  }, [open, mounted, initialTab, onAfterClose]);

  const handleTabChange = (tab: SettingsTab) => {
    if (tab === activeTab) return;
    setActiveTab(tab);
    onActiveTabChange?.(tab);
  };

  useEffect(() => {
    setSearchValue("");
  }, [activeTab]);

  useEffect(() => {
    if (!mounted || closing) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      requestClose("escape");
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [mounted, closing, requestClose]);

  if (!mounted) return null;

  const tabs = SETTINGS_TAB_ORDER.map((id) => ({
    id,
    label: t(SETTINGS_TAB_CONFIG[id].label),
    icon: SETTINGS_TAB_CONFIG[id].icon,
  }));
  const activeConfig = SETTINGS_TAB_CONFIG[activeTab];
  const activeContent = (() => {
    if (activeTab === "general") return <GeneralSettingsPage />;
    if (activeTab === "desktop-pet") return <DesktopPetSettingsPage />;
    if (activeTab === "developer") return <DeveloperSettingsPage />;
    if (activeTab === "sidebar") return <SidebarSettingsPage />;
    if (activeTab === "terminal-theme") return <ThemeSettingsPage />;
    if (activeTab === "shortcuts") return <ShortcutSettingsPage searchValue={searchValue} />;
    if (activeTab === "templates") return <TemplateSettingsPage searchValue={searchValue} />;
    if (activeTab === "providers") return <ProviderSettingsPage searchValue={searchValue} />;
    if (activeTab === "model-pricing") return <ModelPricingSettingsPage searchValue={searchValue} />;
    if (activeTab === "cc-connect") return <CcConnectSettingsPage />;
    if (activeTab === "ssh-hosts") return <SshHostsSettingsPage searchValue={searchValue} onTerminalOpened={onClose} />;
    if (activeTab === "sync") return <SyncSettingsPage />;
    if (activeTab === "history-sources") return <HistorySourceSettingsPage />;
    if (activeTab === "hooks") return <HookSettingsPage />;
    if (activeTab === "statusline") return <StatuslineSettingsPage searchValue={searchValue} />;
    if (activeTab === "command-suggestions") return <CommandSuggestionSettingsPage />;
    if (activeTab === "about") return <AboutSettingsPage />;
    return null;
  })();

  return (
    <AppMantineThemeProvider>
      <div
        className={`fixed inset-x-0 bottom-0 ${isLikelyMacOs() ? "top-0" : "top-[26px]"} z-50 ${
          closing ? "animate-fade-out" : "animate-fade-in"
        }`}
        style={{ fontFamily: effectiveUiFontFamily }}
        onClick={() => requestClose("backdrop")}
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
            onTabChange={handleTabChange}
            title={t(activeConfig.title)}
            description={t(activeConfig.description)}
            searchValue={searchValue}
            searchPlaceholder={activeConfig.searchPlaceholder ? t(activeConfig.searchPlaceholder) : undefined}
            onSearchChange={setSearchValue}
            onClose={() => requestClose("topbar")}
          >
            {activeContent}
          </SettingsLayout>
        </div>
      </div>
    </AppMantineThemeProvider>
  );
}
