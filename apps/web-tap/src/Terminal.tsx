import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { BookOpenText, Keyboard, MonitorUp } from "lucide-react";
import { flushSync } from "react-dom";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { createTerminalKeyboardOptions } from "../../../src/shared/lib/terminalKeyboardProtocol";
import { installTerminalUnicode } from "../../../src/shared/lib/terminalUnicode";
import { installTerminalQueryPolicy } from "../../../src/shared/lib/terminalQueryPolicy";
import { createWebTerminalFrames, type RenderFrame } from "../../../src/shared/lib/webTerminalRenderQueue";
import { createTerminalColorQueryFilter } from "../../../src/shared/lib/terminalColorQueryFilter";
import type { TerminalStream } from "./protocol";
import type { TerminalState } from "./useWorkspace";
import { preparePaste, type Key, type Modifiers } from "./input";
import { terminalKeyBytes } from "./terminalKeys";
import { terminalWrites } from "./terminalWrites";
import { readerLines } from "./format";
import { nativeCommandPrefix } from "./completion";
import type { Translate } from "./i18n";
import { PHONE_QUERY } from "./preferences";
import { installTerminalViewport } from "./terminalViewport";

export type TerminalHandle = {
  key: (key: Key, modifiers: Modifiers) => boolean;
  message: (text: string) => Promise<boolean>;
  command: (prefix: string) => boolean;
  /** Native keyboard input straight into xterm (phones otherwise keep its textarea read-only). */
  focus: () => void;
  leaveDirect: () => void;
};
/** What the session header and dock show about this renderer. */
export type TerminalInfo = { size: string; direct: boolean };
type Props = {
  ref?: Ref<TerminalHandle>; sessionId: string; stream: TerminalStream; active: boolean; visible: boolean;
  connected: boolean; state: TerminalState; fontSize: number; t: Translate;
  nativeMenu?: boolean;
  onInput: (text: string) => boolean; onResize: (cols: number, rows: number) => void;
  onError: (code: string) => void;
  onRetry: () => void;
  onInfo?: (info: TerminalInfo) => void;
};
const DESKTOP_MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', Consolas, 'Liberation Mono', 'Noto Sans Mono CJK SC', monospace";

