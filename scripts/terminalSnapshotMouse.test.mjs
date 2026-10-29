import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const source = read("src/shared/lib/terminalSnapshot.ts");
const output = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { serializeTerminalSnapshot, restoreTerminalSnapshot, restoreKnownTerminalCheckpoint } = await import(
  `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`,
);

for (const tracking of ["none", "x10", "vt200", "drag", "any"]) {
  for (const encoding of ["DEFAULT", "SGR", "SGR_PIXELS"]) {
    test(`complete ${tracking}/${encoding} snapshot survives tail trimming and legacy preparation`, () => {
      const terminal = { modes: { mouseTrackingMode: tracking }, _core: { mouseStateService: { activeEncoding: encoding } } };
      const snapshot = serializeTerminalSnapshot(terminal, { serialize: () => "line\n".repeat(2200) });
      assert.equal(restoreTerminalSnapshot(snapshot), snapshot);
      const tail = snapshot.split("\n").slice(-2000).join("\n");
      assert.equal(restoreTerminalSnapshot(tail), tail);
      assert.ok(tail.includes("\x1b[?1006;1016l"));
      if (encoding === "SGR") assert.ok(tail.includes("\x1b[?1006h"));
      if (encoding === "SGR_PIXELS") assert.ok(tail.includes("\x1b[?1016h"));
      const mode = { none: "", x10: "9", vt200: "1000", drag: "1002", any: "1003" }[tracking];
      if (mode) assert.ok(tail.endsWith(`\x1b[?${mode}h`));
    });
  }
}

test("unavailable or unknown xterm internals fail before publishing a corrupt snapshot", () => {
  for (const terminal of [{}, { _core: { mouseStateService: { activeEncoding: "FUTURE" } } }]) {
    assert.throws(() => serializeTerminalSnapshot(terminal, { serialize: () => "screen" }), /encoding_unavailable/);
  }
});

test("only old snapshots with enabled tracking and missing encoding need conservative recovery", () => {
  for (const modes of ["9", "1000", "1002", "1003", "9;1003"]) {
    const old = `screen\x1b[?${modes}h`;
    const safe = restoreTerminalSnapshot(old);
    assert.ok(safe.endsWith("\x1b[?9;1000;1002;1003l"));
    assert.ok(!safe.includes("1006h"), "must not guess SGR");
    assert.equal(restoreTerminalSnapshot(safe), safe, "compatibility is idempotent");
  }
  for (const old of ["shell", "\x1b[?1003h\x1b[?1003l", "\x1b[?1006l\x1b[?1003h", "\x1b[?1016h\x1b[?1002h"]) {
    assert.equal(restoreTerminalSnapshot(old), old);
  }
});

test("old-daemon fallback requires exact saved-snapshot identity and leaves raw legacy mouse output alone", () => {
  const old = "screen\x1b[?1003h";
  assert.equal(restoreKnownTerminalCheckpoint(old, old), restoreTerminalSnapshot(old));
  assert.equal(restoreKnownTerminalCheckpoint("older\n" + old, old), restoreTerminalSnapshot("older\n" + old));
  for (const saved of [undefined, "", "different screen\x1b[?1003h"]) {
    assert.equal(restoreKnownTerminalCheckpoint(old, saved), old);
  }
});

test("all snapshot producers and explicit restore boundaries use the production helpers", () => {
  const controller = read("src/features/terminal/hooks/useXTermController.ts");
  assert.doesNotMatch(controller, /serializeAddon\.serialize\(/);
  assert.equal((controller.match(/serializeTerminalSnapshot\(terminal, serializeAddon\)/g) ?? []).length, 2);
  assert.match(controller, /restoreTerminalSnapshot\(initialTerminalOutput\)/);
  const display = read("src/features/terminal/hooks/useTerminalDisplay.ts");
  assert.match(display, /payload\.kind === "replay"\s*\? restoreKnownTerminalCheckpoint/);
  assert.match(display, /charCount: rawText\.length/);
  assert.match(display, /restoreKnownTerminalCheckpoint\(rawText,/);
  assert.match(controller, /initialTerminalOutput = useTerminalStore\.getState\(\)\.daemonAttachPendingSessionIds\.has\(sessionId\)\s*\? undefined/);
});

test("live daemon restore preserves saved checkpoint identity without enabling static startup replay", () => {
  const source = read("src/features/terminal/store/terminalStore.ts");
  const ast = ts.createSourceFile("store.ts", source, ts.ScriptTarget.Latest, true);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "attachedSession") expression = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(expression);
  const js = ts.transpileModule(`return ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const snapshot = "screen\x1b[?1003h";
  const session = new Function("ps", "daemonSession", "attachedMeta", "getRestoredAgentTerminalMetadata", js)(
    { id: "test", initialTerminalOutput: snapshot }, {}, {}, () => ({}),
  );
  assert.equal(session.initialTerminalOutput, snapshot);
  assert.equal(session.deferStartupUntilInitialOutput, false);
});
