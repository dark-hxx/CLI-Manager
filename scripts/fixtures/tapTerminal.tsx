import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { Terminal, type TerminalHandle } from "../../apps/web-tap/src/Terminal";
import { translator } from "../../apps/web-tap/src/i18n";
import { createTerminalStream } from "../../src/shared/lib/webTerminalStream";
import { batchWebTerminalFrames } from "../../src/shared/lib/webTerminalFrames";
import "../../apps/web-tap/src/styles.css";

const root = createRoot(document.getElementById("root")!);
const handle = createRef<TerminalHandle>();
const stream = createTerminalStream();
const id = "isolated-terminal";
stream.start(id);
let term: Xterm;
// Test-only observation: all bytes still traverse the real stream, writer and renderer.
const open = Xterm.prototype.open;
Xterm.prototype.open = function(parent) { term = this; return open.call(this, parent); };
let sequence = 0, chunk = 0;
const errors: string[] = [], inputs: string[] = [], resizes: number[][] = [];
const config = { height: 650, fontSize: 14, active: true, visible: true, nativeMenu: false,
  mode: "desktop" as "desktop" | "web", cols: 191, rows: 67, language: "zh-CN" as "zh-CN" | "en-US" };
function configure(next: Partial<typeof config> = {}) {
  Object.assign(config, next);
  flushSync(() => root.render(<div className="tap-session is-visible is-terminal" style={{ height: config.height, display: config.visible ? undefined : "none" }}>
    <div className={`tap-session-content${config.nativeMenu ? " has-native-command" : ""}`}>
      <div className="tap-terminal-panel">
        <Terminal ref={handle} sessionId={id} stream={stream} active={config.active} visible={config.visible} connected
          state={{ status: "running", controlMode: config.mode, cols: config.cols, rows: config.rows }}
          nativeMenu={config.nativeMenu} fontSize={config.fontSize} t={translator(config.language)}
          onInput={(text) => { inputs.push(text); return true; }} onResize={(cols, rows) => resizes.push([cols, rows])}
          onError={(error) => errors.push(error)} onRetry={() => {}} />
      </div>
    </div>
  </div>));
}
function write(text: string) {
  const cols = config.mode === "desktop" ? config.cols : term.cols;
  const rows = config.mode === "desktop" ? config.rows : term.rows;
  const frames = batchWebTerminalFrames([{ kind: "output", sessionId: id, sequence: ++sequence, cols, rows, data: new TextEncoder().encode(text) }]);
  for (const batch of frames) stream.publish(id, { sequence: ++chunk, frames: batch.frames });
  return sequence;
}
function snapshot() {
  const container = document.querySelector<HTMLElement>(".tap-terminal-screen")!;
  const reader = document.querySelector<HTMLElement>(".tap-terminal-reader")!;
  const rows = [...document.querySelectorAll<HTMLElement>(".xterm-rows > div")];
  const last = rows.at(-1)?.getBoundingClientRect();
  const rect = container.getBoundingClientRect();
  return { grid: [term.cols, term.rows], rendered: stream.renderedSequence(id), errors, inputs, resizes,
    baseY: term.buffer.active.baseY, viewportY: term.buffer.active.viewportY,
    reading: !reader.hidden, readerWidth: reader.clientWidth, readerScrollWidth: reader.scrollWidth,
    readerTop: reader.scrollTop, readerMax: reader.scrollHeight - reader.clientHeight,
    top: container.scrollTop, left: container.scrollLeft, maxTop: container.scrollHeight - container.clientHeight,
    maxLeft: container.scrollWidth - container.clientWidth, hostHeight: container.clientHeight,
    finalInBuffer: term.buffer.active.getLine(term.rows - 1)?.translateToString(true),
    lastRowVisible: !!last && getComputedStyle(container).visibility !== "hidden" && container.clientHeight > 0
      && last.top >= rect.top - 1 && last.bottom <= rect.top + container.clientHeight + 1,
    // Last-row visibility alone misses xterm's former inner clip; inspect the clipping ancestor too.
    innerHeight: term.element?.getBoundingClientRect().height,
    lastRowBottom: last?.bottom, visibleBottom: rect.top + container.clientHeight };
}
Object.assign(window, { tapTerminalFixture: { configure, write, snapshot,
  focus: () => handle.current?.focus(), leaveDirect: () => handle.current?.leaveDirect() } });
configure();
