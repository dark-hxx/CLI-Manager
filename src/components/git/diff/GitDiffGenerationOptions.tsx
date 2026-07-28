import { Rows3, Space } from "lucide-react";
import {
  GIT_DIFF_CONTEXT_LINE_OPTIONS,
  GIT_DIFF_WHITESPACE_MODES,
  type GitDiffContextLines,
  type GitDiffOptions,
  type GitDiffWhitespaceMode,
} from "../../../lib/gitDiffOptions";
import { useI18n } from "../../../lib/i18n";

interface GitDiffGenerationOptionsProps {
  options: GitDiffOptions;
  onChange: (options: GitDiffOptions) => void;
}

const SELECT_CLASS = "git-diff-toolbar-select ui-focus-ring h-6 min-w-0 rounded border px-1 text-[11px]";

export function GitDiffGenerationOptions({
  options,
  onChange,
}: GitDiffGenerationOptionsProps) {
  const { t } = useI18n();

  return (
    <div className="flex shrink-0 items-center gap-2">
      <label className="flex min-w-0 items-center gap-1">
        <Space size={13} className="shrink-0 text-text-muted" aria-hidden="true" />
        <span className="sr-only">{t("git.diff.whitespace")}</span>
        <select
          className={`${SELECT_CLASS} max-w-32`}
          value={options.whitespace}
          title={t("git.diff.whitespace")}
          aria-label={t("git.diff.whitespace")}
          onChange={(event) => onChange({
            ...options,
            whitespace: event.target.value as GitDiffWhitespaceMode,
          })}
        >
          {GIT_DIFF_WHITESPACE_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {t(`git.diff.whitespace.${mode}`)}
            </option>
          ))}
        </select>
      </label>

      <label className="flex min-w-0 items-center gap-1">
        <Rows3 size={13} className="shrink-0 text-text-muted" aria-hidden="true" />
        <span className="sr-only">{t("git.diff.contextLines")}</span>
        <select
          className={`${SELECT_CLASS} w-16`}
          value={options.contextLines}
          title={t("git.diff.contextLines")}
          aria-label={t("git.diff.contextLines")}
          onChange={(event) => onChange({
            ...options,
            contextLines: Number(event.target.value) as GitDiffContextLines,
          })}
        >
          {GIT_DIFF_CONTEXT_LINE_OPTIONS.map((lineCount) => (
            <option key={lineCount} value={lineCount}>
              {t("git.diff.contextLinesValue", { count: lineCount })}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
