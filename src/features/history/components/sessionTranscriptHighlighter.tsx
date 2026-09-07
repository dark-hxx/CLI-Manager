import type { ReactNode } from "react";

const STATUS_TOKENS = new Set(["no_task", "planning", "in_progress", "completed", "failed"]);
const PATH_TOKEN_PATTERN = "(?:[A-Za-z]:\\\\[^\\s`\"'<>|]+|(?:src|\\.trellis)[/\\\\][^\\s`\"'<>|]+)";
const SEMANTIC_TOKEN_PATTERN =
  String.raw`\b(?:no_task|planning|in_progress|completed|failed)\b` +
  "|" +
  PATH_TOKEN_PATTERN +
  "|" +
  String.raw`\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,12}\b`;
const GIT_STATUS_RE = /^(\s*)(\?\?|[MADR])(\s+)(.*)$/;
const MAX_QUERY_LENGTH = 128;
const MAX_QUERY_MATCHES = 400;

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeQueryRegex(query: string): RegExp | null {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > MAX_QUERY_LENGTH) return null;
  return new RegExp(escapeRegExp(trimmed), "ig");
}

function isStatusToken(value: string): boolean {
  return STATUS_TOKENS.has(value.toLowerCase());
}

function isPathToken(value: string): boolean {
  return /^[A-Za-z]:\\/.test(value) || /^(?:src|\.trellis)[/\\]/.test(value);
}

function getSemanticClass(value: string): string {
  if (isStatusToken(value)) return "ui-history-transcript-status";
  if (isPathToken(value)) return "ui-history-transcript-path";
  return "ui-history-transcript-commit";
}

function renderSemanticToken(value: string, key: string): ReactNode {
  if (isStatusToken(value)) {
    return (
      <span key={key} className="ui-history-transcript-token ui-history-transcript-status" data-status={value.toLowerCase()}>
        {value}
      </span>
    );
  }

  return (
    <span key={key} className={`ui-history-transcript-token ${getSemanticClass(value)}`}>
      {value}
    </span>
  );
}

function appendNode(nodes: ReactNode[], node: ReactNode) {
  if (Array.isArray(node)) {
    nodes.push(...node);
    return;
  }
  nodes.push(node);
}

function renderSemanticHighlights(text: string, keyPrefix: string): ReactNode {
  const regex = new RegExp(SEMANTIC_TOKEN_PATTERN, "gi");
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let index = 0;

  for (let match = regex.exec(text); match; match = regex.exec(text)) {
    const value = match[0];
    if (!value) break;
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    nodes.push(renderSemanticToken(value, `${keyPrefix}-semantic-${index}`));
    lastIndex = match.index + value.length;
    index += 1;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.length > 0 ? nodes : text;
}

export function renderTranscriptHighlights(text: string, query = "", keyPrefix = "transcript"): ReactNode {
  const queryRegex = makeQueryRegex(query);
  if (!queryRegex) return renderSemanticHighlights(text, keyPrefix);

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let index = 0;

  for (let match = queryRegex.exec(text); match; match = queryRegex.exec(text)) {
    const value = match[0];
    if (!value) break;
    if (index >= MAX_QUERY_MATCHES) break;

    if (match.index > lastIndex) {
      appendNode(nodes, renderSemanticHighlights(text.slice(lastIndex, match.index), `${keyPrefix}-before-${index}`));
    }
    nodes.push(
      <mark key={`${keyPrefix}-query-${index}`} className="ui-markdown-search-mark">
        {value}
      </mark>
    );
    lastIndex = match.index + value.length;
    index += 1;
  }

  if (lastIndex < text.length) appendNode(nodes, renderSemanticHighlights(text.slice(lastIndex), `${keyPrefix}-after`));
  return nodes.length > 0 ? nodes : renderSemanticHighlights(text, keyPrefix);
}

function isLikelyGitTarget(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes(" -> ")) return true;
  if (/[/\\.]/.test(trimmed)) return true;
  return /^[A-Za-z0-9_@-]+$/.test(trimmed) && /[A-Z]/.test(trimmed);
}

export function isGitStatusLine(line: string): boolean {
  const match = GIT_STATUS_RE.exec(line);
  return Boolean(match && isLikelyGitTarget(match[4]));
}

export function renderTranscriptLineHighlights(line: string, query = "", keyPrefix = "line"): ReactNode {
  const match = GIT_STATUS_RE.exec(line);
  if (match && isLikelyGitTarget(match[4])) {
    return (
      <>
        {match[1]}
        <span className="ui-history-transcript-git-prefix" data-status={match[2]}>
          {match[2]}
        </span>
        {match[3]}
        {renderTranscriptHighlights(match[4], query, `${keyPrefix}-git-target`)}
      </>
    );
  }

  return renderTranscriptHighlights(line, query, keyPrefix);
}
