// 移植自舊分支（Tap-Code 的 ansi.test.ts）；SGR 解析、256 色與字寬。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ansiColor, cells, cellWidth, laidOut, parseSgr, runColors, TERMINAL_THEME } from "./ansi.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const sgr = (params) => `${ESC}[${params}m`;
const ACUTE = String.fromCharCode(0x301);

test("parseSgr 把 /context 的格子拆成上色的幾段", () => {
  // Claude Code 的 /context：256 色的格子，39 回到預設前景。
  const line = `${sgr("38;5;244")}⛀ ${sgr("38;5;140")}⛁ ⛁ ${sgr("39")}  ${sgr("38;5;246")}${sgr("3")}Estimated${sgr("23")}${sgr("39")}`;
  assert.deepEqual(parseSgr(line), [
    { text: "⛀ ", fg: "rgb(128,128,128)" },
    { text: "⛁ ⛁ ", fg: "rgb(175,135,215)" },
    { text: "  " },
    { text: "Estimated", fg: "rgb(148,148,148)", italic: true },
  ]);
});

test("parseSgr 套用與清除屬性、16 色、256 色與真彩色", () => {
  const runs = parseSgr(`${sgr("1;31")}a${sgr("2")}b${sgr("22")}c${sgr("4;9;7")}d${sgr("24;29;27;92;44")}e${sgr("103;38;2;215;119;87")}f${sgr("")}g`);
  assert.deepEqual(runs, [
    { text: "a", bold: true, fg: TERMINAL_THEME.red },
    { text: "b", bold: true, dim: true, fg: TERMINAL_THEME.red },
    { text: "c", fg: TERMINAL_THEME.red },
    { text: "d", fg: TERMINAL_THEME.red, underline: true, strike: true, inverse: true },
    { text: "e", fg: TERMINAL_THEME.brightGreen, bg: TERMINAL_THEME.blue },
    { text: "f", fg: "rgb(215,119,87)", bg: TERMINAL_THEME.brightYellow },
    { text: "g" },
  ]);
});

test("parseSgr 接受冒號子參數，超出範圍的顏色略過", () => {
  assert.deepEqual(parseSgr(`${sgr("38:2::1:2:3")}a${sgr("48:5:17;4:3")}b${sgr("4:0;38;5;300;38;2;1;2;999")}c`), [
    { text: "a", fg: "rgb(1,2,3)" },
    { text: "b", fg: "rgb(1,2,3)", bg: ansiColor(17), underline: true },
    { text: "c", fg: "rgb(1,2,3)", bg: ansiColor(17) },
  ]);
});

test("parseSgr 去掉其他控制序列，標記照純文字保留", () => {
  const input = `${ESC}[2K${ESC}[1A<b>${ESC}]8;;https://x.test${BEL}link${ESC}]8;;${BEL}${ESC}[?25l${ESC}(B</b>\r`;
  assert.deepEqual(parseSgr(input), [{ text: "<b>link</b>" }]);
  // 參數裡混了別的字元就不是 SGR，不會被當成顏色。
  assert.deepEqual(parseSgr(`${ESC}[38;5;1;expression(1)m x`), [{ text: "xpression(1)m x" }]);
});

test("反白時前景與背景互換", () => {
  assert.deepEqual(runColors({ text: "x", inverse: true }), { fg: TERMINAL_THEME.background, bg: TERMINAL_THEME.foreground });
  assert.deepEqual(runColors({ text: "x", fg: "#111", bg: "#222", inverse: true }), { fg: "#222", bg: "#111" });
});

test("ansiColor 照 xterm 的 256 色表", () => {
  assert.equal(ansiColor(1), TERMINAL_THEME.red);
  assert.equal(ansiColor(16), "rgb(0,0,0)");
  assert.equal(ansiColor(140), "rgb(175,135,215)");
  assert.equal(ansiColor(231), "rgb(255,255,255)");
  assert.equal(ansiColor(232), "rgb(8,8,8)");
  assert.equal(ansiColor(255), "rgb(238,238,238)");
});

test("非 ASCII 的字各佔固定的 1 或 2 欄", () => {
  assert.equal(cellWidth("a"), 1);
  assert.equal(cellWidth("⛁"), 1);
  assert.equal(cellWidth("⚠"), 1);
  assert.equal(cellWidth("中"), 2);
  assert.equal(cellWidth("，"), 2);
  assert.equal(cellWidth("😀"), 2);
  assert.equal(cellWidth(ACUTE), 0);
  assert.deepEqual(cells(`⛁ ab中${ACUTE}x · y`), [
    { char: "⛁", wide: false },
    " ab",
    { char: `中${ACUTE}`, wide: true },
    "x ",
    { char: "·", wide: false },
    " y",
  ]);
});

test("靠空白或框線排版的輸出不換行，一般文字照常換行", () => {
  assert.equal(laidOut("⛁ ⛁ ⛶\n⛶ ⛶ ⛶"), true);
  assert.equal(laidOut("Name     Size\nfoo.txt  12"), true);
  assert.equal(laidOut("└ 23 tools"), true);
  assert.equal(laidOut("Kept model as Opus 5 (1M context)\nsecond line"), false);
});
