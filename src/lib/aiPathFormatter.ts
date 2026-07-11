import type { Project, ProjectFileEntry } from "./types";

const DEFAULT_TREE_MAX_DEPTH = 2;
const DEFAULT_TREE_MAX_NODES = 50;
export const TERMINAL_FILE_PATH_MIME = "application/x-cli-manager-file-path";

export interface AiTextSelection {
  startLine: number;
  endLine: number;
  text?: string;
}

interface RenderState {
  renderedNodes: number;
  truncated: boolean;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function lineText(selection: AiTextSelection): string {
  return selection.startLine === selection.endLine
    ? `L${selection.startLine}`
    : `L${selection.startLine}-L${selection.endLine}`;
}

function sortEntries(entries: ProjectFileEntry[]): ProjectFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function formatAiPath(
  project: Pick<Project, "name">,
  relativePath: string,
  kind: ProjectFileEntry["kind"] = "file"
): string {
  const base = `@${project.name}`;
  const normalizedPath = normalizeRelativePath(relativePath);
  const path = normalizedPath ? `${base}/${normalizedPath}` : base;
  return kind === "directory" ? `${path.replace(/\/+$/, "")}/` : path;
}

export function formatAiPathBlock(
  relativePath: string,
  kind: ProjectFileEntry["kind"] = "file"
): string {
  const normalizedPath = normalizeRelativePath(relativePath);
  const path = normalizedPath ? `@${normalizedPath}` : "@";
  return kind === "directory" && normalizedPath ? `${path}/` : path;
}

export function formatTerminalDragPath(
  project: Pick<Project, "name" | "cli_tool">,
  relativePath: string,
  kind: ProjectFileEntry["kind"] = "file"
): string {
  const normalizedPath = normalizeRelativePath(relativePath);
  const cliTool = project.cli_tool.trim().toLowerCase();

  if (/\bcodex\b/.test(cliTool)) {
    const path = normalizedPath || ".";
    return kind === "directory" && normalizedPath ? `${path}/` : path;
  }

  if (/\bclaude\b/.test(cliTool) || cliTool === "code") {
    const path = normalizedPath ? `@${normalizedPath}` : "@";
    return kind === "directory" && normalizedPath ? `${path}/` : path;
  }

  return formatAiPath(project, relativePath, kind);
}

// 面向终端注入的引用锚点：@相对路径 + 行号范围，不带项目名前缀、不含选中的代码文本，
// 便于终端把整段渲染成文件 chip（与拖入的 formatAiPathBlock 形态一致）。
export function formatAiPathAnchorBlock(
  relativePath: string,
  selection?: AiTextSelection | null
): string {
  const path = formatAiPathBlock(relativePath, "file");
  if (!selection) return path;
  return `${path} ${lineText(selection)}`;
}

export function formatAiAnchor(
  project: Pick<Project, "name">,
  relativePath: string,
  selection?: AiTextSelection | null
): string {
  const path = formatAiPath(project, relativePath, "file");
  if (!selection) return path;

  const selectedText = selection.text?.trim();
  if (selection.startLine === selection.endLine && selectedText) {
    return `${path} ${lineText(selection)} ${selectedText}`;
  }
  return `${path} ${lineText(selection)}`;
}

export function formatAiContextBlock(
  project: Pick<Project, "name">,
  relativePath: string,
  selection?: AiTextSelection | null
): string {
  return [
    `path: ${formatAiPath(project, relativePath, "file")}`,
    selection ? `lines: ${lineText(selection)}` : null,
  ].filter(Boolean).join("\n");
}

export function formatAiTree(
  project: Pick<Project, "name">,
  entry: Pick<ProjectFileEntry, "path" | "kind" | "children">
): string {
  const header = formatAiPath(project, entry.path, entry.kind);
  if (entry.kind !== "directory") return header;

  const lines = [header];
  const state: RenderState = { renderedNodes: 0, truncated: false };
  renderTreeChildren(entry.children ?? [], 1, DEFAULT_TREE_MAX_DEPTH, "", lines, state);
  if (state.truncated) lines.push("... (+more omitted)");
  return lines.join("\n");
}

export function formatAiRootTree(project: Pick<Project, "name">, entries: ProjectFileEntry[]): string {
  const lines = [formatAiPath(project, "", "directory")];
  const state: RenderState = { renderedNodes: 0, truncated: false };
  renderTreeChildren(entries, 1, DEFAULT_TREE_MAX_DEPTH, "", lines, state);
  if (state.truncated) lines.push("... (+more omitted)");
  return lines.join("\n");
}

function renderTreeChildren(
  entries: ProjectFileEntry[],
  depth: number,
  maxDepth: number,
  prefix: string,
  lines: string[],
  state: RenderState
) {
  if (depth > maxDepth) {
    if (entries.length > 0) state.truncated = true;
    return;
  }

  const sortedEntries = sortEntries(entries);
  sortedEntries.forEach((entry, index) => {
    if (state.renderedNodes >= DEFAULT_TREE_MAX_NODES) {
      state.truncated = true;
      return;
    }

    state.renderedNodes += 1;
    const isLast = index === sortedEntries.length - 1;
    const connector = isLast ? "└─ " : "├─ ";
    const suffix = entry.kind === "directory" ? "/" : "";
    lines.push(`${prefix}${connector}${entry.name}${suffix}`);

    if (entry.kind === "directory") {
      renderTreeChildren(
        entry.children ?? [],
        depth + 1,
        maxDepth,
        `${prefix}${isLast ? "   " : "│  "}`,
        lines,
        state
      );
    }
  });
}
