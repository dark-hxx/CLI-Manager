import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { logWarn } from "../lib/logger";
import appIcon32 from "../assets/app-icon-32.png";

const IN_TAURI = isTauri();

export function WindowTitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!IN_TAURI) return;
    const appWindow = getCurrentWindow();
    let mounted = true;
    let unlisten: (() => void) | null = null;

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

    void (async () => {
      await syncMaximized();
      try {
        unlisten = await appWindow.onResized(() => {
          void syncMaximized();
        });
      } catch (err) {
        logWarn("Failed to listen to window resize event", err);
      }
    })();

    return () => {
      mounted = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const runWindowAction = (action: () => Promise<void>) => {
    if (!IN_TAURI) return;
    void action().catch((err) => {
      logWarn("Window title bar action failed", err);
    });
  };

  return (
    <header className="window-titlebar flex h-9 shrink-0 items-center bg-bg-secondary">
      <div
        className="flex min-w-0 flex-1 items-center gap-2 px-3 text-xs"
        data-tauri-drag-region
        onDoubleClick={() => runWindowAction(() => getCurrentWindow().toggleMaximize())}
      >
        <img
          src={appIcon32}
          alt="App Icon"
          className="h-4 w-4 shrink-0 rounded-[3px]"
          draggable={false}
        />
        <span className="truncate font-medium tracking-wide text-text-primary">CLI-Manager</span>
      </div>
      {IN_TAURI && (
        <div className="flex items-center">
          <button
            type="button"
            className="titlebar-btn"
            aria-label="最小化"
            title="最小化"
            onClick={() => runWindowAction(() => getCurrentWindow().minimize())}
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="titlebar-btn"
            aria-label={maximized ? "还原" : "最大化"}
            title={maximized ? "还原" : "最大化"}
            onClick={() => runWindowAction(() => getCurrentWindow().toggleMaximize())}
          >
            {maximized ? <Copy size={12} /> : <Square size={12} />}
          </button>
          <button
            type="button"
            className="titlebar-btn titlebar-btn-close"
            aria-label="关闭"
            title="关闭"
            onClick={() => runWindowAction(() => getCurrentWindow().close())}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </header>
  );
}
