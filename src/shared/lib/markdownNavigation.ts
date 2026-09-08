export type MarkdownNavigationTarget =
  | { kind: "document"; fragment: string }
  | { kind: "external"; href: string }
  | { kind: "file"; path: string; fragment: string }
  | { kind: "invalid"; reason: "malformed" | "outside-project" | "unsupported-scheme" };

export interface MarkdownHeadingTarget {
  id: string;
  lineNumber: number;
}

function decodeLinkPart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeProjectPath(path: string): string | null {
  const parts: string[] = [];
  for (const segment of path.replace(/\\/gu, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

export function resolveMarkdownHref(href: string, currentPath: string): MarkdownNavigationTarget {
  const trimmed = href.trim();
  if (!trimmed) return { kind: "invalid", reason: "malformed" };

  const scheme = /^([a-z][a-z\d+.-]*):/iu.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme) {
    return scheme === "http" || scheme === "https" || scheme === "mailto"
      ? { kind: "external", href: trimmed }
      : { kind: "invalid", reason: "unsupported-scheme" };
  }
  if (trimmed.startsWith("//") || /^[a-z]:[\\/]/iu.test(trimmed)) {
    return { kind: "invalid", reason: "outside-project" };
  }

  const fragmentIndex = trimmed.indexOf("#");
  const rawPath = fragmentIndex === -1 ? trimmed : trimmed.slice(0, fragmentIndex);
  const rawFragment = fragmentIndex === -1 ? "" : trimmed.slice(fragmentIndex + 1);
  const decodedFragment = decodeLinkPart(rawFragment);
  if (decodedFragment === null) return { kind: "invalid", reason: "malformed" };
  if (!rawPath) return { kind: "document", fragment: decodedFragment };
  if (rawPath.includes("?")) return { kind: "invalid", reason: "malformed" };

  const decodedPath = decodeLinkPart(rawPath);
  if (decodedPath === null || decodedPath.includes("\0")) {
    return { kind: "invalid", reason: "malformed" };
  }
  const baseDirectory = currentPath.replace(/\\/gu, "/").split("/").slice(0, -1).join("/");
  const combined = decodedPath.startsWith("/")
    ? decodedPath.slice(1)
    : `${baseDirectory}/${decodedPath}`;
  const path = normalizeProjectPath(combined);
  return path === null
    ? { kind: "invalid", reason: "outside-project" }
    : { kind: "file", path, fragment: decodedFragment };
}

export function createMarkdownHeadingId(text: string, counts: Map<string, number>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, (character) => character === "-" || character === "_" ? character : "")
    .replace(/\s/gu, "-");
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function stripHeadingMarkup(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/gu, "$1")
    .replace(/[`*_~]/gu, "")
    .replace(/<[^>]+>/gu, "")
    .replace(/\\([\\`*{}\[\]()#+.!_>-])/gu, "$1")
    .replace(/[ \t]+#+[ \t]*$/u, "")
    .trim();
}

export function collectMarkdownHeadings(content: string): MarkdownHeadingTarget[] {
  const counts = new Map<string, number>();
  const headings: MarkdownHeadingTarget[] = [];
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  let fence: { marker: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^[ \t]*(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { marker: marker[0], length: marker.length };
      else if (fence.marker === marker[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*$/u.exec(line);
    const setext = index + 1 < lines.length && /^[ \t]{0,3}(?:=+|-+)[ \t]*$/u.test(lines[index + 1])
      ? line.trim()
      : null;
    const text = stripHeadingMarkup(atx?.[1] ?? setext ?? "");
    if (!text) continue;
    headings.push({ id: createMarkdownHeadingId(text, counts), lineNumber: index + 1 });
    if (setext !== null) index += 1;
  }
  return headings;
}

export function findMarkdownHeadingLine(content: string, fragment: string): number | null {
  if (!fragment) return 1;
  return collectMarkdownHeadings(content).find((heading) => heading.id === fragment)?.lineNumber ?? null;
}

interface LinkRange {
  start: number;
  end: number;
  href: string;
}

function sourceOffset(content: string, lineNumber: number, columnNumber: number): number | null {
  if (lineNumber < 1 || columnNumber < 1) return null;
  const lines = content.split("\n");
  if (lineNumber > lines.length) return null;
  let offset = 0;
  for (let line = 1; line < lineNumber; line += 1) {
    offset += lines[line - 1].length + 1;
  }
  return offset + columnNumber - 1;
}

function collectReferenceDefinitions(content: string, isBlocked: (offset: number) => boolean): Map<string, string> {
  const definitions = new Map<string, string>();
  for (const match of content.matchAll(/^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(?:<([^>]+)>|(\S+))/gmu)) {
    if (isBlocked(match.index)) continue;
    definitions.set(match[1].trim().replace(/\s+/gu, " ").toLowerCase(), match[2] ?? match[3]);
  }
  return definitions;
}

function collectMarkdownCodeRanges(content: string): Array<[number, number]> {
  const blocked: Array<[number, number]> = [];
  let fence: { marker: string; length: number; start: number } | null = null;
  for (const match of content.matchAll(/^.*(?:\n|$)/gmu)) {
    const line = match[0].replace(/\n$/u, "");
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (!marker) continue;
    if (!fence) {
      fence = { marker: marker[0], length: marker.length, start: match.index };
    } else if (marker[0] === fence.marker && marker.length >= fence.length) {
      blocked.push([fence.start, match.index + match[0].length]);
      fence = null;
    }
  }
  if (fence) blocked.push([fence.start, content.length]);
  for (const match of content.matchAll(/`+[^\n]*?`+/gu)) blocked.push([match.index, match.index + match[0].length]);
  return blocked;
}

function collectSourceLinks(content: string): LinkRange[] {
  const links: LinkRange[] = [];
  const blocked = collectMarkdownCodeRanges(content);
  const isBlocked = (offset: number) => blocked.some(([start, end]) => offset >= start && offset < end);
  const definitions = collectReferenceDefinitions(content, isBlocked);

  for (const match of content.matchAll(/\[!\[[^\]\n]*\]\([^\n)]*\)\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^\s)\\]|\([^\n)]*\))+))(?:\s+["'(][^\n]*["')])?\s*\)/gu)) {
    if (!isBlocked(match.index)) links.push({ start: match.index, end: match.index + match[0].length, href: match[1] ?? match[2] });
  }
  for (const match of content.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^\s)\\]|\([^\n)]*\))+))(?:\s+["'(][^\n]*["')])?\s*\)/gu)) {
    if (!isBlocked(match.index) && !links.some((link) => match.index >= link.start && match.index < link.end)) {
      links.push({ start: match.index, end: match.index + match[0].length, href: match[1] ?? match[2] });
    }
  }
  for (const match of content.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/gu)) {
    if (isBlocked(match.index)) continue;
    const key = (match[2] || match[1]).trim().replace(/\s+/gu, " ").toLowerCase();
    const href = definitions.get(key);
    if (href) links.push({ start: match.index, end: match.index + match[0].length, href });
  }
  for (const match of content.matchAll(/(?<!!)\[([^\]\n]+)\](?![\[(])/gu)) {
    if (isBlocked(match.index) || content[match.index + match[0].length] === ":") continue;
    if (links.some((link) => match.index >= link.start && match.index < link.end)) continue;
    const key = match[1].trim().replace(/\s+/gu, " ").toLowerCase();
    const href = definitions.get(key);
    if (href) links.push({ start: match.index, end: match.index + match[0].length, href });
  }
  for (const match of content.matchAll(/<(https?:\/\/[^>\s]+|mailto:[^>\s]+)>/giu)) {
    if (!isBlocked(match.index)) links.push({ start: match.index, end: match.index + match[0].length, href: match[1] });
  }
  for (const match of content.matchAll(/https?:\/\/[^\s<>]+/giu)) {
    if (isBlocked(match.index) || links.some((link) => match.index >= link.start && match.index < link.end)) continue;
    links.push({ start: match.index, end: match.index + match[0].replace(/[),.;!?]+$/u, "").length, href: match[0].replace(/[),.;!?]+$/u, "") });
  }
  return links;
}

export function findMarkdownLinkAtPosition(
  content: string,
  lineNumber: number,
  columnNumber: number,
): string | null {
  const offset = sourceOffset(content, lineNumber, columnNumber);
  if (offset === null) return null;
  return collectSourceLinks(content).find((link) => offset >= link.start && offset < link.end)?.href ?? null;
}
