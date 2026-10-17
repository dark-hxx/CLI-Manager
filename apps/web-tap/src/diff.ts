// 工具結果裡的改動（unified diff 的區塊）排成一行一行：每一行標出行號，刪除的行用舊檔的行號。
import type { Hunk } from "./transcript";

export type DiffRow = { tone: "add" | "del" | "same"; number: number; text: string };

/** 一個區塊的每一行：新增與未變的行用新檔的行號往下數，刪除的行用舊檔的行號。 */
export function hunkRows(hunk: Hunk): DiffRow[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return hunk.lines.map((line) => {
    const sign = line[0];
    if (sign === "-") return { tone: "del", number: oldLine++, text: line.slice(1) };
    if (sign === "+") return { tone: "add", number: newLine++, text: line.slice(1) };
    oldLine++;
    return { tone: "same", number: newLine++, text: line.slice(1) };
  });
}
