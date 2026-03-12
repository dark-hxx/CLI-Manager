import { Command } from "@tauri-apps/plugin-shell";

export interface ExternalTab {
  cwd?: string;
  title: string;
  startupCmd?: string;
}

function pushTabArgs(args: string[], tab: ExternalTab) {
  args.push("new-tab");
  if (tab.cwd) {
    args.push("-d", tab.cwd);
  }
  args.push("--title", tab.title);
  if (tab.startupCmd && tab.startupCmd.trim()) {
    args.push("powershell", "-NoExit", "-Command", tab.startupCmd);
  } else {
    args.push("powershell");
  }
}

export async function openWindowsTerminal(tabs: ExternalTab[]) {
  if (!tabs.length) return;
  const args: string[] = ["-w", "0"];
  tabs.forEach((tab, idx) => {
    if (idx > 0) args.push(";");
    pushTabArgs(args, tab);
  });
  try {
    await Command.create("wt", args).spawn();
  } catch (err) {
    console.error("Failed to open Windows Terminal:", err);
  }
}
