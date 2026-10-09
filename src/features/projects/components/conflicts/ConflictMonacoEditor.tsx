import { memo, useCallback, useEffect, useId, useMemo, useRef, type ReactNode } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { ArrowLeft, ArrowRight, Check, TriangleAlert } from "lucide-react";
import { Button } from "../../../../shared/ui/button";
import { useI18n } from "../../../../shared/i18n/index";
import { useSettingsStore } from "../../../../shared/preferences/settingsStore";
import { FOLLOW_TERMINAL_PREVIEW_THEME, resolveTerminalPreviewTheme } from "../../../../shared/lib/terminalPreviewTheme";
import { configureMonaco, configureMonacoLocale, languageFromPath } from "../../../../shared/platform/monacoSetup";
import { conflictChoiceText, normalizeConflictEdit } from "../../lib/conflictTextEdit";
import type { ConflictBlock, ConflictChoice } from "../../lib/conflictProtocol";
import type { ConflictColumnSizes } from "../../lib/conflictColumnLayout";
import { ConflictPaneLayout } from "./ConflictPaneLayout";

configureMonaco();

const OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true, minimap: { enabled: false }, folding: false, glyphMargin: false,
  scrollBeyondLastLine: false, wordWrap: "off", fontSize: 13, lineHeight: 24,
  lineNumbersMinChars: 3, lineDecorationsWidth: 6, roundedSelection: false,
  stickyScroll: { enabled: false }, codeLens: false, links: false,
  selectionHighlight: false, occurrencesHighlight: "off", renderValidationDecorations: "off",
  quickSuggestions: false, suggestOnTriggerCharacters: false, wordBasedSuggestions: "off",
  maxTokenizationLineLength: 2000, padding: { top: 8, bottom: 8 },
  overviewRulerLanes: 0, hideCursorInOverviewRuler: true, overviewRulerBorder: false,
  renderLineHighlight: "none",
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
};

// Avoid expensive language services for conflicts spanning most of a large file.
function needsPlainText(text: string): boolean {
  if (text.length > 128 * 1024) return true;
  let lines = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n" && ++lines > 2000) return true;
  }
  return false;
}

interface PaneProps {
  role: "base" | "result" | "worktree"; title: string; badge: string; label: string;
  text: string; language: string; theme: string; readOnly: boolean; lineStart?: number;
  acceptLabel?: string; acceptDisabled?: boolean; selected?: boolean; onAccept?: () => void;
  onEdit?: (text: string) => void;
  heading?: string; branch?: string; children?: ReactNode;
}