/** Independent Tap presentation; the wire frames and grid ownership stay upstream. */
export function Terminal({ ref, sessionId, stream, active, visible, connected, state, fontSize, t, onInput, onResize, onError, onRetry, onInfo, nativeMenu = false }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Xterm | null>(null);
  const options = useRef({ active, visible, connected, state, onInput, onResize, onError, nativeMenu });
  options.current = { active, visible, connected, state, onInput, onResize, onError, nativeMenu };
  const relayout = useRef(() => {});
  const [direct, setDirect] = useState(false);
  const [dimensions, setDimensions] = useState("");
  const [reading, setReading] = useState(false);
  const [readerText, setReaderText] = useState("");
  const [failed, setFailed] = useState(false);
  const broken = useRef(false);
  const presentation = useRef<"auto" | "native" | "reader">("auto");
  const directInput = useRef(false);
  const reader = useRef<HTMLDivElement>(null);
  const readerPinned = useRef(true);
  const sendVersion = useRef(0);
  useEffect(() => { if (!connected || !active) sendVersion.current++; }, [connected, active]);

  useImperativeHandle(ref, () => ({
    command: (prefix) => Boolean(nativeCommandPrefix(prefix) && terminal.current && !broken.current
      && options.current.connected && options.current.active && options.current.onInput(prefix)),
    key: (key, modifiers) => Boolean(terminal.current && !broken.current && options.current.connected
      && options.current.onInput(terminalKeyBytes(terminal.current, key, modifiers))),
    message: async (text) => {
      const term = terminal.current;
      if (!term || broken.current || !options.current.connected || !options.current.active) return false;
      const content = preparePaste(text, term.modes.bracketedPasteMode);
      const generation = sendVersion.current;
      if (!options.current.onInput(content)) return false;
      // Native TUIs need time to process paste before handling the submission key.
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (generation !== sendVersion.current || !options.current.connected || !options.current.active) {
        options.current.onError("unknownDelivery"); return false;
      }
      return options.current.onInput("\r");
    },
    focus: () => enterDirect(),
    leaveDirect: () => leaveDirect(),
  }), []);
  function enterDirect() {
    if (!options.current.connected || broken.current) return;
    directInput.current = true;
    flushSync(() => { setReading(false); setDirect(true); });
    relayout.current();
    const textarea = terminal.current?.textarea;
    if (textarea) { textarea.readOnly = false; textarea.inputMode = "text"; }
    terminal.current?.focus();
  }
  function leaveDirect() {
    const textarea = terminal.current?.textarea;
    const coarse = matchMedia("(pointer: coarse)").matches;
    if (textarea) { textarea.readOnly = coarse; textarea.inputMode = coarse ? "none" : "text"; }
    directInput.current = false;
    terminal.current?.blur(); setDirect(false); relayout.current();
  }
  const info = useRef(onInfo);
  info.current = onInfo;
  useEffect(() => { info.current?.({ size: dimensions, direct }); }, [dimensions, direct]);
  useEffect(() => { if (!connected && direct) leaveDirect(); }, [connected, direct]);
  const lines = useMemo(() => readerLines(readerText.split("\n")), [readerText]);
  useEffect(() => {
    if (!reading || !active || !visible || !reader.current) return;
    let frame = 0;
    const pin = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (readerPinned.current && reader.current) reader.current.scrollTop = reader.current.scrollHeight;
      });
    };
    const observer = new ResizeObserver(pin); observer.observe(reader.current); pin();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [reading, readerText, fontSize, active, visible]);

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let writing = false;
    let releaseWrite: (() => void) | undefined;
    let queue: RenderFrame[] = [];
    let queuedBytes = 0;
    let raf = 0;
    let readerTimer: ReturnType<typeof setTimeout> | undefined;
    let usingReader = false;
    const writeToken = Symbol(sessionId);
    const frames = createWebTerminalFrames();
    let decoder = new TextDecoder();
    const colors = createTerminalColorQueryFilter();
    const term = new Xterm({
      ...createTerminalKeyboardOptions(),
      allowProposedApi: true, scrollback: 5000, convertEol: false, cursorBlink: false, cursorStyle: "bar",
      fontFamily: DESKTOP_MONO, fontSize, fontWeightBold: 700, lineHeight: 1, minimumContrastRatio: 4.5,
      theme: { background: "#1c1b22", foreground: "#e4e4e7", cursor: "#c4b5fd", selectionBackground: "#a78bfa55" },
    });
    installTerminalUnicode(term);
    // The native host owns terminal query replies; browsers are mirrors, including Tap.
    const policy = installTerminalQueryPolicy(term, () => false);
    term.loadAddon(new WebLinksAddon((event, url) => {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
    }));
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current);
    let reported = "";
    terminal.current = term;
    if (matchMedia("(pointer: coarse)").matches && term.textarea) {
      term.textarea.readOnly = true; term.textarea.inputMode = "none";
    }
    const readBuffer = () => {
      readerTimer = undefined;
      if (disposed || !usingReader || !options.current.active || !options.current.visible) return;
      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let index = Math.max(0, buffer.length - 800); index < buffer.length; index++) {
        const line = buffer.getLine(index);
        if (!line) continue;
        const text = line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
        if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
        else lines.push(text);
      }
      while (lines.length && !lines.at(-1)) lines.pop();
      setReaderText(lines.join("\n"));
    };
    const scheduleReader = () => {
      if (usingReader && readerTimer === undefined) readerTimer = setTimeout(readBuffer, 150);
    };
    const resize = () => {
      if (disposed || writing || queue.length || frames.pending() || !options.current.active || !options.current.visible
        || document.visibilityState === "hidden" || !host.current?.clientWidth) return;
      if (options.current.state.controlMode === "desktop") {
        const { cols, rows } = options.current.state;
        if (cols && rows && (term.cols !== cols || term.rows !== rows)) term.resize(cols, rows);
      } else {
        fit.fit();
        const geometry = `${term.cols}:${term.rows}`;
        if (geometry !== reported) { reported = geometry; options.current.onResize(term.cols, term.rows); }
      }
      const fitCols = fit.proposeDimensions()?.cols ?? term.cols;
      const narrow = options.current.state.controlMode === "desktop" && term.cols > fitCols + 2;
      usingReader = !options.current.nativeMenu && !directInput.current
        && (presentation.current === "reader" || (presentation.current === "auto" && (phoneFont.matches || narrow)));
      setReading(usingReader);
      if (usingReader) readBuffer();
      setDimensions(`${term.cols}×${term.rows}`);
    };
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(resize); };
    relayout.current = schedule;
    const observer = new ResizeObserver(schedule); observer.observe(host.current);
    const phoneFont = matchMedia(PHONE_QUERY);
    const applyFont = () => {
      if (disposed) return;
      if (phoneFont.matches) {
        void document.fonts.load(`${fontSize}px "Tap Mono"`).then(() => {
          if (!disposed && phoneFont.matches) {
            term.options.fontFamily = "'Tap Mono', 'Noto Sans Mono CJK SC', monospace"; term.options.lineHeight = 1.1; schedule();
          }
        }, () => { if (!disposed) schedule(); });
      } else { term.options.fontFamily = DESKTOP_MONO; term.options.lineHeight = 1; schedule(); }
    };
    phoneFont.addEventListener("change", applyFont); applyFont();
    const input = term.onData((data) => {
      if (!broken.current && options.current.active && options.current.connected) options.current.onInput(data);
    });
    const binary = term.onBinary((data) => {
      if (!broken.current && options.current.active && options.current.connected) options.current.onInput(data);
    });
    const drain = async () => {
      if (writing || disposed) return;
      writing = true;
      try {
        let processed = 0;
        while (queue.length && !disposed) {
          // Coalesce only adjacent same-grid frames; resets and original geometry stay ordered.
          const { frame, reset } = queue[0]!;
          let count = 1;
          let bytes = frame.data.length;
          while (count < queue.length) {
            const next = queue[count]!;
            if (next.reset || next.frame.cols !== frame.cols || next.frame.rows !== frame.rows
              || bytes + next.frame.data.length > 256 * 1024) break;
            bytes += next.frame.data.length; count++;
          }
          const batch = queue.splice(0, count);
          queuedBytes -= bytes;
          if (frame.cols > 0 && frame.rows > 0 && (term.cols !== frame.cols || term.rows !== frame.rows)) term.resize(frame.cols, frame.rows);
          if (reset) { colors.reset(); decoder = new TextDecoder(); }
          const parts: string[] = [];
          let rendered = 0;
          for (const item of batch) {
            const data = Uint8Array.from(atob(item.frame.data), (value) => value.charCodeAt(0));
            parts.push(colors.feed(decoder.decode(data, { stream: true })));
            if (item.frame.sequenceEnd !== false) rendered = Math.max(rendered, item.frame.sequence);
          }
          const text = (reset ? "\x1bc" : "") + parts.join("");
          await new Promise<void>((resolve, reject) => {
            releaseWrite = resolve;
            terminalWrites.request({ token: writeToken,
              isVisible: () => options.current.active && options.current.visible,
              start: () => {
                if (disposed) { resolve(); return; }
                try { if (text) term.write(text, resolve); else resolve(); } catch (error) { reject(error); }
              },
            });
          });
          releaseWrite = undefined;
          if (disposed) return;
          if (rendered > 0) stream.markRendered(sessionId, rendered);
          scheduleReader();
          if (++processed % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } catch { if (!disposed) { broken.current = true; setFailed(true); options.current.onError("terminal_render_failed"); } }
      finally { writing = false; if (!disposed) schedule(); }
    };
    const unsubscribe = stream.subscribe(sessionId, (chunk) => {
      if (disposed || broken.current) return;
      let next: RenderFrame[];
      try { next = frames.accept(chunk); }
      catch { broken.current = true; setFailed(true); options.current.onError("terminal_buffer_full"); return; }
      queuedBytes += next.reduce((total, item) => total + item.frame.data.length, 0);
      if (queuedBytes > 24 * 1024 * 1024) {
        broken.current = true; setFailed(true); options.current.onError("terminal_buffer_full"); return;
      }
      queue.push(...next); void drain();
    });
    const visibility = () => { if (document.visibilityState === "visible") schedule(); };
    document.addEventListener("visibilitychange", visibility); schedule();
    return () => {
      disposed = true; sendVersion.current++; unsubscribe(); observer.disconnect();
      terminalWrites.cancel(writeToken);
      clearTimeout(readerTimer);
      phoneFont.removeEventListener("change", applyFont);
      document.removeEventListener("visibilitychange", visibility); cancelAnimationFrame(raf);
      input.dispose(); binary.dispose(); policy.dispose(); releaseWrite?.(); queue = [];
      terminal.current = null; relayout.current = () => {}; term.dispose();
    };
  }, [sessionId, stream]);

  useEffect(() => {
    if (terminal.current) terminal.current.options.fontSize = fontSize;
    relayout.current();
  }, [fontSize, active, visible, state.controlMode, state.cols, state.rows, nativeMenu]);

  useEffect(() => {
    const term = terminal.current, container = host.current;
    if (reading || !active || !visible || !term || !container) return;
    return installTerminalViewport(term, container, nativeMenu);
  }, [reading, nativeMenu, direct, active, visible, sessionId, stream]);

  return <div className={`tap-terminal${direct ? " is-direct" : ""}`} aria-label={t("terminal")}>
    {failed && <div className="tap-terminal-failed" role="alert">{t("unavailable")} <button type="button" onClick={onRetry}>{t("reconnect")}</button></div>}
    <div ref={host} className="tap-terminal-screen" style={reading ? { visibility: "hidden" } : undefined} />
    <div ref={reader} className="tap-terminal-reader" hidden={!reading} style={{ fontSize }} onScroll={(event) => {
      if (!reading) return;
      const node = event.currentTarget;
      readerPinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
    }}>
      {lines.map(({ text, rule }, index) => <div key={index} className={rule ? "is-rule" : undefined}>{text || "\u00a0"}</div>)}
    </div>
    {(!nativeMenu || direct) && <div className="tap-terminal-chips">
      {!nativeMenu && !direct && <button type="button" className="tap-terminal-chip" title={t(reading ? "nativeHint" : "readingHint")}
        onClick={() => { presentation.current = reading ? "native" : "reader"; relayout.current(); }}>
        {reading ? <MonitorUp size={13} /> : <BookOpenText size={13} />}{t(reading ? "nativeView" : "readingView")}
      </button>}
      {direct && <button type="button" className="tap-terminal-chip is-direct" aria-pressed onClick={leaveDirect}>
        <Keyboard size={13} />{t("directStop")}
      </button>}
    </div>}
  </div>;
}
