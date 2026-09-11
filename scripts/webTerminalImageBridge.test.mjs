import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

// Exercise the production bridge function without starting the user's desktop.
const source = await readFile(new URL("../src/hooks/useWebDeviceBridge.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("bridge.ts", source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "executeTerminalImageAttachment");
assert.ok(declaration);
let saves = 0;
let writes = 0;
let failSave = false;
const sessions = [{ id: "original", shell: "pwsh" }];
const bridges = new Map([["original", { socket: { write() { writes++; } } }]]);
const context = vm.createContext({
  terminalBridges: bridges,
  useTerminalStore: { getState: () => ({ sessions }) },
  invoke: async (command, payload) => {
    assert.equal(command, "file_attach_data");
    assert.equal(payload.fileName, "phone.png");
    saves++;
    if (failSave) throw new Error("disk_full");
    return "C:/test photo.png";
  },
  formatShellPathList: paths => `'${paths[0]}'`,
});
vm.runInContext(ts.transpile(declaration.getText(ast)), context);
const operation = { payload: { sessionId: "original", fileName: "phone.png", dataBase64: "aW1hZ2U=" } };
const result = await context.executeTerminalImageAttachment(operation);
assert.equal(result.delivery, "browser_paste");
assert.equal(result.sessionId, "original");
assert.equal(result.pasteText, "'C:/test photo.png'");
assert.equal(writes, 0, "Preparation must not type a path before the browser pastes it");
failSave = true;
await assert.rejects(context.executeTerminalImageAttachment(operation), /disk_full/);
bridges.clear();
await assert.rejects(context.executeTerminalImageAttachment(operation), /terminal_session_not_found/);
assert.equal(saves, 2, "Closed session must be rejected before saving");
assert.equal(writes, 0);
console.log("Web image bridge: prepare-only result, original target, save failure and closed-session checks passed.");