const ConflictCodePane = memo(function ConflictCodePane({ role, title, badge, label, text, language, theme, readOnly, lineStart = 1, onEdit, acceptLabel, acceptDisabled, selected, onAccept, heading, branch, children }: PaneProps) {
  const { t } = useI18n();
  const id = useId();
  const instance = useRef<editor.IStandaloneCodeEditor | null>(null);
  const suppressChange = useRef(false);
  const disposeDecorations = useRef<(() => void) | null>(null);
  const paneRole = useRef(role);
  const latest = useRef({ text, onEdit, readOnly });
  latest.current = { text, onEdit, readOnly };
  const options = useMemo(() => ({ ...OPTIONS, readOnly, domReadOnly: readOnly, ariaLabel: label,
    lineNumbers: (line: number) => String(line + lineStart - 1),
  }), [readOnly, label, lineStart]);
  const mount: OnMount = useCallback((codeEditor, monaco) => {
    instance.current = codeEditor;
    const model = codeEditor.getModel();
    if (!model) return;
    // Inserting into an empty model keeps a leading BOM literal, not hidden
    // model metadata. The backend retains the source file's line endings.
    suppressChange.current = true;
    try {
      model.setEOL(monaco.editor.EndOfLineSequence.LF);
      model.applyEdits([{ range: model.getFullModelRange(), text: latest.current.text.replace(/\r\n/g, "\n") }]);
    } finally { suppressChange.current = false; }
    // One tracked range per model, not one decoration/DOM node per line.
    const decorations = codeEditor.createDecorationsCollection();
    const markConflict = () => decorations.set([{ range: model.getFullModelRange(), options: {
      isWholeLine: true,
      className: `conflict-line-${paneRole.current}`,
      linesDecorationsClassName: `conflict-gutter-${paneRole.current}`,
      marginClassName: `conflict-margin-${paneRole.current}`,
      stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges,
    } }]);
    markConflict();
    const listener = model.onDidChangeContent(markConflict);
    disposeDecorations.current = () => { listener.dispose(); decorations.clear(); };
  }, []);
  const change = useCallback((value: string | undefined) => {
    if (!suppressChange.current && !latest.current.readOnly) latest.current.onEdit?.(value ?? "");
  }, []);
  useEffect(() => {
    const codeEditor = instance.current;
    const model = codeEditor?.getModel();
    if (!codeEditor || !model) return;
    const value = text.replace(/\r\n/g, "\n");
    if (model.getValue() === value) return;
    // Save acknowledgements do not reset the cursor, scroll, IME or undo stack.
    // Explicit side choices remain undoable rather than replacing the model.
    suppressChange.current = true;
    try {
      codeEditor.pushUndoStop();
      codeEditor.executeEdits("conflict-choice", [{ range: model.getFullModelRange(), text: value }]);
      codeEditor.pushUndoStop();
    } finally { suppressChange.current = false; }
  }, [text]);
  useEffect(() => () => { disposeDecorations.current?.(); disposeDecorations.current = null; instance.current = null; }, []);
  return <section className={`conflict-code-pane conflict-code-pane-${role}`} data-conflict-pane={role} data-readonly={readOnly} aria-label={title}>
    <header className="conflict-code-heading">
      {role === "worktree" && <Button size="sm" variant="outline" className="conflict-accept-arrow"
        aria-label={acceptLabel} title={acceptLabel} aria-pressed={selected} disabled={acceptDisabled} onClick={onAccept}><ArrowLeft size={13} aria-hidden="true" /><span>{t("worktree.conflict.acceptShort")}</span></Button>}
      <div className="conflict-code-caption"><span title={title}>{heading ?? title}</span>
        {branch && <code title={branch}>{branch}</code>}<small>{badge}</small>
      </div>
      {role === "base" && <Button size="sm" variant="outline" className="conflict-accept-arrow"
        aria-label={acceptLabel} title={acceptLabel} aria-pressed={selected} disabled={acceptDisabled} onClick={onAccept}><span>{t("worktree.conflict.acceptShort")}</span><ArrowRight size={13} aria-hidden="true" /></Button>}
    </header>
    {children}
    <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
      <Editor path={`inmemory://conflict/${encodeURIComponent(id)}/${role}`} defaultValue="" language={language} theme={theme}
        options={options} keepCurrentModel={false} saveViewState={false} onMount={mount} onChange={change}
        loading={<span className="text-xs text-text-muted">{t("worktree.conflict.modelLoading")}</span>} />
    </div>
  </section>;
});

