import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import "@xterm/xterm/css/xterm.css";
import { restoreTerminalSnapshot, serializeTerminalSnapshot } from "../../src/shared/lib/terminalSnapshot";

const write = (terminal: Terminal, text: string) => new Promise<void>(done => terminal.write(text, done));
let original: Terminal;
let restored: Terminal;
let originalReports: string[] = [];
let restoredReports: string[] = [];
let snapshot = "";
const encoding = (terminal: Terminal) => (terminal as unknown as {
  _core: { mouseStateService: { activeEncoding: string } };
})._core.mouseStateService.activeEncoding;

function create(id: string, collect: (text: string) => void) {
  const terminal = new Terminal({ cols: 40, rows: 8, scrollback: 3000, fontSize: 15, allowProposedApi: true });
  const addon = new SerializeAddon();
  terminal.loadAddon(addon);
  terminal.open(document.getElementById(id)!);
  terminal.onData(collect);
  terminal.onBinary(collect);
  return { terminal, addon };
}

const api = {
  async setup(sequence: string, options: { legacy?: boolean; tail?: boolean; preexisting?: boolean } = {}) {
    original?.dispose();
    restored?.dispose();
    document.getElementById("source")!.replaceChildren();
    document.getElementById("restored")!.replaceChildren();
    const source = create("source", data => originalReports.push(data));
    const target = create("restored", data => restoredReports.push(data));
    original = source.terminal;
    restored = target.terminal;
    if (options.tail) await write(original, "history row\r\n".repeat(2200));
    await write(original, "selectable text for mouse test\r\nsecond row\r\n" + sequence);
    snapshot = options.legacy ? source.addon.serialize() : serializeTerminalSnapshot(original, source.addon);
    if (options.tail) snapshot = snapshot.split("\n").slice(-2000).join("\n");
    if (options.preexisting) await write(restored, "\x1b[?1003h\x1b[?1016h");
    await write(restored, restoreTerminalSnapshot(snapshot));
    originalReports = [];
    restoredReports = [];
    return api.state();
  },
  clear() { originalReports = []; restoredReports = []; },
  state() {
    return {
      original: { tracking: original.modes.mouseTrackingMode, encoding: encoding(original), reports: originalReports },
      restored: { tracking: restored.modes.mouseTrackingMode, encoding: encoding(restored), reports: restoredReports },
      snapshotHasEncoding: /\x1b\[\?1006/.test(snapshot),
      selected: restored.hasSelection(),
    };
  },
  async writeRestored(sequence: string) { await write(restored, sequence); },
  async resetAndRoundTrip() {
    original.reset();
    const addon = new SerializeAddon();
    original.loadAddon(addon);
    await write(restored, serializeTerminalSnapshot(original, addon));
    addon.dispose();
    return api.state();
  },
};

Object.assign(window, { mouseSnapshotTest: api });
