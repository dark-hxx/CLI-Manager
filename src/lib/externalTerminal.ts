import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { logError } from "./logger";

export interface ExternalTab {
  cwd?: string;
  title: string;
  startupCmd?: string;
  shell?: string;
}

export async function openWindowsTerminal(tabs: ExternalTab[]) {
  if (!tabs.length) return;
  try {
    await invoke("open_windows_terminal", {
      tabs: tabs.map((t) => ({
        cwd: t.cwd ?? null,
        title: t.title,
        startup_cmd: t.startupCmd ?? null,
        shell: t.shell ?? null,
      })),
    });
  } catch (err) {
    const message = String(err);
    const isWindowsTerminalNotFound = /program notfound|wt\.exe\) not found|not found/i.test(message);
    toast.error("无法打开外部终端", {
      description: isWindowsTerminalNotFound
        ? "未找到 Windows Terminal（wt.exe）。请先安装 Windows Terminal，或在设置中关闭“外部终端”。"
        : message,
    });
    logError("Failed to open Windows Terminal", err);
  }
}
