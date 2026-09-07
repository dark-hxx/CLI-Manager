import type { OsPlatform } from "../../../shared/platform/shell";

const WINDOWS_DRIVE_PATH_PATTERN = /^\/?[a-z]:[\\/]/iu;

const normalizePathValue = (value: string | null | undefined): string | null => {
  const normalized = value?.trim();
  return normalized || null;
};

export function decodeOscPathValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseOsc7Cwd(body: string, os: OsPlatform): string | null {
  const value = body.trim();
  if (!value.toLocaleLowerCase().startsWith("file://")) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;

    const path = decodeOscPathValue(url.pathname);
    if (WINDOWS_DRIVE_PATH_PATTERN.test(path) && os !== "macos" && os !== "linux") {
      return path.startsWith("/") ? path.slice(1) : path;
    }
    if (url.hostname && url.hostname !== "localhost" && os === "windows") {
      return `//${url.hostname}${path}`;
    }
    return path || null;
  } catch {
    return null;
  }
}

export function resolveTerminalProjectPath(
  cwd: string | null | undefined,
  projectPath: string | null | undefined,
  os: OsPlatform,
): string | null {
  const terminalPath = normalizePathValue(cwd);
  const fallbackPath = normalizePathValue(projectPath);
  if (!terminalPath) return fallbackPath;
  if (!fallbackPath) return terminalPath;

  const terminalIsWindows = WINDOWS_DRIVE_PATH_PATTERN.test(terminalPath);
  const fallbackIsWindows = WINDOWS_DRIVE_PATH_PATTERN.test(fallbackPath);
  if (terminalIsWindows !== fallbackIsWindows) return fallbackPath;

  if (
    os !== "windows"
    && fallbackPath.startsWith("/")
    && terminalPath.startsWith("//")
    && terminalPath.endsWith(fallbackPath)
  ) {
    return fallbackPath;
  }

  return terminalPath;
}
