import { useEffect, useState } from "react";
import { LanguageMode, TranslationKey, resolveLanguage, translate } from "./i18n";
import { useAppModel } from "./useAppModel";
import { GlobalErrorPage, HostHome, LoadingPage, LoginPage, SessionExpiredPage, Workbench } from "./views";

type ThemeMode = "system" | "light" | "dark";

const THEME_KEY = "cli-manager.web.theme";
const LANGUAGE_KEY = "cli-manager.web.language";

function loadStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = localStorage.getItem(key) as T | null;
  return value && allowed.includes(value) ? value : fallback;
}

export function App() {
  const [page, setPage] = useState<"hosts" | "workbench">("hosts");
  const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
    loadStored(THEME_KEY, ["system", "light", "dark"], "system"),
  );
  const [languageMode, setLanguageMode] = useState<LanguageMode>(() =>
    loadStored(LANGUAGE_KEY, ["auto", "zh-CN", "en-US"], "auto"),
  );
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const model = useAppModel();
  const language = resolveLanguage(languageMode);
  const t = (key: TranslationKey) => translate(language, key);
  const resolvedTheme = themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.lang = language;
    localStorage.setItem(THEME_KEY, themeMode);
    localStorage.setItem(LANGUAGE_KEY, languageMode);
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content",
      resolvedTheme === "dark" ? "#0a0a0a" : "#f4f8fe",
    );
  }, [language, languageMode, resolvedTheme, themeMode]);

  useEffect(() => {
    if (model.authPhase !== "authenticated") setPage("hosts");
  }, [model.authPhase]);

  const cycleTheme = () => {
    setThemeMode((current) => (current === "system" ? "light" : current === "light" ? "dark" : "system"));
  };

  const cycleLanguage = () => {
    setLanguageMode((current) => (current === "auto" ? "zh-CN" : current === "zh-CN" ? "en-US" : "auto"));
  };

  if (model.authPhase === "checking") return <LoadingPage t={t} />;
  if (model.authPhase === "login") return <LoginPage t={t} error={model.error} onLogin={model.login} />;
  if (model.authPhase === "expired") return <SessionExpiredPage t={t} onLogin={model.checkAuth} />;
  if (model.authPhase === "error") return <GlobalErrorPage t={t} error={model.error} onRetry={model.checkAuth} />;
  if (model.loadState === "loading" || model.loadState === "idle") return <LoadingPage t={t} />;
  if (model.loadState === "error") return <GlobalErrorPage t={t} error={model.error} onRetry={model.loadWorkspace} />;

  if (page === "hosts") {
    return (
      <HostHome
        t={t}
        userName={model.user?.username ?? t("developer")}
        devices={model.devices}
        pairing={model.pairing}
        socketState={model.socketState}
        resolvedTheme={resolvedTheme}
        onTheme={cycleTheme}
        onLanguage={cycleLanguage}
        onLogout={() => void model.logout()}
        onRefresh={() => void model.loadWorkspace()}
        onSelectDevice={(deviceId) => {
          model.selectDevice(deviceId);
          setPage("workbench");
        }}
        onClaimPairing={model.claimPairing}
        onResetPairing={() => model.setPairing({ status: "idle" })}
      />
    );
  }

  return (
    <Workbench
      t={t}
      userName={model.user?.username ?? t("developer")}
      devices={model.devices}
      selectedDevice={model.selectedDevice}
      history={model.history}
      selectedSession={model.selectedSession}
      projectContexts={model.projectContexts}
      selectedProjectContext={model.selectedProjectContext}
      timeline={model.timeline}
      pairing={model.pairing}
      socketState={model.socketState}
      draft={model.draft}
      composerMessage={model.composerMessage}
      latestSyncAt={model.latestSyncAt}
      resolvedTheme={resolvedTheme}
      onTheme={cycleTheme}
      onLanguage={cycleLanguage}
      onLogout={() => void model.logout()}
      onBackToHosts={() => setPage("hosts")}
      onRefresh={() => void model.loadWorkspace()}
      onSelectDevice={model.selectDevice}
      onSelectSession={model.selectSession}
      onSelectProjectContext={model.selectProjectContext}
      onDraft={model.setDraft}
      onSend={() => void model.sendPrompt()}
      onClaimPairing={model.claimPairing}
      onResetPairing={() => model.setPairing({ status: "idle" })}
      onSubmitManagement={model.submitManagementOperation}
    />
  );
}
