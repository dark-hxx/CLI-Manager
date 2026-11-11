import { useState, useEffect, useRef, useCallback } from "react";
import { SegmentedControl } from "@mantine/core";
import {
  ClipboardList,
  Coins,
  Code2,
  History,
  Handshake,
  Info,
  Keyboard,
  PanelLeft,
  PawPrint,
  Puzzle,
  RadioTower,
  Server,
  RefreshCw,
  Settings2,
  Sparkles,
  Terminal,
  Webhook,
  PanelsTopLeft,
} from "lucide-react";
import "@mantine/core/styles.css";
import { useFocusTrap } from "../../../shared/hooks/useFocusTrap";
import { AppMantineThemeProvider } from "../../../shared/ui/MantineThemeProvider";
import { SettingsLayout } from "../components/SettingsLayout";
import { SettingsThemeProvider } from "../components/SettingsThemeProvider";
import { SETTINGS_NAV_ICONS, type SettingsIconComponent } from "../components/SettingsIcons";
import { useWorkspaceBackground } from "../../workspace/api/WorkspaceBackground";
import { GeneralSettingsPage } from "../components/pages/GeneralSettingsPage";
import { DeveloperSettingsPage } from "../components/pages/DeveloperSettingsPage";
import { SidebarSettingsPage } from "../components/pages/SidebarSettingsPage";
import { ThemeSettingsPage } from "../components/pages/ThemeSettingsPage";
import { ShortcutSettingsPage } from "../components/pages/ShortcutSettingsPage";
import { TemplateSettingsPage } from "../components/pages/TemplateSettingsPage";
import { SyncSettingsPage } from "../components/pages/SyncSettingsPage";
import { HistorySourceSettingsPage } from "../components/pages/HistorySourceSettingsPage";
import { HookSettingsPage } from "../index";
import { StatuslineSettingsPage } from "../components/pages/StatuslineSettingsPage";
import { CommandSuggestionSettingsPage } from "../components/pages/CommandSuggestionSettingsPage";
import { NativeProviderSettingsPage } from "../components/pages/NativeProviderSettingsPage";
import { ModelPricingSettingsPage } from "../components/pages/ModelPricingSettingsPage";
import { AboutSettingsPage } from "../components/pages/AboutSettingsPage";
import { SponsorsSettingsPage } from "../components/pages/SponsorsSettingsPage";
import { SPONSORS_ENABLED } from "./sponsors";
import { DesktopPetSettingsPage } from "../components/pages/DesktopPetSettingsPage";
import { RemoteConnectionsSettingsPage } from "../components/pages/RemoteConnectionsSettingsPage";
import { SshHostsSettingsPage } from "../components/pages/SshHostsSettingsPage";
import { GlobalExtensionsPage } from "../../extensions";
import { useMcpSaveWorkflow } from "../../extensions/api/mcpSaving";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";
import { useI18n, type TranslationKey } from "../../../shared/i18n/index";
import { normalizeFontFamilyStack } from "../../../shared/platform/systemFonts";

export type SettingsTab =
  | "general"
  | "extensions"
  | "desktop-pet"
  | "developer"
  | "sidebar"
  | "terminal-theme"
  | "shortcuts"
  | "templates"
  | "native-providers"
  | "sponsors"
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
  icon: SettingsIconComponent;
  searchPlaceholder?: TranslationKey;
}

const SETTINGS_TAB_ORDER: SettingsTab[] = [
  "general",
  "terminal-theme",
  "shortcuts",
  "templates",
  "native-providers",
  "extensions",
  "model-pricing",
  "cc-connect",
  "ssh-hosts",
  "sync",
  "history-sources",
  "hooks",
  "statusline",
  "sidebar",
  "desktop-pet",
  "developer",
  ...(SPONSORS_ENABLED ? (["sponsors"] as const) : []),
  "about",
];

const WIDE_SETTINGS_TABS: ReadonlySet<SettingsTab> = new Set([
  "terminal-theme", "shortcuts", "templates", "native-providers", "extensions", "model-pricing", "ssh-hosts", "statusline",
]);

