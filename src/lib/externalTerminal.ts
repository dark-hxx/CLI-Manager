import { Command } from "@tauri-apps/plugin-shell";

export interface ExternalTab {
  cwd?: string;
  title: string;
  startupCmd?: string;
  shell?: string;
}

const SHELL_EXE: Record<string, { exe: string; noExitFlag?: string }> = {
  powershell: { exe: "powershell", noExitFlag: "-NoExit" },
  cmd: { exe: "cmd", noExitFlag: "/K" },
  pwsh: { exe: "pwsh", noExitFlag: "-NoExit" },
  wsl: { exe: "wsl" },
  bash: { exe: "bash" },
};

function pushTabArgs(args: string[], tab: ExternalTab) {
  args.push("new-tab");
  if (tab.cwd) {
    args.push("-d", tab.cwd);
  }
  args.push("--title", tab.title);

  const shellKey = tab.shell ?? "powershell";
  const info = SHELL_EXE[shellKey] ?? SHELL_EXE.powershell;

  if (tab.startupCmd && tab.startupCmd.trim()) {
    args.push(info.exe);
    if (info.noExitFlag) args.push(info.noExitFlag);
    if (shellKey === "cmd") {
      args.push(tab.startupCmd);
    } else {
      args.push("-Command", tab.startupCmd);
    }
  } else {
    args.push(info.exe);
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
