import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { logWarn } from "../lib/logger";
import { getOsPlatform } from "../lib/shell";
import appIcon32 from "../assets/app-icon-32.png";
import { useI18n } from "../lib/i18n";

const IN_TAURI = isTauri();

function isLikelyMacOs() {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

export function WindowTitleBar() {
  const { t } = useI18n();
  const [isMacOs, setIsMacOs] = useState(isLikelyMacOs);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!IN_TAURI) return;
    void getOsPlatform()
      .then((platform) => setIsMacOs(platform === "macos"))
      .catch((err) => logWarn("Failed to read OS platform for title bar", err));
  }, []);

  useEffect(() => {
    if (!IN_TAURI || isMacOs) return;
    const appWindow = getCurrentWindow();
    let mounted = true;

    const syncMaximized = async () => {
      try {
        const next = await appWindow.isMaximized();
        if (mounted) {
          setMaximized(next);
        }
      } catch (err) {
        logWarn("Failed to read window maximize state", err);
      }
    };

    void syncMaximized();

    return () => {
      mounted = false;
    };
  }, [isMacOs]);

  const runWindowAction = (source: string, action: () => Promise<void>) => {
    if (!IN_TAURI) return;
    void (async () => {
      try {
        await action();
        if (source === "toggleMaximize") {
          const next = await getCurrentWindow().isMaximized();
          setMaximized(next);
        }
      } catch (err) {
        logWarn("Window title bar action failed", { source, err });
      }
    })();
  };

  if (isMacOs) return null;

  return (
    <header className="window-titlebar flex h-[26px] shrink-0 items-center bg-surface-container-low">
      <div
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 text-[13px]"
        data-tauri-drag-region
        onDoubleClick={() => runWindowAction("toggleMaximize", () => getCurrentWindow().toggleMaximize())}
      >
        <img
          src={appIcon32}
          alt="App Icon"
          className="h-4 w-4 shrink-0 rounded-[3px]"
          draggable={false}
        />
        <span className="truncate text-[13px] font-semibold tracking-[0.005em] text-on-surface">CLI-Manager</span>
      </div>
      {!isMacOs && IN_TAURI && (
        <div className="flex items-center">
          <button
            type="button"
            className="titlebar-btn"
            aria-label={t("window.minimize")}
            title={t("window.minimize")}
            onClick={() => runWindowAction("minimize", () => getCurrentWindow().minimize())}
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="titlebar-btn"
            aria-label={maximized ? t("window.restore") : t("window.maximize")}
            title={maximized ? t("window.restore") : t("window.maximize")}
            onClick={() => runWindowAction("toggleMaximize", () => getCurrentWindow().toggleMaximize())}
          >
            {maximized ? <Copy size={12} /> : <Square size={12} />}
          </button>
          <button
            type="button"
            className="titlebar-btn titlebar-btn-close"
            aria-label={t("window.close")}
            title={t("window.close")}
            onClick={() => runWindowAction("close", () => getCurrentWindow().close())}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </header>
  );
}
