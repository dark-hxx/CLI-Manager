import { MarkdownContent, type MarkdownContentProps } from "../../../shared/ui/MarkdownContent";
import { unwrapFencedMarkdown } from "../../../shared/lib/markdownSource";

type HistoryMarkdownVariant = "history" | "terminal";

interface HistoryMarkdownContentProps extends Omit<MarkdownContentProps, "variant"> {
  variant?: HistoryMarkdownVariant;
}

export function HistoryMarkdownContent({
  variant = "history",
  ...props
}: HistoryMarkdownContentProps) {
  const content = variant === "history"
    ? unwrapFencedMarkdown(props.content)
    : props.content;

  return (
    <MarkdownContent
      {...props}
      content={content}
      variant={variant === "terminal" ? "terminal" : "default"}
    />
  );
}
