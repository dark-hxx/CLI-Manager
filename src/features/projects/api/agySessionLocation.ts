import { parseWslPath, windowsPathToLinux } from "../../../shared/lib/wslPaths";

// A Windows drive path compares without case. WSL and native POSIX paths do not.
// UNC spelling may vary (wsl$ vs wsl.localhost); the named distro may not.
export function sameAgyCwd(recorded: string, target: string, distro?: string): boolean {
  const normalize = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = parseWslPath(recorded), b = parseWslPath(target);
  if (distro) {
    if ([a, b].some((p) => p && p.distro.toLowerCase() !== distro.toLowerCase())) return false;
    return normalize(a?.linuxPath ?? windowsPathToLinux(recorded) ?? recorded) === normalize(b?.linuxPath ?? windowsPathToLinux(target) ?? target);
  }
  if (a || b) return false;
  const left = normalize(recorded), right = normalize(target);
  return /^[a-z]:/i.test(left) || left.startsWith("//") ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function validAgyTabLocation(cwd: string | undefined, shell: string | null | undefined, environment?: string | null, os?: string): boolean {
  if (!cwd || !/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(cwd) || /[\x00-\x1f]/.test(cwd) || /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(cwd)) return false;
  const wsl = Boolean(parseWslPath(cwd));
  const windows = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(cwd);
  if (os && (os === "unknown" || (os === "windows") !== windows)) return false;
  return (environment == null || environment === (wsl ? "wsl" : "local")) && (shell === "wsl") === wsl;
}
