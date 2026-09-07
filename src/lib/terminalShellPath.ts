// Pure shell path helpers: quoting and joining paths per shell/OS. Depends only
// on the pure shell-key normalizers in ./shell, not on any xterm runtime.

import { normalizeShellForOs, normalizeShellKey, type OsPlatform, type ShellKey } from "./shell";

export const normalizeShellForKnownOs = (
  shell: string | null | undefined,
  os: OsPlatform,
): ShellKey | undefined => (
  os === "unknown" ? normalizeShellKey(shell) : normalizeShellForOs(shell, os)
);

export const quoteShellPath = (path: string, shell: string | null | undefined) => {
  const normalized = normalizeShellKey(shell);
  const shellPath = normalized === "wsl" ? windowsPathToWsl(path) : path;
  if (normalized === "cmd") return `"${shellPath.replace(/"/g, "\"\"")}"`;
  if (normalized === "powershell" || normalized === "pwsh") return `'${shellPath.replace(/'/g, "''")}'`;
  return `'${shellPath.replace(/'/g, "'\\''")}'`;
};

export const windowsPathToWsl = (path: string): string => {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path.trim());
  if (!match) return path;
  const tail = match[2].replace(/\\/g, "/").replace(/^\/+/, "");
  return tail ? `/mnt/${match[1].toLowerCase()}/${tail}` : `/mnt/${match[1].toLowerCase()}`;
};

export const formatShellPathList = (paths: string[], shell: string | null | undefined) => (
  paths.filter(Boolean).map((path) => quoteShellPath(path, shell)).join(" ")
);

export const joinLocalPath = (rootPath: string, relativePath: string) => {
  const normalizedRelativePath = relativePath.replace(/^[/\\]+/u, "");
  if (/[\\/]/u.test(rootPath) && rootPath.includes("\\")) {
    return `${rootPath.replace(/[\\/]+$/u, "")}\\${normalizedRelativePath.replace(/\//g, "\\")}`;
  }
  return `${rootPath.replace(/\/+$/u, "")}/${normalizedRelativePath.replace(/\\/g, "/")}`;
};