const SETTINGS_TAB_CONFIG: Record<SettingsTab, SettingsTabConfig> = {
  general: {
    label: "settings.tabs.general.label",
    title: "settings.tabs.general.title",
    description: "settings.tabs.general.description",
    icon: Settings2,
  },
  extensions: {
    label: "settings.tabs.extensions.label",
    title: "extensions.page.title",
    description: "extensions.page.description",
    icon: Puzzle,
    searchPlaceholder: "extensions.page.search",
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
  "native-providers": {
    label: "settings.tabs.nativeProviders.label",
    title: "settings.tabs.nativeProviders.title",
    description: "settings.tabs.nativeProviders.description",
    icon: Sparkles,
    searchPlaceholder: "settings.tabs.nativeProviders.search",
  },
  sponsors: {
    label: "settings.tabs.sponsors.label",
    title: "settings.tabs.sponsors.title",
    description: "settings.tabs.sponsors.description",
    icon: Handshake,
  },
  "model-pricing": {
    label: "settings.tabs.modelPricing.label",
    title: "settings.tabs.modelPricing.title",
    description: "settings.tabs.modelPricing.description",
    icon: Coins,
    searchPlaceholder: "settings.tabs.modelPricing.search",
  },
  // Retain the persisted sidebar ID; this page now owns Web connections only.
  "cc-connect": {
    label: "settings.tabs.remoteConnections.label",
    title: "settings.tabs.remoteConnections.title",
    description: "settings.tabs.remoteConnections.description",
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

/**
 * 设置页之上是否还压着别的弹框层。
 *
 * Mantine `Modal`（`role="dialog"` + `aria-modal`）与 Radix `Dialog` 都在捕获阶段处理 Escape，
 * 早于设置页挂在 document 上的冒泡监听；两者都不会 stopPropagation，
 * keepMounted 的隐藏抽屉不拥有 Escape；事件路径仍保留已在捕获阶段关闭的弹框，
 * 因此即使关闭动画为零，也不能让同一次 Escape 连带关掉设置页。
 */
function hasOverlayAboveSettings(settingsDialog: HTMLElement | null, event: KeyboardEvent): boolean {
  if (!settingsDialog) return false;
  const selector = '[role="dialog"], [role="alertdialog"]';
  if (event.composedPath().some((node) =>
    node instanceof HTMLElement && node !== settingsDialog && node.matches(selector),
  )) return true;

  const layers = document.querySelectorAll<HTMLElement>(selector);
  for (const layer of Array.from(layers)) {
    if (layer === settingsDialog || layer.contains(settingsDialog)) continue;
    // 布局矩形同时排除自身或祖先 display:none；透明的退出动画仍保留弹层归属。
    const { visibility } = window.getComputedStyle(layer);
    if (layer.getClientRects().length > 0 && visibility !== "hidden" && visibility !== "collapse") {
      return true;
    }
  }
  return false;
}

export function SettingsModal({ open, onClose, onAfterClose, initialTab, onActiveTabChange }: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? "general");
  const [searchValue, setSearchValue] = useState("");
  const [extensionTab, setExtensionTab] = useState<"mcp" | "skills">("mcp");
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const mcpSave = useMcpSaveWorkflow(open && activeTab === "extensions");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(open);
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
  const settingsIconStyle = useSettingsStore((s) => s.settingsIconStyle);
  const effectiveUiFontFamily = normalizeFontFamilyStack(uiFontFamily);
  const { t } = useI18n();
  const { active: workspaceBackgroundActive } = useWorkspaceBackground();
  useFocusTrap(dialogRef, mounted && !closing);

  const requestClose = useCallback((_reason: "topbar" | "backdrop" | "escape") => {
    if (activeTab === "extensions") mcpSave.requestLeave(onClose);
    else onClose();
  }, [onClose, activeTab, mcpSave.requestLeave]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      if (initialTab) setActiveTab(initialTab === "sponsors" && !SPONSORS_ENABLED ? "general" : initialTab);
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
    const change = () => { setActiveTab(tab); onActiveTabChange?.(tab); };
    if (activeTab === "extensions") mcpSave.requestLeave(change);
    else change();
  };

  useEffect(() => {
    setSearchValue("");
  }, [activeTab]);

  useEffect(() => {
    if (!mounted || closing) return;
    const handleEscape = (event: KeyboardEvent) => {
      // 长按 Esc 不能在子窗关闭后继续穿透；下一次独立按键才属于设置页。
      if (event.key !== "Escape" || event.repeat || event.isComposing || event.defaultPrevented) return;
      // 上层还有弹框（供应商维护、SSH 主机维护、插件安装等）时，Escape 归它处理，设置页不参与
      if (hasOverlayAboveSettings(dialogRef.current, event)) return;
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
    icon: settingsIconStyle === "refined" ? SETTINGS_NAV_ICONS[id] : SETTINGS_TAB_CONFIG[id].icon,
  }));
  const activeConfig = SETTINGS_TAB_CONFIG[activeTab];
  const activeContent = (() => {
    if (activeTab === "general") return <GeneralSettingsPage />;
    if (activeTab === "extensions") return <GlobalExtensionsPage activeTab={extensionTab} mcpSave={mcpSave} />;
    if (activeTab === "desktop-pet") return <DesktopPetSettingsPage />;
    if (activeTab === "developer") return <DeveloperSettingsPage />;
    if (activeTab === "sidebar") return <SidebarSettingsPage />;
    if (activeTab === "terminal-theme") return <ThemeSettingsPage />;
    if (activeTab === "shortcuts") return <ShortcutSettingsPage searchValue={searchValue} />;
    if (activeTab === "templates") return <TemplateSettingsPage searchValue={searchValue} />;
    if (activeTab === "native-providers") return <NativeProviderSettingsPage searchValue={searchValue} />;
    if (activeTab === "sponsors" && SPONSORS_ENABLED) return <SponsorsSettingsPage />;
    if (activeTab === "model-pricing") return <ModelPricingSettingsPage searchValue={searchValue} />;
    if (activeTab === "cc-connect") return <RemoteConnectionsSettingsPage />;
    if (activeTab === "ssh-hosts") return <SshHostsSettingsPage searchValue={searchValue} onTerminalOpened={onClose} />;
    if (activeTab === "sync") return <SyncSettingsPage />;
    if (activeTab === "history-sources") {
      return <HistorySourceSettingsPage onOpenNativeProviderSettings={() => handleTabChange("native-providers")} />;
    }
    if (activeTab === "hooks") return <HookSettingsPage />;
    if (activeTab === "statusline") return <StatuslineSettingsPage searchValue={searchValue} />;
    if (activeTab === "command-suggestions") return <CommandSuggestionSettingsPage />;
    if (activeTab === "about") return <AboutSettingsPage />;
    return null;
  })();

  return (
    <AppMantineThemeProvider>
      <SettingsThemeProvider>
        {mcpSave.dialog}
        <div
          className={`settings-scope ui-workspace-settings-overlay fixed inset-x-0 bottom-0 ${isLikelyMacOs() ? "top-0" : "top-[26px]"} z-50 ${
            closing ? "animate-fade-out" : "animate-fade-in"
          }`}
          data-workspace-background={workspaceBackgroundActive ? "true" : undefined}
          style={{ fontFamily: effectiveUiFontFamily }}
          onClick={(event) => {
            // Portal 内的点击仍可能沿 React 树冒泡，只有真实遮罩点击才是离开意图。
            if (event.target === event.currentTarget) requestClose("backdrop");
          }}
        >
          <div
            ref={dialogRef}
            className={`ui-workspace-settings-dialog ui-surface-base flex h-full w-full overflow-hidden${
              closing ? "" : " animate-slide-down"
            }`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={t("settings.dialogLabel")}
          >
            <SettingsLayout
              contentWidth={WIDE_SETTINGS_TABS.has(activeTab) ? "wide" : "standard"}
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={handleTabChange}
              title={t(activeConfig.title)}
              description={t(activeConfig.description)}
              searchValue={searchValue}
              searchPlaceholder={activeTab !== "extensions" && activeConfig.searchPlaceholder ? t(activeConfig.searchPlaceholder) : undefined}
              searchReplacement={activeTab === "extensions" ? <SegmentedControl
                fullWidth value={extensionTab}
                data={[{ value: "mcp", label: t("extensions.tabs.mcp") }, { value: "skills", label: t("extensions.tabs.skills") }]}
                onChange={value => {
                  if (value === extensionTab) return;
                  mcpSave.requestLeave(() => setExtensionTab(value as "mcp" | "skills"));
                }}
              /> : undefined}
              onSearchChange={setSearchValue}
              onClose={() => requestClose("topbar")}
            >
              {activeContent}
            </SettingsLayout>
          </div>
        </div>
      </SettingsThemeProvider>
    </AppMantineThemeProvider>
  );
}
