export interface TerminalFileLinkMatch {
  text: string;
  startIndex: number;
  endIndex: number;
}

const ABSOLUTE_FILE_PATH_PATTERN = /(?:\/?[A-Za-z]:[\\/][^\s`"'<>|?*]+|\\\\[^\\/\s]+[\\/][^\s`"'<>|?*]+|\/(?:mnt\/[A-Za-z]|home|root|workspace|work|data|opt|tmp|usr|var)(?:\/[^\s`"'<>|]+)+)/gu;
const TRAILING_PATH_PUNCTUATION = /[,.;:!?，。；：！？、)\]}）】》」』]+$/u;
const TRAILING_SOURCE_LOCATION = /:\d+(?::\d+)?(?::[^\s]*)?$/u;
const WSL_UNC_ROOT_PATTERN = /^\\\\wsl(?:\.localhost|\$)\\([^\\/]+)(?:[\\/]|$)/iu;

function trimPathPunctuation(value: string): string {
  return value.replace(TRAILING_PATH_PUNCTUATION, "").replace(TRAILING_SOURCE_LOCATION, "");
}

export function findTerminalFileLinks(line: string): TerminalFileLinkMatch[] {
  const matches: TerminalFileLinkMatch[] = [];
  const pattern = new RegExp(ABSOLUTE_FILE_PATH_PATTERN.source, ABSOLUTE_FILE_PATH_PATTERN.flags);

  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    const previousCharacter = match.index > 0 ? line[match.index - 1] : "";
    if (previousCharacter && /[A-Za-z0-9:/\\]/u.test(previousCharacter)) continue;
    const text = trimPathPunctuation(match[0]);
    if (!text) continue;
    matches.push({
      text,
      startIndex: match.index,
      endIndex: match.index + text.length,
    });
  }

  return matches;
}

export function resolveTerminalFileSystemPath(path: string, currentRootPath?: string | null): string | null {
  const trimmed = path.trim();
  if (/^\/[A-Za-z]:[\\/]/u.test(trimmed)) return trimmed.slice(1);
  if (/^[A-Za-z]:[\\/]/u.test(trimmed) || /^\\\\[^\\/]+[\\/]/u.test(trimmed)) return trimmed;

  const mountedDrive = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/u.exec(trimmed);
  if (mountedDrive) {
    const tail = mountedDrive[2] ? `/${mountedDrive[2]}` : "/";
    return `${mountedDrive[1].toUpperCase()}:${tail}`;
  }

  if (!trimmed.startsWith("/")) return null;
  const distro = currentRootPath ? WSL_UNC_ROOT_PATTERN.exec(currentRootPath)?.[1] : null;
  if (!distro) return null;
  return `\\\\wsl.localhost\\${distro}${trimmed.replace(/\//g, "\\")}`;
}

export function absolutePathToProjectRelative(rootPath: string, targetPath: string): string | null {
  const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/\/+$/u, "");
  const normalizedTarget = targetPath.replace(/\\/g, "/");
  const comparableRoot = normalizedRoot.toLowerCase();
  const comparableTarget = normalizedTarget.toLowerCase();

  if (comparableTarget === comparableRoot) return "";
  if (!comparableTarget.startsWith(`${comparableRoot}/`)) return null;
  return normalizedTarget.slice(normalizedRoot.length + 1);
}
