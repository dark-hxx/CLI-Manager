import type { ConflictBlock, ConflictChoice } from "./conflictProtocol";

/** Match Rust's exact side concatenation; an unchosen preview is not a resolution. */
export function conflictChoiceText(block: ConflictBlock, choice?: ConflictChoice): string {
  switch (choice?.kind) {
    case "base_branch": return block.base;
    case "worktree": return block.worktree;
    case "edited": return choice.text;
    default: return block.base + block.worktree;
  }
}

/** Editors display LF even for CRLF values. Preserve the source's uniform style.
 * Mixed-newline files are whole-file-only at the Rust boundary. */
export function conflictEditNewline(source: string): "\n" | "\r\n" | null {
  let lf = false; let crlf = false;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") {
      if (index > 0 && source[index - 1] === "\r") crlf = true; else lf = true;
    }
  }
  return lf && crlf ? null : crlf ? "\r\n" : "\n";
}
export function normalizeConflictEdit(text: string, newline: "\n" | "\r\n"): string {
  return text.replace(/\r?\n/g, newline);
}
