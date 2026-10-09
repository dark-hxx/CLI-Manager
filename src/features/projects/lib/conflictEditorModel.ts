import type { ConflictDetail } from './conflictProtocol';
import { buildConflictRows, type ConflictRow } from './conflictRows';
import { conflictLineWidth } from './conflictSelection';
import { conflictEditNewline } from './conflictTextEdit';

export interface ConflictEditorModel {
  rows: ConflictRow[];
  widths: [number, number];
  newline: '\n' | '\r\n' | null;
}

/** Pure source model: choices and draft revisions never affect its contents. */
export function buildConflictEditorModel(detail: ConflictDetail): ConflictEditorModel {
  const rows = buildConflictRows(detail);
  const widths: [number, number] = [0, 0];
  for (const row of rows) {
    if (row.kind === 'control') continue;
    widths[0] = Math.max(widths[0], conflictLineWidth(row.left));
    widths[1] = Math.max(widths[1], conflictLineWidth(row.right));
  }
  return { rows, widths, newline: conflictEditNewline(detail.source ?? '') };
}
