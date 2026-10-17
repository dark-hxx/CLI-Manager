// 工具步驟裡的改動：由 Edit／MultiEdit 的前後文字算出行級差異、把 Write 與新增檔案的整份內容當成新增，
// 以及每一行的行號。呈現方式移植自 Tap-Code（web/src/DiffView.tsx）。
// 紀錄裡只有工具的參數，不知道片段在檔案的哪一行：只有確定時才編行號（新檔案從第 1 行起），其他不編造。

/** 一段差異：lines 每行以 "+"、"-" 或空白開頭；oldStart／newStart 不知道時省略，畫面就不顯示行號。 */
export type Hunk = {
  lines: string[];
  oldStart?: number;
  newStart?: number;
  /** apply_patch 的 `@@` 後面寫的定位文字（例如函式名稱）。 */
  header?: string;
  /** Edit 的 replace_all：同一段替換套用到檔案裡所有相符處。 */
  replaceAll?: boolean;
};

export type DiffRow = { tone: "add" | "del" | "same"; number?: number; text: string };

/** 一段的每一行：新增與未變的行用新檔的行號往下數，刪除的行用舊檔的行號；起點不知道時沒有行號。 */
export function hunkRows(hunk: Hunk): DiffRow[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return hunk.lines.map((line): DiffRow => {
    const sign = line[0];
    const text = line.slice(1);
    if (sign === "-") {
      const number = oldLine;
      if (oldLine !== undefined) oldLine++;
      return { tone: "del", number, text };
    }
    const number = newLine;
    if (newLine !== undefined) newLine++;
    if (sign === "+") return { tone: "add", number, text };
    if (oldLine !== undefined) oldLine++;
    return { tone: "same", number, text };
  });
}

/** 拆成行：結尾換行不多算一個空行，行尾的 \r 去掉；空字串沒有任何行。 */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

/** 最長共同子序列表格的上限（格數）；超過時中間那段改成整段刪除再整段新增，不讓手機卡住。 */
const MAX_CELLS = 1_000_000;

/**
 * 兩段文字的行級差異（最長共同子序列，刪除排在新增前面）。開頭與結尾相同的行先略過再比對中間；
 * 回傳的每一行以 "+"、"-" 或空白開頭，未變的行照樣保留，Edit 的片段本來就不長。
 */
export function lineDiff(before: string, after: string): string[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out = a.slice(0, start).map((line) => ` ${line}`);
  const rows = endA - start;
  const columns = endB - start;
  if (rows * columns > MAX_CELLS) {
    for (let index = start; index < endA; index++) out.push(`-${a[index]}`);
    for (let index = start; index < endB; index++) out.push(`+${b[index]}`);
  } else {
    // table[i][j]：a 從 start+i、b 從 start+j 起到中段結尾的共同子序列長度。格數受上限約束，值不超過 1000。
    const width = columns + 1;
    const table = new Uint16Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = columns - 1; j >= 0; j--) {
        table[i * width + j] = a[start + i] === b[start + j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < columns) {
      if (a[start + i] === b[start + j]) {
        out.push(` ${a[start + i]}`);
        i++;
        j++;
      } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
        out.push(`-${a[start + i]}`);
        i++;
      } else {
        out.push(`+${b[start + j]}`);
        j++;
      }
    }
    for (; i < rows; i++) out.push(`-${a[start + i]}`);
    for (; j < columns; j++) out.push(`+${b[start + j]}`);
  }
  for (let index = endA; index < a.length; index++) out.push(` ${a[index]}`);
  return out;
}

/** 整份新內容（Write、apply_patch 新增的檔案）：每一行都是新增，從第 1 行起編號。 */
export function createdHunk(content: string): Hunk {
  return { oldStart: 0, newStart: 1, lines: splitLines(content).map((line) => `+${line}`) };
}

/** 幾段差異合計的新增與刪除行數。 */
export function countLines(hunks: readonly Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line[0] === "+") added++;
      else if (line[0] === "-") removed++;
    }
  }
  return { added, removed };
}
