// Terminal cell-width helpers: pure Unicode width math with no xterm runtime
// dependency. Extracted from XTermTerminal to shrink the component and make the
// width logic independently testable.

const isCombiningCodePoint = (codePoint: number) => (
  (codePoint >= 0x0300 && codePoint <= 0x036f) ||
  (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
  (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
  (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
  (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
);

const isWideCodePoint = (codePoint: number) => (
  codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
);

export const getTerminalCellWidth = (text: string) => {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0) continue;
    if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0) || isCombiningCodePoint(codePoint)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
};

export const resolveCursorIndexFromCellOffset = (text: string, cellOffset: number) => {
  const chars = Array.from(text);
  if (cellOffset <= 0) return 0;
  let consumedCells = 0;
  for (let index = 0; index < chars.length; index += 1) {
    const charWidth = Math.max(1, getTerminalCellWidth(chars[index]));
    consumedCells += charWidth;
    if (cellOffset < consumedCells) return index + 1;
  }
  return chars.length;
};
