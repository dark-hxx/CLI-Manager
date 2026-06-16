import { ChevronRight, File, FileCode, FileText, Braces, Palette, Image as ImageIcon, Settings, Terminal, Folder } from "../icons";
import type { GitTreeNode } from "../../lib/types";
import { GitStatusIcon } from "./GitStatusIcon";
import { useGitStore } from "../../stores/gitStore";
import { TERM } from "../stats/termStatsUi";

interface GitTreeNodeProps {
  node: GitTreeNode;
  depth: number;
}

function getFileIcon(fileName: string) {
  const lowerName = fileName.toLowerCase();
  const ext = fileName.split(".").pop()?.toLowerCase();

  // 特殊文件名精确匹配（优先级最高）
  if (
    lowerName === "dockerfile" ||
    lowerName.startsWith("dockerfile.") ||
    lowerName === ".dockerignore" ||
    lowerName === "docker-compose.yml" ||
    lowerName === "docker-compose.yaml"
  ) {
    return { icon: Settings, color: TERM.blue };
  }

  if (
    lowerName === "package.json" ||
    lowerName === "package-lock.json" ||
    lowerName === "pom.xml" ||
    lowerName === "build.gradle" ||
    lowerName === "build.gradle.kts" ||
    lowerName === "cargo.toml" ||
    lowerName === "cargo.lock" ||
    lowerName === "go.mod" ||
    lowerName === "go.sum" ||
    lowerName === "requirements.txt" ||
    lowerName === "pipfile" ||
    lowerName === "gemfile" ||
    lowerName === "composer.json"
  ) {
    return { icon: Settings, color: TERM.yellow };
  }

  if (
    lowerName === ".gitignore" ||
    lowerName === ".gitattributes" ||
    lowerName === ".editorconfig" ||
    lowerName === ".eslintrc" ||
    lowerName === ".prettierrc" ||
    lowerName === "tsconfig.json" ||
    lowerName === "vite.config.ts" ||
    lowerName === "vite.config.js" ||
    lowerName === "webpack.config.js" ||
    lowerName === "rollup.config.js"
  ) {
    return { icon: Settings, color: TERM.dim };
  }

  if (lowerName === "readme.md" || lowerName === "readme" || lowerName === "license" || lowerName === "changelog.md") {
    return { icon: FileText, color: TERM.cyan };
  }

  // 扩展名匹配
  switch (ext) {
    // 代码文件
    case "ts":
    case "tsx":
      return { icon: FileCode, color: TERM.blue };

    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return { icon: FileCode, color: TERM.yellow };

    case "rs":
      return { icon: FileCode, color: "#ce422b" };

    case "py":
      return { icon: FileCode, color: "#3776ab" };

    case "java":
      return { icon: FileCode, color: "#b07219" };

    case "go":
      return { icon: FileCode, color: TERM.cyan };

    case "rb":
      return { icon: FileCode, color: "#cc342d" };

    case "php":
      return { icon: FileCode, color: "#4f5d95" };

    case "cpp":
    case "c":
    case "h":
    case "hpp":
      return { icon: FileCode, color: "#f34b7d" };

    case "swift":
    case "kt":
    case "scala":
    case "lua":
    case "r":
    case "dart":
      return { icon: FileCode, color: TERM.blue };

    case "vue":
      return { icon: FileCode, color: TERM.green };

    case "svelte":
      return { icon: FileCode, color: "#ff3e00" };

    // Shell 脚本
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "ps1":
    case "bat":
    case "cmd":
      return { icon: Terminal, color: TERM.green };

    // 配置文件（JSON 系）
    case "json":
    case "jsonc":
    case "json5":
      return { icon: Braces, color: TERM.yellow };

    // 配置文件（YAML/TOML/INI）
    case "toml":
    case "yaml":
    case "yml":
      return { icon: Settings, color: "#cb171e" };

    case "ini":
    case "conf":
    case "config":
    case "env":
    case "properties":
      return { icon: Settings, color: TERM.dim };

    // 构建/依赖配置
    case "gradle":
    case "maven":
    case "lock":
    case "sum":
      return { icon: Settings, color: TERM.dim };

    // 文档
    case "md":
    case "mdx":
      return { icon: FileText, color: TERM.cyan };

    case "txt":
    case "rst":
    case "adoc":
    case "tex":
      return { icon: FileText, color: TERM.dim };

    // 样式文件
    case "css":
      return { icon: Palette, color: "#563d7c" };

    case "scss":
    case "sass":
      return { icon: Palette, color: "#c6538c" };

    case "less":
    case "styl":
      return { icon: Palette, color: TERM.blue };

    // 图片
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "ico":
    case "bmp":
    case "tiff":
      return { icon: ImageIcon, color: TERM.magenta };

    case "svg":
      return { icon: ImageIcon, color: "#ffb13b" };

    // 数据文件
    case "xml":
    case "csv":
    case "tsv":
      return { icon: Braces, color: TERM.dim };

    // 数据库
    case "sql":
    case "db":
    case "sqlite":
    case "sqlite3":
      return { icon: Settings, color: TERM.cyan };

    // HTML/模板
    case "html":
    case "htm":
    case "xhtml":
      return { icon: FileCode, color: "#e34c26" };

    case "hbs":
    case "ejs":
    case "pug":
    case "jade":
      return { icon: FileCode, color: TERM.dim };

    default:
      return { icon: File, color: TERM.dim };
  }
}

