import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import xterm from "@xterm/xterm";
import serialize from "@xterm/addon-serialize";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const output = ts.transpileModule(read("src/shared/lib/terminalSnapshot.ts"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { releaseViewportForRecreatedPty, restoreTerminalSnapshot, serializeTerminalSnapshot } = await import(
  `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`,
);

const ROWS = 5;
const createTerminal = () => new xterm.Terminal({ cols: 40, rows: ROWS, scrollback: 100, allowProposedApi: true });
const write = (terminal, data) => new Promise(resolve => terminal.write(data, resolve));
const lines = terminal => {
  const buffer = terminal.buffer.active;
  return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true));
};
const viewport = terminal => lines(terminal).slice(terminal.buffer.active.baseY);
const screen = terminal => {
  const { baseY, cursorX, cursorY } = terminal.buffer.active;
  return { lines: lines(terminal), baseY, cursor: [cursorX, cursorY] };
};
// Snapshot suffixes written by useXTermController (restoredCursor is "\x1b[?25h" outside Codex).
const FRESH_PTY_MODES = "\x1b[?6l\x1b[r\x1b[0m\x1b[?25h";
const LIVE_PTY = "\x1b[?25h";
// The former suffix: fresh-PTY modes plus cursor parking on a clean bottom line.
const PARKED = `${FRESH_PTY_MODES}\x1b[999B\r\n`;

async function restoreSnapshot(snapshotLines, suffix) {
  const terminal = createTerminal();
  await write(terminal, `${snapshotLines.join("\r\n")}${suffix}`);
  return terminal;
}
const released = terminal => new Promise(resolve => releaseViewportForRecreatedPty(terminal, resolve));
const history = ["old 0", "old 1", "old 2", "old 3", "old 4", "old 5", "PS C:\\repo> npm run build"];
// Captured from the bundled ConPTY: prompt is linear, PSReadLine redraws the input line with absolute CUP.
const bundledConptyStartup = "PS C:\\repo> \x1b[?25l\x1b[1;13H\x1b[93mnpm\x1b[39;49m run build\x1b[0m\x1b[1;26H\x1b[?25h";
// Captured from the system ConPTY: the first frame clears the screen and homes the cursor.
const systemConptyStartup = "\x1b[?25l\x1b[2J\x1b[m\x1b[HPS C:\\repo> \x1b[?25h";

async function liveTerminal(data) {
  const terminal = createTerminal();
  const addon = new serialize.SerializeAddon();
  terminal.loadAddon(addon);
  await write(terminal, data);
  return { terminal, addon };
}
// Pane remount: the unmounting xterm is serialized and a new xterm restores it while the PTY keeps running.
async function remount(live, suffix) {
  const terminal = createTerminal();
  await write(terminal, `${restoreTerminalSnapshot(serializeTerminalSnapshot(live.terminal, live.addon, 2000))}${suffix}`);
  return terminal;
}
async function continuePty(terminals, data) {
  for (const terminal of terminals) await write(terminal, data);
}
const livePrompt = "old 0\r\nold 1\r\nPS C:\\repo> ";
// PSReadLine echo of "dir" on row 3 through ConPTY, then the command output.
const livePsReadLine = "\x1b[?25l\x1b[3;13H\x1b[93mdir\x1b[0m\x1b[3;16H\x1b[?25h\r\n\r\n    Directory: C:\\repo\r\n";
const liveInkFrame = "history\r\n+----+\r\n| >  |\r\n+----+";
// Ink (Claude Code) erases its previous frame relative to the cursor, then redraws it.
const liveInkRedraw = "\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G+----+\r\n| >x |\r\n+----+";

test("cursor parking alone lets absolute ConPTY redraws overwrite restored history", async () => {
  const terminal = await restoreSnapshot(history, PARKED);
  await write(terminal, bundledConptyStartup);
  // The input line lands on a restored history row instead of after the new prompt.
  assert.match(viewport(terminal)[0], /^old \d +npm run build$/);
});