export default function ConflictMonacoEditor({ block, choice, baseBranch, worktreeBranch, filePath, lineStarts, newline, disabled, onChoice, columnSizes, onColumnSizesChange }: {
  block: ConflictBlock; choice?: ConflictChoice; baseBranch: string; worktreeBranch: string;
  filePath?: string; lineStarts?: [number, number]; newline: "\n" | "\r\n" | null;
  disabled: boolean; onChoice: (id: string, choice: ConflictChoice) => void;
  columnSizes: ConflictColumnSizes; onColumnSizesChange: (sizes: ConflictColumnSizes) => void;
}) {
  const { t, language } = useI18n();
  const resolvedTheme = useSettingsStore((state) => state.resolvedTheme);
  const terminalThemeName = useSettingsStore((state) => state.terminalThemeName);
  const lightThemePalette = useSettingsStore((state) => state.lightThemePalette);
  const darkThemePalette = useSettingsStore((state) => state.darkThemePalette);
  const terminalTextColor = useSettingsStore((state) => state.terminalTextColor);
  // The conflict tab follows the terminal itself, including when preview panels use a pinned preset.
  const { tone } = useMemo(() => resolveTerminalPreviewTheme({
    previewThemeName: FOLLOW_TERMINAL_PREVIEW_THEME, terminalThemeName, resolvedTheme,
    lightThemePalette, darkThemePalette, terminalTextColor,
  }), [terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette, terminalTextColor]);
  useEffect(() => { configureMonacoLocale(language); }, [language]);
  const result = conflictChoiceText(block, choice);
  const large = useMemo(() => needsPlainText(block.base) || needsPlainText(block.worktree), [block.base, block.worktree]);
  const editorLanguage = large ? "plaintext" : languageFromPath(filePath ?? "");
  const largeResult = large || needsPlainText(result);
  const resultLanguage = largeResult ? "plaintext" : editorLanguage;
  const editorTheme = tone === "dark" ? "vs-dark" : "vs";
  const resultTitle = t("worktree.conflict.mergeResult");
  return <>
    <div className="conflict-merge-grid-scroll">
      <ConflictPaneLayout sizes={columnSizes} onSizesChange={onColumnSizesChange} chosen={!!choice}
        labels={[t("worktree.conflict.resizeBaseResult"), t("worktree.conflict.resizeResultWorktree")]}
        resizeHint={t("worktree.conflict.resizeHint")}>
        <ConflictCodePane role="base" title={t("worktree.conflict.base", { branch: baseBranch })}
          heading={t("worktree.conflict.targetLabel")} branch={baseBranch}
          badge={t("worktree.conflict.readOnly")} label={t("worktree.conflict.base", { branch: baseBranch })}
          text={block.base} language={editorLanguage} theme={editorTheme} readOnly lineStart={lineStarts?.[0]}
          acceptLabel={t("worktree.conflict.acceptSide", { branch: baseBranch })} acceptDisabled={disabled}
          selected={choice?.kind === "base_branch"} onAccept={() => onChoice(block.id, { kind: "base_branch" })} />
        <ConflictCodePane role="result" title={resultTitle} label={resultTitle} branch={filePath?.split(/[\\/]/).pop()}
          badge={t(disabled || newline === null ? "worktree.conflict.readOnly" : "worktree.conflict.editable")}
          text={result} language={resultLanguage} theme={editorTheme} readOnly={disabled || newline === null}
          onEdit={(text) => { if (newline !== null) onChoice(block.id, { kind: "edited", text: normalizeConflictEdit(text, newline) }); }}>
          <div className="conflict-result-actions" data-chosen={!!choice}>
            <span className="conflict-result-status" role="status">
              {choice ? <Check size={13} aria-hidden="true" /> : <TriangleAlert size={13} aria-hidden="true" />}
              {t(choice ? "worktree.conflict.blockChosen" : "worktree.conflict.notChosen")}
            </span>
            <div className="conflict-result-choices">
              <Button size="sm" className="conflict-choose-base" disabled={disabled} aria-pressed={choice?.kind === "base_branch"}
                title={t("worktree.conflict.acceptSide", { branch: baseBranch })} onClick={() => onChoice(block.id, { kind: "base_branch" })}>{t("worktree.conflict.acceptLeft")}</Button>
              <Button size="sm" className="conflict-choose-worktree" disabled={disabled} aria-pressed={choice?.kind === "worktree"}
                title={t("worktree.conflict.acceptSide", { branch: worktreeBranch })} onClick={() => onChoice(block.id, { kind: "worktree" })}>{t("worktree.conflict.acceptRight")}</Button>
            </div>
          </div>
        </ConflictCodePane>
        <ConflictCodePane role="worktree" title={t("worktree.conflict.worktree", { branch: worktreeBranch })}
          heading={t("worktree.conflict.worktreeLabel")} branch={worktreeBranch}
          badge={t("worktree.conflict.readOnly")} label={t("worktree.conflict.worktree", { branch: worktreeBranch })}
          text={block.worktree} language={editorLanguage} theme={editorTheme} readOnly lineStart={lineStarts?.[1]}
          acceptLabel={t("worktree.conflict.acceptSide", { branch: worktreeBranch })} acceptDisabled={disabled}
          selected={choice?.kind === "worktree"} onAccept={() => onChoice(block.id, { kind: "worktree" })} />
      </ConflictPaneLayout>
    </div>
    {(!choice || newline === null || largeResult) && <div className="conflict-merge-note" role="status">
      {newline === null ? t("worktree.conflict.manualUnavailable") : !choice ? t("worktree.conflict.resultPreview") : t("worktree.conflict.largePlainText")}
    </div>}
  </>;
}
