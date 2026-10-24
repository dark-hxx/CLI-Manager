import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logWarn } from "../../../shared/platform/logger";
import { getOsPlatform } from "../../../shared/platform/shell";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function useWindowsExplorerContextMenu(ready: boolean): void {
  const enabled = useSettingsStore((state) => state.windowsExplorerContextMenuEnabled);
  useEffect(() => {
    if (!IN_TAURI || !ready) return;
    let disposed = false;
    void getOsPlatform()
      .then((platform) => {
        if (disposed || platform !== "windows") return;
        return invoke("set_windows_explorer_context_menu", { enabled });
      })
      .catch((error) => logWarn("Failed to synchronize Windows Explorer context menu", error));
    return () => {
      disposed = true;
    };
  }, [enabled, ready]);
}
