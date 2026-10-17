// 命令輸出的顏色：256 色表與對話視圖用的 SGR 解析（Bash／exec 等工具的輸出照終端上色）。
// 與畫面分開，方便測試。移植自 Tap-Code（web/src/ansi.ts）。

// 原生終端的深色視窗，淺色或深色介面都一樣；CLI 自己指定的真彩色照原樣顯示。
export const TERMINAL_THEME = {
  background: "#1c1b22", foreground: "#e4e4e7",
  black: "#3f3f46", red: "#f87171", green: "#4ade80", yellow: "#fbbf24", blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#d4d4d8",
  brightBlack: "#71717a", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde047", brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#fafafa",
};

const T = TERMINAL_THEME;
// 256 色表的前 16 色與上面的主題一致。
const ANSI = [
  T.black, T.red, T.green, T.yellow, T.blue, T.magenta, T.cyan, T.white,
  T.brightBlack, T.brightRed, T.brightGreen, T.brightYellow, T.brightBlue, T.brightMagenta, T.brightCyan, T.brightWhite,
];

/** 256 色表裡的一色：前 16 色照主題，其後是 6×6×6 色塊與 24 階灰。 */
export function ansiColor(index: number): string {
  if (index < 16) return ANSI[index]!;
  if (index < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const value = index - 16;
    return `rgb(${steps[Math.floor(value / 36)]},${steps[Math.floor(value / 6) % 6]},${steps[value % 6]})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray},${gray},${gray})`;
}

/** 一段樣式相同的文字。顏色都是由數字算出來的 `#rrggbb` 或 `rgb()`，不會帶進任何原文。 */
export type AnsiRun = {
  text: string; fg?: string; bg?: string;
  bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; inverse?: boolean;
};

type Style = Omit<AnsiRun, "text">;
type Value = number | undefined;

const byte = (value: Value): value is number => value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255;
const number = (text: string): Value => text === "" ? 0 : /^\d{1,5}$/.test(text) ? Number(text) : undefined;

/** 38/48 後面的延伸色（5;n 或 2;r;g;b）；傳回顏色與用掉的參數個數。 */
function extended(values: Value[]): [string | undefined, number] {
  const [mode, ...rest] = values;
  if (mode === 5) return [byte(rest[0]) ? ansiColor(rest[0]) : undefined, 2];
  if (mode === 2) {
    const [red, green, blue] = rest;
    return [byte(red) && byte(green) && byte(blue) ? `rgb(${red},${green},${blue})` : undefined, 4];
  }
  return [undefined, values.length];
}

function apply(style: Style, params: string): Style {
  const next = { ...style };
  const groups = params.split(";");
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    if (group.includes(":")) {
      // 冒號子參數：38:5:n、38:2:[色彩空間:]r:g:b、4:n（各種底線）。
      const [head, ...parts] = group.split(":").map(number);
      if (head === 38 || head === 48) {
        if (parts[0] === 2 && parts.length >= 5) parts.splice(1, 1);
        const [color] = extended(parts);
        if (color) next[head === 38 ? "fg" : "bg"] = color;
      } else if (head === 4) {
        if (parts[0] === 0) delete next.underline;
        else next.underline = true;
      }
      continue;
    }
    const code = number(group);
    if (code === undefined) continue;
    if (code === 0) {
      for (const key of Object.keys(next) as (keyof Style)[]) delete next[key];
    } else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if (code === 29) delete next.strike;
    else if (code >= 30 && code <= 37) next.fg = ANSI[code - 30];
    else if (code >= 90 && code <= 97) next.fg = ANSI[code - 90 + 8];
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47) next.bg = ANSI[code - 40];
    else if (code >= 100 && code <= 107) next.bg = ANSI[code - 100 + 8];
    else if (code === 49) delete next.bg;
    else if (code === 38 || code === 48) {
      const [color, used] = extended(groups.slice(index + 1, index + 5).map(number));
      index += used;
      if (color) next[code === 38 ? "fg" : "bg"] = color;
    }
  }
  return next;
}

