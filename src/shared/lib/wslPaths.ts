export interface WslPath { distro: string; linuxPath: string }

export function parseWslPath(value: string | null | undefined): WslPath | null {
  const path = value?.trim().replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//") ?? "";
  const match = path.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i);
  return match ? { distro: match[1], linuxPath: match[2] || "/" } : null;
}

export function toWslUnc(distro: string, linuxPath: string): string {
  if (!distro || /[\\/\x00-\x1f]/.test(distro) || !linuxPath.startsWith("/")
    || /[\x00-\x1f]/.test(linuxPath) || linuxPath.split("/").some((part) => part === "..")) {
    throw new Error("history_resume_wsl_path_invalid");
  }
  return `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, "\\")}`;
}

export function windowsPathToLinux(value: string): string | null {
  const match = value.trim().match(/^([a-z]):[\\/](.*)$/i);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}` : null;
}
