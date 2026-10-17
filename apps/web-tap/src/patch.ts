// Codex 的 apply_patch 修補文字依檔案分組成差異段落。移植自 Tap-Code 的修補解析（transcript-core 的 codex/patch.rs）。
// 修補本身沒有行號：只有新增的檔案從第 1 行起編號，其他段落不顯示行號。
import type { Hunk } from "./diff.ts";

export type PatchFile = {
  path: string;
  /** `*** Move to:` 搬到的新路徑。 */
  moved?: string;
  op: "add" | "update" | "delete";
  hunks: Hunk[];
};

const FILE_LINE = /^\*\*\* (Add|Update|Delete) File: (.*)$/;

/**
 * 解析 apply_patch 的修補文字（`*** Add File:`、`*** Update File:`、`*** Delete File:`、`*** Move to:` 與 `@@` 段落）。
 * 文字被截斷時照樣解析讀得到的部分；由呼叫端依截斷標記告訴使用者後面還有內容。
 */
export function parsePatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  const begin = text.indexOf("*** Begin Patch");
  for (const raw of (begin >= 0 ? text.slice(begin) : text).split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const header = FILE_LINE.exec(line);
    if (header) {
      const op = header[1] === "Add" ? "add" : header[1] === "Delete" ? "delete" : "update";
      files.push({ path: header[2]!.trim(), op, hunks: [] });
      continue;
    }
    const file = files.at(-1);
    if (line.startsWith("*** Move to: ")) {
      const moved = line.slice("*** Move to: ".length).trim();
      if (file && moved) file.moved = moved;
      continue;
    }
    if (line.startsWith("*** End Patch")) break;
    // 其他標記（Begin Patch、End of File）不是內容。
    if (line.startsWith("*** ") || !file || file.op === "delete") continue;
    if (file.op === "add") {
      if (!line.startsWith("+")) continue;
      if (!file.hunks.length) file.hunks.push({ oldStart: 0, newStart: 1, lines: [] });
      file.hunks[0]!.lines.push(line);
      continue;
    }
    if (line.startsWith("@@")) {
      const anchor = line.slice(2).trim();
      file.hunks.push({ lines: [], ...(anchor ? { header: anchor } : {}) });
      continue;
    }
    // 修補裡完全空白的行是空的未變行。
    const entry = line === "" ? " " : line;
    if (!" -+".includes(entry[0]!)) continue;
    if (!file.hunks.length) file.hunks.push({ lines: [] });
    file.hunks.at(-1)!.lines.push(entry);
  }
  // 結尾換行造成的空白未變行不算內容。
  for (const file of files) {
    for (const hunk of file.hunks) while (hunk.lines.at(-1) === " ") hunk.lines.pop();
  }
  return files;
}

/** 透過殼層呼叫的 apply_patch（`["apply_patch", 修補]` 或 `apply_patch <<'EOF'`）的修補文字；不是時為 undefined。 */
export function shellPatch(argv: unknown, command: string): string | undefined {
  if (Array.isArray(argv) && (argv[0] === "apply_patch" || argv[0] === "applypatch") && typeof argv[1] === "string") return argv[1];
  const script = command.trimStart();
  if (!script.startsWith("apply_patch") && !script.startsWith("applypatch")) return undefined;
  const start = script.indexOf("*** Begin Patch");
  return start >= 0 ? script.slice(start) : undefined;
}
