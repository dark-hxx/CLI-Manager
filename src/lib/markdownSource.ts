const MARKDOWN_SOURCE_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*(?:md|markdown)[ \t]*\n([\s\S]*?)\n\1[ \t]*$/i;

/**
 * Unwrap a message whose complete body is a Markdown source fence.
 *
 * A fenced code block inside the source remains untouched; only an outer
 * fence that covers the entire message is eligible for unwrapping.
 */
export function unwrapFencedMarkdown(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  const match = MARKDOWN_SOURCE_FENCE.exec(normalized);
  return match?.[2] ?? content;
}
