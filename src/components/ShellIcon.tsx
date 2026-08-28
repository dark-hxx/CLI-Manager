import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Command, Fish, GitBranch, Shell as ShellGlyph, Terminal } from "lucide-react";
import cmdIcon from "../assets/shell/cmd.svg";
import gitBashIcon from "../assets/shell/git-bash.svg";
import powershell7Icon from "../assets/shell/powershell-7.svg";
import powershellIcon from "../assets/shell/powershell.svg";
import wslIcon from "../assets/shell/wsl.svg";
import { normalizeShellKey, type ShellKey } from "../lib/shell";
import { cn } from "../lib/utils";

type ShellIconKey = ShellKey | "nushell";

const shellIconCache = new Map<string, string | null>();
const shellIconRequests = new Map<string, Promise<string | null>>();
const bundledShellIcons: Partial<Record<ShellIconKey, string>> = {
  powershell: powershellIcon,
  pwsh: powershell7Icon,
  cmd: cmdIcon,
  gitbash: gitBashIcon,
  wsl: wslIcon,
};

interface ShellIconProps {
  shell?: string | null;
  size?: number;
  className?: string;
}

function inferShellIconKey(value?: string | null): ShellIconKey | undefined {
  const normalized = normalizeShellKey(value);
  if (normalized) return normalized;

  const raw = value?.trim().toLowerCase() ?? "";
  if (!raw) return undefined;

  // Custom profiles may contain an executable path followed by arguments.
  if (/\b(?:powershell|pwsh)(?:\.exe)?\b/.test(raw)) {
    return raw.includes("pwsh") ? "pwsh" : "powershell";
  }
  if (/\bcmd(?:\.exe)?\b/.test(raw)) return "cmd";
  if (/\bwsl(?:\.exe)?\b/.test(raw)) return "wsl";
  if (raw.includes("git-bash") || (raw.includes("\\git\\") && raw.includes("bash"))) return "gitbash";
  if (raw.includes("nushell") || /(?:^|[\\/])nu(?:\.exe)?(?:$|[\\/])/.test(raw)) return "nushell";
  return undefined;
}

function loadShellIcon(command: string): Promise<string | null> {
  if (shellIconCache.has(command)) return Promise.resolve(shellIconCache.get(command) ?? null);
  const pending = shellIconRequests.get(command);
  if (pending) return pending;

  const request = invoke<string | null>("terminal_shell_icon", { command })
    .catch(() => null)
    .then((icon) => {
      shellIconCache.set(command, icon);
      return icon;
    })
    .finally(() => {
      shellIconRequests.delete(command);
    });
  shellIconRequests.set(command, request);
  return request;
}

function useShellIcon(command: string): string | undefined {
  const [loadedIcon, setLoadedIcon] = useState<string | undefined>(() => {
    return shellIconCache.get(command) ?? undefined;
  });

  useEffect(() => {
    let cancelled = false;
    if (!command) {
      setLoadedIcon(undefined);
      return () => {
        cancelled = true;
      };
    }

    const cached = shellIconCache.get(command);
    if (cached) {
      setLoadedIcon(cached);
      return () => {
        cancelled = true;
      };
    }

    setLoadedIcon(undefined);
    void loadShellIcon(command).then((icon) => {
      if (!cancelled) setLoadedIcon(icon ?? undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [command]);

  return loadedIcon;
}

export function ShellIcon({ shell, size = 16, className }: ShellIconProps) {
  const command = shell?.trim() ?? "";
  const iconKey = inferShellIconKey(shell);
  const bundledIcon = iconKey ? bundledShellIcons[iconKey] : undefined;
  const loadedIcon = useShellIcon(bundledIcon ? "" : command);
  const iconClassName = cn("shrink-0", className);

  if (bundledIcon || loadedIcon) {
    return (
      <img
        src={bundledIcon ?? loadedIcon}
        alt=""
        aria-hidden="true"
        className={cn("shrink-0 object-contain", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  switch (iconKey) {
    case "powershell":
    case "pwsh":
    case "wsl":
    case "nushell":
      return <Terminal aria-hidden="true" size={size} className={cn("text-text-muted", iconClassName)} />;
    case "cmd":
      return <Command aria-hidden="true" size={size} className={cn("text-sky-400", iconClassName)} />;
    case "gitbash":
      return <GitBranch aria-hidden="true" size={size} className={cn("text-orange-400", iconClassName)} />;
    case "fish":
      return <Fish aria-hidden="true" size={size} className={cn("text-cyan-300", iconClassName)} />;
    case "zsh":
      return <ShellGlyph aria-hidden="true" size={size} className={cn("text-violet-300", iconClassName)} />;
    case "bash":
    case "sh":
    default:
      return <Terminal aria-hidden="true" size={size} className={cn("text-text-muted", iconClassName)} />;
  }
}
