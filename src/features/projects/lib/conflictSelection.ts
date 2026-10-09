import type { ClipboardEvent } from "react";

/** Copy only the side on which selection started, excluding gutters and action text. */
export function copyConflictSelection(event: ClipboardEvent<HTMLDivElement>): void {
  if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
  const cell = anchor?.closest<HTMLTableCellElement>("td.diff-code");
  if (!cell || !event.currentTarget.contains(cell)) return;
  const column = cell.cellIndex + 1;
  const selected = selection.getRangeAt(0);
  const lines: string[] = [];
  for (const node of event.currentTarget.querySelectorAll(`td.diff-code:nth-child(${column})`)) {
    if (node.classList.contains("diff-code-omit") || !selected.intersectsNode(node)) continue;
    const slice = document.createRange();
    slice.selectNodeContents(node);
    if (selected.compareBoundaryPoints(Range.START_TO_START, slice) > 0) slice.setStart(selected.startContainer, selected.startOffset);
    if (selected.compareBoundaryPoints(Range.END_TO_END, slice) < 0) slice.setEnd(selected.endContainer, selected.endOffset);
    lines.push(slice.toString());
  }
  if (lines.length) { event.preventDefault(); event.clipboardData.setData("text/plain", lines.join("\n")); }
}

/** Conservative fixed-font width includes tabs and wide Unicode without measuring every DOM row. */
export function conflictLineWidth(text: string): number {
  let columns = 0;
  for (const char of text) columns += char === "\t" ? 4 - columns % 4 : char.codePointAt(0)! > 255 ? 2 : 1;
  return columns * 9 + 80;
}
