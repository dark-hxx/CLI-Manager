export interface TerminalFileLinkMatch {
  text: string;
  path: string;
  kind: "absolute" | "relative";
  startIndex: number;
  endIndex: number;
  lineNumber?: number;
  columnNumber?: number;
}

interface TerminalBufferCellLike {
  getChars(): string;
  getWidth(): number;
}

interface TerminalBufferLineLike {
  readonly length: number;
  getCell(index: number): TerminalBufferCellLike | undefined;
}

const ABSOLUTE_FILE_PATH_PATTERN = /(?:\/?[A-Za-z]:[\\/][^\s`"'<>|?*]+|\\\\[^\\/\s]+[\\/][^\s`"'<>|?*]+|\/(?:mnt\/[A-Za-z]|home|root|workspace|work|data|opt|tmp|usr|var)(?:\/[^\s`"'<>|]+)+)/gu;
const TRAILING_PATH_PUNCTUATION = /[,.;:!?，。；：！？、)\]}）】》」』]+$/u;
const WSL_UNC_ROOT_PATTERN = /^\\\\wsl(?:\.localhost|\$)\\([^\\/]+)(?:[\\/]|$)/iu;
const SOURCE_LOCATION_PATTERN = /(?::(\d+)(?::(\d+))?(?::[^\s]*)?|\((\d+)(?:,(\d+))?\))$/u;
const RELATIVE_FILE_PATH_PATTERN = /(?:\.{1,2}[\\/]|(?!@)[A-Za-z0-9_.-]+[\\/])[^\s`"'<>|?*]+/gu;
const HTTP_URL_PATTERN = /https?:\/\/[^\s`"'<>]+/giu;

function parsePathCandidate(value: string): Pick<TerminalFileLinkMatch, "text" | "path" | "lineNumber" | "columnNumber"> | null {
  let text = value;
  let location = SOURCE_LOCATION_PATTERN.exec(text);
  if (!location) {
    text = text.replace(TRAILING_PATH_PUNCTUATION, "");
    location = SOURCE_LOCATION_PATTERN.exec(text);
  }
  if (!text) return null;
  const path = location ? text.slice(0, -location[0].length) : text;
  if (!path) return null;
  const lineNumber = Number(location?.[1] ?? location?.[3]);
  const columnNumber = Number(location?.[2] ?? location?.[4]);
  return {
    text,
    path,
    ...(Number.isInteger(lineNumber) && lineNumber > 0 ? { lineNumber } : {}),
    ...(Number.isInteger(columnNumber) && columnNumber > 0 ? { columnNumber } : {}),
  };
}

function overlaps(match: Pick<TerminalFileLinkMatch, "startIndex" | "endIndex">, startIndex: number, endIndex: number): boolean {
  return startIndex < match.endIndex && endIndex > match.startIndex;
}

function findHttpUrlRanges(line: string): Array<Pick<TerminalFileLinkMatch, "startIndex" | "endIndex">> {
  const ranges: Array<Pick<TerminalFileLinkMatch, "startIndex" | "endIndex">> = [];
  const pattern = new RegExp(HTTP_URL_PATTERN.source, HTTP_URL_PATTERN.flags);
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    ranges.push({ startIndex: match.index, endIndex: match.index + match[0].length });
  }
  return ranges;
}

export function findTerminalFileLinks(line: string): TerminalFileLinkMatch[] {
  const matches: TerminalFileLinkMatch[] = [];
  const pattern = new RegExp(ABSOLUTE_FILE_PATH_PATTERN.source, ABSOLUTE_FILE_PATH_PATTERN.flags);

  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    const previousCharacter = match.index > 0 ? line[match.index - 1] : "";
    if (previousCharacter && /[A-Za-z0-9:/\\]/u.test(previousCharacter)) continue;
    const candidate = parsePathCandidate(match[0]);
    if (!candidate) continue;
    matches.push({
      ...candidate,
      kind: "absolute",
      startIndex: match.index,
      endIndex: match.index + candidate.text.length,
    });
  }

  return matches;
}

export function findTerminalRelativeFileLinks(line: string): TerminalFileLinkMatch[] {
  const absoluteMatches = findTerminalFileLinks(line);
  const excludedRanges = [...absoluteMatches, ...findHttpUrlRanges(line)];
  const matches: TerminalFileLinkMatch[] = [];
  const pattern = new RegExp(RELATIVE_FILE_PATH_PATTERN.source, RELATIVE_FILE_PATH_PATTERN.flags);

  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    const candidate = parsePathCandidate(match[0]);
    if (!candidate || candidate.path.startsWith("@")) continue;
    const endIndex = match.index + candidate.text.length;
    if (excludedRanges.some((range) => overlaps(range, match.index, endIndex))) continue;
    matches.push({
      ...candidate,
      kind: "relative",
      startIndex: match.index,
      endIndex,
    });
  }

  return matches;
}

export function terminalStringRangeToBufferColumns(
  line: TerminalBufferLineLike,
  startIndex: number,
  endIndex: number,
): { startColumn: number; endColumn: number } | null {
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 0 || endIndex < startIndex) {
    return null;
  }

  const columns: number[] = [0];
  let column = 0;
  let stringIndex = 0;
  while (column < line.length && stringIndex < endIndex) {
    const cell = line.getCell(column);
    const chars = cell?.getChars() || " ";
    const width = Math.max(1, cell?.getWidth() ?? 1);
    for (let index = 0; index < chars.length; index += 1) {
      columns[stringIndex + index] = column;
    }
    stringIndex += chars.length;
    columns[stringIndex] = column + width;
    column += width;
  }

  const startColumn = columns[startIndex];
  const endColumn = columns[endIndex];
  return startColumn === undefined || endColumn === undefined ? null : { startColumn, endColumn };
}

export function normalizeTerminalRelativePath(path: string): string | null {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("@") || /^[A-Za-z]:\//u.test(trimmed) || trimmed.startsWith("/")) return null;

  const segments: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join("/") : null;
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
