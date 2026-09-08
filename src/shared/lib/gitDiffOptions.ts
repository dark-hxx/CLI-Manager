export const GIT_DIFF_WHITESPACE_MODES = ["exact", "ignore-eol", "ignore-all"] as const;
export type GitDiffWhitespaceMode = (typeof GIT_DIFF_WHITESPACE_MODES)[number];

export const GIT_DIFF_CONTEXT_LINE_OPTIONS = [3, 10, 20] as const;
export type GitDiffContextLines = (typeof GIT_DIFF_CONTEXT_LINE_OPTIONS)[number];

export interface GitDiffOptions {
  whitespace: GitDiffWhitespaceMode;
  contextLines: GitDiffContextLines;
}

export const DEFAULT_GIT_DIFF_OPTIONS: Readonly<GitDiffOptions> = Object.freeze({
  whitespace: "exact",
  contextLines: 3,
});

export function isDefaultGitDiffOptions(options: GitDiffOptions | undefined): boolean {
  return options === undefined
    || (options.whitespace === DEFAULT_GIT_DIFF_OPTIONS.whitespace
      && options.contextLines === DEFAULT_GIT_DIFF_OPTIONS.contextLines);
}
