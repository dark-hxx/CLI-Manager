import { ChevronRight, FileCode2, Folder } from "lucide-react";
import { useMemo, useState } from "react";
import type { GitCommitFile } from "../../../lib/types";
import { useI18n } from "../../../lib/i18n";
import { TERM } from "../../stats/termStatsUi";
import { STATUS_CONFIG } from "../GitStatusIcon";

interface GitChangedFilesTreeProps {
  files: GitCommitFile[];
  onSelect: (file: GitCommitFile) => void;
  selectedFile: GitCommitFile | null;
}

interface FileNode {
  kind: "file";
  name: string;
  path: string;
  file: GitCommitFile;
}

interface DirectoryNode {
  kind: "directory";
  name: string;
  key: string;
  children: Map<string, TreeNode>;
}

type TreeNode = FileNode | DirectoryNode;

function normalizePath(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

function buildTree(files: GitCommitFile[]): DirectoryNode {
  const root: DirectoryNode = {
    kind: "directory",
    name: "",
    key: "",
    children: new Map(),
  };
  for (const file of files) {
    const parts = normalizePath(file.path);
    let current = root;
    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      const key = current.key ? `${current.key}/${part}` : part;
      if (isFile) {
        current.children.set(key, {
          kind: "file",
          name: part,
          path: file.path,
          file,
        });
        return;
      }
      const existing = current.children.get(key);
      if (existing?.kind === "directory") {
        current = existing;
        return;
      }
      const directory: DirectoryNode = {
        kind: "directory",
        name: part,
        key,
        children: new Map(),
      };
      current.children.set(key, directory);
      current = directory;
    });
  }
  return root;
}

function sortNodes(nodes: Iterable<TreeNode>): TreeNode[] {
  return [...nodes].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
  });
}

function TreeDirectory({
  node,
  depth,
  onSelect,
  selectedFile,
}: {
  node: DirectoryNode;
  depth: number;
  onSelect: (file: GitCommitFile) => void;
  selectedFile: GitCommitFile | null;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const children = sortNodes(node.children.values());
  return (
    <div>
      {node.name && (
        <button
          type="button"
          className="ui-focus-ring flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-[10px]"
          style={{ paddingLeft: `${8 + depth * 14}px`, color: TERM.fg }}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          title={node.key}
        >
          <ChevronRight
            size={12}
            className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <Folder
            size={12}
            className="shrink-0"
            style={{ color: TERM.yellow }}
          />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          <span className="shrink-0 text-[9px]" style={{ color: TERM.dim }}>
            {children.length}
          </span>
        </button>
      )}
      {(expanded || !node.name) &&
        children.map((child) => {
          if (child.kind === "directory") {
            return (
              <TreeDirectory
                key={child.key}
                node={child}
                depth={node.name ? depth + 1 : depth}
                onSelect={onSelect}
                selectedFile={selectedFile}
              />
            );
          }
          const selected =
            selectedFile?.path === child.file.path &&
            selectedFile.oldPath === child.file.oldPath;
          return (
            <button
              key={`${child.file.oldPath ?? ""}:${child.path}`}
              type="button"
              className="ui-focus-ring flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-[10px]"
              style={{
                paddingLeft: `${22 + depth * 14}px`,
                color: TERM.fg,
                backgroundColor: selected
                  ? "rgba(128, 180, 210, 0.14)"
                  : "transparent",
              }}
              onClick={() => onSelect(child.file)}
              title={child.path}
            >
              <span
                className="w-3 shrink-0 font-bold"
                style={{
                  color: STATUS_CONFIG[child.file.status]?.color ?? TERM.fg,
                }}
              >
                {child.file.status}
              </span>
              <FileCode2
                size={11}
                className="shrink-0"
                style={{ color: TERM.dim }}
              />
              <span className="min-w-0 flex-1 truncate">{child.name}</span>
              {!child.file.binary && (
                <span className="shrink-0">
                  <span style={{ color: TERM.green }}>+{child.file.added}</span>{" "}
                  <span style={{ color: TERM.red }}>-{child.file.deleted}</span>
                </span>
              )}
            </button>
          );
        })}
      {!children.length && node.name && (
        <div className="px-3 py-1 text-[10px]" style={{ color: TERM.dim }}>
          {t("git.history.noFiles")}
        </div>
      )}
    </div>
  );
}

export function GitChangedFilesTree({
  files,
  onSelect,
  selectedFile,
}: GitChangedFilesTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  return (
    <TreeDirectory
      node={tree}
      depth={0}
      onSelect={onSelect}
      selectedFile={selectedFile}
    />
  );
}
