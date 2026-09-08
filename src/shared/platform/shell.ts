import { invoke } from "@tauri-apps/api/core";

export type ShellKey =
  // Windows
  | "powershell" | "cmd" | "pwsh" | "wsl" | "gitbash"
  // Unix-like (macOS, Linux)
  | "bash" | "zsh" | "fish" | "sh";

export type OsPlatform = "windows" | "macos" | "linux" | "unknown";

function endsWithExe(raw: string, exeName: string): boolean {
  return raw.endsWith(`\\${exeName}`) || raw.endsWith(`/${exeName}`);
}

function isGitBashPath(raw: string): boolean {
  return (
    endsWithExe(raw, "git-bash.exe") ||
    raw.endsWith("/git/bin/bash.exe") ||
    raw.endsWith("\\git\\bin\\bash.exe") ||
    raw.endsWith("/git/usr/bin/bash.exe") ||
    raw.endsWith("\\git\\usr\\bin\\bash.exe")
  );
}

export function normalizeShellKey(value?: string | null): ShellKey | undefined {
  if (!value) return undefined;
  const raw = value.trim().toLowerCase();
  if (!raw) return undefined;

  // Windows shells
  if (
    raw === "powershell" ||
    raw === "powershell.exe" ||
    raw === "windows powershell" ||
    endsWithExe(raw, "powershell.exe")
  ) {
    return "powershell";
  }
  if (raw === "cmd" || raw === "cmd.exe" || raw === "command prompt" || endsWithExe(raw, "cmd.exe")) {
    return "cmd";
  }
  if (raw === "pwsh" || raw === "pwsh.exe" || raw === "powershell core" || endsWithExe(raw, "pwsh.exe")) {
    return "pwsh";
  }
  if (raw === "wsl" || raw === "wsl.exe" || endsWithExe(raw, "wsl.exe")) {
    return "wsl";
  }
  if (raw === "gitbash" || raw === "git bash" || raw === "git-bash" || isGitBashPath(raw)) {
    return "gitbash";
  }

  // Unix shells
  if (raw === "bash" || raw === "bash.exe" || endsWithExe(raw, "bash.exe") || raw === "/bin/bash") {
    return "bash";
  }
  if (raw === "zsh" || raw === "/bin/zsh" || endsWithExe(raw, "zsh")) {
    return "zsh";
  }
  if (raw === "fish" || raw === "/bin/fish" || endsWithExe(raw, "fish")) {
    return "fish";
  }
  if (raw === "sh" || raw === "/bin/sh" || endsWithExe(raw, "sh")) {
    return "sh";
  }

  return undefined;
}

/**
 * Get current OS platform
 */
export async function getOsPlatform(): Promise<OsPlatform> {
  try {
    const platform = await invoke<string>("get_os_platform");
    return platform as OsPlatform;
  } catch (err) {
    console.error("Failed to get OS platform:", err);
    return "unknown";
  }
}

/**
 * Get platform-specific default shell (sync helper, no invoke)
 */
export function defaultShellForOs(os: OsPlatform): ShellKey {
  if (os === "macos") {
    return "zsh";
  } else if (os === "linux") {
    return "bash";
  } else {
    return "powershell";
  }
}

export function isWindowsOnlyShellKey(value?: string | null): boolean {
  const normalized = normalizeShellKey(value);
  return (
    normalized === "powershell" ||
    normalized === "cmd" ||
    normalized === "wsl" ||
    normalized === "gitbash"
  );
}

export function normalizeShellForOs(value: string | null | undefined, os: OsPlatform): ShellKey | undefined {
  const normalized = normalizeShellKey(value);
  if (!normalized) return undefined;
  if (os !== "windows" && isWindowsOnlyShellKey(normalized)) return undefined;
  return normalized;
}

/**
 * Get platform-specific default shell
 */
export async function getDefaultShellForPlatform(): Promise<ShellKey> {
  const os = await getOsPlatform();
  return defaultShellForOs(os);
}