test("recreated PTY output starts on an empty viewport above preserved history", async () => {
  const terminal = await restoreSnapshot(history, FRESH_PTY_MODES);
  await released(terminal);
  assert.equal(terminal.options.scrollOnEraseInDisplay, false);
  const { baseY, cursorX, cursorY } = terminal.buffer.active;
  assert.deepEqual(lines(terminal).slice(0, baseY), history);
  assert.deepEqual([cursorX, cursorY], [0, 0]);
  assert.ok(viewport(terminal).every(line => line === ""));

  await write(terminal, bundledConptyStartup);
  assert.deepEqual(lines(terminal).slice(0, baseY), history);
  assert.equal(viewport(terminal)[0], "PS C:\\repo> npm run build");
});

test("system ConPTY's first-frame clear no longer erases restored history", async () => {
  const terminal = await restoreSnapshot(history, FRESH_PTY_MODES);
  await released(terminal);
  const { baseY } = terminal.buffer.active;
  await write(terminal, systemConptyStartup);
  assert.deepEqual(lines(terminal).slice(0, baseY), history);
  assert.equal(viewport(terminal)[0], "PS C:\\repo> ");
});

test("short snapshots move into scrollback without a blank gap", async () => {
  const terminal = await restoreSnapshot(["PS C:\\repo> dir"], FRESH_PTY_MODES);
  await released(terminal);
  assert.deepEqual(lines(terminal).slice(0, terminal.buffer.active.baseY), ["PS C:\\repo> dir"]);
});

test("cursor parking on a live remount desynchronizes later PTY output", async () => {
  for (const [frame, next] of [[livePrompt, livePsReadLine], [liveInkFrame, liveInkRedraw]]) {
    const live = await liveTerminal(frame);
    const mounted = await remount(live, PARKED);
    await continuePty([live.terminal, mounted], next);
    assert.notDeepEqual(screen(mounted), screen(live.terminal));
  }
});

test("a live remount continues absolute and relative PTY redraws exactly like the unmounted terminal", async () => {
  for (const [frame, next] of [[livePrompt, livePsReadLine], [liveInkFrame, liveInkRedraw]]) {
    const live = await liveTerminal(frame);
    const mounted = await remount(live, LIVE_PTY);
    assert.deepEqual(screen(mounted), screen(live.terminal));
    await continuePty([live.terminal, mounted], next);
    assert.deepEqual(screen(mounted), screen(live.terminal));
  }
});

test("a live remount keeps the TUI scroll region instead of resetting it", async () => {
  const live = await liveTerminal("\x1b[1;3ra\r\nb\r\nc\r\nd");
  const region = terminal => [terminal._core.buffer.scrollTop, terminal._core.buffer.scrollBottom];
  assert.deepEqual(region(await remount(live, LIVE_PTY)), [0, 2]);
  assert.deepEqual(region(await remount(live, PARKED)), [0, ROWS - 1]);
});

test("restore never replays shell startup commands and marks only recreated snapshot sessions", () => {
  const store = read("src/features/terminal/store/terminalStore.ts");
  // An explicit empty command stops resolvePtyLaunch from falling back to the project default.
  assert.match(store, /startupCmd: cliKind \? restoredStartupCmd : "",/);
  const launch = read("src/features/terminal/lib/terminalLaunch.ts");
  assert.match(launch, /let resolvedStartupCmd = options\.startupCmd === undefined && project\?\.environment_type === "ssh"/);
  assert.match(launch, /const usesProjectDefaultStartup = options\.startupCmd == null/);
  assert.match(store, /const initialTerminalOutput = cliKind \? undefined : ps\.initialTerminalOutput;/);
  // The original command stays as Tab metadata for shell sessions.
  assert.match(store, /startupCmd: !cliKind \? restoredStartupCmd\s*:/);
  assert.match(store, /if \(launchStartupCmd && !launch\.startupHandledByLaunch\) \{/);
  assert.doesNotMatch(store, /deferStartupUntilInitialOutput/);
  assert.match(store, /if \(hasInitialOutput\) recreatedPtyDisplayPendingSessionIds\.add\(newSessionId\);/);
  assert.match(store, /daemonAttachPendingSessionIds,\s*recreatedPtyDisplayPendingSessionIds,/);
  // Both close paths drop the one-shot marker together with the daemon attach marker.
  assert.equal(store.match(/newRecreatedPtyDisplayPending\.delete\((?:id|closedSessionId)\);/g)?.length, 2);
  assert.equal(store.match(/recreatedPtyDisplayPendingSessionIds: newRecreatedPtyDisplayPending,/g)?.length, 2);
});
