import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const built = await build({ entryPoints: [fileURLToPath(new URL("./terminalColorQueryFilter.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "esm" });
const { createTerminalColorQueryFilter } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`);
const ESC = "\x1b", ST = ESC + "\\";
test("mixed setters remain before immediate colored text", () => {
  const f = createTerminalColorQueryFilter();
  assert.equal(f.feed(`${ESC}]4;1;#ff0000;2;?;3;#00ff00${ST}${ESC}[31mRED`), `${ESC}]4;1;#ff0000;3;#00ff00${ST}${ESC}[31mRED`);
  assert.equal(f.feed(`${ESC}]10;?;#fff;?${ST}text`), `${ESC}]10;;#fff;${ST}text`);
  assert.equal(f.feed(`${ESC}]11;#fff;?\x07text`), `${ESC}]11;#fff;\x07text`);
});
test("all character and UTF8 byte chunk widths preserve ordered output", () => {
  const input = `你好😀${ESC}]4;1;?;2;#123456${ST}${ESC}]12;?\x07${ESC}[32m绿${ESC}]10;?;#fff${ST}`;
  const expected = `你好😀${ESC}]4;2;#123456${ST}${ESC}[32m绿${ESC}]10;;#fff${ST}`;
  for (let split = 0; split <= input.length; split++) {
    const f = createTerminalColorQueryFilter();
    assert.equal(f.feed(input.slice(0, split)) + f.feed(input.slice(split)), expected);
  }
  const bytes = new TextEncoder().encode(input);
  for (let size = 1; size <= bytes.length; size++) {
    const decoder = new TextDecoder(), f = createTerminalColorQueryFilter();
    let output = "";
    for (let offset = 0; offset < bytes.length; offset += size) output += f.feed(decoder.decode(bytes.slice(offset, offset + size), { stream: true }));
    output += f.feed(decoder.decode());
    assert.equal(output, expected);
  }
});
test("text CSI unrelated OSC and setters remain untouched", () => {
  const input = `text${ESC}[?25h${ESC}]0;title?\x07${ESC}]52;c;?${ST}${ESC}]4${ST}${ESC}]10;#fff${ST}`;
  const f = createTerminalColorQueryFilter();
  assert.equal(Array.from(input).map(char => f.feed(char)).join(""), input);
});
test("allowed output passes and reset clears partial stream", () => {
  const f = createTerminalColorQueryFilter();
  assert.equal(f.feed(`${ESC}]10;?${ST}`, false), `${ESC}]10;?${ST}`);
  assert.equal(f.feed(`${ESC}]4;1;`), "");
  f.reset();
  assert.equal(f.feed(`normal${ESC}]12;?${ST}`), "normal");
});
test("completing frame determines policy across boundaries", () => {
  const f = createTerminalColorQueryFilter();
  assert.equal(f.feed(`${ESC}]10;`, true), "");
  assert.equal(f.feed(`?${ST}`, false), `${ESC}]10;?${ST}`);
});
test("oversized and aborted OSC do not retain or swallow subsequent text", () => {
  const f = createTerminalColorQueryFilter();
  const large = `${ESC}]0;` + "a".repeat(20_000);
  assert.equal(f.feed(large), large);
  assert.equal(f.feed(`${ST}text${ESC}]12;?${ST}`), `${ST}text`);
  const malformed = `${ESC}]10;broken${ESC}[31mtext`;
  assert.equal(f.feed(malformed), malformed);
});
