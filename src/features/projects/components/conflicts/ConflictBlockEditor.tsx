import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useI18n } from "../../../../shared/i18n/index";
import { Button } from "../../../../shared/ui/button";
import { useConflictEditorModel } from "../../hooks/useConflictEditorModel";
import type { ConflictChoice, ConflictDetail } from "../../lib/conflictProtocol";
import type { ConflictColumnSizes } from "../../lib/conflictColumnLayout";

class EditorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function ConflictBlockEditor({ detail, baseBranch, worktreeBranch, filePath, disabled, onChoice, toolbarContainer, columnSizes, onColumnSizesChange }: {
  detail: ConflictDetail; baseBranch: string; worktreeBranch: string; filePath?: string;
  disabled: boolean; onChoice: (id: string, choice: ConflictChoice) => void;
  toolbarContainer?: HTMLElement | null;
  columnSizes: ConflictColumnSizes; onColumnSizesChange: (sizes: ConflictColumnSizes) => void;
}) {
  const { t } = useI18n();
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const MonacoEditor = useMemo(() => lazy(() => import("./ConflictMonacoEditor")), [attempt]);
  const { model, failed, retry } = useConflictEditorModel(detail);
  const activeIndex = Math.max(0, detail.blocks.findIndex((block) => block.id === activeBlockId));
  const block = detail.blocks[activeIndex];
  const choice = block && detail.draft.choices[block.id];
  const lineStarts = useMemo(() => {
    const starts = new Map<string, [number, number]>();
    let left = 1;
    let right = 1;
    for (const row of model?.rows ?? []) {
      if (row.kind === "control") starts.set(row.block.id, [left, right]);
      else {
        if (row.leftNumber !== null) left = row.leftNumber + 1;
        if (row.rightNumber !== null) right = row.rightNumber + 1;
      }
    }
    return starts;
  }, [model]);
  const nextUnresolved = () => {
    for (let offset = 1; offset <= detail.blocks.length; offset++) {
      const candidate = detail.blocks[(activeIndex + offset) % detail.blocks.length];
      if (!detail.draft.choices[candidate.id]) { setActiveBlockId(candidate.id); break; }
    }
  };
  const loading = <div className="p-3 text-sm" role="status">{t("worktree.conflict.modelLoading")}</div>;
  // Dock only the controls in the workspace toolbar; the editor and draft owner stay mounted here.
  const toolbar = model && block && <div className="conflict-merge-toolbar">
    <div className="conflict-block-navigation" role="group" aria-label={t("worktree.conflict.blockPosition", { current: activeIndex + 1, total: detail.blocks.length })}>
      <Button variant="ghost" size="sm" disabled={disabled || activeIndex === 0}
        onClick={() => setActiveBlockId(detail.blocks[activeIndex - 1].id)}><ChevronUp size={14} aria-hidden="true" />{t("worktree.conflict.previousBlock")}</Button>
      <Button variant="ghost" size="sm" disabled={disabled || activeIndex === detail.blocks.length - 1}
        onClick={() => setActiveBlockId(detail.blocks[activeIndex + 1].id)}>{t("worktree.conflict.nextBlock")}<ChevronDown size={14} aria-hidden="true" /></Button>
    </div>
    <span className="conflict-block-position">{t("worktree.conflict.blockPosition", { current: activeIndex + 1, total: detail.blocks.length })}</span>
    <Button variant="ghost" size="sm" disabled={disabled || detail.blocks.every((item) => detail.draft.choices[item.id])}
      onClick={nextUnresolved}>{t("worktree.conflict.nextUnresolved")}</Button>
    <Button variant="outline" size="sm" disabled={disabled} aria-pressed={choice?.kind === "both"}
      onClick={() => onChoice(block.id, { kind: "both" })}>{t("worktree.conflict.choose.both")}</Button>
  </div>;
  return <div className="conflict-block-editor flex min-h-0 flex-1 flex-col" data-conflict-editor>
    {toolbarContainer ? createPortal(toolbar, toolbarContainer) : toolbarContainer === undefined ? toolbar : null}
    {!model ? <div className="p-3 text-sm" role={failed ? "alert" : "status"}>
      {t(failed ? "worktree.conflict.modelFailed" : "worktree.conflict.modelLoading")}
      {failed && <Button variant="outline" size="sm" className="ml-2" onClick={retry}>{t("worktree.conflict.modelRetry")}</Button>}
    </div> : block && <>
      <EditorBoundary key={attempt} fallback={<div role="alert" className="p-3 text-sm">
        {t("worktree.conflict.modelFailed")}
        <Button variant="outline" size="sm" className="ml-2" onClick={() => setAttempt((value) => value + 1)}>{t("worktree.conflict.modelRetry")}</Button>
      </div>}>
        <Suspense fallback={loading}>
          <MonacoEditor key={`${detail.fileId}:${detail.draft.sourceHash}:${block.id}`} block={block} choice={choice}
            baseBranch={baseBranch} worktreeBranch={worktreeBranch} filePath={filePath} lineStarts={lineStarts.get(block.id)}
            columnSizes={columnSizes} onColumnSizesChange={onColumnSizesChange}
            newline={model.newline} disabled={disabled} onChoice={onChoice} />
        </Suspense>
      </EditorBoundary>
    </>}
  </div>;
}
