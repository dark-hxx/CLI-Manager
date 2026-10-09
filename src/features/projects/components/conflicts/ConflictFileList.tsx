import { useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { Check, FileCode2 } from "lucide-react";
import { useI18n } from "../../../../shared/i18n/index";
import { Button } from "../../../../shared/ui/button";
import type { ConflictView } from "../../lib/conflictController";
import { conflictFileState } from "../../lib/conflictProgress";

export function ConflictFileList({ view, onPage, onSelect }: { view: ConflictView; onPage: (cursor: number) => void; onSelect: (fileId: string) => void }) {
  const { t } = useI18n();
  const scroll = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const files = view.page?.files ?? [];
  const pageCount = Math.max(1, Math.ceil((view.snapshot?.total ?? 0) / 200));
  const currentPage = Math.floor(view.cursor / 200) + 1;
  const virtualizer = useVirtualizer({
    count: files.length, getScrollElement: () => scroll.current, estimateSize: () => 28, overscan: 4,
    getItemKey: (index) => files[index].fileId,
    rangeExtractor: (range) => [...new Set([...defaultRangeExtractor(range), ...(focused !== null && focused < files.length ? [focused] : [])])].sort((a, b) => a - b),
  });
  // Pin only the keyboard focus row, not every selected/visited row.
  const focusRow = (index: number) => {
    const next = Math.max(0, Math.min(files.length - 1, index));
    setFocused(next); virtualizer.scrollToIndex(next);
    requestAnimationFrame(() => scroll.current?.querySelector<HTMLButtonElement>(`[data-file-index="${next}"]`)?.focus());
  };
  return <aside className="conflict-file-list flex min-h-0 min-w-0 flex-col border-r border-border p-2">
    <h3 className="conflict-file-list-title">{t("worktree.conflict.files")}<span>{view.snapshot?.total ?? 0}</span></h3>
    <div ref={scroll} role="list" aria-label={t("worktree.conflict.files")} className="min-h-0 flex-1 overflow-auto" style={{ height: 520, maxHeight: 520 }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null); }}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((row) => {
          const file = files[row.index];
          const state = conflictFileState(file, view.detail);
          const label = t(`worktree.conflict.${state}`);
          return <div key={file.fileId} role="listitem" style={{ position: "absolute", top: row.start, height: 28, width: "100%" }}>
          <button type="button" data-file-index={row.index} data-resolved={file.resolved} aria-current={view.selectedId === file.fileId ? "true" : undefined}
            data-state={state} title={`${file.displayPath} — ${label}`} onFocus={() => setFocused(row.index)} aria-disabled={file.resolved}
            className="conflict-file-row w-full text-left text-xs leading-7 focus-visible:outline focus-visible:outline-2"
            onClick={() => { if (!file.resolved) onSelect(file.fileId); }} onKeyDown={(event) => {
              const next = event.key === "ArrowDown" ? row.index + 1 : event.key === "ArrowUp" ? row.index - 1 : event.key === "Home" ? 0 : event.key === "End" ? files.length - 1 : null;
              if (next !== null) { event.preventDefault(); focusRow(next); }
            }}>
            <span className="conflict-file-dot" aria-hidden="true" /><FileCode2 size={14} className="conflict-file-icon" aria-hidden="true" />
            <span className="conflict-file-path">{file.displayPath}</span>
            {file.resolved ? <Check size={13} className="text-success shrink-0" aria-hidden="true" /> : <span className="conflict-file-state" aria-hidden="true">{label}</span>}
            <span className="sr-only"> — {label}</span>
          </button>
        </div>; })}
      </div>
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
      <Button size="sm" variant="outline" disabled={view.busy || currentPage === 1} onClick={() => onPage(Math.max(0, view.cursor - 200))}>{t("worktree.conflict.previous")}</Button>
      <label>{t("worktree.conflict.page")} <input key={currentPage} type="number" min={1} max={pageCount} defaultValue={currentPage} disabled={view.busy} className="w-16 rounded border border-border bg-bg-primary p-1"
        onKeyDown={(event) => { if (event.key === "Enter") { const value = Number(event.currentTarget.value); if (Number.isInteger(value) && value >= 1 && value <= pageCount) onPage((value - 1) * 200); } }} /> / {pageCount}</label>
      <Button size="sm" variant="outline" disabled={view.busy || !view.page || view.page.nextCursor === null} onClick={() => { if (view.page?.nextCursor != null) onPage(view.page.nextCursor); }}>{t("worktree.conflict.next")}</Button>
      <Button size="sm" variant="ghost" disabled={view.busy || currentPage === pageCount} onClick={() => onPage((pageCount - 1) * 200)}>{t("worktree.conflict.last")}</Button>
    </div>
  </aside>;
}
