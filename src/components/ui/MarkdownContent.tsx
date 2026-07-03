import { useMemo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PrismAsyncLight as SyntaxHighlighter } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { cn } from "@/lib/utils";
import { logError } from "@/lib/logger";
import { useSettingsStore } from "@/stores/settingsStore";

SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("sh", bash);
SyntaxHighlighter.registerLanguage("shell", bash);
SyntaxHighlighter.registerLanguage("powershell", bash);
SyntaxHighlighter.registerLanguage("ps1", bash);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("diff", diff);
SyntaxHighlighter.registerLanguage("patch", diff);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("js", javascript);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("jsonl", json);
SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("markdown", markdown);
SyntaxHighlighter.registerLanguage("md", markdown);
SyntaxHighlighter.registerLanguage("rust", rust);
SyntaxHighlighter.registerLanguage("rs", rust);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("ts", typescript);

const remarkPlugins = [remarkGfm];

export type MarkdownVariant = "default" | "terminal";
export type MarkdownLinkBehavior = "preview" | "open";

export interface MarkdownContentProps {
  content: string;
  query?: string;
  compact?: boolean;
  variant?: MarkdownVariant;
  linkBehavior?: MarkdownLinkBehavior;
  terminalCodeTheme?: "light" | "dark";
  className?: string;
}

type MarkdownCodeTheme = typeof oneDark;

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let cachedQuery: string | null = null;
let cachedRegex: RegExp | null = null;
let cachedNormalized = "";

function getHighlightRegex(trimmed: string): { regex: RegExp; normalized: string } {
  if (cachedQuery === trimmed && cachedRegex) {
    return { regex: cachedRegex, normalized: cachedNormalized };
  }
  const regex = new RegExp(`(${escapeRegExp(trimmed)})`, "ig");
  cachedQuery = trimmed;
  cachedRegex = regex;
  cachedNormalized = trimmed.toLowerCase();
  return { regex, normalized: cachedNormalized };
}

const HIGHLIGHT_TEXT_MAX_LENGTH = 24_000;
const HIGHLIGHT_PARTS_MAX = 400;

function highlightMarkdownText(text: string, query: string): ReactNode {
  const trimmed = query.trim();
  if (!trimmed || text.length > HIGHLIGHT_TEXT_MAX_LENGTH) return text;
  const { regex, normalized } = getHighlightRegex(trimmed);
  const parts = text.split(regex);
  if (parts.length > HIGHLIGHT_PARTS_MAX) return text;
  return parts.map((part, idx) => {
    if (part.toLowerCase() === normalized) {
      return (
        <mark key={`${part}-${idx}`} className="ui-markdown-search-mark">
          {part}
        </mark>
      );
    }
    return <span key={`${part}-${idx}`}>{part}</span>;
  });
}

function renderText(children: ReactNode, query: string): ReactNode {
  if (!query.trim()) return children;
  if (typeof children === "string") return highlightMarkdownText(children, query);
  if (Array.isArray(children)) {
    return children.map((child, index) => (
      <span key={index}>{renderText(child, query)}</span>
    ));
  }
  return children;
}

function extractPlainText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractPlainText).join("");
  if (children && typeof children === "object" && "props" in children) {
    const props = (children as { props?: { children?: ReactNode } }).props;
    return props?.children ? extractPlainText(props.children) : "";
  }
  return "";
}

function openMarkdownUrl(href: string) {
  void openUrl(href).catch((err) => logError("打开 Markdown 链接失败", { href, err }));
}

function getTableTextAlign(align: string | undefined) {
  if (align === "left" || align === "right" || align === "center" || align === "justify") return align;
  return undefined;
}