export function GitTreeNodeComponent({ node, depth }: GitTreeNodeProps) {
  const { collapsedDirs, toggleDir } = useGitStore();
  const isCollapsed = collapsedDirs.has(node.path);
  const indentPx = depth * 12 + 4;

  if (node.type === "file") {
    const { icon: FileIconComponent, color } = getFileIcon(node.name);

    return (
      <div
        className="flex items-center gap-1.5 rounded py-0.5 px-1 hover:bg-opacity-10 cursor-pointer text-[11px]"
        style={{ paddingLeft: indentPx, backgroundColor: "transparent" }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${TERM.cyan}20`)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
      >
        <FileIconComponent size={11} strokeWidth={1.5} style={{ color }} className="shrink-0" />
        <span className="flex-1 truncate" style={{ color: TERM.fg }}>{node.name}</span>
        {node.change && (
          <>
            <GitStatusIcon status={node.change.status} size={12} />
            {(node.change.added > 0 || node.change.deleted > 0) && (
              <span className="text-[10px]" style={{ color: TERM.dim }}>
                {node.change.added > 0 && (
                  <span style={{ color: TERM.green }}>+{node.change.added}</span>
                )}
                {node.change.added > 0 && node.change.deleted > 0 && " "}
                {node.change.deleted > 0 && (
                  <span style={{ color: TERM.red }}>-{node.change.deleted}</span>
                )}
              </span>
            )}
          </>
        )}
      </div>
    );
  }

  // 目录节点
  const hasChildren = node.children && node.children.length > 0;

  return (
    <div>
      <div
        className="flex items-center gap-1.5 rounded py-0.5 px-1 hover:bg-opacity-10 cursor-pointer font-medium text-[11px]"
        style={{ paddingLeft: indentPx, backgroundColor: "transparent" }}
        onClick={() => toggleDir(node.path)}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${TERM.cyan}20`)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
      >
        <span
          className="inline-flex items-center justify-center shrink-0 transition-transform"
          style={{
            transform: isCollapsed ? "rotate(0deg)" : "rotate(90deg)",
            color: TERM.dim,
          }}
        >
          <ChevronRight size={10} strokeWidth={2} />
        </span>
        <Folder size={11} strokeWidth={1.5} style={{ color: TERM.yellow }} className="shrink-0" />
        <span className="flex-1 truncate" style={{ color: TERM.fg }}>{node.name}</span>
        {hasChildren && (
          <span className="text-[9px] rounded px-1 py-0" style={{ color: TERM.dim, backgroundColor: `${TERM.dim}20` }}>
            {node.children!.length}
          </span>
        )}
      </div>

      {!isCollapsed && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <GitTreeNodeComponent key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
