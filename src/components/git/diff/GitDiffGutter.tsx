import { Check } from "lucide-react";
import { getChangeKey, type GutterOptions } from "react-diff-view";
import type { TranslationKey } from "../../../lib/i18n";
import { gitDiffChangeSide } from "./gitDiffSelection";

type Translate = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

interface GitDiffGutterProps {
  options: GutterOptions;
  selectedKeys: ReadonlySet<string>;
  interactive: boolean;
  t: Translate;
}

export function GitDiffGutter({
  options,
  selectedKeys,
  interactive,
  t,
}: GitDiffGutterProps) {
  const { change, side, renderDefault } = options;
  if (change.type === "normal") return renderDefault();
  const changeSide = gitDiffChangeSide(change);
  if (!interactive || !changeSide || changeSide !== side) return renderDefault();

  const key = getChangeKey(change);
  const selected = selectedKeys.has(key);
  const marker = change.type === "insert" ? "+" : "-";
  const label = t(
    change.type === "insert" ? "git.diff.gutter.insert" : "git.diff.gutter.delete",
    { line: change.lineNumber },
  );

  return (
    <button
      type="button"
      className="git-diff-gutter-button ui-focus-ring"
      data-git-diff-change-key={key}
      aria-label={label}
      aria-pressed={selected}
      title={label}
    >
      <span className="git-diff-gutter-marker" aria-hidden="true">{marker}</span>
      <span className="git-diff-gutter-line" aria-hidden="true">{renderDefault()}</span>
      <span className="git-diff-gutter-check-slot" aria-hidden="true">
        {selected && <Check className="git-diff-gutter-check" size={10} />}
      </span>
    </button>
  );
}