function makeLink(
  href: string | undefined,
  children: ReactNode,
  query: string,
  behavior: MarkdownLinkBehavior,
  className?: string,
  title?: string
) {
  if (!href) return <span className={cn("ui-markdown-link", className)}>{renderText(children, query)}</span>;
  if (href.startsWith("#")) {
    return (
      <a className={cn("ui-markdown-link", className)} href={href} title={title ?? href}>
        {renderText(children, query)}
      </a>
    );
  }
  if (behavior === "open") {
    return (
      <a
        className={cn("ui-markdown-link", className)}
        href={href}
        title={title ?? href}
        aria-label={`打开链接：${extractPlainText(children) || href}`}
        onClick={(e) => {
          e.preventDefault();
          openMarkdownUrl(href);
        }}
      >
        {renderText(children, query)}
      </a>
    );
  }

  const linkTitle = href ? `纯文本链接预览：${href}` : "纯文本链接预览";
  return (
    <span className={cn("ui-markdown-link", className)} title={linkTitle} aria-label={linkTitle}>
      {renderText(children, query)}
    </span>
  );
}

const makeComponents = (
  query: string,
  linkBehavior: MarkdownLinkBehavior,
  codeTheme: MarkdownCodeTheme
): Components => {
  const headingCounts = new Map<string, number>();

  const makeHeadingId = (children: ReactNode) => {
    const raw = extractPlainText(children).trim().toLowerCase();
    const base =
      raw
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "heading";
    const count = headingCounts.get(base) ?? 0;
    headingCounts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };

  return {
  h1({ children, className }) {
    const id = makeHeadingId(children);
    return (
      <h1 id={id} className={cn("ui-markdown-h ui-markdown-h1", className)}>
        <a className="ui-markdown-heading-anchor" href={`#${id}`} aria-label="标题锚点">
          #
        </a>
        {renderText(children, query)}
      </h1>
    );
  },
  h2({ children, className }) {
    const id = makeHeadingId(children);
    return (
      <h2 id={id} className={cn("ui-markdown-h ui-markdown-h2", className)}>
        <a className="ui-markdown-heading-anchor" href={`#${id}`} aria-label="标题锚点">
          #
        </a>
        {renderText(children, query)}
      </h2>
    );
  },
  h3({ children, className }) {
    const id = makeHeadingId(children);
    return (
      <h3 id={id} className={cn("ui-markdown-h ui-markdown-h3", className)}>
        <a className="ui-markdown-heading-anchor" href={`#${id}`} aria-label="标题锚点">
          #
        </a>
        {renderText(children, query)}
      </h3>
    );
  },
  h4({ children, className }) {
    const id = makeHeadingId(children);
    return (
      <h4 id={id} className={cn("ui-markdown-h ui-markdown-h4", className)}>
        <a className="ui-markdown-heading-anchor" href={`#${id}`} aria-label="标题锚点">
          #
        </a>
        {renderText(children, query)}
      </h4>
    );
  },
  h5({ children, className }) {
    const id = makeHeadingId(children);
    return (
      <h5 id={id} className={cn("ui-markdown-h ui-markdown-h5", className)}>
        <a className="ui-markdown-heading-anchor" href={`#${id}`} aria-label="标题锚点">
          #
        </a>
        {renderText(children, query)}
      </h5>
    );
  },
  h6({ children, className }) {
    const id = makeHeadingId(children);
    return (
      <h6 id={id} className={cn("ui-markdown-h ui-markdown-h6", className)}>
        <a className="ui-markdown-heading-anchor" href={`#${id}`} aria-label="标题锚点">
          #
        </a>
        {renderText(children, query)}
      </h6>
    );
  },
  p({ children }) {
    return <p className="ui-markdown-p">{renderText(children, query)}</p>;
  },
  ul({ children, className }) {
    return <ul className={cn("ui-markdown-ul", className)}>{children}</ul>;
  },
  ol({ children, className, start }) {
    return (
      <ol className={cn("ui-markdown-ol", className)} start={start}>
        {children}
      </ol>
    );
  },
  li({ children, className }) {
    return <li className={className}>{renderText(children, query)}</li>;
  },
  blockquote({ children }) {
    return <blockquote className="ui-markdown-quote">{children}</blockquote>;
  },
  hr() {
    return <hr className="ui-markdown-hr" />;
  },
  table({ children }) {
    return (
      <div className="ui-markdown-table-wrap">
        <table className="ui-markdown-table">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="ui-markdown-thead">{children}</thead>;
  },
  tbody({ children }) {
    return <tbody className="ui-markdown-tbody">{children}</tbody>;
  },
  tr({ children }) {
    return <tr className="ui-markdown-tr">{children}</tr>;
  },
  th({ children, align }) {
    const textAlign = getTableTextAlign(align);
    return <th style={textAlign ? { textAlign } : undefined}>{renderText(children, query)}</th>;
  },
  td({ children, align }) {
    const textAlign = getTableTextAlign(align);
    return <td style={textAlign ? { textAlign } : undefined}>{renderText(children, query)}</td>;
  },
  input({ type, checked }) {
    if (type !== "checkbox") return <input type={type} checked={checked} readOnly disabled />;
    return (
      <input
        type="checkbox"
        className="ui-markdown-checkbox"
        checked={Boolean(checked)}
        readOnly
        disabled
        aria-label={checked ? "已完成" : "未完成"}
      />
    );
  },
  sup({ children }) {
    return <sup className="ui-markdown-sup">{children}</sup>;
  },
  section({ children, className }) {
    return <section className={cn("ui-markdown-section", className)}>{children}</section>;
  },
  br() {
    return <br className="ui-markdown-br" />;
  },
  strong({ children }) {
    return <strong className="ui-markdown-strong">{renderText(children, query)}</strong>;
  },
  em({ children }) {
    return <em className="ui-markdown-em">{renderText(children, query)}</em>;
  },
  del({ children }) {
    return <del className="ui-markdown-del">{renderText(children, query)}</del>;
  },
  a({ href, children, className, title }) {
    return makeLink(href, children, query, linkBehavior, className, title);
  },
  img({ src, alt, title }) {
    return (
      <span className="ui-markdown-image" title={title ?? src}>
        <span className="ui-markdown-image-label">图片</span>
        <span className="ui-markdown-image-text">{alt || src || "未命名图片"}</span>
      </span>
    );
  },
  code({ children, className }) {
    const code = String(children).replace(/\n$/, "");
    const match = /language-([\w-]+)/.exec(className ?? "");
    const language = match?.[1]?.toLowerCase();

    if (!language) {
      return <code className="ui-markdown-inline-code">{renderText(code, query)}</code>;
    }

    return (
      <div className="ui-markdown-code-block">
        <div className="ui-markdown-code-header">
          <span>{language}</span>
        </div>
        <SyntaxHighlighter
          language={language}
          style={codeTheme}
          customStyle={{
            margin: 0,
            padding: "0.75rem",
            background: "transparent",
            fontSize: "0.75rem",
            lineHeight: 1.55,
          }}
          codeTagProps={{ className: "ui-markdown-code-tag" }}
          wrapLongLines
        >
          {code}
        </SyntaxHighlighter>
      </div>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
  };
};

export function MarkdownContent({
  content,
  query = "",
  compact = false,
  variant = "default",
  linkBehavior = variant === "terminal" ? "open" : "preview",
  terminalCodeTheme,
  className,
}: MarkdownContentProps) {
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const codeTheme = useMemo<MarkdownCodeTheme>(() => {
    if (variant === "terminal") {
      return terminalCodeTheme === "light" ? oneLight : oneDark;
    }
    return resolvedTheme === "dark" ? oneDark : oneLight;
  }, [resolvedTheme, terminalCodeTheme, variant]);

  return (
    <div
      className={cn(
        "ui-markdown text-xs text-text-primary",
        variant === "terminal" && "ui-markdown-terminal",
        compact && "ui-markdown-compact",
        className
      )}
    >
      <Markdown remarkPlugins={remarkPlugins} components={makeComponents(query, linkBehavior, codeTheme)} skipHtml>
        {content}
      </Markdown>
    </div>
  );
}