const same = (a: Style, b: Style) => a.fg === b.fg && a.bg === b.bg && !a.bold === !b.bold && !a.dim === !b.dim
  && !a.italic === !b.italic && !a.underline === !b.underline && !a.strike === !b.strike && !a.inverse === !b.inverse;

// CSI（ESC [ 參數 中介 結尾）、OSC（到 BEL 或 ESC \）、其他 ESC 序列、控制字元（換行與 Tab 除外）。
const SEQUENCE = /\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[\x20-\x2f]*[\x30-\x7e]?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * 把帶 SGR 的終端文字拆成樣式相同的幾段。紀錄裡的工具輸出可能夾著任何控制序列，這裡只套用 SGR，
 * 其他控制序列（游標移動、OSC…）與控制字元一律去掉，不認得的參數略過；結果只有純文字與算出來的顏色。
 */
export function parseSgr(input: string): AnsiRun[] {
  const runs: AnsiRun[] = [];
  let style: Style = {};
  let text = "";
  const flush = () => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && same(last, style)) last.text += text;
    else runs.push({ ...style, text });
    text = "";
  };
  let last = 0;
  for (const match of input.matchAll(SEQUENCE)) {
    text += input.slice(last, match.index);
    last = match.index + match[0].length;
    if (match[3] === "m" && !match[2] && /^[\d;:]*$/.test(match[1]!)) {
      const next = apply(style, match[1]!);
      if (!same(next, style)) {
        flush();
        style = next;
      }
    }
  }
  text += input.slice(last);
  flush();
  return runs;
}

/** 這段的前景、背景色（反白時互換；預設色用主題的前景與背景）。 */
export function runColors(run: AnsiRun): { fg?: string; bg?: string } {
  if (!run.inverse) return { fg: run.fg, bg: run.bg };
  return { fg: run.bg ?? T.background, bg: run.fg ?? T.foreground };
}

const ZERO = /^[\p{Mn}\p{Me}\u200b-\u200f\u2060\ufe00-\ufe0f\ufeff]$/u;
const EMOJI = /^\p{Emoji_Presentation}$/u;
// 東亞全形與寬字元：諺文字母、中日韓部首與標點、假名、注音、中日韓文字、彝文、諺文音節、
// 相容漢字、直排與全形標點、全形字母，以及擴充區的漢字。
const WIDE = /^[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{1f200}-\u{1f2ff}\u{20000}-\u{3fffd}]$/u;

/** 一個字在終端裡佔幾欄：組合字元 0 欄，中日韓全形與 emoji 2 欄，其他 1 欄。 */
export function cellWidth(char: string): 0 | 1 | 2 {
  if (ZERO.test(char)) return 0;
  if (WIDE.test(char) || EMOJI.test(char)) return 2;
  return 1;
}

/** 一段畫面：ASCII 照等寬字型排；其他字各佔固定的 1 或 2 欄，字型裡沒有的符號也對得齊。 */
export type Cell = string | { char: string; wide: boolean };

/** 把一段文字切成 ASCII 片段與單字的格子；組合字元跟著前一個字。 */
export function cells(text: string): Cell[] {
  const out: Cell[] = [];
  let plain = "";
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) {
      plain += char;
      continue;
    }
    const width = cellWidth(char);
    const previous = out[out.length - 1];
    if (width === 0) {
      if (!plain && previous && typeof previous !== "string") previous.char += char;
      else plain += char;
      continue;
    }
    if (plain) out.push(plain);
    plain = "";
    out.push({ char, wide: width === 2 });
  }
  if (plain) out.push(plain);
  return out;
}

/**
 * 輸出靠空白或框線排版（欄位對齊、格子、表格）時不能自動換行，改成左右捲動；
 * 一般的文字照常換行。
 */
export function laidOut(text: string): boolean {
  return text.split("\n").some((line) => /\S {2,}\S/.test(line) || /[\u2500-\u259f\u26c0-\u26ff]/.test(line));
}
