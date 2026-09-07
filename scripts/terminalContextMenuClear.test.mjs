import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/components/XTermTerminal.tsx", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

test("terminal context-menu clear works independently of foreground PTY input handling", () => {
  const handler = source.match(
    /const handleMenuClear = \(\) => \{([\s\S]*?)\n  \};/,
  )?.[1];

  assert.ok(handler, "handleMenuClear was not found");
  assert.ok(
    handler.includes('enqueueActiveWrite("\\x1b[2J\\x1b[H");'),
    "clear must enqueue an ANSI erase/home sequence through xterm",
  );
  assert.ok(
    handler.includes('terminalProcessManager.write(sessionId, "\\x0c")'),
    "clear must retain Ctrl+L so shells and TUIs can redraw",
  );
  assert.equal(handler.includes("terminal.clear()"), false);
  assert.ok(
    handler.indexOf("enqueueActiveWrite") < handler.indexOf("terminalProcessManager.write"),
    "the local display clear must be queued before requesting a process redraw",
  );
});
