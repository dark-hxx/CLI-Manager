import { useMemo, type KeyboardEvent, type MouseEvent } from "react";
import {
  Diff,
  Hunk,
  tokenize,
  type ChangeEventArgs,
  type FileData,
  type HunkData,
} from "react-diff-view";
import { Undo2 } from "../../icons";
import { debugConsoleWarn } from "../../../lib/debugConsole";
import { useI18n } from "../../../lib/i18n";
import type { GitDiffViewMode } from "../../../stores/settingsStore";
import { detectLanguage, refractor } from "../diffHighlight";
import { GitDiffGutter } from "./GitDiffGutter";
import type { GitDiffController } from "./types";

interface GitDiffHunkBlockProps {
  controller: GitDiffController;
  diffType: FileData["type"];
  fileName: string;
  hunk: HunkData;
  hunkIndex: number;
  syntaxHighlight: boolean;
  viewMode: GitDiffViewMode;
  onGutterClick: (args: ChangeEventArgs, event: MouseEvent<HTMLElement>) => void;
  onGutterKeyDown: (args: ChangeEventArgs, event: KeyboardEvent<HTMLElement>) => void;
}

export function GitDiffHunkBlock({
  controller,
  diffType,
  fileName,
  hunk,
  hunkIndex,
  syntaxHighlight,
  viewMode,
  onGutterClick,
  onGutterKeyDown,
}: GitDiffHunkBlockProps) {
  const { t } = useI18n();
  const tokens = useMemo(() => {
    if (!syntaxHighlight) return null;
    const language = detectLanguage(fileName);
    if (!language) return null;
    try {
      return tokenize([hunk], { highlight: true, refractor, language });
    } catch (error) {
      debugConsoleWarn("[GitDiffViewer] Failed to highlight visible hunk:", error);
      return null;
    }
  }, [fileName, hunk, syntaxHighlight]);

  return (
    <div data-git-diff-hunk-index={hunkIndex}>
      <div
        aria-current={controller.activeHunkIndex === hunkIndex ? "location" : undefined}
        onClick={() => controller.goToHunk(hunkIndex)}
        className="flex min-h-7 items-center justify-between gap-2 px-3 py-1"
        style={{
          backgroundColor: controller.activeHunkIndex === hunkIndex
            ? "var(--surface-container-high)"
            : "var(--surface-container-low)",
          borderTop: "1px solid color-mix(in srgb, var(--border) 20%, transparent)",
        }}
      >
        <span className="truncate text-[11px] text-text-muted">{hunk.content}</span>
        {controller.canRevertHunks && (
          <button
            type="button"
            onClick={() => void controller.revertHunk(hunkIndex)}
            disabled={controller.reverting}
            className="ui-focus-ring flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-opacity hover:opacity-80 disabled:opacity-40"
            style={{ color: "var(--danger)" }}
            title={t("git.diff.revertHunkTitle")}
          >
            <Undo2 size={11} aria-hidden="true" />
            {t("git.diff.revertHunk")}
          </button>
        )}
      </div>
      <Diff
        viewType={viewMode}
        diffType={diffType}
        hunks={[hunk]}
        tokens={tokens}
        selectedChanges={controller.selectedKeys}
        renderGutter={(options) => (
          <GitDiffGutter
            options={options}
            selectedKeys={controller.selectedKeySet}
            interactive={controller.canRevertLines}
            t={t}
          />
        )}
        gutterEvents={controller.canRevertLines ? {
          onClick: onGutterClick,
          onKeyDown: onGutterKeyDown,
        } : undefined}
      >
        {() => <Hunk hunk={hunk} />}
      </Diff>
    </div>
  );
}
